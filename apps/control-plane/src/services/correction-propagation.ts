import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { RehearsalAction, Revision, Rule, Trace } from "@dex-ai/shared";
import type { AgentAdapter, AgentEvent, AgentStatus } from "../agent/adapter";
import { buildCorrectionPropagationPrompt } from "../agent/prompts";
import { parseAgentResult, type CorrectionResult } from "../agent/results";
import { runInTransaction, type ControlPlaneDb } from "../db/client";
import { getRule, updateRule } from "../repositories/rules";
import { insertRevision, toApiRevision, type NewRevision } from "../repositories/revisions";
import { getSessionSummary } from "../repositories/sessions";
import { finishAgentTask, insertAgentTask } from "../repositories/teaching";
import { insertTrace, listSessionTraces } from "../repositories/traces";

/** Typed failure the caller maps onto an HTTP error response. */
export class CorrectionPropagationError extends Error {
  constructor(
    readonly code: "session_not_found" | "trace_not_found" | "unknown_rule_update" | "agent_failed",
    message: string,
    readonly httpStatus: 404 | 502,
  ) {
    super(message);
  }
}

// Decision traces declare the stored rules that shaped them through this key.
const traceContributionSchema = z.looseObject({
  contributingRuleIds: z.array(z.string()),
});

/** Read the rule ids a decision trace cites, treating any other output as none. */
export function readContributingRuleIds(traceOutput: unknown): string[] {
  const parsed = traceContributionSchema.safeParse(traceOutput);
  return parsed.success ? parsed.data.contributingRuleIds : [];
}

export interface CorrectionPropagationDeps {
  database: DatabaseSync;
  db: ControlPlaneDb;
  adapter: AgentAdapter;
}

export interface CorrectionPropagationInput {
  sessionId: string;
  /** Trace of the corrected decision; null falls back to the session's latest trace. */
  traceId: string | null;
  priorAction: RehearsalAction;
  correctedAction: RehearsalAction;
  correctionReason: string;
}

export interface CorrectionPropagationWrite {
  trace: Trace;
  updatedRules: Rule[];
  revisions: Revision[];
}

async function resolveDecisionTrace(
  db: ControlPlaneDb,
  sessionId: string,
  traceId: string | null,
): Promise<Trace> {
  const traces = await listSessionTraces(db, sessionId);
  if (traceId !== null) {
    const trace = traces.find((candidate) => candidate.id === traceId);
    if (!trace) {
      throw new CorrectionPropagationError(
        "trace_not_found",
        "Decision trace does not exist in this session",
        404,
      );
    }
    return trace;
  }
  const latest = traces.at(-1);
  if (!latest) {
    throw new CorrectionPropagationError(
      "trace_not_found",
      "The session has no decision trace to correct",
      404,
    );
  }
  return latest;
}

interface CorrectionTaskRun {
  status: AgentStatus;
  reasoning: string[];
  result: CorrectionResult | null;
  failure: string | null;
}

async function runCorrectionAgentTask(
  adapter: AgentAdapter,
  input: { taskId: string; sessionId: string; prompt: string; signal: AbortSignal },
): Promise<CorrectionTaskRun> {
  const run: CorrectionTaskRun = { status: "running", reasoning: [], result: null, failure: null };
  const stream = adapter.start({
    ...input,
    kind: "correction_propagation",
    resultSchema: "correction",
  });
  for await (const event of stream) {
    const agentEvent: AgentEvent = event;
    if (agentEvent.type === "reasoning") run.reasoning.push(agentEvent.text);
    else if (agentEvent.type === "result") {
      // Defensive parse: an invalid result is a task failure, never a stored value.
      run.result = parseAgentResult("correction", agentEvent.value) as CorrectionResult;
    } else if (agentEvent.type === "error") run.failure = agentEvent.message;
    else run.status = agentEvent.status;
  }
  return run;
}

/** A failed run still leaves an inspectable task row and trace in the session. */
async function recordFailedCorrectionTask(
  deps: CorrectionPropagationDeps,
  failure: { taskId: string; sessionId: string; reasoning: string[]; message: string },
): Promise<void> {
  const now = new Date();
  await runInTransaction(deps.database, async () => {
    await finishAgentTask(deps.db, failure.taskId, { status: "failed", error: failure.message });
    await insertTrace(deps.db, {
      id: randomUUID(),
      taskId: failure.taskId,
      sessionId: failure.sessionId,
      eventId: null,
      step: 0,
      input: { kind: "correction_propagation" },
      reasoning: failure.message,
      output: { error: failure.message, reasoning: failure.reasoning },
      confidence: null,
      createdAt: now,
    });
  });
}

/**
 * Apply one user correction to every stored rule that contributed to the
 * corrected decision. Each affected rule gets its own revision entry linked
 * to the correction trace and the session that caused it. Updated rules live
 * in the rules table, which every later planning and teaching prompt reads,
 * so the correction reaches the next similar session without extra wiring.
 */
export async function propagateCorrection(
  deps: CorrectionPropagationDeps,
  input: CorrectionPropagationInput,
): Promise<CorrectionPropagationWrite> {
  const session = await getSessionSummary(deps.db, input.sessionId);
  if (!session) {
    throw new CorrectionPropagationError("session_not_found", "Session does not exist", 404);
  }
  const decisionTrace = await resolveDecisionTrace(deps.db, input.sessionId, input.traceId);

  const contributingRules: Rule[] = [];
  for (const ruleId of readContributingRuleIds(decisionTrace.output)) {
    const rule = await getRule(deps.db, ruleId);
    // A cited rule may have been deleted since the decision; skip it.
    if (rule) contributingRules.push(rule);
  }

  const taskId = randomUUID();
  await insertAgentTask(deps.db, {
    id: taskId,
    sessionId: input.sessionId,
    kind: "correction_propagation",
    startedAt: new Date(),
  });
  const prompt = buildCorrectionPropagationPrompt({
    priorAction: input.priorAction,
    correctedAction: input.correctedAction,
    correctionReason: input.correctionReason,
    contributingRules,
  });
  const controller = new AbortController();
  const run = await runCorrectionAgentTask(deps.adapter, {
    taskId,
    sessionId: input.sessionId,
    prompt,
    signal: controller.signal,
  });

  if (!run.result) {
    const message =
      run.failure ?? `Agent task ended with status ${run.status} before producing rule updates`;
    await recordFailedCorrectionTask(deps, {
      taskId,
      sessionId: input.sessionId,
      reasoning: run.reasoning,
      message,
    });
    throw new CorrectionPropagationError("agent_failed", message, 502);
  }
  const result: CorrectionResult = run.result;

  // An update naming a rule outside the contributing set is fabricated.
  const contributingById = new Map(contributingRules.map((rule) => [rule.id, rule]));
  const unknownUpdate = result.ruleUpdates.find((update) => !contributingById.has(update.ruleId));
  if (unknownUpdate) {
    const message = `Rule update cites ${unknownUpdate.ruleId}, which did not contribute to the corrected decision`;
    await recordFailedCorrectionTask(deps, {
      taskId,
      sessionId: input.sessionId,
      reasoning: run.reasoning,
      message,
    });
    throw new CorrectionPropagationError("unknown_rule_update", message, 502);
  }

  const now = new Date();
  const traceId = randomUUID();
  const reasoning = [...run.reasoning, result.reasoningTrace].join("\n");
  const traceInput = {
    priorAction: input.priorAction,
    correctedAction: input.correctedAction,
    correctionReason: input.correctionReason,
  };
  const traceOutput = {
    contributingRuleIds: contributingRules.map((rule) => rule.id),
    ruleUpdates: result.ruleUpdates,
  };
  const trace: Trace = {
    id: traceId,
    taskId,
    sessionId: input.sessionId,
    eventId: null,
    step: 0,
    input: traceInput,
    reasoning,
    output: traceOutput,
    confidence: null,
    createdAt: now.toISOString(),
  };

  return runInTransaction(deps.database, async () => {
    await finishAgentTask(deps.db, taskId, { status: "completed", error: null });
    await insertTrace(deps.db, {
      id: traceId,
      taskId,
      sessionId: input.sessionId,
      eventId: null,
      step: 0,
      input: traceInput,
      reasoning,
      output: traceOutput,
      confidence: null,
      createdAt: now,
    });

    const write: CorrectionPropagationWrite = { trace, updatedRules: [], revisions: [] };
    for (const update of result.ruleUpdates) {
      const before = contributingById.get(update.ruleId);
      if (!before) continue;
      const after: Rule = {
        ...before,
        condition: update.condition,
        action: update.action,
        confidence: update.confidence,
        // A propagated correction makes the rule authoritative for future decisions.
        status: "corrected",
        updatedAt: now.toISOString(),
      };
      await updateRule(deps.db, before.id, {
        condition: after.condition,
        action: after.action,
        confidence: after.confidence,
        status: after.status,
        updatedAt: now,
      });
      const newRevision: NewRevision = {
        id: randomUUID(),
        entityType: "rule",
        entityId: before.id,
        sourceSessionId: input.sessionId,
        traceId,
        actor: "agent",
        before,
        after,
        reason: update.changeReason,
        createdAt: now,
      };
      await insertRevision(deps.db, newRevision);
      write.updatedRules.push(after);
      write.revisions.push(toApiRevision(newRevision));
    }
    return write;
  });
}
