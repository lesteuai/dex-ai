import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpBindings, WebSocketLike } from "@hono/node-server";
import { Hono } from "hono";
import type { SessionDescriptor, TeachingDraft, WsEvent } from "@dex-ai/shared";
import type { AgentAdapter, AgentEvent, AgentStartInput } from "../agent/adapter";
import { DeterministicAgentAdapter } from "../agent/deterministic-adapter";
import { createDb, openSqliteDatabase, type ControlPlaneDb } from "../db/client";
import { runMigrations } from "../db/migrate";
import { storeEventBatch } from "../repositories/events";
import { buildSessionTimeline, type SessionTimeline } from "../services/session-timeline";
import { StreamHub } from "../stream/hub";
import { createTeachingRoute } from "./teaching";

const TEMP_BASE = "/tmp/opencode";
const TRANSCRIPT = "always answer the salary question with my stored range";

type TeachingApp = Hono<{ Bindings: HttpBindings }>;
type WsMessageOfType<T extends WsEvent["type"]> = Extract<WsEvent, { type: T }>;

interface TeachingRunResponse {
  taskId: string;
  status: "completed" | "failed" | "cancelled";
  eventId: string;
  draft: TeachingDraft | null;
}

interface TeachingErrorResponse {
  error: string;
  message: string;
  fieldErrors?: Record<string, string[]>;
}

/**
 * DeterministicAgentAdapter wrapped so a test can cancel mid-run: the first
 * event waits on a gate the test releases, keeping the task registered as
 * running while the test calls the cancel endpoint.
 */
class GatedAgentAdapter implements AgentAdapter {
  readonly startedTaskIds: string[] = [];
  private releaseGate: () => void = () => undefined;

  constructor(private readonly inner: AgentAdapter) {}

  start(input: AgentStartInput): AsyncIterable<AgentEvent> {
    this.startedTaskIds.push(input.taskId);
    return this.streamFirstEventGated(this.inner.start(input));
  }

  cancel(taskId: string): Promise<void> {
    return this.inner.cancel(taskId);
  }

  releaseFirstEvent(): void {
    this.releaseGate();
  }

  private async *streamFirstEventGated(stream: AsyncIterable<AgentEvent>): AsyncGenerator<AgentEvent> {
    let gated = true;
    for await (const event of stream) {
      if (gated) {
        gated = false;
        await new Promise<void>((resolve) => {
          this.releaseGate = resolve;
        });
      }
      yield event;
    }
  }
}

let dbDir: string;
let database: DatabaseSync;
let db: ControlPlaneDb;
let hub: StreamHub;
let messages: WsEvent[];

beforeEach(async () => {
  dbDir = mkdtempSync(join(TEMP_BASE, "dex-ai-teaching-"));
  database = openSqliteDatabase(join(dbDir, "control-plane.sqlite"));
  db = createDb(database);
  await runMigrations(database);
  hub = new StreamHub();
  messages = [];
  // A fake open WebSocket captures every envelope the hub publishes.
  const hubClient: WebSocketLike = {
    protocol: "dex-ai.test",
    readyState: 1,
    close: () => undefined,
    send: (data) => {
      messages.push(JSON.parse(String(data)) as WsEvent);
    },
    on: () => hubClient,
    off: () => hubClient,
  };
  hub.subscribe(hubClient);
});

afterEach(() => {
  database.close();
  rmSync(dbDir, { recursive: true, force: true });
});

function buildTeachingApp(adapter: AgentAdapter): TeachingApp {
  const app = new Hono<{ Bindings: HttpBindings }>();
  app.route("/", createTeachingRoute({ database, db, hub, adapter }));
  return app;
}

async function seedSession(): Promise<SessionDescriptor> {
  const session: SessionDescriptor = {
    id: randomUUID(),
    browserKind: "chrome",
    sourceUrl: "https://jobs.example/listings",
  };
  await storeEventBatch(database, db, session, [
    {
      type: "search_filter",
      id: randomUUID(),
      ts: "2026-11-21T10:00:00.000Z",
      payload: { pageUrl: "https://jobs.example/listings", query: "typescript", filters: {} },
    },
  ]);
  return session;
}

async function postJson(app: TeachingApp, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function createVoiceDraft(app: TeachingApp, sessionId: string): Promise<TeachingDraft> {
  const response = await postJson(app, "/drafts", {
    source: "voice",
    transcript: TRANSCRIPT,
    sessionId,
  });
  return (await readJson<{ draft: TeachingDraft }>(response)).draft;
}

async function listPendingDrafts(app: TeachingApp): Promise<TeachingDraft[]> {
  return (await readJson<{ drafts: TeachingDraft[] }>(await app.request("/drafts"))).drafts;
}

async function getTimeline(sessionId: string): Promise<SessionTimeline> {
  const timeline = await buildSessionTimeline(db, sessionId);
  if (timeline === null) throw new Error("Expected the seeded session timeline to exist");
  return timeline;
}

function messagesOfType<T extends WsEvent["type"]>(type: T): WsMessageOfType<T>[] {
  return messages.filter((message): message is WsMessageOfType<T> => message.type === type);
}

const messageTypes = () => messages.map((message) => message.type);

describe("teaching draft lifecycle", () => {
  it("creates a pending draft, lists it, and discards it", async () => {
    const app = buildTeachingApp(new DeterministicAgentAdapter());
    const session = await seedSession();

    const created = await postJson(app, "/drafts", {
      source: "voice",
      transcript: TRANSCRIPT,
      sessionId: session.id,
    });
    expect(created.status).toBe(200);
    const draft = (await readJson<{ draft: TeachingDraft }>(created)).draft;
    expect(draft.status).toBe("pending");
    expect(draft.source).toBe("voice");
    expect(draft.transcript).toBe(TRANSCRIPT);
    expect(draft.sessionId).toBe(session.id);
    expect(await listPendingDrafts(app)).toEqual([draft]);

    const discarded = await postJson(app, `/drafts/${draft.id}/discard`, {});
    expect(discarded.status).toBe(200);
    expect((await readJson<{ draft: TeachingDraft }>(discarded)).draft.status).toBe("discarded");
    expect(await listPendingDrafts(app)).toEqual([]);
  });

  it("rejects an invalid transcript or source with field errors and stores nothing", async () => {
    const app = buildTeachingApp(new DeterministicAgentAdapter());
    await seedSession();

    const emptyTranscript = await postJson(app, "/drafts", { source: "voice", transcript: "" });
    expect(emptyTranscript.status).toBe(400);
    const emptyBody = await readJson<TeachingErrorResponse>(emptyTranscript);
    expect(emptyBody.error).toBe("invalid_request");
    expect(emptyBody.fieldErrors?.transcript?.length).toBeGreaterThan(0);

    const badSource = await postJson(app, "/drafts", {
      source: "carrier-pigeon",
      transcript: TRANSCRIPT,
    });
    expect(badSource.status).toBe(400);
    expect((await readJson<TeachingErrorResponse>(badSource)).fieldErrors?.source?.length).toBeGreaterThan(0);

    expect(await listPendingDrafts(app)).toEqual([]);
  });

  it("rejects a draft for an unknown session", async () => {
    const app = buildTeachingApp(new DeterministicAgentAdapter());

    const response = await postJson(app, "/drafts", {
      source: "voice",
      transcript: TRANSCRIPT,
      sessionId: randomUUID(),
    });

    expect(response.status).toBe(404);
    expect((await readJson<TeachingErrorResponse>(response)).error).toBe("not_found");
    expect(await listPendingDrafts(app)).toEqual([]);
  });

  it("rejects a malformed JSON body", async () => {
    const app = buildTeachingApp(new DeterministicAgentAdapter());

    const response = await app.request("/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    expect(response.status).toBe(400);
    expect((await readJson<TeachingErrorResponse>(response)).error).toBe("invalid_request");
  });
});

describe("teaching runs", () => {
  it("confirming a voice draft creates a reason_stated event and a linked trace in the session timeline", async () => {
    const app = buildTeachingApp(new DeterministicAgentAdapter());
    const session = await seedSession();
    const draft = await createVoiceDraft(app, session.id);

    const response = await postJson(app, "/", { draftId: draft.id });
    expect(response.status).toBe(200);
    const run = await readJson<TeachingRunResponse>(response);
    expect(run.status).toBe("completed");
    expect(run.draft?.id).toBe(draft.id);
    expect(run.draft?.status).toBe("confirmed");

    const timeline = await getTimeline(session.id);
    const teachingEvent = timeline.timeline.find(
      (item) => item.kind === "event" && item.event.id === run.eventId,
    );
    if (teachingEvent?.kind !== "event" || teachingEvent.event.type !== "reason_stated") {
      throw new Error("Expected the confirmed transcript in the session timeline");
    }
    expect(teachingEvent.event.type).toBe("reason_stated");
    expect(teachingEvent.event.payload.input).toBe("voice");
    expect(teachingEvent.event.payload.text).toBe(TRANSCRIPT);

    const traceItem = timeline.timeline.find(
      (item) => item.kind === "trace" && item.trace.eventId === run.eventId,
    );
    if (traceItem?.kind !== "trace") {
      throw new Error("Expected a trace linked to the teaching event");
    }
    expect(traceItem.trace.taskId).toBe(run.taskId);
    expect(traceItem.trace.reasoning).toContain("salary");
  });

  it("confirming with an edited transcript uses the edited text", async () => {
    const app = buildTeachingApp(new DeterministicAgentAdapter());
    const session = await seedSession();
    const draft = await createVoiceDraft(app, session.id);
    const edited = "answer salary questions with my published range only";

    const run = await readJson<TeachingRunResponse>(
      await postJson(app, "/", { draftId: draft.id, text: edited }),
    );

    expect(run.status).toBe("completed");
    const timeline = await getTimeline(session.id);
    const teachingEvent = timeline.timeline.find(
      (item) => item.kind === "event" && item.event.id === run.eventId,
    );
    if (teachingEvent?.kind !== "event" || teachingEvent.event.type !== "reason_stated") {
      throw new Error("Expected the edited transcript in the session timeline");
    }
    expect(teachingEvent.event.payload.input).toBe("voice");
    expect(teachingEvent.event.payload.text).toBe(edited);
  });

  it("typed teaching bypasses the draft", async () => {
    const app = buildTeachingApp(new DeterministicAgentAdapter());
    const session = await seedSession();

    const response = await postJson(app, "/", { text: TRANSCRIPT, sessionId: session.id });
    expect(response.status).toBe(200);
    const run = await readJson<TeachingRunResponse>(response);
    expect(run.status).toBe("completed");
    expect(run.draft).toBeNull();
    expect(await listPendingDrafts(app)).toEqual([]);

    const timeline = await getTimeline(session.id);
    const teachingEvent = timeline.timeline.find(
      (item) => item.kind === "event" && item.event.id === run.eventId,
    );
    if (teachingEvent?.kind !== "event" || teachingEvent.event.type !== "reason_stated") {
      throw new Error("Expected the typed teaching event in the session timeline");
    }
    expect(teachingEvent.event.payload.input).toBe("text");
  });

  it("rejects an apply request with neither a draft id nor text", async () => {
    const app = buildTeachingApp(new DeterministicAgentAdapter());

    const response = await postJson(app, "/", {});

    expect(response.status).toBe(400);
    const body = await readJson<TeachingErrorResponse>(response);
    expect(body.error).toBe("invalid_request");
    expect(body.message).toContain("draft id or typed text");
  });

  it("rejects typed teaching without a session id", async () => {
    const app = buildTeachingApp(new DeterministicAgentAdapter());

    const response = await postJson(app, "/", { text: TRANSCRIPT });

    expect(response.status).toBe(400);
    expect((await readJson<TeachingErrorResponse>(response)).message).toContain("session id");
  });

  it("rejects an unknown draft id and a draft that is no longer pending", async () => {
    const app = buildTeachingApp(new DeterministicAgentAdapter());
    const session = await seedSession();

    const unknown = await postJson(app, "/", { draftId: randomUUID(), sessionId: session.id });
    expect(unknown.status).toBe(404);
    expect((await readJson<TeachingErrorResponse>(unknown)).error).toBe("not_found");

    const draft = await createVoiceDraft(app, session.id);
    await postJson(app, `/drafts/${draft.id}/discard`, {});
    const notPending = await postJson(app, "/", { draftId: draft.id, sessionId: session.id });
    expect(notPending.status).toBe(409);
    expect((await readJson<TeachingErrorResponse>(notPending)).error).toBe("draft_not_pending");
  });

  it("agent failure preserves the pending draft and reports the failure", async () => {
    const failingAdapter = new DeterministicAgentAdapter({
      rules: {
        reasoning: ["Mapping the transcript onto rules."],
        result: null,
        failWith: "the configured provider is unavailable",
      },
    });
    const app = buildTeachingApp(failingAdapter);
    const session = await seedSession();
    const draft = await createVoiceDraft(app, session.id);

    const response = await postJson(app, "/", { draftId: draft.id });
    expect(response.status).toBe(502);
    const body = await readJson<TeachingErrorResponse>(response);
    expect(body.error).toBe("teaching_task_failed");
    expect(body.message).toContain("the configured provider is unavailable");

    const pending = await listPendingDrafts(app);
    expect(pending.map((pendingDraft) => pendingDraft.id)).toEqual([draft.id]);
    expect(pending[0]?.status).toBe("pending");
  });

  it("cancellation aborts a running teaching task and keeps the draft pending", async () => {
    const adapter = new GatedAgentAdapter(new DeterministicAgentAdapter());
    const app = buildTeachingApp(adapter);
    const session = await seedSession();
    const draft = await createVoiceDraft(app, session.id);

    const runPromise = postJson(app, "/", { draftId: draft.id });
    await vi.waitFor(() => expect(adapter.startedTaskIds).toHaveLength(1));
    const cancelResponse = await app.request(`/tasks/${adapter.startedTaskIds[0]}/cancel`, {
      method: "POST",
    });
    expect(cancelResponse.status).toBe(200);
    expect(await readJson<{ ok: boolean }>(cancelResponse)).toEqual({ ok: true });

    adapter.releaseFirstEvent();
    const run = await readJson<TeachingRunResponse>(await runPromise);
    expect(run.status).toBe("cancelled");
    expect(run.draft?.id).toBe(draft.id);
    expect(run.draft?.status).toBe("pending");

    const pending = await listPendingDrafts(app);
    expect(pending.map((pendingDraft) => pendingDraft.id)).toEqual([draft.id]);

    // The aborted run publishes no failure and keeps its trace.
    expect(messageTypes()).toEqual(["session.updated", "trace.started", "trace.completed"]);
    const [traceCompleted] = messagesOfType("trace.completed");
    if (traceCompleted === undefined) throw new Error("Expected trace.completed for the cancelled run");
    expect(traceCompleted.payload.trace.taskId).toBe(adapter.startedTaskIds[0]);
    expect(traceCompleted.payload.trace.output).toEqual({ cancelled: true });
  });

  it("cancelling an unknown teaching task returns 404", async () => {
    const app = buildTeachingApp(new DeterministicAgentAdapter());

    const response = await app.request(`/tasks/${randomUUID()}/cancel`, { method: "POST" });

    expect(response.status).toBe(404);
    expect((await readJson<TeachingErrorResponse>(response)).error).toBe("not_found");
  });
});

describe("stream events published by a teaching run", () => {
  it("publishes session.updated, trace.started, trace.delta and trace.completed for a completed run", async () => {
    const app = buildTeachingApp(new DeterministicAgentAdapter());
    const session = await seedSession();
    const draft = await createVoiceDraft(app, session.id);

    const run = await readJson<TeachingRunResponse>(await postJson(app, "/", { draftId: draft.id }));

    expect(messageTypes()).toEqual([
      "session.updated",
      "trace.started",
      "trace.delta",
      "trace.delta",
      "trace.completed",
    ]);
    const [sessionUpdated, traceStarted] = messages;
    if (sessionUpdated?.type !== "session.updated" || traceStarted?.type !== "trace.started") {
      throw new Error("Expected the run to open with session and trace events");
    }
    expect(sessionUpdated.payload.session.id).toBe(session.id);
    expect(traceStarted.payload.trace.taskId).toBe(run.taskId);
    expect(traceStarted.payload.trace.eventId).toBe(run.eventId);

    const deltas = messagesOfType("trace.delta");
    expect(deltas).toHaveLength(2);
    for (const delta of deltas) {
      expect(delta.payload.traceId).toBe(traceStarted.payload.trace.id);
      expect(delta.payload.text.length).toBeGreaterThan(0);
    }

    const [traceCompleted] = messagesOfType("trace.completed");
    if (traceCompleted === undefined) throw new Error("Expected trace.completed for the run");
    expect(traceCompleted.payload.trace.id).toBe(traceStarted.payload.trace.id);
    expect(traceCompleted.payload.trace.eventId).toBe(run.eventId);
    // The scripted rules result is exposed as the trace output.
    expect(traceCompleted.payload.trace.output).toMatchObject({
      rules: [expect.objectContaining({ scope: "rehearsal.fill" })],
    });
  });

  it("publishes task.failed with the failure message when the agent run fails", async () => {
    const failingAdapter = new DeterministicAgentAdapter({
      rules: {
        reasoning: ["Mapping the transcript onto rules."],
        result: null,
        failWith: "the configured provider is unavailable",
      },
    });
    const app = buildTeachingApp(failingAdapter);
    const session = await seedSession();
    const draft = await createVoiceDraft(app, session.id);

    await postJson(app, "/", { draftId: draft.id });

    const [traceStarted] = messagesOfType("trace.started");
    const [taskFailed] = messagesOfType("task.failed");
    if (traceStarted === undefined || taskFailed === undefined) {
      throw new Error("Expected trace.started and task.failed for the failed run");
    }
    expect(taskFailed.payload.taskId).toBe(traceStarted.payload.trace.taskId);
    expect(taskFailed.payload.message).toContain("the configured provider is unavailable");
    expect(messageTypes().at(-1)).toBe("task.failed");
  });
});
