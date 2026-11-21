import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  webUrlSchema,
  type EvaluationRecord,
  type RehearsalAction,
  type Rule,
  type SessionDescriptor,
  type Trace,
} from "@dex-ai/shared";
import type { AgentAdapter, AgentEvent, AgentStatus } from "../agent/adapter";
import { buildRehearsalPlanPrompt } from "../agent/prompts";
import { parseAgentResult, type RehearsalPlanResult } from "../agent/results";
import { runInTransaction, type ControlPlaneDb } from "../db/client";
import { evaluations } from "../db/schema";
import { listProfileEntries } from "../repositories/profile";
import { listRules } from "../repositories/rules";
import { getSessionSummary, upsertSession } from "../repositories/sessions";
import { finishAgentTask, insertAgentTask } from "../repositories/teaching";
import { insertTrace, listSessionTraces } from "../repositories/traces";

/** Typed failure the evaluations route maps onto an HTTP error response. */
export class FixtureEvaluationError extends Error {
  constructor(
    readonly code: "fixture_unreadable" | "agent_failed",
    message: string,
    readonly httpStatus: 500 | 502,
  ) {
    super(message);
  }
}

// Declared expectations for the held-out fixture session. The file is read on
// every run so editing it takes effect without a control-plane restart.
const EXPECTED_SESSION_URL = new URL("../../fixtures/job-site/expected-session.json", import.meta.url);

const expectedSessionFileSchema = z.strictObject({
  postingUrl: webUrlSchema,
  navigation: z.array(z.strictObject({ url: webUrlSchema })),
  fields: z.array(z.strictObject({ selector: z.string().min(1), value: z.string() })),
});

type ExpectedSession = z.infer<typeof expectedSessionFileSchema>;

function readExpectedSession(): ExpectedSession {
  try {
    return expectedSessionFileSchema.parse(JSON.parse(readFileSync(EXPECTED_SESSION_URL, "utf8")));
  } catch (error) {
    throw new FixtureEvaluationError(
      "fixture_unreadable",
      `Unreadable expected-session fixture: ${(error as Error).message}`,
      500,
    );
  }
}

// One stable held-out session carries every evaluation run's traces so repeat
// runs compare their errors against each other inside one timeline.
const FIXTURE_SESSION_ID = "6d5e4f3a-2b1c-4a8d-9e0f-1a2b3c4d5e6f";

async function ensureFixtureSession(db: ControlPlaneDb, expected: ExpectedSession): Promise<string> {
  const descriptor: SessionDescriptor = {
    id: FIXTURE_SESSION_ID,
    browserKind: "chrome",
    postingUrl: expected.postingUrl,
  };
  const existing = await getSessionSummary(db, descriptor.id);
  if (!existing) await upsertSession(db, descriptor, new Date());
  return descriptor.id;
}

export interface FixtureEvaluationErrorDetail {
  /** Stable key that identifies the same divergence across runs. */
  identity: string;
  kind: "navigation" | "field_value";
  message: string;
  expected: string | null;
  actual: string | null;
}

/** Only navigate and fill actions are compared; other kinds carry no declared expectation. */
function comparePlannedActions(
  expected: ExpectedSession,
  actions: RehearsalAction[],
): FixtureEvaluationErrorDetail[] {
  const errors: FixtureEvaluationErrorDetail[] = [];

  const plannedUrls = actions
    .filter((action): action is Extract<RehearsalAction, { kind: "navigate" }> => action.kind === "navigate")
    .map((action) => action.url);
  const expectedUrls = expected.navigation.map((step) => step.url);
  for (const url of expectedUrls) {
    if (!plannedUrls.includes(url)) {
      errors.push({
        identity: `navigate:${url}`,
        kind: "navigation",
        message: `Missing expected navigation to ${url}`,
        expected: url,
        actual: null,
      });
    }
  }
  for (const url of plannedUrls) {
    if (!expectedUrls.includes(url)) {
      errors.push({
        identity: `navigate:${url}`,
        kind: "navigation",
        message: `Unexpected navigation to ${url}`,
        expected: null,
        actual: url,
      });
    }
  }

  const fills = new Map<string, string>();
  for (const action of actions) {
    if (action.kind === "fill") fills.set(action.selector, action.value);
  }
  for (const field of expected.fields) {
    const planned = fills.get(field.selector);
    if (planned === undefined) {
      errors.push({
        identity: `field:${field.selector}`,
        kind: "field_value",
        message: `Missing expected fill of ${field.selector}`,
        expected: field.value,
        actual: null,
      });
    } else if (planned !== field.value) {
      errors.push({
        identity: `field:${field.selector}`,
        kind: "field_value",
        message: `Field ${field.selector} expects ${JSON.stringify(field.value)} but the plan fills ${JSON.stringify(planned)}`,
        expected: field.value,
        actual: planned,
      });
    }
  }
  for (const [selector, value] of fills) {
    if (!expected.fields.some((field) => field.selector === selector)) {
      errors.push({
        identity: `field:${selector}`,
        kind: "field_value",
        message: `Unexpected fill of ${selector}, not declared in the expected session`,
        expected: null,
        actual: value,
      });
    }
  }
  return errors;
}

function ruleMatchesFillSelector(rule: Rule, selector: string): boolean {
  const condition =
    typeof rule.condition === "object" && rule.condition !== null
      ? (rule.condition as Record<string, unknown>)
      : {};
  if (typeof condition.selector === "string") return condition.selector === selector;
  if (typeof condition.fieldLabelContains === "string") {
    return selector.toLowerCase().includes(condition.fieldLabelContains.toLowerCase());
  }
  return false;
}

/** Rules that shaped any planned fill, cited on the evaluation trace for correction propagation. */
function findContributingRuleIds(rules: Rule[], actions: RehearsalAction[]): string[] {
  const selectors = actions
    .filter((action): action is Extract<RehearsalAction, { kind: "fill" }> => action.kind === "fill")
    .map((action) => action.selector);
  return rules
    .filter((rule) => selectors.some((selector) => ruleMatchesFillSelector(rule, selector)))
    .map((rule) => rule.id);
}

const evaluationTraceOutputSchema = z.looseObject({
  kind: z.literal("fixture_evaluation"),
  errors: z.array(z.looseObject({ identity: z.string() })),
});

/** Error identities of the newest earlier evaluation run, skipped when absent. */
async function readPreviousErrorIdentities(db: ControlPlaneDb, sessionId: string): Promise<string[]> {
  const traces = await listSessionTraces(db, sessionId);
  for (const trace of [...traces].reverse()) {
    const parsed = evaluationTraceOutputSchema.safeParse(trace.output);
    if (parsed.success) return parsed.data.errors.map((error) => error.identity);
  }
  return [];
}

export interface ErrorClassCounts {
  errorsUnchanged: number;
  errorsCorrected: number;
  errorsNew: number;
}

function classifyErrorIdentities(current: string[], previous: string[]): ErrorClassCounts {
  const currentIdentities = new Set(current);
  const previousIdentities = new Set(previous);
  const errorsUnchanged = [...currentIdentities].filter((identity) =>
    previousIdentities.has(identity),
  ).length;
  const errorsNew = currentIdentities.size - errorsUnchanged;
  const errorsCorrected = [...previousIdentities].filter(
    (identity) => !currentIdentities.has(identity),
  ).length;
  return { errorsUnchanged, errorsCorrected, errorsNew };
}

interface PlannerTaskRun {
  status: AgentStatus;
  reasoning: string[];
  result: RehearsalPlanResult | null;
  failure: string | null;
}

async function runPlannerAgentTask(
  adapter: AgentAdapter,
  input: { taskId: string; sessionId: string; prompt: string; signal: AbortSignal },
): Promise<PlannerTaskRun> {
  const run: PlannerTaskRun = { status: "running", reasoning: [], result: null, failure: null };
  const stream = adapter.start({
    ...input,
    kind: "rehearsal_planning",
    resultSchema: "rehearsalPlan",
  });
  for await (const event of stream) {
    const agentEvent: AgentEvent = event;
    if (agentEvent.type === "reasoning") run.reasoning.push(agentEvent.text);
    else if (agentEvent.type === "result") {
      // Defensive parse: an invalid result is a task failure, never a stored value.
      run.result = parseAgentResult("rehearsalPlan", agentEvent.value) as RehearsalPlanResult;
    } else if (agentEvent.type === "error") run.failure = agentEvent.message;
    else run.status = agentEvent.status;
  }
  return run;
}

/** A failed run still leaves an inspectable task row and trace in the session. */
async function recordFailedPlannerTask(
  deps: FixtureEvaluationDeps,
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
      input: { kind: "fixture_evaluation" },
      reasoning: failure.message,
      output: { error: failure.message, reasoning: failure.reasoning },
      confidence: null,
      createdAt: now,
    });
  });
}

export interface FixtureEvaluationDeps {
  database: DatabaseSync;
  db: ControlPlaneDb;
  adapter: AgentAdapter;
}

export interface FixtureEvaluationWrite {
  evaluation: EvaluationRecord;
  /** Every divergence from the declared expectations, surfaced for correction. */
  errors: FixtureEvaluationErrorDetail[];
  trace: Trace;
}

/**
 * Run the held-out fixture evaluation: plan a rehearsal for the fixture
 * posting through the agent adapter, compare the proposed actions against the
 * declared expected navigation and field values, and record the run with
 * unchanged, corrected and new error counts against the previous run.
 */
export async function runFixtureEvaluation(
  deps: FixtureEvaluationDeps,
): Promise<FixtureEvaluationWrite> {
  const expected = readExpectedSession();
  const sessionId = await ensureFixtureSession(deps.db, expected);

  const prompt = buildRehearsalPlanPrompt({
    postingUrl: expected.postingUrl,
    entries: await listProfileEntries(deps.db),
    rules: await listRules(deps.db),
  });
  const taskId = randomUUID();
  await insertAgentTask(deps.db, {
    id: taskId,
    sessionId,
    kind: "rehearsal_planning",
    startedAt: new Date(),
  });
  const controller = new AbortController();
  const run = await runPlannerAgentTask(deps.adapter, {
    taskId,
    sessionId,
    prompt,
    signal: controller.signal,
  });

  if (!run.result) {
    const message =
      run.failure ?? `Agent task ended with status ${run.status} before producing a rehearsal plan`;
    await recordFailedPlannerTask(deps, { taskId, sessionId, reasoning: run.reasoning, message });
    throw new FixtureEvaluationError("agent_failed", message, 502);
  }
  const plan: RehearsalPlanResult = run.result;

  const actions = plan.actions.map((proposed) => proposed.action);
  const errors = comparePlannedActions(expected, actions);
  const contributingRuleIds = findContributingRuleIds(await listRules(deps.db), actions);
  const counts = classifyErrorIdentities(
    errors.map((error) => error.identity),
    await readPreviousErrorIdentities(deps.db, sessionId),
  );

  const now = new Date();
  const traceId = randomUUID();
  const evaluationId = randomUUID();
  const traceInput = {
    kind: "fixture_evaluation",
    postingUrl: expected.postingUrl,
    expectedNavigation: expected.navigation,
    expectedFields: expected.fields,
  };
  const traceOutput = {
    kind: "fixture_evaluation",
    postingUrl: expected.postingUrl,
    actions,
    contributingRuleIds,
    errors,
    ...counts,
  };
  const reasoning = [...run.reasoning, plan.reasoningTrace].join("\n");

  return runInTransaction(deps.database, async () => {
    await finishAgentTask(deps.db, taskId, { status: "completed", error: null });
    await insertTrace(deps.db, {
      id: traceId,
      taskId,
      sessionId,
      eventId: null,
      step: 0,
      input: traceInput,
      reasoning,
      output: traceOutput,
      confidence: null,
      createdAt: now,
    });
    await deps.db
      .insert(evaluations)
      .values({
        id: evaluationId,
        fixtureSessionId: sessionId,
        errorsUnchanged: counts.errorsUnchanged,
        errorsCorrected: counts.errorsCorrected,
        errorsNew: counts.errorsNew,
        createdAt: now,
      })
      .run();

    return {
      evaluation: {
        id: evaluationId,
        fixtureSessionId: sessionId,
        errorsUnchanged: counts.errorsUnchanged,
        errorsCorrected: counts.errorsCorrected,
        errorsNew: counts.errorsNew,
        createdAt: now.toISOString(),
      },
      errors,
      trace: {
        id: traceId,
        taskId,
        sessionId,
        eventId: null,
        step: 0,
        input: traceInput,
        reasoning,
        output: traceOutput,
        confidence: null,
        createdAt: now.toISOString(),
      },
    };
  });
}
