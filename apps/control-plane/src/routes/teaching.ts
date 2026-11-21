import type { DatabaseSync } from "node:sqlite";
import type { HttpBindings } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  applyTeachingRequestSchema,
  createTeachingDraftRequestSchema,
} from "@dex-ai/shared";
import type { AgentAdapter } from "../agent/adapter";
import type { ControlPlaneDb } from "../db/client";
import { TeachingError, TeachingService } from "../services/teaching";
import type { StreamHub } from "../stream/hub";

type TeachingContext = Context<{ Bindings: HttpBindings }>;

export interface TeachingRouteDeps {
  database: DatabaseSync;
  db: ControlPlaneDb;
  hub: StreamHub;
  adapter: AgentAdapter;
}

function teachingErrorResponse(c: TeachingContext, error: unknown): Response | Promise<Response> {
  if (error instanceof TeachingError) {
    return c.json({ error: error.error, message: error.message }, error.status);
  }
  // Unexpected failures surface as Hono's default 500.
  throw error;
}

async function parseRequestBody<T>(
  c: TeachingContext,
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
 * POST /api/teaching/drafts stores a voice or typed transcript for review,
 * GET /api/teaching/drafts lists pending drafts, and POST /api/teaching
 * confirms or edits a draft, or applies typed teaching directly.
 */
export function createTeachingRoute(deps: TeachingRouteDeps): Hono<{ Bindings: HttpBindings }> {
  const teaching = new Hono<{ Bindings: HttpBindings }>();
  const service = new TeachingService({
    database: deps.database,
    db: deps.db,
    hub: deps.hub,
    adapter: deps.adapter,
  });

  teaching.post("/drafts", async (c) => {
    try {
      const parsed = await parseRequestBody(c, createTeachingDraftRequestSchema);
      if ("response" in parsed) return parsed.response;
      const draft = await service.createDraft({
        source: parsed.data.source,
        transcript: parsed.data.transcript,
        sessionId: parsed.data.sessionId ?? null,
      });
      return c.json({ draft });
    } catch (error) {
      return teachingErrorResponse(c, error);
    }
  });

  teaching.get("/drafts", async (c) => c.json({ drafts: await service.listPendingDrafts() }));

  teaching.post("/drafts/:id/discard", async (c) => {
    try {
      return c.json({ draft: await service.discardDraft(c.req.param("id")) });
    } catch (error) {
      return teachingErrorResponse(c, error);
    }
  });

  teaching.post("/", async (c) => {
    try {
      const parsed = await parseRequestBody(c, applyTeachingRequestSchema);
      if ("response" in parsed) return parsed.response;
      const run = await service.applyTeaching(parsed.data);
      if (run.status === "failed") {
        // The draft stays pending so the user can retry the same transcript.
        return c.json(
          { error: "teaching_task_failed", message: run.failureMessage ?? "The teaching task failed" },
          502,
        );
      }
      return c.json({ taskId: run.taskId, status: run.status, eventId: run.eventId, draft: run.draft });
    } catch (error) {
      return teachingErrorResponse(c, error);
    }
  });

  teaching.post("/tasks/:taskId/cancel", async (c) => {
    const cancelled = await service.cancelTeachingTask(c.req.param("taskId"));
    if (!cancelled) {
      return c.json({ error: "not_found", message: "No running teaching task with that id" }, 404);
    }
    return c.json({ ok: true });
  });

  return teaching;
}
