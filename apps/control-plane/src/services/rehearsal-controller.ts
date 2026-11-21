import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  RehearsalActionRecord,
  RehearsalDecisionRequest,
  RehearsalRecord,
  StartRehearsalRequest,
  WsEvent,
} from "@dex-ai/shared";
import { rehearsalPauseReasonSchema } from "@dex-ai/shared";
import type { AgentAdapter } from "../agent/adapter";
import { runInTransaction, type ControlPlaneDb } from "../db/client";
import {
  deleteProposedRehearsalActions,
  getRehearsalActionRecord,
  getRehearsalRecord,
  insertRehearsal,
  insertRehearsalAction,
  listRehearsalActions,
  updateRehearsal,
  updateRehearsalAction,
} from "../repositories/rehearsals";
import { getSessionSummary } from "../repositories/sessions";
import type { StreamHub } from "../stream/hub";
import {
  classifySubmitAttempt,
  planRehearsal,
  RehearsalPlannerError,
  type PageSnapshot,
  type RehearsalPlanOutcome,
} from "./rehearsal-planner";

type PauseReason = z.infer<typeof rehearsalPauseReasonSchema>;

/** Typed failure the rehearsals route maps onto an HTTP error response. */
export class RehearsalError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502,
    readonly error: string,
    message: string,
  ) {
    super(message);
  }
}

export interface RehearsalControllerDeps {
  database: DatabaseSync;
  db: ControlPlaneDb;
  hub: StreamHub;
  adapter: AgentAdapter;
  /** Config default; each rehearsal can override it at start. */
  defaultConfidenceThreshold: number;
}

export interface RehearsalView {
  rehearsal: RehearsalRecord;
  actions: RehearsalActionRecord[];
}

export interface RehearsalDecisionResult {
  rehearsal: RehearsalRecord;
  action: RehearsalActionRecord | null;
}

/** One submission attempt the extension guard refused to perform. */
export type BlockedAttempt =
  | { reason: "submit_navigation"; url: string }
  | { reason: "submit_control" | "submit_activation"; selector: string };

// The hub validates the envelope against the shared schema before fanout.
function wsEnvelope(type: WsEvent["type"], payload: unknown): WsEvent {
  return { type, id: randomUUID(), ts: new Date().toISOString(), payload } as WsEvent;
}

/**
 * Rehearsal state machine. Every action the extension may execute carries
 * status approved on the current pointer of a running rehearsal, and a
 * submit-shaped attempt anywhere in the flow is recorded as blocked instead
 * of executed, even after user approval.
 */
export class RehearsalController {
  private readonly pauseReasons = new Map<string, PauseReason>();
  private readonly actionReasoning = new Map<string, string>();

  constructor(private readonly deps: RehearsalControllerDeps) {}

  async startRehearsal(request: StartRehearsalRequest): Promise<RehearsalView> {
    const session = await getSessionSummary(this.deps.db, request.sessionId);
    if (!session) throw new RehearsalError(404, "not_found", "Session does not exist");
    const postingUrl = request.postingUrl ?? session.postingUrl;
    if (!postingUrl) {
      throw new RehearsalError(
        400,
        "posting_url_required",
        "The rehearsal needs a posting url from the request or the session",
      );
    }

    const plan = await this.runPlanner({ sessionId: session.id, postingUrl, snapshot: null });
    const rehearsalId = randomUUID();
    const now = new Date();
    const actions = this.buildPlannedActions(rehearsalId, plan, 1, now);
    const firstProposed = actions.find((action) => action.status === "proposed") ?? null;
    const confidenceThreshold = request.confidenceThreshold ?? this.deps.defaultConfidenceThreshold;

    await runInTransaction(this.deps.database, async () => {
      await insertRehearsal(this.deps.db, {
        id: rehearsalId,
        sessionId: session.id,
        postingUrl,
        browserKind: session.browserKind,
        status: firstProposed ? "running" : "completed",
        confidenceThreshold,
        currentActionId: firstProposed?.id ?? null,
        startedAt: now,
      });
      for (const action of actions) {
        await insertRehearsalAction(this.deps.db, { ...action, createdAt: now });
      }
    });
    this.publishPlannedBlocks(actions, plan);

    let rehearsal: RehearsalRecord = {
      id: rehearsalId,
      sessionId: session.id,
      postingUrl,
      browserKind: session.browserKind,
      status: firstProposed ? "running" : "completed",
      confidenceThreshold,
      currentActionId: firstProposed?.id ?? null,
      startedAt: now.toISOString(),
    };
    if (firstProposed) rehearsal = await this.gateCurrentAction(rehearsal, firstProposed);
    return { rehearsal, actions: await listRehearsalActions(this.deps.db, rehearsalId) };
  }

  async getRehearsal(id: string): Promise<RehearsalView | null> {
    const rehearsal = await getRehearsalRecord(this.deps.db, id);
    if (!rehearsal) return null;
    return { rehearsal, actions: await listRehearsalActions(this.deps.db, id) };
  }

  async applyDecision(id: string, decision: RehearsalDecisionRequest): Promise<RehearsalDecisionResult> {
    const rehearsal = await this.requireRehearsal(id);
    if (decision.type === "pause") return this.handlePauseDecision(rehearsal);
    if (decision.type === "resume") return this.handleResumeDecision(rehearsal);
    return this.handleActionDecision(rehearsal, decision);
  }

  /** Replan from a page snapshot; decided and executed actions survive. */
  async acceptPageSnapshot(id: string, snapshot: PageSnapshot): Promise<RehearsalView> {
    const rehearsal = await this.requireRehearsal(id);
    this.requireActiveRehearsal(rehearsal);
    const plan = await this.runPlanner({
      sessionId: rehearsal.sessionId,
      postingUrl: rehearsal.postingUrl ?? "",
      snapshot,
    });

    const existing = await listRehearsalActions(this.deps.db, id);
    const current = existing.find((action) => action.id === rehearsal.currentActionId) ?? null;
    const nextSequence = existing.reduce((max, action) => Math.max(max, action.sequence), 0) + 1;
    const now = new Date();
    const actions = this.buildPlannedActions(id, plan, nextSequence, now);
    const firstProposed = actions.find((action) => action.status === "proposed") ?? null;
    const currentIsProposed = current?.status === "proposed";
    // A snapshot can reveal that the already approved current action targets
    // a submit control: block it like any other submission attempt.
    const currentBlockReason =
      current !== null && current.status === "approved" ? classifySubmitAttempt(current.action, snapshot) : null;

    await runInTransaction(this.deps.database, async () => {
      await deleteProposedRehearsalActions(this.deps.db, id);
      for (const action of actions) {
        await insertRehearsalAction(this.deps.db, { ...action, createdAt: now });
      }
      if (currentBlockReason !== null && current !== null) {
        await updateRehearsalAction(this.deps.db, current.id, { status: "blocked" });
      }
      if (currentIsProposed) {
        await updateRehearsal(this.deps.db, id, {
          currentActionId: firstProposed?.id ?? null,
          ...(firstProposed ? {} : { status: "completed" }),
        });
      }
    });
    this.publishPlannedBlocks(actions, plan);

    let updated: RehearsalRecord = rehearsal;
    if (currentBlockReason !== null && current !== null) {
      this.deps.hub.publish(
        wsEnvelope("rehearsal.blocked", {
          action: { ...current, status: "blocked" },
          reason: currentBlockReason,
        }),
      );
      // The blocked current action leaves the pointer stale, so advance to
      // the fresh proposals or end the rehearsal.
      updated = await this.advanceToNextProposed(rehearsal);
    }
    if (currentIsProposed) {
      updated = {
        ...rehearsal,
        currentActionId: firstProposed?.id ?? null,
        ...(firstProposed ? {} : { status: "completed" as const }),
      };
      if (firstProposed) updated = await this.gateCurrentAction(updated, firstProposed);
    }
    return { rehearsal: updated, actions: await listRehearsalActions(this.deps.db, id) };
  }

  /** The extension guard reports a submission it refused to perform. */
  async recordBlockedAttempt(id: string, attempt: BlockedAttempt): Promise<RehearsalDecisionResult> {
    const rehearsal = await this.requireRehearsal(id);
    const action: RehearsalActionRecord["action"] = attempt.reason === "submit_navigation"
      ? { kind: "navigate", url: attempt.url }
      : { kind: "click_non_submit", selector: attempt.selector };
    const existing = await listRehearsalActions(this.deps.db, id);
    const now = new Date();
    const record: RehearsalActionRecord = {
      id: randomUUID(),
      rehearsalId: id,
      sequence: existing.reduce((max, item) => Math.max(max, item.sequence), 0) + 1,
      action,
      confidence: 0,
      status: "blocked",
      traceId: null,
      createdAt: now.toISOString(),
    };

    await runInTransaction(this.deps.database, async () => {
      await insertRehearsalAction(this.deps.db, { ...record, createdAt: now });
    });
    this.deps.hub.publish(wsEnvelope("rehearsal.blocked", { action: record, reason: attempt.reason }));
    return { rehearsal, action: record };
  }

  /** Extension disconnect pauses the rehearsal and demands an explicit resume. */
  async markDisconnected(id: string): Promise<RehearsalDecisionResult> {
    const rehearsal = await this.requireRehearsal(id);
    if (rehearsal.status === "completed" || rehearsal.status === "failed") {
      return { rehearsal, action: null };
    }
    const current = await this.getCurrentAction(rehearsal);
    const paused = await this.setPaused(rehearsal, current, "disconnected");
    return { rehearsal: paused, action: await this.getCurrentAction(paused) };
  }

  /** The extension executed the current approved action on the page. */
  async reportExecuted(id: string, actionId: string): Promise<RehearsalDecisionResult> {
    const rehearsal = await this.requireRehearsal(id);
    if (rehearsal.status !== "running") {
      throw new RehearsalError(
        409,
        "rehearsal_not_running",
        "A paused rehearsal executes no further action until it is explicitly resumed",
      );
    }
    const action = await this.requireRehearsalAction(rehearsal, actionId);
    if (rehearsal.currentActionId !== action.id) {
      throw new RehearsalError(409, "action_not_current", "Only the current action can be reported as executed");
    }
    if (action.status !== "approved") {
      throw new RehearsalError(409, "action_not_approved", "Only an approved action can be reported as executed");
    }

    const executed: RehearsalActionRecord = { ...action, status: "executed" };
    await runInTransaction(this.deps.database, async () => {
      await updateRehearsalAction(this.deps.db, action.id, { status: "executed" });
    });
    this.deps.hub.publish(wsEnvelope("rehearsal.executed", { action: executed }));

    const advanced = await this.advanceToNextProposed({ ...rehearsal, currentActionId: action.id });
    return { rehearsal: advanced, action: executed };
  }

  private async requireRehearsal(id: string): Promise<RehearsalRecord> {
    const rehearsal = await getRehearsalRecord(this.deps.db, id);
    if (!rehearsal) throw new RehearsalError(404, "not_found", "Rehearsal does not exist");
    return rehearsal;
  }

  private requireActiveRehearsal(rehearsal: RehearsalRecord): void {
    if (rehearsal.status === "completed" || rehearsal.status === "failed") {
      throw new RehearsalError(409, "rehearsal_not_active", "The rehearsal has already ended");
    }
  }

  private async requireRehearsalAction(
    rehearsal: RehearsalRecord,
    actionId: string,
  ): Promise<RehearsalActionRecord> {
    const action = await getRehearsalActionRecord(this.deps.db, actionId);
    if (!action || action.rehearsalId !== rehearsal.id) {
      throw new RehearsalError(404, "not_found", "Rehearsal action does not exist");
    }
    return action;
  }

  private async getCurrentAction(rehearsal: RehearsalRecord): Promise<RehearsalActionRecord | null> {
    if (!rehearsal.currentActionId) return null;
    return getRehearsalActionRecord(this.deps.db, rehearsal.currentActionId);
  }

  /** Plan candidates become stored records; blocked ones never get proposed. */
  private buildPlannedActions(
    rehearsalId: string,
    plan: RehearsalPlanOutcome,
    firstSequence: number,
    now: Date,
  ): RehearsalActionRecord[] {
    const actions = plan.actions.map((candidate, index) => ({
      id: randomUUID(),
      rehearsalId,
      sequence: firstSequence + index,
      action: candidate.action,
      confidence: candidate.confidence,
      status: candidate.blockReason === null ? ("proposed" as const) : ("blocked" as const),
      traceId: plan.traceId,
      createdAt: now.toISOString(),
    }));
    for (let index = 0; index < plan.actions.length; index += 1) {
      const candidate = plan.actions[index];
      if (candidate.reasoning.length > 0) this.actionReasoning.set(actions[index].id, candidate.reasoning);
    }
    return actions;
  }

  private publishPlannedBlocks(actions: RehearsalActionRecord[], plan: RehearsalPlanOutcome): void {
    for (const [index, action] of actions.entries()) {
      const candidate = plan.actions[index];
      if (action.status === "blocked" && candidate.blockReason !== null) {
        this.deps.hub.publish(wsEnvelope("rehearsal.blocked", { action, reason: candidate.blockReason }));
      }
    }
  }

  private async runPlanner(input: {
    sessionId: string;
    postingUrl: string;
    snapshot: PageSnapshot | null;
  }) {
    try {
      return await planRehearsal(
        {
          database: this.deps.database,
          db: this.deps.db,
          hub: this.deps.hub,
          adapter: this.deps.adapter,
        },
        input,
      );
    } catch (error) {
      if (error instanceof RehearsalPlannerError) {
        throw new RehearsalError(502, "rehearsal_plan_failed", error.message);
      }
      throw error;
    }
  }

  /**
   * Show the current proposal, auto-approve it when confident, otherwise
   * pause before execution until the user approves, corrects or rejects.
   */
  private async gateCurrentAction(
    rehearsal: RehearsalRecord,
    action: RehearsalActionRecord,
  ): Promise<RehearsalRecord> {
    const reasoning = this.actionReasoning.get(action.id);
    this.deps.hub.publish(
      wsEnvelope("rehearsal.proposed", {
        action,
        ...(reasoning === undefined ? {} : { reasoning }),
      }),
    );
    if (rehearsal.status !== "running") return rehearsal;
    if (action.confidence >= rehearsal.confidenceThreshold) {
      await runInTransaction(this.deps.database, async () => {
        await updateRehearsalAction(this.deps.db, action.id, { status: "approved" });
      });
      return rehearsal;
    }
    return this.setPaused(rehearsal, action, "low_confidence");
  }

  /**
   * Pause always leaves the rehearsal without an executable action: an
   * approved current action goes back to proposed until explicit resume.
   */
  private async setPaused(
    rehearsal: RehearsalRecord,
    current: RehearsalActionRecord | null,
    reason: PauseReason,
  ): Promise<RehearsalRecord> {
    this.pauseReasons.set(rehearsal.id, reason);
    await runInTransaction(this.deps.database, async () => {
      await updateRehearsal(this.deps.db, rehearsal.id, { status: "paused" });
      if (current?.status === "approved") {
        await updateRehearsalAction(this.deps.db, current.id, { status: "proposed" });
      }
    });
    this.deps.hub.publish(
      wsEnvelope("rehearsal.paused", {
        rehearsalId: rehearsal.id,
        actionId: current?.id ?? null,
        reason,
      }),
    );
    return { ...rehearsal, status: "paused" };
  }

  private async handlePauseDecision(rehearsal: RehearsalRecord): Promise<RehearsalDecisionResult> {
    this.requireActiveRehearsal(rehearsal);
    // Pausing an already paused rehearsal strengthens the pause: approval
    // alone no longer resumes it.
    const current = await this.getCurrentAction(rehearsal);
    const paused = await this.setPaused(rehearsal, current, "user_paused");
    return { rehearsal: paused, action: await this.getCurrentAction(paused) };
  }

  private async handleResumeDecision(rehearsal: RehearsalRecord): Promise<RehearsalDecisionResult> {
    if (rehearsal.status !== "paused") {
      throw new RehearsalError(409, "not_paused", "Only a paused rehearsal can be resumed");
    }
    this.pauseReasons.delete(rehearsal.id);
    const running = { ...rehearsal, status: "running" as const };
    await runInTransaction(this.deps.database, async () => {
      await updateRehearsal(this.deps.db, rehearsal.id, { status: "running" });
    });

    const current = await this.getCurrentAction(running);
    if (current?.status === "proposed") {
      // A below-threshold proposal pauses again right away: it still needs
      // user approval even after an explicit resume.
      return { rehearsal: await this.gateCurrentAction(running, current), action: current };
    }
    return { rehearsal: running, action: current };
  }

  private async handleActionDecision(
    rehearsal: RehearsalRecord,
    decision: RehearsalDecisionRequest & { type: "approve" | "correct" | "reject"; actionId: string },
  ): Promise<RehearsalDecisionResult> {
    this.requireActiveRehearsal(rehearsal);
    const action = await this.requireRehearsalAction(rehearsal, decision.actionId);
    if (rehearsal.currentActionId !== action.id) {
      throw new RehearsalError(409, "action_not_current", "The decision must target the current action");
    }

    if (decision.type === "approve") return this.handleApprove(rehearsal, action);
    if (decision.type === "correct") return this.handleCorrect(rehearsal, action, decision.action);
    return this.handleReject(rehearsal, action);
  }

  private async handleApprove(
    rehearsal: RehearsalRecord,
    action: RehearsalActionRecord,
  ): Promise<RehearsalDecisionResult> {
    if (action.status === "blocked") {
      // The AC-12 guarantee: a submission attempt stays blocked even when
      // the user approves it afterwards.
      throw new RehearsalError(
        409,
        "submit_blocked",
        "A blocked submission attempt stays blocked even after approval",
      );
    }
    if (action.status !== "proposed") {
      throw new RehearsalError(409, "action_not_proposed", "Only a proposed action can be approved");
    }

    const approved: RehearsalActionRecord = { ...action, status: "approved" };
    const updated = await this.resolveLowConfidencePause(rehearsal, async () => {
      await updateRehearsalAction(this.deps.db, action.id, { status: "approved" });
    });
    return { rehearsal: updated, action: approved };
  }

  private async handleCorrect(
    rehearsal: RehearsalRecord,
    action: RehearsalActionRecord,
    corrected: RehearsalActionRecord["action"],
  ): Promise<RehearsalDecisionResult> {
    if (action.status !== "proposed" && action.status !== "blocked") {
      throw new RehearsalError(409, "action_not_proposed", "Only a proposed action can be corrected");
    }
    const blockReason = classifySubmitAttempt(corrected, null);
    if (blockReason !== null) {
      // The correction itself is a submission attempt: record it as blocked.
      const blocked: RehearsalActionRecord = { ...action, action: corrected, status: "blocked" };
      await runInTransaction(this.deps.database, async () => {
        await updateRehearsalAction(this.deps.db, action.id, {
          action: corrected,
          status: "blocked",
        });
      });
      this.deps.hub.publish(wsEnvelope("rehearsal.blocked", { action: blocked, reason: blockReason }));
      return { rehearsal, action: blocked };
    }

    // The user authored the replacement, so it carries full confidence.
    const correctedRecord: RehearsalActionRecord = {
      ...action,
      action: corrected,
      confidence: 1,
      status: "approved",
    };
    const updated = await this.resolveLowConfidencePause(rehearsal, async () => {
      await updateRehearsalAction(this.deps.db, action.id, {
        action: corrected,
        confidence: 1,
        status: "approved",
      });
    });
    this.deps.hub.publish(
      wsEnvelope("rehearsal.proposed", { action: correctedRecord, reasoning: "Corrected by the user before execution" }),
    );
    return { rehearsal: updated, action: correctedRecord };
  }

  private async handleReject(
    rehearsal: RehearsalRecord,
    action: RehearsalActionRecord,
  ): Promise<RehearsalDecisionResult> {
    if (action.status === "executed" || action.status === "rejected") {
      throw new RehearsalError(409, "action_not_proposed", "Only a pending action can be rejected");
    }
    const rejected: RehearsalActionRecord = { ...action, status: "rejected" };
    const updated = await this.resolveLowConfidencePause(rehearsal, async () => {
      await updateRehearsalAction(this.deps.db, action.id, { status: "rejected" });
    });
    return {
      rehearsal: await this.advanceToNextProposed(updated),
      action: rejected,
    };
  }

  /**
   * Run one decision write, then resume the rehearsal when the only thing
   * holding it paused was the low-confidence proposal the user just
   * decided on. User, interrupt and disconnect pauses demand resume.
   */
  private async resolveLowConfidencePause(
    rehearsal: RehearsalRecord,
    write: () => Promise<void>,
  ): Promise<RehearsalRecord> {
    const resolvesPause =
      rehearsal.status === "paused" && this.pauseReasons.get(rehearsal.id) === "low_confidence";
    await runInTransaction(this.deps.database, async () => {
      await write();
      if (resolvesPause) await updateRehearsal(this.deps.db, rehearsal.id, { status: "running" });
    });
    if (resolvesPause) this.pauseReasons.delete(rehearsal.id);
    return resolvesPause ? { ...rehearsal, status: "running" } : rehearsal;
  }

  /** Move the pointer to the next proposal, gate it, or complete the rehearsal. */
  private async advanceToNextProposed(rehearsal: RehearsalRecord): Promise<RehearsalRecord> {
    const actions = await listRehearsalActions(this.deps.db, rehearsal.id);
    const currentSequence = actions.find((action) => action.id === rehearsal.currentActionId)?.sequence ?? 0;
    const next = actions.find((action) => action.status === "proposed" && action.sequence > currentSequence);
    if (next) {
      await runInTransaction(this.deps.database, async () => {
        await updateRehearsal(this.deps.db, rehearsal.id, { currentActionId: next.id });
      });
      return this.gateCurrentAction({ ...rehearsal, currentActionId: next.id }, next);
    }

    // Nothing proposed remains, so the rehearsal ends even if it was paused.
    this.pauseReasons.delete(rehearsal.id);
    const completed: RehearsalRecord = { ...rehearsal, status: "completed", currentActionId: null };
    await runInTransaction(this.deps.database, async () => {
      await updateRehearsal(this.deps.db, rehearsal.id, { status: "completed", currentActionId: null });
    });
    return completed;
  }
}
