import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import { jobMatchRequestSchema } from "@dex-ai/shared";
import type { ControlPlaneDb } from "../db/client";
import { listProfileEntries } from "../repositories/profile";
import { scorePosting } from "../services/job-match";

/** POST /api/match scores posting text against the stored profile. */
export function createMatchRoute(deps: { db: ControlPlaneDb }): Hono<{ Bindings: HttpBindings }> {
  const match = new Hono<{ Bindings: HttpBindings }>();

  match.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_request", message: "Request body must be valid JSON" }, 400);
    }
    const request = jobMatchRequestSchema.safeParse(body);
    if (!request.success) {
      return c.json(
        {
          error: "invalid_request",
          message: "Invalid job match request",
          fieldErrors: z.flattenError(request.error).fieldErrors,
        },
        400,
      );
    }
    const entries = await listProfileEntries(deps.db);
    return c.json(scorePosting(request.data, entries));
  });

  return match;
}
