import { eq } from "drizzle-orm";
import type {
  RehearsalAction,
  RehearsalActionRecord,
  SessionTimelineItem,
  SessionSummary,
} from "@dex-ai/shared";
import type { ControlPlaneDb } from "../db/client";
import { rehearsalActions, rehearsals } from "../db/schema";
import { listSessionEvents } from "../repositories/events";
import { getSessionSummary } from "../repositories/sessions";
import { listSessionRevisions } from "../repositories/revisions";
import { listSessionTraces } from "../repositories/traces";

export interface SessionTimeline {
  session: SessionSummary;
  timeline: SessionTimelineItem[];
}

function toRehearsalActionRecord(row: {
  id: string;
  rehearsalId: string;
  sequence: number;
  kind: RehearsalAction["kind"];
  target: unknown;
  value: string | null;
  confidence: number;
  status: RehearsalActionRecord["status"];
  traceId: string | null;
  createdAt: Date;
}): RehearsalActionRecord {
  // The target JSON holds the kind-specific fields; fill keeps its value column.
  const target = (typeof row.target === "object" && row.target !== null ? row.target : {}) as Record<string, unknown>;
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

async function listSessionRehearsalActions(
  db: ControlPlaneDb,
  sessionId: string,
): Promise<RehearsalActionRecord[]> {
  const rows = await db
    .select({
      id: rehearsalActions.id,
      rehearsalId: rehearsalActions.rehearsalId,
      sequence: rehearsalActions.sequence,
      kind: rehearsalActions.kind,
      target: rehearsalActions.target,
      value: rehearsalActions.value,
      confidence: rehearsalActions.confidence,
      status: rehearsalActions.status,
      traceId: rehearsalActions.traceId,
      createdAt: rehearsalActions.createdAt,
    })
    .from(rehearsalActions)
    .innerJoin(rehearsals, eq(rehearsalActions.rehearsalId, rehearsals.id))
    .where(eq(rehearsals.sessionId, sessionId));
  return rows.map(toRehearsalActionRecord);
}

/** Chronological session view assembled from every stored activity kind. */
export async function buildSessionTimeline(
  db: ControlPlaneDb,
  sessionId: string,
): Promise<SessionTimeline | null> {
  const session = await getSessionSummary(db, sessionId);
  if (!session) return null;

  const entries: { anchor: number; sortId: string; item: SessionTimelineItem }[] = [];
  for (const event of await listSessionEvents(db, sessionId)) {
    entries.push({ anchor: Date.parse(event.ts), sortId: event.id, item: { kind: "event", event } });
  }
  for (const trace of await listSessionTraces(db, sessionId)) {
    entries.push({ anchor: Date.parse(trace.createdAt), sortId: trace.id, item: { kind: "trace", trace } });
  }
  for (const revision of await listSessionRevisions(db, sessionId)) {
    entries.push({
      anchor: Date.parse(revision.createdAt),
      sortId: revision.id,
      item: { kind: "revision", revision },
    });
  }
  for (const action of await listSessionRehearsalActions(db, sessionId)) {
    entries.push({
      anchor: Date.parse(action.createdAt),
      sortId: action.id,
      item: { kind: "rehearsal_action", action },
    });
  }

  entries.sort((a, b) => a.anchor - b.anchor || a.sortId.localeCompare(b.sortId));
  return { session, timeline: entries.map((entry) => entry.item) };
}
