import type { DatabaseSync } from "node:sqlite";
import type { HttpBindings } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  rehearsalDecisionRequestSchema,
  startRehearsalRequestSchema,
  webUrlSchema,
} from "@dex-ai/shared";
import type { AgentAdapter } from "../agent/adapter";
import type { ControlPlaneDb } from "../db/client";
import { pageSnapshotSchema } from "../services/rehearsal-planner";
import { RehearsalController, RehearsalError } from "../services/rehearsal-controller";
import type { StreamHub } from "../stream/hub";

type RehearsalsContext = Context<{ Bindings: HttpBindings }>;

export interface RehearsalsRouteDeps {
  database: DatabaseSync;
  db: ControlPlaneDb;
  hub: StreamHub;
  adapter: AgentAdapter;
  /** Config default; the start request can override it per rehearsal. */
  confidenceThreshold: number;
}

// The extension guard reports which submit path it refused, so each reason
// carries exactly the locator of the attempt.
const blockedAttemptRequestSchema = z.discriminatedUnion("reason", [
  z.strictObject({ reason: z.literal("submit_navigation"), url: webUrlSchema }),
  z.strictObject({ reason: z.literal("submit_control"), selector: z.string().min(1) }),
  z.strictObject({ reason: z.literal("submit_activation"), selector: z.string().min(1) }),
]);

function rehearsalsErrorResponse(c: RehearsalsContext, error: unknown): Response | Promise<Response> {
  if (error instanceof RehearsalError) {
    return c.json({ error: error.error, message: error.message }, error.status);
  }
  // Unexpected failures surface as Hono's default 500.
  throw error;
}

async function parseRequestBody<T>(
  c: RehearsalsContext,
  schema: z.ZodType<T>,
): Promise<{ data: T } | { response: Response }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return {
      response: c.json({ error: "invalid_request", message: "Request body must be valid JSON" }, 400),
    };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const { formErrors, fieldErrors } = z.flattenError(parsed.error as z.ZodError);
    return {
      response: c.json(
        {
          error: "invalid_request",
          message: formErrors[0] ?? "Invalid request body",
          fieldErrors,
        },
        400,
      ),
    };
  }
  return { data: parsed.data };
}

/**
 * POST /api/rehearsals starts a rehearsal, GET /:id inspects it, and
 * POST /:id/decisions approves, corrects, rejects, pauses or resumes it.
 * The snapshot, blocked-attempt, disconnect and execution endpoints carry
 * the extension side of the flow.
 */
export function createRehearsalsRoute(deps: RehearsalsRouteDeps): Hono<{ Bindings: HttpBindings }> {
  const rehearsals = new Hono<{ Bindings: HttpBindings }>();
  const controller = new RehearsalController({
    database: deps.database,
    db: deps.db,
    hub: deps.hub,
    adapter: deps.adapter,
    defaultConfidenceThreshold: deps.confidenceThreshold,
  });

  rehearsals.post("/", async (c) => {
    try {
      const parsed = await parseRequestBody(c, startRehearsalRequestSchema);
      if ("response" in parsed) return parsed.response;
      const started = await controller.startRehearsal(parsed.data);
      return c.json({ rehearsal: started.rehearsal });
    } catch (error) {
      return rehearsalsErrorResponse(c, error);
    }
  });

  rehearsals.get("/:id", async (c) => {
    const view = await controller.getRehearsal(c.req.param("id"));
    if (!view) {
      return c.json({ error: "not_found", message: "Rehearsal does not exist" }, 404);
    }
    return c.json(view);
  });

  rehearsals.post("/:id/decisions", async (c) => {
    try {
      const parsed = await parseRequestBody(c, rehearsalDecisionRequestSchema);
      if ("response" in parsed) return parsed.response;
      const decided = await controller.applyDecision(c.req.param("id"), parsed.data);
      return c.json({ rehearsal: decided.rehearsal });
    } catch (error) {
      return rehearsalsErrorResponse(c, error);
    }
  });

  rehearsals.post("/:id/snapshot", async (c) => {
    try {
      const parsed = await parseRequestBody(c, pageSnapshotSchema);
      if ("response" in parsed) return parsed.response;
      return c.json(await controller.acceptPageSnapshot(c.req.param("id"), parsed.data));
    } catch (error) {
      return rehearsalsErrorResponse(c, error);
    }
  });

  rehearsals.post("/:id/blocked-attempts", async (c) => {
    try {
      const parsed = await parseRequestBody(c, blockedAttemptRequestSchema);
      if ("response" in parsed) return parsed.response;
      const recorded = await controller.recordBlockedAttempt(c.req.param("id"), parsed.data);
      return c.json({ rehearsal: recorded.rehearsal, action: recorded.action });
    } catch (error) {
      return rehearsalsErrorResponse(c, error);
    }
  });

  rehearsals.post("/:id/disconnect", async (c) => {
    try {
      const paused = await controller.markDisconnected(c.req.param("id"));
      return c.json({ rehearsal: paused.rehearsal });
    } catch (error) {
      return rehearsalsErrorResponse(c, error);
    }
  });

  rehearsals.post("/:id/actions/:actionId/executed", async (c) => {
    try {
      const executed = await controller.reportExecuted(c.req.param("id"), c.req.param("actionId"));
      return c.json({ rehearsal: executed.rehearsal, action: executed.action });
    } catch (error) {
      return rehearsalsErrorResponse(c, error);
    }
  });

  return rehearsals;
}
