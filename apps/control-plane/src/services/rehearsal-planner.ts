import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  rehearsalBlockReasonSchema,
  webUrlSchema,
  type RehearsalAction,
  type Trace,
} from "@dex-ai/shared";
import type { AgentAdapter, AgentEvent } from "../agent/adapter";
import { buildRehearsalPlanPrompt } from "../agent/prompts";
import { parseAgentResult, type RehearsalPlanResult } from "../agent/results";
import { runInTransaction, type ControlPlaneDb } from "../db/client";
import { listProfileEntries } from "../repositories/profile";
import { listRules } from "../repositories/rules";
import { finishAgentTask, insertAgentTask } from "../repositories/teaching";
import { insertTrace } from "../repositories/traces";
import type { StreamHub } from "../stream/hub";

/**
 * Page snapshot captured by the extension for the posting under rehearsal.
 * It is the ground truth for which controls exist and which of them submit.
 */

export const pageSnapshotFieldSchema = z.strictObject({
  selector: z.string().min(1),
  label: z.string().optional(),
  fieldType: z.string().optional(),
  // The extension marks controls that would submit the managed form.
  submits: z.boolean().optional(),
});

export const pageSnapshotSchema = z.strictObject({
  url: webUrlSchema,
  title: z.string().optional(),
  fields: z.array(pageSnapshotFieldSchema).max(200),
  links: z.array(z.strictObject({ selector: z.string().min(1), url: webUrlSchema })).max(200).optional(),
});

export type PageSnapshot = z.infer<typeof pageSnapshotSchema>;
export type RehearsalBlockReason = z.infer<typeof rehearsalBlockReasonSchema>;

const SUBMIT_PATTERN = /submit/i;

/**
 * Classify an action that would submit the application. The shared action
 * vocabulary has no submit kind, so this catches the submit-shaped
 * navigation and controls a plan or a user correction can still reach for.
 */
export function classifySubmitAttempt(
  action: RehearsalAction,
  snapshot: PageSnapshot | null,
): RehearsalBlockReason | null {
  if (action.kind === "navigate") {
    return SUBMIT_PATTERN.test(action.url) ? "submit_navigation" : null;
  }
  if (action.kind === "scroll" || action.kind === "wait") return null;
  if (SUBMIT_PATTERN.test(action.selector)) {
    return action.kind === "click_non_submit" ? "submit_activation" : "submit_control";
  }
  // A field the snapshot itself marks as a submit control blocks every
  // interaction with it, whatever its selector says.
  const markedSubmit =
    snapshot?.fields.some((field) => field.selector === action.selector && field.submits === true) ?? false;
  if (!markedSubmit) return null;
  return action.kind === "click_non_submit" ? "submit_activation" : "submit_control";
}

export interface PlannedAction {
  action: RehearsalAction;
  confidence: number;
  reasoning: string;
  blockReason: RehearsalBlockReason | null;
}

export interface RehearsalPlanOutcome {
  taskId: string;
  traceId: string;
  reasoningTrace: string;
  actions: PlannedAction[];
}

/** Typed planning failure the rehearsal controller maps onto HTTP 502. */
export class RehearsalPlannerError extends Error {}

export interface RehearsalPlannerDeps {
  database: DatabaseSync;
  db: ControlPlaneDb;
  hub: StreamHub;
  adapter: AgentAdapter;
}

interface PlannerRun {
  result: RehearsalPlanResult | null;
  failureMessage: string | null;
  reasoningLines: string[];
}

async function consumePlannerEvents(
  deps: RehearsalPlannerDeps,
  input: { taskId: string; traceId: string; sessionId: string; prompt: string },
): Promise<PlannerRun> {
  const run: PlannerRun = { result: null, failureMessage: null, reasoningLines: [] };
  // Planning has no cancel endpoint, but the adapter contract requires a signal.
  const controller = new AbortController();
  const stream = deps.adapter.start({
    taskId: input.taskId,
    kind: "rehearsal_planning",
    sessionId: input.sessionId,
    prompt: input.prompt,
    resultSchema: "rehearsalPlan",
    signal: controller.signal,
  });

  for await (const event of stream) {
    const agentEvent: AgentEvent = event;
    if (agentEvent.type === "reasoning") {
      run.reasoningLines.push(agentEvent.text);
      deps.hub.publish({
        type: "trace.delta",
        id: randomUUID(),
        ts: new Date().toISOString(),
        payload: { traceId: input.traceId, text: agentEvent.text },
      });
    } else if (agentEvent.type === "result") {
      // An invalid plan is a task failure, never a stored rehearsal action.
      try {
        run.result = parseAgentResult("rehearsalPlan", agentEvent.value) as RehearsalPlanResult;
      } catch (error) {
        run.failureMessage ??= (error as Error).message;
      }
    } else if (agentEvent.type === "error") {
      run.failureMessage ??= agentEvent.message;
    } else if (agentEvent.type === "status" && agentEvent.status !== "running") {
      if (agentEvent.status === "completed" && (run.result === null || run.failureMessage !== null)) {
        run.failureMessage ??= "The planning task completed without a valid rehearsal plan";
      } else if (agentEvent.status === "cancelled") {
        run.failureMessage ??= "The rehearsal planning task was cancelled";
      }
      break;
    }
  }
  return run;
}

/**
 * Run one rehearsal planning task through the agent adapter. The plan,
 * its trace and the task row are recorded even when the task fails, and a
 * failed task throws RehearsalPlannerError instead of returning a plan.
 */
export async function planRehearsal(
  deps: RehearsalPlannerDeps,
  input: { sessionId: string; postingUrl: string; snapshot: PageSnapshot | null },
): Promise<RehearsalPlanOutcome> {
  const taskId = randomUUID();
  const traceId = randomUUID();
  const startedAt = new Date();
  const prompt = buildRehearsalPlanPrompt({
    postingUrl: input.postingUrl,
    entries: await listProfileEntries(deps.db),
    rules: await listRules(deps.db),
    ...(input.snapshot ? { snapshot: input.snapshot } : {}),
  });

  await runInTransaction(deps.database, async () => {
    await insertAgentTask(deps.db, {
      id: taskId,
      sessionId: input.sessionId,
      kind: "rehearsal_planning",
      startedAt,
    });
  });
  deps.hub.publish({
    type: "trace.started",
    id: randomUUID(),
    ts: startedAt.toISOString(),
    payload: {
      trace: {
        id: traceId,
        taskId,
        sessionId: input.sessionId,
        eventId: null,
        step: 0,
        reasoning: null,
        confidence: null,
        createdAt: startedAt.toISOString(),
      },
    },
  });

  const run = await consumePlannerEvents(deps, { taskId, traceId, sessionId: input.sessionId, prompt });

  const finishedAt = new Date();
  const reasoning = run.reasoningLines.join("\n");
  const result = run.result;
  const output = result === null
    ? { error: run.failureMessage }
    : { postingUrl: result.postingUrl, reasoningTrace: result.reasoningTrace, actions: result.actions };
  const traceInput = {
    postingUrl: input.postingUrl,
    ...(input.snapshot ? { snapshot: input.snapshot } : {}),
  };
  const trace: Trace = {
    id: traceId,
    taskId,
    sessionId: input.sessionId,
    eventId: null,
    step: 0,
    input: traceInput,
    reasoning,
    output,
    confidence: null,
    createdAt: finishedAt.toISOString(),
  };

  await runInTransaction(deps.database, async () => {
    await insertTrace(deps.db, {
      id: traceId,
      taskId,
      sessionId: input.sessionId,
      eventId: null,
      step: 0,
      input: traceInput,
      reasoning,
      output,
      confidence: null,
      createdAt: finishedAt,
    });
    await finishAgentTask(deps.db, taskId, {
      status: result === null ? "failed" : "completed",
      error: result === null ? run.failureMessage : null,
    });
  });
  deps.hub.publish({
    type: "trace.completed",
    id: randomUUID(),
    ts: finishedAt.toISOString(),
    payload: { trace },
  });

  if (result === null) {
    deps.hub.publish({
      type: "task.failed",
      id: randomUUID(),
      ts: finishedAt.toISOString(),
      payload: { taskId, message: run.failureMessage ?? "The rehearsal planning task failed" },
    });
    throw new RehearsalPlannerError(run.failureMessage ?? "The rehearsal planning task failed");
  }

  return {
    taskId,
    traceId,
    reasoningTrace: result.reasoningTrace,
    actions: result.actions.map((candidate) => ({
      action: candidate.action,
      confidence: candidate.confidence,
      reasoning: candidate.reasoning,
      // The shared schema already excludes a submit kind; classification
      // catches the submit-shaped attempts that remain within the vocabulary.
      blockReason: classifySubmitAttempt(candidate.action, input.snapshot),
    })),
  };
}
