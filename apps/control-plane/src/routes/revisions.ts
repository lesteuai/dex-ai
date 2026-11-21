import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import { revisionsQuerySchema } from "@dex-ai/shared";
import type { ControlPlaneDb } from "../db/client";
import { listRevisions } from "../repositories/revisions";

export interface RevisionsRouteDeps {
  db: ControlPlaneDb;
}

/** GET /api/revisions returns the filterable revision history, newest first. */
export function createRevisionsRoute(deps: RevisionsRouteDeps): Hono<{ Bindings: HttpBindings }> {
  const revisions = new Hono<{ Bindings: HttpBindings }>();

  revisions.get("/", async (c) => {
    const query = revisionsQuerySchema.safeParse({
      entityType: c.req.query("entityType"),
      sessionId: c.req.query("sessionId"),
    });
    if (!query.success) {
      return c.json(
        {
          error: "invalid_request",
          message: "Invalid revision history query",
          fieldErrors: z.flattenError(query.error).fieldErrors,
        },
        400,
      );
    }
    return c.json({ revisions: await listRevisions(deps.db, query.data) });
  });

  return revisions;
}
