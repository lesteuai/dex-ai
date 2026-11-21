import { desc, eq } from "drizzle-orm";
import type { SessionDescriptor, SessionSummary } from "@dex-ai/shared";
import type { ControlPlaneDb } from "../db/client";
import { sessions } from "../db/schema";

type SessionRow = typeof sessions.$inferSelect;

export function toSessionSummary(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    browserKind: row.browserKind,
    // An empty source marks a session whose descriptor carried no URL.
    sourceUrl: row.source === "" ? null : row.source,
    postingUrl: row.postingUrl,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
  };
}

async function getSessionRow(db: ControlPlaneDb, id: string): Promise<SessionRow | null> {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
  return row ?? null;
}

export async function getSessionSummary(db: ControlPlaneDb, id: string): Promise<SessionSummary | null> {
  const row = await getSessionRow(db, id);
  return row ? toSessionSummary(row) : null;
}

/** Insert the session on first sight, refresh descriptor fields afterwards. */
export async function upsertSession(
  db: ControlPlaneDb,
  descriptor: SessionDescriptor,
  startedAt: Date,
): Promise<void> {
  const existing = await getSessionRow(db, descriptor.id);
  if (existing) {
    await db
      .update(sessions)
      .set({
        browserKind: descriptor.browserKind,
        source: descriptor.sourceUrl ?? existing.source,
        postingUrl: descriptor.postingUrl ?? existing.postingUrl,
      })
      .where(eq(sessions.id, descriptor.id));
    return;
  }
  await db
    .insert(sessions)
    .values({
      id: descriptor.id,
      browserKind: descriptor.browserKind,
      source: descriptor.sourceUrl ?? "",
      postingUrl: descriptor.postingUrl ?? null,
      status: "active",
      startedAt,
      endedAt: null,
    })
    .run();
}

export async function listSessions(db: ControlPlaneDb): Promise<SessionSummary[]> {
  const rows = await db.select().from(sessions).orderBy(desc(sessions.startedAt));
  return rows.map(toSessionSummary);
}
