import { asc, eq } from "drizzle-orm";
import type { Revision } from "@dex-ai/shared";
import type { ControlPlaneDb } from "../db/client";
import { revisions } from "../db/schema";

type RevisionRow = typeof revisions.$inferSelect;

export interface NewRevision {
  id: string;
  entityType: string;
  entityId: string;
  sourceSessionId: string | null;
  traceId: string | null;
  actor: "agent" | "user";
  before: unknown;
  after: unknown;
  reason: string;
  createdAt: Date;
}

export function toRevision(row: RevisionRow): Revision {
  return {
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    sourceSessionId: row.sourceSessionId,
    traceId: row.traceId,
    actor: row.actor,
    before: row.before,
    after: row.after,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function insertRevision(db: ControlPlaneDb, revision: NewRevision): Promise<void> {
  await db
    .insert(revisions)
    .values({ ...revision, before: revision.before ?? null })
    .run();
}

export async function listSessionRevisions(
  db: ControlPlaneDb,
  sessionId: string,
): Promise<Revision[]> {
  const rows = await db
    .select()
    .from(revisions)
    .where(eq(revisions.sourceSessionId, sessionId))
    .orderBy(asc(revisions.createdAt), asc(revisions.id));
  return rows.map(toRevision);
}
