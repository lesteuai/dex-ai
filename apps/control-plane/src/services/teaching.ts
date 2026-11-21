import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ApplyTeachingRequest,
  ObservedEventEnvelope,
  SessionSummary,
  TeachingDraft,
  Trace,
} from "@dex-ai/shared";
import type { AgentAdapter } from "../agent/adapter";
import { buildTeachingPrompt } from "../agent/prompts";
import { parseAgentResult } from "../agent/results";
import { runInTransaction, type ControlPlaneDb } from "../db/client";
import { insertEvents } from "../repositories/events";
import { listRules } from "../repositories/rules";
import { getSessionSummary } from "../repositories/sessions";
import {
  finishAgentTask,
  getTeachingDraft,
  insertAgentTask,
  insertTeachingDraft,
  listTeachingDrafts,
  setTeachingDraftStatus,
} from "../repositories/teaching";
import { insertTrace } from "../repositories/traces";
import type { StreamHub } from "../stream/hub";

/** Typed failure the teaching route maps onto an HTTP error response. */
export class TeachingError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly error: string,
    message: string,
  ) {
    super(message);
  }
}

export interface TeachingServiceDeps {
  database: DatabaseSync;
  db: ControlPlaneDb;
  hub: StreamHub;
  adapter: AgentAdapter;
}

export interface CreateTeachingDraftInput {
  source: TeachingDraft["source"];
  transcript: string;
  sessionId: string | null;
}

export interface TeachingRunResult {
  taskId: string;
  eventId: string;
  status: "completed" | "failed" | "cancelled";
  draft: TeachingDraft | null;
  failureMessage: string | null;
}

/**
 * Teaching console backend: voice transcript drafts, typed teaching and the
 * teaching agent task that turns one confirmed transcript into rules.
 * A failed or cancelled task leaves the source draft pending for retry.
 */
export class TeachingService {
  private readonly runningTasks = new Map<string, AbortController>();

  constructor(private readonly deps: TeachingServiceDeps) {}

  async createDraft(input: CreateTeachingDraftInput): Promise<TeachingDraft> {
    if (input.sessionId) await this.requireSession(input.sessionId);
    const draft: TeachingDraft = {
      id: randomUUID(),
      source: input.source,
      transcript: input.transcript,
      status: "pending",
      sessionId: input.sessionId,
      createdAt: new Date().toISOString(),
    };
    await insertTeachingDraft(this.deps.db, {
      id: draft.id,
      source: draft.source,
      transcript: draft.transcript,
      status: draft.status,
      sessionId: draft.sessionId,
      createdAt: new Date(draft.createdAt),
    });
    return draft;
  }

  async listPendingDrafts(): Promise<TeachingDraft[]> {
    return listTeachingDrafts(this.deps.db, "pending");
  }

  async discardDraft(id: string): Promise<TeachingDraft> {
    const draft = await this.requirePendingDraft(id);
    const discarded = await setTeachingDraftStatus(this.deps.db, draft.id, "discarded");
    // The row exists, so the update cannot leave the draft missing.
    return discarded ?? draft;
  }

  /** Confirm or edit one draft, or apply typed teaching with no draft at all. */
  async applyTeaching(request: ApplyTeachingRequest): Promise<TeachingRunResult> {
    const draft = request.draftId ? await this.requirePendingDraft(request.draftId) : null;
    // A text sent with a draft id is the user's edit of the transcript.
    const transcript = request.text ?? draft?.transcript;
    if (transcript === undefined) {
      throw new TeachingError(400, "invalid_request", "Teaching needs a transcript");
    }
    const sessionId = request.sessionId ?? draft?.sessionId ?? null;
    if (sessionId === null) {
      throw new TeachingError(
        400,
        "invalid_request",
        "Teaching needs a session id from the request or from the draft",
      );
    }
    const session = await this.requireSession(sessionId);
    return this.runTeachingTask({ transcript, draft, session });
  }

  /** Abort a running teaching task; the adapter ends its stream as cancelled. */
  async cancelTeachingTask(taskId: string): Promise<boolean> {
    const controller = this.runningTasks.get(taskId);
    if (!controller) return false;
    controller.abort();
    await this.deps.adapter.cancel(taskId);
    return true;
  }

  private async requireSession(sessionId: string): Promise<SessionSummary> {
    const session = await getSessionSummary(this.deps.db, sessionId);
    if (!session) throw new TeachingError(404, "not_found", "Session does not exist");
    return session;
  }

  private async requirePendingDraft(id: string): Promise<TeachingDraft> {
    const draft = await getTeachingDraft(this.deps.db, id);
    if (!draft) throw new TeachingError(404, "not_found", "Teaching draft does not exist");
    if (draft.status !== "pending") {
      throw new TeachingError(409, "draft_not_pending", "Only a pending draft can be confirmed or discarded");
    }
    return draft;
  }

  private async runTeachingTask(input: {
    transcript: string;
    draft: TeachingDraft | null;
    session: SessionSummary;
  }): Promise<TeachingRunResult> {
    const { transcript, draft, session } = input;
    const sessionId = session.id;
    const eventId = randomUUID();
    const taskId = randomUUID();
    const traceId = randomUUID();
    const startedAt = new Date();

    // The confirmed transcript becomes one reason_stated event on the timeline.
    const envelope: ObservedEventEnvelope = {
      type: "reason_stated",
      id: eventId,
      ts: startedAt.toISOString(),
      payload: { input: draft ? draft.source : "text", text: transcript },
    };
    await runInTransaction(this.deps.database, async () => {
      await insertEvents(this.deps.db, sessionId, [envelope]);
      await insertAgentTask(this.deps.db, { id: taskId, sessionId, kind: "teaching", startedAt });
    });
    this.publishSessionUpdated(session);
    this.deps.hub.publish({
      type: "trace.started",
      id: randomUUID(),
      ts: startedAt.toISOString(),
      payload: {
        trace: {
          id: traceId,
          taskId,
          sessionId,
          eventId,
          step: 0,
          reasoning: null,
          confidence: null,
          createdAt: startedAt.toISOString(),
        },
      },
    });

    const outcome = await this.consumeTeachingEvents({
      taskId,
      traceId,
      sessionId,
      transcript,
    });

    const finishedAt = new Date();
    const reasoning = outcome.reasoningLines.join("\n");
    const trace: Trace = {
      id: traceId,
      taskId,
      sessionId,
      eventId,
      step: 0,
      input: { transcript },
      reasoning,
      output: outcome.output,
      confidence: null,
      createdAt: finishedAt.toISOString(),
    };

    // The trace, the task row and the draft status change land atomically.
    let confirmedDraft: TeachingDraft | null = null;
    await runInTransaction(this.deps.database, async () => {
      await insertTrace(this.deps.db, {
        id: traceId,
        taskId,
        sessionId,
        eventId,
        step: 0,
        input: { transcript },
        reasoning,
        output: outcome.output,
        confidence: null,
        createdAt: finishedAt,
      });
      if (outcome.status === "completed") {
        await finishAgentTask(this.deps.db, taskId, { status: "completed", error: null });
        // A failed or cancelled task skips this, so the draft stays pending.
        if (draft) confirmedDraft = await setTeachingDraftStatus(this.deps.db, draft.id, "confirmed");
      } else {
        await finishAgentTask(this.deps.db, taskId, {
          status: outcome.status,
          error: outcome.failureMessage,
        });
      }
    });

    this.deps.hub.publish({
      type: "trace.completed",
      id: randomUUID(),
      ts: finishedAt.toISOString(),
      payload: { trace },
    });
    if (outcome.status === "failed") {
      this.deps.hub.publish({
        type: "task.failed",
        id: randomUUID(),
        ts: finishedAt.toISOString(),
        payload: { taskId, message: outcome.failureMessage ?? "The teaching task failed" },
      });
    }

    return {
      taskId,
      eventId,
      status: outcome.status,
      draft: confirmedDraft ?? draft,
      failureMessage: outcome.failureMessage,
    };
  }

  private async consumeTeachingEvents(input: {
    taskId: string;
    traceId: string;
    sessionId: string;
    transcript: string;
  }): Promise<{
    status: "completed" | "failed" | "cancelled";
    output: unknown;
    failureMessage: string | null;
    reasoningLines: string[];
  }> {
    const { taskId, traceId, transcript } = input;
    const controller = new AbortController();
    this.runningTasks.set(taskId, controller);
    const reasoningLines: string[] = [];
    let result: unknown = null;
    let failureMessage: string | null = null;
    let status: "completed" | "failed" | "cancelled" | null = null;

    // The prompt names existing rules so teaching refines them instead of duplicating.
    const prompt = buildTeachingPrompt({
      transcript,
      existingRules: await listRules(this.deps.db),
    });
    const stream = this.deps.adapter.start({
      taskId,
      kind: "teaching",
      sessionId: input.sessionId,
      prompt,
      resultSchema: "rules",
      signal: controller.signal,
    });

    try {
      for await (const event of stream) {
        if (event.type === "reasoning") {
          reasoningLines.push(event.text);
          this.deps.hub.publish({
            type: "trace.delta",
            id: randomUUID(),
            ts: new Date().toISOString(),
            payload: { traceId, text: event.text },
          });
        } else if (event.type === "result") {
          try {
            result = parseAgentResult("rules", event.value);
          } catch (error) {
            failureMessage ??= (error as Error).message;
          }
        } else if (event.type === "error") {
          failureMessage ??= event.message;
        } else if (event.type === "status" && event.status !== "running") {
          // A completed claim without a valid result is a failure.
          status = event.status === "completed" && (result === null || failureMessage !== null)
            ? "failed"
            : event.status;
          break;
        }
      }
    } finally {
      this.runningTasks.delete(taskId);
    }

    if (status === null) {
      status = "failed";
      failureMessage ??= "The agent task ended without a terminal status";
    }
    if (status === "failed" && failureMessage === null) {
      failureMessage = "The teaching task failed";
    }

    const output =
      status === "completed" ? result : status === "cancelled" ? { cancelled: true } : { error: failureMessage };
    return { status, output, failureMessage, reasoningLines };
  }

  private publishSessionUpdated(session: SessionSummary): void {
    this.deps.hub.publish({
      type: "session.updated",
      id: randomUUID(),
      ts: new Date().toISOString(),
      payload: { session },
    });
  }
}
