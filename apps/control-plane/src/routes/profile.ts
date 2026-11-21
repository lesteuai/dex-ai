import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import { envelopeIdSchema, patchProfileEntryRequestSchema, type WsEvent } from "@dex-ai/shared";
import type { AgentAdapter } from "../agent/adapter";
import type { ControlPlaneDb } from "../db/client";
import {
  applyProfileEntryCorrection,
  listProfileEntries,
  type ProfileEntryCorrection,
} from "../repositories/profile";
import { ProfileInferenceError, inferProfileForSession } from "../services/profile-inference";
import type { StreamHub } from "../stream/hub";

export interface ProfileRouteDeps {
  database: DatabaseSync;
  db: ControlPlaneDb;
  adapter: AgentAdapter;
  hub: StreamHub;
}

const inferenceRequestSchema = z.strictObject({ sessionId: envelopeIdSchema });

// The hub validates the envelope against the shared schema before fanout.
function wsEnvelope(type: WsEvent["type"], payload: unknown): WsEvent {
  return { type, id: randomUUID(), ts: new Date().toISOString(), payload } as WsEvent;
}

/** GET /api/profile lists entries, POST /api/profile/inference runs one inference, PATCH corrects. */
export function createProfileRoute(deps: ProfileRouteDeps): Hono<{ Bindings: HttpBindings }> {
  const profile = new Hono<{ Bindings: HttpBindings }>();

  profile.get("/", async (c) => c.json({ entries: await listProfileEntries(deps.db) }));

  profile.post("/inference", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_request", message: "Request body must be valid JSON" }, 400);
    }
    const request = inferenceRequestSchema.safeParse(body);
    if (!request.success) {
      return c.json(
        {
          error: "invalid_request",
          message: "Invalid profile inference request",
          fieldErrors: z.flattenError(request.error).fieldErrors,
        },
        400,
      );
    }

    try {
      const write = await inferProfileForSession(deps, request.data.sessionId);
      for (const trace of write.traces) {
        deps.hub.publish(wsEnvelope("trace.completed", { trace }));
      }
      for (const entry of write.entries) {
        deps.hub.publish(wsEnvelope("profile.updated", { entry }));
      }
      for (const revision of write.revisions) {
        deps.hub.publish(wsEnvelope("revision.created", { revision }));
      }
      return c.json({ entries: write.entries });
    } catch (error) {
      if (error instanceof ProfileInferenceError) {
        return c.json({ error: error.code, message: error.message }, error.httpStatus);
      }
      throw error;
    }
  });

  profile.patch("/:id", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_request", message: "Request body must be valid JSON" }, 400);
    }
    const request = patchProfileEntryRequestSchema.safeParse(body);
    if (!request.success) {
      return c.json(
        {
          error: "invalid_request",
          message: "Invalid profile entry correction",
          fieldErrors: z.flattenError(request.error).fieldErrors,
        },
        400,
      );
    }
    const { value, status, reason } = request.data;
    if (value === undefined && status === undefined) {
      return c.json(
        { error: "invalid_request", message: "Provide a value or status to correct" },
        400,
      );
    }

    const correction: ProfileEntryCorrection = {
      ...(value !== undefined ? { value } : {}),
      ...(status !== undefined ? { status } : {}),
      reason: reason ?? "User correction from the profile editor",
    };
    const corrected = await applyProfileEntryCorrection(
      deps.database,
      deps.db,
      c.req.param("id"),
      correction,
    );
    if (!corrected) {
      return c.json({ error: "not_found", message: "Profile entry does not exist" }, 404);
    }

    deps.hub.publish(wsEnvelope("profile.updated", { entry: corrected.after }));
    deps.hub.publish(wsEnvelope("revision.created", { revision: corrected.revision }));
    return c.json({ entry: corrected.after });
  });

  return profile;
}
