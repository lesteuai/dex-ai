import { asc, eq } from "drizzle-orm";
import type { Trace } from "@dex-ai/shared";
import type { ControlPlaneDb } from "../db/client";
import { traces } from "../db/schema";

type TraceRow = typeof traces.$inferSelect;

export interface NewTrace {
  id: string;
  taskId: string | null;
  sessionId: string;
  eventId: string | null;
  step: number;
  input: unknown;
  reasoning: string;
  output: unknown;
  confidence: number | null;
  createdAt: Date;
}

export function toTrace(row: TraceRow): Trace {
  return {
    id: row.id,
    taskId: row.taskId,
    sessionId: row.sessionId,
    eventId: row.eventId,
    // The column stores text; the API contract reports a step number.
    step: Number(row.step),
    input: row.input,
    reasoning: row.reasoning,
    output: row.output,
    confidence: row.confidence,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function insertTrace(db: ControlPlaneDb, trace: NewTrace): Promise<void> {
  await db
    .insert(traces)
    .values({ ...trace, step: String(trace.step) })
    .run();
}

export async function listSessionTraces(db: ControlPlaneDb, sessionId: string): Promise<Trace[]> {
  const rows = await db
    .select()
    .from(traces)
    .where(eq(traces.sessionId, sessionId))
    .orderBy(asc(traces.createdAt), asc(traces.id));
  return rows.map(toTrace);
}
