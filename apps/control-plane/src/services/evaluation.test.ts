import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RehearsalAction } from "@dex-ai/shared";
import { DeterministicAgentAdapter } from "../agent/deterministic-adapter";
import { insertRule } from "../repositories/rules";
import { listSessionTraces } from "../repositories/traces";
import { openTestDatabase, type TestDatabase } from "../test-server";
import {
  FixtureEvaluationError,
  runFixtureEvaluation,
  type FixtureEvaluationDeps,
} from "./evaluation";

let testDb: TestDatabase;

beforeEach(async () => {
  testDb = await openTestDatabase();
});

afterEach(() => {
  testDb.dispose();
});

function evaluationDeps(adapter: DeterministicAgentAdapter): FixtureEvaluationDeps {
  return { database: testDb.database, db: testDb.db, adapter };
}

const APPLY_URL = "http://127.0.0.1:8787/fixtures/job/apply.html";

function scriptedPlanAdapter(actions: RehearsalAction[]): DeterministicAgentAdapter {
  return new DeterministicAgentAdapter({
    rehearsalPlan: {
      reasoning: ["Scripted fixture planning reasoning."],
      result: {
        postingUrl: "http://127.0.0.1:8787/fixtures/job/posting.html",
        reasoningTrace: "Scripted plan for the held-out fixture session.",
        actions: actions.map((action) => ({
          action,
          confidence: 0.9,
          reasoning: "Scripted action reasoning.",
        })),
      },
    },
  });
}

const NAVIGATE: RehearsalAction = { kind: "navigate", url: APPLY_URL };
const CORRECT_NAME_FILL: RehearsalAction = { kind: "fill", selector: "#full-name", value: "Jordan Lee" };
const CORRECT_EMAIL_FILL: RehearsalAction = {
  kind: "fill",
  selector: "#email",
  value: "jordan.lee@example.com",
};
const WRONG_EMAIL_FILL: RehearsalAction = {
  kind: "fill",
  selector: "#email",
  value: "wrong-address@example.net",
};
const UNEXPECTED_PHONE_FILL: RehearsalAction = { kind: "fill", selector: "#phone", value: "555-0100" };
const UNEXPECTED_COVER_LETTER_FILL: RehearsalAction = {
  kind: "fill",
  selector: "#cover-letter",
  value: "Dear team",
};

// Divergent baseline: wrong email value plus an undeclared phone fill.
const BASELINE_ACTIONS = [NAVIGATE, CORRECT_NAME_FILL, WRONG_EMAIL_FILL, UNEXPECTED_PHONE_FILL];
// Post-correction: email fixed, phone error unchanged, one new error added.
const PARTIALLY_CORRECTED_ACTIONS = [
  NAVIGATE,
  CORRECT_NAME_FILL,
  CORRECT_EMAIL_FILL,
  UNEXPECTED_PHONE_FILL,
  UNEXPECTED_COVER_LETTER_FILL,
];
// Fully corrected: exactly the declared navigation and field values.
const CLEAN_ACTIONS = [NAVIGATE, CORRECT_NAME_FILL, CORRECT_EMAIL_FILL];

async function seedRuleMatching(selector: string): Promise<string> {
  const id = randomUUID();
  await insertRule(testDb.db, {
    id,
    scope: "rehearsal.fill",
    condition: { selector },
    action: { fillValueFrom: "profile.wrong_source" },
    confidence: 0.8,
    status: "confirmed",
    sourceSessionId: null,
    contributingRuleIds: [],
    updatedAt: new Date(),
  });
  return id;
}

async function fixtureSessionId(): Promise<string> {
  const row = testDb.database.prepare("SELECT id FROM sessions").get() as { id: string };
  return row.id;
}

function evaluationRows(): Array<Record<string, number>> {
  return testDb.database
    .prepare("SELECT errors_unchanged, errors_corrected, errors_new FROM evaluations")
    .all() as Array<Record<string, number>>;
}

describe("runFixtureEvaluation", () => {
  it("surfaces every divergence with details and stores the baseline counters", async () => {
    const emailRuleId = await seedRuleMatching("#email");
    const phoneRuleId = await seedRuleMatching("#phone");

    const write = await runFixtureEvaluation(evaluationDeps(scriptedPlanAdapter(BASELINE_ACTIONS)));

    expect(write.errors.map((error) => error.identity)).toEqual(["field:#email", "field:#phone"]);
    expect(write.errors.find((error) => error.identity === "field:#email")).toMatchObject({
      kind: "field_value",
      expected: "jordan.lee@example.com",
      actual: "wrong-address@example.net",
    });
    expect(write.errors.find((error) => error.identity === "field:#phone")).toMatchObject({
      kind: "field_value",
      expected: null,
      actual: "555-0100",
    });
    // First run has no previous run, so both divergences count as new.
    expect(write.evaluation).toMatchObject({
      errorsUnchanged: 0,
      errorsCorrected: 0,
      errorsNew: 2,
    });

    // The divergence is recorded on the trace, with the contributing rules
    // cited for correction, instead of being silently accepted.
    const sessionId = await fixtureSessionId();
    expect(write.trace.sessionId).toBe(sessionId);
    expect(write.evaluation.fixtureSessionId).toBe(sessionId);
    expect(write.trace.output).toMatchObject({
      kind: "fixture_evaluation",
      errors: [{ identity: "field:#email" }, { identity: "field:#phone" }],
    });
    const output = write.trace.output as { contributingRuleIds: string[] };
    expect(output.contributingRuleIds.sort()).toEqual([emailRuleId, phoneRuleId].sort());

    expect(evaluationRows()).toEqual([{ errors_unchanged: 0, errors_corrected: 0, errors_new: 2 }]);
    expect(await listSessionTraces(testDb.db, sessionId)).toHaveLength(1);
  });

  it("distinguishes unchanged, corrected and new errors and reaches a lower count", async () => {
    await runFixtureEvaluation(evaluationDeps(scriptedPlanAdapter(BASELINE_ACTIONS)));

    const second = await runFixtureEvaluation(
      evaluationDeps(scriptedPlanAdapter(PARTIALLY_CORRECTED_ACTIONS)),
    );
    expect(second.errors.map((error) => error.identity)).toEqual([
      "field:#phone",
      "field:#cover-letter",
    ]);
    expect(second.evaluation).toMatchObject({
      errorsUnchanged: 1,
      errorsCorrected: 1,
      errorsNew: 1,
    });

    // After full teaching the repeatable run reports no uncorrected errors.
    const third = await runFixtureEvaluation(evaluationDeps(scriptedPlanAdapter(CLEAN_ACTIONS)));
    expect(third.errors).toEqual([]);
    expect(third.evaluation).toMatchObject({
      errorsUnchanged: 0,
      errorsCorrected: 2,
      errorsNew: 0,
    });

    // Every run shares one held-out fixture session and leaves its own row.
    const sessionId = await fixtureSessionId();
    expect(second.evaluation.fixtureSessionId).toBe(sessionId);
    expect(third.evaluation.fixtureSessionId).toBe(sessionId);
    expect(await listSessionTraces(testDb.db, sessionId)).toHaveLength(3);
    expect(evaluationRows()).toEqual([
      { errors_unchanged: 0, errors_corrected: 0, errors_new: 2 },
      { errors_unchanged: 1, errors_corrected: 1, errors_new: 1 },
      { errors_unchanged: 0, errors_corrected: 2, errors_new: 0 },
    ]);
  });

  it("records a failed trace and leaves no evaluation row when the planner fails", async () => {
    const adapter = new DeterministicAgentAdapter({
      rehearsalPlan: { reasoning: ["thinking"], result: {}, failWith: "the provider connection dropped" },
    });

    await expect(runFixtureEvaluation(evaluationDeps(adapter))).rejects.toMatchObject({
      code: "agent_failed",
      httpStatus: 502,
    } satisfies Partial<FixtureEvaluationError>);

    expect(
      testDb.database.prepare("SELECT kind, status, error FROM agent_tasks").all(),
    ).toEqual([{ kind: "rehearsal_planning", status: "failed", error: "the provider connection dropped" }]);
    const sessionId = await fixtureSessionId();
    const traces = await listSessionTraces(testDb.db, sessionId);
    expect(traces).toHaveLength(1);
    expect(traces[0].output).toMatchObject({ error: "the provider connection dropped" });
    expect(evaluationRows()).toEqual([]);
  });

  it("treats a fabricated plan result as a failure with no evaluation row", async () => {
    // The action vocabulary has no submit kind, so this result is fabricated.
    const adapter = new DeterministicAgentAdapter({
      rehearsalPlan: {
        reasoning: ["thinking"],
        result: {
          postingUrl: "http://127.0.0.1:8787/fixtures/job/posting.html",
          reasoningTrace: "Fabricated plan.",
          actions: [
            {
              action: { kind: "submit", selector: "#apply" },
              confidence: 0.9,
              reasoning: "Fabricated submit action.",
            },
          ],
        },
      },
    });

    await expect(runFixtureEvaluation(evaluationDeps(adapter))).rejects.toMatchObject({
      code: "agent_failed",
      httpStatus: 502,
    } satisfies Partial<FixtureEvaluationError>);

    expect(
      testDb.database.prepare("SELECT kind, status, error FROM agent_tasks").all(),
    ).toEqual([
      {
        kind: "rehearsal_planning",
        status: "failed",
        error: expect.stringContaining("failed validation"),
      },
    ]);
    const sessionId = await fixtureSessionId();
    const traces = await listSessionTraces(testDb.db, sessionId);
    expect(traces).toHaveLength(1);
    expect(traces[0].output).toMatchObject({ error: expect.stringContaining("failed validation") });
    expect(evaluationRows()).toEqual([]);
  });
});
