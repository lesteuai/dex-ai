import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ProfileEntry, Revision } from "@dex-ai/shared";
import { entryStatusSchema } from "@dex-ai/shared";
import { runInTransaction, type ControlPlaneDb } from "../db/client";
import { profileEntries } from "../db/schema";
import { insertRevision, toApiRevision, type NewRevision } from "./revisions";

type ProfileEntryRow = typeof profileEntries.$inferSelect;

type EntryStatus = z.infer<typeof entryStatusSchema>;

export interface NewProfileEntry {
  id: string;
  section: string;
  key: string;
  value: unknown;
  confidence: number;
  status: EntryStatus;
  sourceEventIds: string[];
  updatedAt: Date;
}

export function toProfileEntry(row: ProfileEntryRow): ProfileEntry {
  return {
    id: row.id,
    section: row.section,
    key: row.key,
    value: row.value,
    confidence: row.confidence,
    status: row.status,
    sourceEventIds: row.sourceEventIds,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listProfileEntries(db: ControlPlaneDb): Promise<ProfileEntry[]> {
  const rows = await db
    .select()
    .from(profileEntries)
    .orderBy(asc(profileEntries.section), asc(profileEntries.key), asc(profileEntries.updatedAt));
  return rows.map(toProfileEntry);
}

export async function getProfileEntry(db: ControlPlaneDb, id: string): Promise<ProfileEntry | null> {
  const [row] = await db.select().from(profileEntries).where(eq(profileEntries.id, id));
  return row ? toProfileEntry(row) : null;
}

/** Inference is idempotent per section and key, so entries are matched by pair. */
export async function findProfileEntryByKey(
  db: ControlPlaneDb,
  section: string,
  key: string,
): Promise<ProfileEntry | null> {
  const [row] = await db
    .select()
    .from(profileEntries)
    .where(and(eq(profileEntries.section, section), eq(profileEntries.key, key)));
  return row ? toProfileEntry(row) : null;
}

export async function insertProfileEntry(db: ControlPlaneDb, entry: NewProfileEntry): Promise<void> {
  await db.insert(profileEntries).values(entry).run();
}

export async function updateProfileEntry(
  db: ControlPlaneDb,
  id: string,
  changes: Partial<Omit<NewProfileEntry, "id">>,
): Promise<void> {
  await db
    .update(profileEntries)
    .set(changes)
    .where(eq(profileEntries.id, id))
    .run();
}

export interface ProfileEntryCorrection {
  value?: unknown;
  status?: EntryStatus;
  reason: string;
}

export interface ProfileEntryCorrectionResult {
  before: ProfileEntry;
  after: ProfileEntry;
  revision: Revision;
}

/** Apply one user correction and its revision row in a single transaction. */
export async function applyProfileEntryCorrection(
  database: DatabaseSync,
  db: ControlPlaneDb,
  id: string,
  correction: ProfileEntryCorrection,
): Promise<ProfileEntryCorrectionResult | null> {
  const before = await getProfileEntry(db, id);
  if (!before) return null;

  const now = new Date();
  const after: ProfileEntry = {
    ...before,
    value: correction.value !== undefined ? correction.value : before.value,
    status: correction.status ?? "corrected",
    updatedAt: now.toISOString(),
  };

  return runInTransaction(database, async () => {
    await updateProfileEntry(db, id, {
      value: after.value,
      status: after.status,
      updatedAt: now,
    });
    const newRevision: NewRevision = {
      id: randomUUID(),
      entityType: "profile_entry",
      entityId: id,
      sourceSessionId: null,
      traceId: null,
      actor: "user",
      before,
      after,
      reason: correction.reason,
      createdAt: now,
    };
    await insertRevision(db, newRevision);
    return { before, after, revision: toApiRevision(newRevision) };
  });
}
