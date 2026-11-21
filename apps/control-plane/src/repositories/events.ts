import type { DatabaseSync } from "node:sqlite";
import { asc, eq, inArray } from "drizzle-orm";
import type { ObservedEventEnvelope, SessionDescriptor } from "@dex-ai/shared";
import { runInTransaction, type ControlPlaneDb } from "../db/client";
import { events } from "../db/schema";
import { upsertSession } from "./sessions";

type EventRow = typeof events.$inferSelect;

export function toEventEnvelope(row: EventRow): ObservedEventEnvelope {
  return {
    type: row.type,
    id: row.id,
    ts: row.capturedAt.toISOString(),
    payload: row.payload,
  } as ObservedEventEnvelope;
}

function toEventRow(sessionId: string, envelope: ObservedEventEnvelope) {
  return {
    id: envelope.id,
    sessionId,
    type: envelope.type,
    capturedAt: new Date(envelope.ts),
    sourceUrl: envelope.payload.pageUrl ?? null,
    payload: envelope.payload,
    // The envelope ID is the dedupe key: replays collapse onto one row.
    dedupeKey: envelope.id,
  };
}

/** Store first-seen envelopes, count replays as duplicates, never store twice. */
export async function insertEvents(
  db: ControlPlaneDb,
  sessionId: string,
  envelopes: ObservedEventEnvelope[],
): Promise<{ accepted: number; duplicates: number }> {
  const existingRows = await db
    .select({ id: events.id })
    .from(events)
    .where(inArray(events.id, envelopes.map((envelope) => envelope.id)));
  const existingIds = new Set(existingRows.map((row) => row.id));

  const seenIds = new Set<string>();
  const freshRows: ReturnType<typeof toEventRow>[] = [];
  for (const envelope of envelopes) {
    if (existingIds.has(envelope.id) || seenIds.has(envelope.id)) continue;
    seenIds.add(envelope.id);
    freshRows.push(toEventRow(sessionId, envelope));
  }
  if (freshRows.length > 0) await db.insert(events).values(freshRows).run();
  return { accepted: freshRows.length, duplicates: envelopes.length - freshRows.length };
}

export async function listSessionEvents(
  db: ControlPlaneDb,
  sessionId: string,
): Promise<ObservedEventEnvelope[]> {
  const rows = await db
    .select()
    .from(events)
    .where(eq(events.sessionId, sessionId))
    .orderBy(asc(events.capturedAt), asc(events.id));
  return rows.map(toEventEnvelope);
}

/** Upsert the session and store its events in one atomic transaction. */
export async function storeEventBatch(
  database: DatabaseSync,
  db: ControlPlaneDb,
  descriptor: SessionDescriptor,
  envelopes: ObservedEventEnvelope[],
): Promise<{ accepted: number; duplicates: number }> {
  if (envelopes.length === 0) return { accepted: 0, duplicates: 0 };
  const earliestCapturedAt = new Date(
    Math.min(...envelopes.map((envelope) => Date.parse(envelope.ts))),
  );
  return runInTransaction(database, async () => {
    await upsertSession(db, descriptor, earliestCapturedAt);
    return insertEvents(db, descriptor.id, envelopes);
  });
}
