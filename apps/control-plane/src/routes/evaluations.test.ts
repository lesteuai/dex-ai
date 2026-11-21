import { Hono } from "hono";
import { evaluationRunResponseSchema, type RehearsalAction } from "@dex-ai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeterministicAgentAdapter } from "../agent/deterministic-adapter";
import { openTestDatabase, type TestDatabase } from "../test-server";
import { createEvaluationsRoute } from "./evaluations";

let testDb: TestDatabase;

beforeEach(async () => {
  testDb = await openTestDatabase();
});

afterEach(() => {
  testDb.dispose();
});

function mountEvaluationsRoute(adapter: DeterministicAgentAdapter): Hono {
  const app = new Hono();
  app.route("/api/evaluations", createEvaluationsRoute({
    database: testDb.database,
    db: testDb.db,
    adapter,
  }));
  return app;
}

async function runEvaluation(app: Hono): Promise<Response> {
  return app.request("/api/evaluations/run", { method: "POST" });
}

const NAVIGATE: RehearsalAction = {
  kind: "navigate",
  url: "http://127.0.0.1:8787/fixtures/job/apply.html",
};
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

const DIVERGENT_ACTIONS = [NAVIGATE, CORRECT_NAME_FILL, WRONG_EMAIL_FILL, UNEXPECTED_PHONE_FILL];
const CORRECTED_ACTIONS = [NAVIGATE, CORRECT_NAME_FILL, CORRECT_EMAIL_FILL];

describe("POST /api/evaluations/run", () => {
  it("returns the three error counters for one fixture evaluation run", async () => {
    const app = mountEvaluationsRoute(scriptedPlanAdapter(DIVERGENT_ACTIONS));

    const response = await runEvaluation(app);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { evaluation: Record<string, number> };
    expect(() => evaluationRunResponseSchema.parse(body)).not.toThrow();
    expect(body.evaluation).toMatchObject({
      errorsUnchanged: 0,
      errorsCorrected: 0,
      errorsNew: 2,
    });
  });

  it("shows measurable improvement across two runs against the same database", async () => {
    const baselineResponse = await runEvaluation(mountEvaluationsRoute(scriptedPlanAdapter(DIVERGENT_ACTIONS)));
    const baseline = ((await baselineResponse.json()) as { evaluation: Record<string, number> }).evaluation;

    const correctedResponse = await runEvaluation(
      mountEvaluationsRoute(scriptedPlanAdapter(CORRECTED_ACTIONS)),
    );
    const corrected = ((await correctedResponse.json()) as { evaluation: Record<string, number> }).evaluation;

    expect(baseline).toMatchObject({ errorsUnchanged: 0, errorsCorrected: 0, errorsNew: 2 });
    expect(corrected).toMatchObject({ errorsUnchanged: 0, errorsCorrected: 2, errorsNew: 0 });
    expect(corrected.errorsCorrected).toBeGreaterThan(baseline.errorsCorrected);
    expect(corrected.errorsNew).toBeLessThan(baseline.errorsNew);

    expect(
      testDb.database.prepare("SELECT COUNT(*) AS count FROM evaluations").get(),
    ).toEqual({ count: 2 });
  });

  it("returns 502 and stores no evaluation row when the planner fails", async () => {
    const adapter = new DeterministicAgentAdapter({
      rehearsalPlan: { reasoning: ["thinking"], result: {}, failWith: "the provider connection dropped" },
    });
    const app = mountEvaluationsRoute(adapter);

    const response = await runEvaluation(app);

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("agent_failed");
    expect(body.message).toBe("the provider connection dropped");
    expect(
      testDb.database.prepare("SELECT COUNT(*) AS count FROM evaluations").get(),
    ).toEqual({ count: 0 });
  });
});
