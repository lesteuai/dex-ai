import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import type { ControlPlaneDb } from "../db/client";
import { listSessions } from "../repositories/sessions";
import { buildSessionTimeline } from "../services/session-timeline";

export interface SessionsRouteDeps {
  db: ControlPlaneDb;
}

/** GET /api/sessions lists sessions, GET /api/sessions/:id returns the timeline. */
export function createSessionsRoute(deps: SessionsRouteDeps): Hono<{ Bindings: HttpBindings }> {
  const sessions = new Hono<{ Bindings: HttpBindings }>();

  sessions.get("/", async (c) => c.json({ sessions: await listSessions(deps.db) }));

  sessions.get("/:id", async (c) => {
    const timeline = await buildSessionTimeline(deps.db, c.req.param("id"));
    if (!timeline) {
      return c.json({ error: "not_found", message: "Session does not exist" }, 404);
    }
    return c.json(timeline);
  });

  return sessions;
}
