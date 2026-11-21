import { asc, eq } from "drizzle-orm";
import type { TeachingDraft } from "@dex-ai/shared";
import type { ControlPlaneDb } from "../db/client";
import { agentTasks, teachingDrafts } from "../db/schema";

type DraftRow = typeof teachingDrafts.$inferSelect;
type TaskRow = typeof agentTasks.$inferSelect;

// The DB source enum stores "typed" where the shared API contract says "text".
const toDbDraftSource = (source: TeachingDraft["source"]) =>
  source === "text" ? "typed" : source;
const toApiDraftSource = (source: DraftRow["source"]) =>
  source === "typed" ? "text" : source;

export function toTeachingDraft(row: DraftRow): TeachingDraft {
  return {
    id: row.id,
    source: toApiDraftSource(row.source),
    transcript: row.transcript,
    status: row.status,
    sessionId: row.sessionId,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface NewTeachingDraft {
  id: string;
  source: TeachingDraft["source"];
  transcript: string;
  status: TeachingDraft["status"];
  sessionId: string | null;
  createdAt: Date;
}

export async function insertTeachingDraft(
  db: ControlPlaneDb,
  draft: NewTeachingDraft,
): Promise<void> {
  await db
    .insert(teachingDrafts)
    .values({
      id: draft.id,
      source: toDbDraftSource(draft.source),
      transcript: draft.transcript,
      status: draft.status,
      sessionId: draft.sessionId,
      createdAt: draft.createdAt,
    })
    .run();
}

export async function getTeachingDraft(
  db: ControlPlaneDb,
  id: string,
): Promise<TeachingDraft | null> {
  const [row] = await db.select().from(teachingDrafts).where(eq(teachingDrafts.id, id));
  return row ? toTeachingDraft(row) : null;
}

export async function listTeachingDrafts(
  db: ControlPlaneDb,
  status: TeachingDraft["status"],
): Promise<TeachingDraft[]> {
  const rows = await db
    .select()
    .from(teachingDrafts)
    .where(eq(teachingDrafts.status, status))
    .orderBy(asc(teachingDrafts.createdAt), asc(teachingDrafts.id));
  return rows.map(toTeachingDraft);
}

export async function setTeachingDraftStatus(
  db: ControlPlaneDb,
  id: string,
  status: TeachingDraft["status"],
): Promise<TeachingDraft | null> {
  await db.update(teachingDrafts).set({ status }).where(eq(teachingDrafts.id, id)).run();
  return getTeachingDraft(db, id);
}

// Agent task rows are shared by every task kind; teaching is the first writer
// and later services reuse these two functions instead of new repositories.

export type AgentTaskKindValue = TaskRow["kind"];
export type AgentTaskStatusValue = TaskRow["status"];

export interface NewAgentTask {
  id: string;
  sessionId: string;
  kind: AgentTaskKindValue;
  startedAt: Date;
}

export async function insertAgentTask(db: ControlPlaneDb, task: NewAgentTask): Promise<void> {
  await db
    .insert(agentTasks)
    .values({
      id: task.id,
      sessionId: task.sessionId,
      kind: task.kind,
      status: "running",
      providerSessionId: null,
      model: null,
      startedAt: task.startedAt,
      finishedAt: null,
      error: null,
    })
    .run();
}

export async function finishAgentTask(
  db: ControlPlaneDb,
  id: string,
  outcome: { status: AgentTaskStatusValue; error: string | null },
): Promise<void> {
  await db
    .update(agentTasks)
    .set({ status: outcome.status, finishedAt: new Date(), error: outcome.error })
    .where(eq(agentTasks.id, id))
    .run();
}
