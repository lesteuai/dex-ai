import { and, asc, desc, eq } from "drizzle-orm";
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

/** Convert a constructed revision into the API shape without a database round trip. */
export function toApiRevision(revision: NewRevision): Revision {
  return {
    id: revision.id,
    entityType: revision.entityType,
    entityId: revision.entityId,
    sourceSessionId: revision.sourceSessionId,
    traceId: revision.traceId,
    actor: revision.actor,
    // A first-ever value has no prior value, so it is absent in the API shape.
    before: revision.before ?? undefined,
    after: revision.after,
    reason: revision.reason,
    createdAt: revision.createdAt.toISOString(),
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

export interface RevisionFilter {
  entityType?: string;
  sessionId?: string;
}

/** Revision history endpoint view: newest first, filterable by entity and session. */
export async function listRevisions(db: ControlPlaneDb, filter: RevisionFilter): Promise<Revision[]> {
  const conditions = [
    filter.entityType !== undefined ? eq(revisions.entityType, filter.entityType) : undefined,
    filter.sessionId !== undefined ? eq(revisions.sourceSessionId, filter.sessionId) : undefined,
  ];
  const rows = await db
    .select()
    .from(revisions)
    .where(and(...conditions))
    .orderBy(desc(revisions.createdAt), desc(revisions.id));
  return rows.map(toRevision);
}
