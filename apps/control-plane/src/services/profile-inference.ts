import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ProfileEntry, Revision, Trace } from "@dex-ai/shared";
import type { AgentAdapter, AgentEvent, AgentStatus } from "../agent/adapter";
import { buildProfileInferencePrompt } from "../agent/prompts";
import { parseAgentResult, type ProfileResult } from "../agent/results";
import { runInTransaction, type ControlPlaneDb } from "../db/client";
import { agentTasks } from "../db/schema";
import { listSessionEvents } from "../repositories/events";
import { getSessionSummary } from "../repositories/sessions";
import {
  findProfileEntryByKey,
  insertProfileEntry,
  listProfileEntries,
  updateProfileEntry,
  type NewProfileEntry,
} from "../repositories/profile";
import { insertRevision, toApiRevision, type NewRevision } from "../repositories/revisions";
import { insertTrace } from "../repositories/traces";

/** Terminal agent failures surface as HTTP errors the profile route translates. */
export class ProfileInferenceError extends Error {
  constructor(
    readonly code: "session_not_found" | "agent_failed",
    message: string,
    readonly httpStatus: 404 | 502,
  ) {
    super(message);
  }
}

export interface ProfileInferenceDeps {
  database: DatabaseSync;
  db: ControlPlaneDb;
  adapter: AgentAdapter;
}

export interface ProfileInferenceWrite {
  entries: ProfileEntry[];
  traces: Trace[];
  revisions: Revision[];
}

interface AgentTaskRun {
  status: AgentStatus;
  reasoning: string[];
  result: ProfileResult | null;
  failure: string | null;
}

async function runProfileAgentTask(
  adapter: AgentAdapter,
  input: { taskId: string; sessionId: string; prompt: string; signal: AbortSignal },
): Promise<AgentTaskRun> {
  const run: AgentTaskRun = { status: "running", reasoning: [], result: null, failure: null };
  const stream = adapter.start({ ...input, kind: "profile_inference", resultSchema: "profile" });
  for await (const event of stream) {
    const agentEvent: AgentEvent = event;
    if (agentEvent.type === "reasoning") run.reasoning.push(agentEvent.text);
    else if (agentEvent.type === "result") {
      // Defensive parse: an invalid result is a task failure, never a stored value.
      run.result = parseAgentResult("profile", agentEvent.value) as ProfileResult;
    } else if (agentEvent.type === "error") run.failure = agentEvent.message;
    else run.status = agentEvent.status;
  }
  return run;
}

async function insertAgentTask(
  db: ControlPlaneDb,
  task: {
    id: string;
    sessionId: string;
    status: "completed" | "failed";
    startedAt: Date;
    finishedAt: Date;
    error?: string | null;
  },
): Promise<void> {
  await db
    .insert(agentTasks)
    .values({ ...task, kind: "profile_inference", error: task.error ?? null })
    .run();
}

/** A failed run still leaves an inspectable task row and trace in the session. */
async function recordFailedTask(
  deps: ProfileInferenceDeps,
  failure: {
    taskId: string;
    sessionId: string;
    reasoning: string[];
    message: string;
  },
): Promise<void> {
  const now = new Date();
  await runInTransaction(deps.database, async () => {
    await insertAgentTask(deps.db, {
      id: failure.taskId,
      sessionId: failure.sessionId,
      status: "failed",
      startedAt: now,
      finishedAt: now,
      error: failure.message,
    });
    await insertTrace(deps.db, {
      id: randomUUID(),
      taskId: failure.taskId,
      sessionId: failure.sessionId,
      eventId: null,
      step: 0,
      input: { kind: "profile_inference" },
      reasoning: failure.message,
      output: { error: failure.message, reasoning: failure.reasoning },
      confidence: null,
      createdAt: now,
    });
  });
}

/**
 * Run profile inference for one stored session through the agent adapter.
 * Every supported entry, its trace and its revision are written in one
 * transaction; unsupported sections stay empty.
 */
export async function inferProfileForSession(
  deps: ProfileInferenceDeps,
  sessionId: string,
): Promise<ProfileInferenceWrite> {
  const session = await getSessionSummary(deps.db, sessionId);
  if (!session) {
    throw new ProfileInferenceError("session_not_found", "Session does not exist", 404);
  }

  const events = await listSessionEvents(deps.db, sessionId);
  const prompt = buildProfileInferencePrompt({
    sessionId,
    events,
    existingEntries: await listProfileEntries(deps.db),
  });

  const taskId = randomUUID();
  const controller = new AbortController();
  const run = await runProfileAgentTask(deps.adapter, {
    taskId,
    sessionId,
    prompt,
    signal: controller.signal,
  });

  if (!run.result) {
    const message =
      run.failure ?? `Agent task ended with status ${run.status} before producing a profile`;
    await recordFailedTask(deps, { taskId, sessionId, reasoning: run.reasoning, message });
    throw new ProfileInferenceError("agent_failed", message, 502);
  }
  const result: ProfileResult = run.result;

  // An entry citing events this session never stored is fabrication, not inference.
  const storedEventIds = new Set(events.map((event) => event.id));
  const now = new Date();

  return runInTransaction(deps.database, async () => {
    await insertAgentTask(deps.db, {
      id: taskId,
      sessionId,
      status: "completed",
      startedAt: now,
      finishedAt: now,
    });

    const write: ProfileInferenceWrite = { entries: [], traces: [], revisions: [] };
    let step = 0;
    for (const section of result.sections) {
      for (const proposed of section.entries) {
        if (!proposed.sourceEventIds.every((id) => storedEventIds.has(id))) continue;

        const previous = await findProfileEntryByKey(deps.db, section.section, proposed.key);
        // An explicit user correction takes precedence over new inference.
        if (previous?.status === "corrected") continue;

        const record: NewProfileEntry = {
          id: previous?.id ?? randomUUID(),
          section: section.section,
          key: proposed.key,
          value: proposed.value,
          confidence: proposed.confidence,
          status: "inferred",
          sourceEventIds: proposed.sourceEventIds,
          updatedAt: now,
        };
        const entry: ProfileEntry = { ...record, updatedAt: now.toISOString() };

        if (previous) {
          await updateProfileEntry(deps.db, entry.id, {
            value: record.value,
            confidence: record.confidence,
            status: record.status,
            sourceEventIds: record.sourceEventIds,
            updatedAt: now,
          });
        } else {
          await insertProfileEntry(deps.db, record);
        }

        const traceRecord = {
          id: randomUUID(),
          taskId,
          sessionId,
          eventId: entry.sourceEventIds[0] ?? null,
          step,
          input: { section: entry.section, key: entry.key, sourceEventIds: entry.sourceEventIds },
          reasoning: proposed.reasoningTrace,
          output: { value: entry.value, confidence: entry.confidence },
          confidence: entry.confidence,
          createdAt: now,
        };
        await insertTrace(deps.db, traceRecord);
        const trace: Trace = { ...traceRecord, createdAt: now.toISOString() };

        const newRevision: NewRevision = {
          id: randomUUID(),
          entityType: "profile_entry",
          entityId: entry.id,
          sourceSessionId: sessionId,
          traceId: trace.id,
          actor: "agent",
          before: previous ?? null,
          after: entry,
          reason: proposed.reasoningTrace,
          createdAt: now,
        };
        await insertRevision(deps.db, newRevision);

        write.entries.push(entry);
        write.traces.push(trace);
        write.revisions.push(toApiRevision(newRevision));
        step += 1;
      }
    }
    return write;
  });
}
