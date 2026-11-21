import type { DatabaseSync } from "node:sqlite";
import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import type { AgentAdapter } from "../agent/adapter";
import type { ControlPlaneDb } from "../db/client";
import { FixtureEvaluationError, runFixtureEvaluation } from "../services/evaluation";

export interface EvaluationsRouteDeps {
  database: DatabaseSync;
  db: ControlPlaneDb;
  adapter: AgentAdapter;
}

/**
 * POST /api/evaluations/run replays the held-out fixture session through the
 * planner and reports unchanged, corrected and new decision errors.
 */
export function createEvaluationsRoute(deps: EvaluationsRouteDeps): Hono<{ Bindings: HttpBindings }> {
  const evaluations = new Hono<{ Bindings: HttpBindings }>();

  evaluations.post("/run", async (c) => {
    try {
      const write = await runFixtureEvaluation({
        database: deps.database,
        db: deps.db,
        adapter: deps.adapter,
      });
      return c.json({ evaluation: write.evaluation });
    } catch (error) {
      if (error instanceof FixtureEvaluationError) {
        return c.json({ error: error.code, message: error.message }, error.httpStatus);
      }
      // Unexpected failures surface as Hono's default 500.
      throw error;
    }
  });

  return evaluations;
}
