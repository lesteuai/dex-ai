import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import {
  observedEventEnvelopeSchema,
  sessionDescriptorSchema,
  type BatchRejection,
  type ObservedEventEnvelope,
} from "@dex-ai/shared";
import type { ControlPlaneDb } from "../db/client";
import { storeEventBatch } from "../repositories/events";
import { getSessionSummary } from "../repositories/sessions";
import type { StreamHub } from "../stream/hub";

export interface EventsRouteDeps {
  database: DatabaseSync;
  db: ControlPlaneDb;
  hub: StreamHub;
}

// Envelope payloads are validated per item so one malformed envelope reports
// its own field errors instead of failing the whole batch.
const batchShapeSchema = z.strictObject({
  session: sessionDescriptorSchema,
  events: z.array(z.unknown()).min(1).max(200),
});

function readEnvelopeId(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || !("id" in raw)) return null;
  return typeof raw.id === "string" ? raw.id : null;
}

/** POST /api/events/batches stores a validated event batch for one session. */
export function createEventsRoute(deps: EventsRouteDeps): Hono<{ Bindings: HttpBindings }> {
  const events = new Hono<{ Bindings: HttpBindings }>();

  events.post("/batches", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_request", message: "Request body must be valid JSON" }, 400);
    }

    const batch = batchShapeSchema.safeParse(body);
    if (!batch.success) {
      return c.json(
        {
          error: "invalid_request",
          message: "Invalid event batch request",
          fieldErrors: z.flattenError(batch.error).fieldErrors,
        },
        400,
      );
    }

    const rejected: BatchRejection[] = [];
    const envelopes: ObservedEventEnvelope[] = [];
    batch.data.events.forEach((rawEvent, index) => {
      const parsed = observedEventEnvelopeSchema.safeParse(rawEvent);
      if (parsed.success) envelopes.push(parsed.data);
      else {
        const { formErrors, fieldErrors } = z.flattenError(parsed.error);
        rejected.push({ index, id: readEnvelopeId(rawEvent), formErrors, fieldErrors });
      }
    });

    const stored =
      envelopes.length > 0
        ? await storeEventBatch(deps.database, deps.db, batch.data.session, envelopes)
        : { accepted: 0, duplicates: 0 };

    // A duplicate-only replay changes no timeline data, so no live update for it.
    const session =
      stored.accepted > 0 ? await getSessionSummary(deps.db, batch.data.session.id) : null;
    if (session) {
      deps.hub.publish({
        type: "session.updated",
        id: randomUUID(),
        ts: new Date().toISOString(),
        payload: { session },
      });
    }

    return c.json({
      sessionId: batch.data.session.id,
      accepted: stored.accepted,
      duplicates: stored.duplicates,
      rejected,
    });
  });

  return events;
}
