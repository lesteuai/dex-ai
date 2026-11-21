import { and, asc, eq } from "drizzle-orm";
import type { RehearsalAction, RehearsalActionRecord, RehearsalRecord } from "@dex-ai/shared";
import type { ControlPlaneDb } from "../db/client";
import { rehearsalActions, rehearsals } from "../db/schema";

type RehearsalRow = typeof rehearsals.$inferSelect;
type RehearsalActionRow = typeof rehearsalActions.$inferSelect;

export interface NewRehearsal {
  id: string;
  sessionId: string;
  postingUrl: string;
  browserKind: RehearsalRecord["browserKind"];
  status: RehearsalRecord["status"];
  confidenceThreshold: number;
  currentActionId: string | null;
  startedAt: Date;
}

export function toRehearsalRecord(row: RehearsalRow): RehearsalRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    postingUrl: row.postingUrl,
    browserKind: row.browserKind,
    status: row.status,
    confidenceThreshold: row.confidenceThreshold,
    currentActionId: row.currentActionId,
    startedAt: row.startedAt.toISOString(),
  };
}

/**
 * The target column holds the kind-specific fields; fill keeps its value in
 * the value column so the two never disagree.
 */
export function splitActionForStorage(action: RehearsalAction): {
  kind: RehearsalAction["kind"];
  target: Record<string, unknown>;
  value: string | null;
} {
  switch (action.kind) {
    case "navigate":
      return { kind: action.kind, target: { url: action.url }, value: null };
    case "focus":
    case "click_non_submit":
      return { kind: action.kind, target: { selector: action.selector }, value: null };
    case "fill":
      return { kind: action.kind, target: { selector: action.selector }, value: action.value };
    case "scroll":
      return {
        kind: action.kind,
        target:
          action.selector === undefined
            ? { deltaY: action.deltaY }
            : { selector: action.selector, deltaY: action.deltaY },
        value: null,
      };
    case "wait":
      return { kind: action.kind, target: { durationMs: action.durationMs }, value: null };
  }
}

export function toRehearsalActionRecord(row: RehearsalActionRow): RehearsalActionRecord {
  const target = (typeof row.target === "object" && row.target !== null ? row.target : {}) as Record<
    string,
    unknown
  >;
  const action = {
    kind: row.kind,
    ...target,
    ...(row.value !== null ? { value: row.value } : {}),
  } as RehearsalAction;
  return {
    id: row.id,
    rehearsalId: row.rehearsalId,
    sequence: row.sequence,
    action,
    confidence: row.confidence,
    status: row.status,
    traceId: row.traceId,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function insertRehearsal(db: ControlPlaneDb, rehearsal: NewRehearsal): Promise<void> {
  await db.insert(rehearsals).values(rehearsal).run();
}

export async function getRehearsalRecord(db: ControlPlaneDb, id: string): Promise<RehearsalRecord | null> {
  const [row] = await db.select().from(rehearsals).where(eq(rehearsals.id, id));
  return row ? toRehearsalRecord(row) : null;
}

export async function updateRehearsal(
  db: ControlPlaneDb,
  id: string,
  changes: { status?: RehearsalRecord["status"]; currentActionId?: string | null },
): Promise<void> {
  await db.update(rehearsals).set(changes).where(eq(rehearsals.id, id)).run();
}

export interface NewRehearsalAction {
  id: string;
  rehearsalId: string;
  sequence: number;
  action: RehearsalAction;
  confidence: number;
  status: RehearsalActionRecord["status"];
  traceId: string | null;
  createdAt: Date;
}

export async function insertRehearsalAction(db: ControlPlaneDb, action: NewRehearsalAction): Promise<void> {
  const stored = splitActionForStorage(action.action);
  await db
    .insert(rehearsalActions)
    .values({
      id: action.id,
      rehearsalId: action.rehearsalId,
      sequence: action.sequence,
      kind: stored.kind,
      target: stored.target,
      value: stored.value,
      confidence: action.confidence,
      status: action.status,
      traceId: action.traceId,
      createdAt: action.createdAt,
    })
    .run();
}

export async function getRehearsalActionRecord(
  db: ControlPlaneDb,
  id: string,
): Promise<RehearsalActionRecord | null> {
  const [row] = await db.select().from(rehearsalActions).where(eq(rehearsalActions.id, id));
  return row ? toRehearsalActionRecord(row) : null;
}

export async function listRehearsalActions(
  db: ControlPlaneDb,
  rehearsalId: string,
): Promise<RehearsalActionRecord[]> {
  const rows = await db
    .select()
    .from(rehearsalActions)
    .where(eq(rehearsalActions.rehearsalId, rehearsalId))
    .orderBy(asc(rehearsalActions.sequence));
  return rows.map(toRehearsalActionRecord);
}

export interface RehearsalActionChanges {
  action?: RehearsalAction;
  status?: RehearsalActionRecord["status"];
  confidence?: number;
  traceId?: string | null;
}

export async function updateRehearsalAction(
  db: ControlPlaneDb,
  id: string,
  changes: RehearsalActionChanges,
): Promise<void> {
  const stored = changes.action === undefined ? null : splitActionForStorage(changes.action);
  await db
    .update(rehearsalActions)
    .set({
      ...(stored === null ? {} : { kind: stored.kind, target: stored.target, value: stored.value }),
      ...(changes.status === undefined ? {} : { status: changes.status }),
      ...(changes.confidence === undefined ? {} : { confidence: changes.confidence }),
      ...(changes.traceId === undefined ? {} : { traceId: changes.traceId }),
    })
    .where(eq(rehearsalActions.id, id))
    .run();
}

/** A replan discards every action the user never decided on. */
export async function deleteProposedRehearsalActions(db: ControlPlaneDb, rehearsalId: string): Promise<void> {
  await db
    .delete(rehearsalActions)
    .where(and(eq(rehearsalActions.rehearsalId, rehearsalId), eq(rehearsalActions.status, "proposed")))
    .run();
}
