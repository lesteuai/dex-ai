import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeAgentEvent,
  type AgentEvent,
  type AgentResultSchemaName,
  type AgentStartInput,
  type AgentTaskKind,
} from "./adapter";
import { OpenCodeAgentAdapter } from "./opencode-adapter";
import { parseAgentResult } from "./results";

// The SDK stays fully mocked, so no test reaches a real OpenCode provider.
const opencodeSdk = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("@opencode/sdk", () => ({
  OpenCode: { create: opencodeSdk.create },
}));

const TEMP_ROOT = "/tmp/opencode";
mkdirSync(TEMP_ROOT, { recursive: true });

const SESSION_ID = randomUUID();
const OTHER_SESSION_ID = randomUUID();
const SOURCE_EVENT_ID = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";

const KIND_TO_RESULT_SCHEMA: Record<AgentTaskKind, AgentResultSchemaName> = {
  profile_inference: "profile",
  teaching: "rules",
  rehearsal_planning: "rehearsalPlan",
  correction_propagation: "correction",
};

const createdDataDirs: string[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(join(TEMP_ROOT, "opencode-adapter-"));
  createdDataDirs.push(dir);
  return dir;
}

function startInput(
  kind: AgentTaskKind,
  signal: AbortSignal = new AbortController().signal,
): AgentStartInput {
  return {
    taskId: randomUUID(),
    kind,
    sessionId: randomUUID(),
    prompt: `unit test prompt for ${kind}`,
    resultSchema: KIND_TO_RESULT_SCHEMA[kind],
    signal,
  };
}

// Collecting normalizes every event, so an emission outside the shared contract fails.
async function collectEvents(adapter: OpenCodeAgentAdapter, input: AgentStartInput): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of adapter.start(input)) {
    events.push(normalizeAgentEvent(event));
  }
  return events;
}

type MockSessionEvent = {
  type: string;
  data: { sessionID?: string; text?: string; error?: { message: string } };
};

function serverConnected(): MockSessionEvent {
  return { type: "server.connected", data: {} };
}

function reasoningEnded(sessionID: string, text: string): MockSessionEvent {
  return { type: "session.reasoning.ended", data: { sessionID, text } };
}

function textEnded(sessionID: string, text: string): MockSessionEvent {
  return { type: "session.text.ended", data: { sessionID, text } };
}

function executionSucceeded(sessionID: string): MockSessionEvent {
  return { type: "session.execution.succeeded", data: { sessionID } };
}

function executionFailed(sessionID: string, message: string): MockSessionEvent {
  return { type: "session.execution.failed", data: { sessionID, error: { message } } };
}

/** Manual event queue: each pull blocks until the test pushes the next event. */
function createEventStream() {
  const pending: MockSessionEvent[] = [];
  const waiters: Array<(result: IteratorResult<MockSessionEvent>) => void> = [];

  return {
    push(event: MockSessionEvent): void {
      const resolveWaiter = waiters.shift();
      if (resolveWaiter) resolveWaiter({ value: event, done: false });
      else pending.push(event);
    },
    [Symbol.asyncIterator](): AsyncIterator<MockSessionEvent> {
      return {
        next(): Promise<IteratorResult<MockSessionEvent>> {
          const event = pending.shift();
          if (event) return Promise.resolve({ value: event, done: false });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
}

function createMockHost(sessionID: string) {
  const stream = createEventStream();
  const host = {
    sessions: {
      create: vi.fn().mockResolvedValue({ id: sessionID }),
      prompt: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined),
    },
    events: {
      subscribe: vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
      }),
    },
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { host, stream };
}

const profileResult = {
  sections: [
    {
      section: "user_facts",
      entries: [
        {
          key: "full_name",
          value: "Jordan Lee",
          confidence: 0.9,
          sourceEventIds: [SOURCE_EVENT_ID],
          reasoningTrace: "The same full name was typed into the name field on two applications.",
        },
      ],
    },
  ],
};

/** Providers often wrap the answer in a JSON fence, so the adapter must strip it. */
function fencedJson(value: object): string {
  return "```json\n" + JSON.stringify(value) + "\n```";
}

function pushSuccessfulTask(
  stream: ReturnType<typeof createEventStream>,
  sessionID: string,
  answerText: string,
): void {
  stream.push(serverConnected());
  stream.push(reasoningEnded(sessionID, "Observed one field_filled event on the application form."));
  stream.push(textEnded(sessionID, answerText));
  stream.push(executionSucceeded(sessionID));
}

afterEach(() => {
  vi.resetAllMocks();
  for (const dir of createdDataDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("OpenCodeAgentAdapter", () => {
  it("creates one host with the configured database path and logging options", async () => {
    const dataDir = tempDataDir();
    const emit = vi.fn();
    const { host, stream } = createMockHost(SESSION_ID);
    opencodeSdk.create.mockResolvedValue(host);
    const adapter = new OpenCodeAgentAdapter({ dataDir, log: { level: "error", emit } });

    pushSuccessfulTask(stream, SESSION_ID, fencedJson(profileResult));
    const events = await collectEvents(adapter, startInput("profile_inference"));

    expect(events.at(-1)).toEqual({ type: "status", status: "completed" });
    expect(opencodeSdk.create).toHaveBeenCalledTimes(1);
    expect(opencodeSdk.create).toHaveBeenCalledWith({
      database: { path: join(dataDir, "opencode.db") },
      log: { level: "error", emit },
    });
  });

  it("creates every session under the configured workspace directory and reuses one host", async () => {
    const dataDir = tempDataDir();
    const { host, stream } = createMockHost(SESSION_ID);
    opencodeSdk.create.mockResolvedValue(host);
    const adapter = new OpenCodeAgentAdapter({ dataDir });
    const firstInput = startInput("profile_inference");

    pushSuccessfulTask(stream, SESSION_ID, fencedJson(profileResult));
    const first = await collectEvents(adapter, firstInput);

    pushSuccessfulTask(stream, SESSION_ID, fencedJson({ rules: [] }));
    const second = await collectEvents(adapter, startInput("teaching"));

    const workspaceDir = join(dataDir, "workspace");
    expect(existsSync(workspaceDir)).toBe(true);
    expect(first.at(-1)).toEqual({ type: "status", status: "completed" });
    expect(second.at(-1)).toEqual({ type: "status", status: "completed" });
    expect(opencodeSdk.create).toHaveBeenCalledTimes(1);
    expect(host.sessions.create).toHaveBeenCalledTimes(2);
    expect(host.sessions.create).toHaveBeenNthCalledWith(1, {
      location: { directory: workspaceDir },
      title: "Dex AI profile_inference",
    });
    expect(host.sessions.create).toHaveBeenNthCalledWith(2, {
      location: { directory: workspaceDir },
      title: "Dex AI teaching",
    });
    expect(host.sessions.prompt).toHaveBeenNthCalledWith(
      1,
      { sessionID: SESSION_ID, text: firstInput.prompt },
      { signal: firstInput.signal },
    );
  });

  it("creates sessions on the configured provider/model", async () => {
    const { host, stream } = createMockHost(SESSION_ID);
    opencodeSdk.create.mockResolvedValue(host);
    const adapter = new OpenCodeAgentAdapter({
      dataDir: tempDataDir(),
      model: "anthropic/claude-sonnet-5-5",
    });

    pushSuccessfulTask(stream, SESSION_ID, fencedJson(profileResult));
    await collectEvents(adapter, startInput("profile_inference"));

    const createInput = host.sessions.create.mock.calls[0]?.[0] as { model?: unknown };
    expect(createInput.model).toEqual({ providerID: "anthropic", id: "claude-sonnet-5-5" });
  });

  it("drops subscription events from other sessions", async () => {
    const { host, stream } = createMockHost(SESSION_ID);
    opencodeSdk.create.mockResolvedValue(host);
    const adapter = new OpenCodeAgentAdapter({ dataDir: tempDataDir() });

    stream.push(serverConnected());
    stream.push(reasoningEnded(OTHER_SESSION_ID, "Another session's reasoning must never surface."));
    stream.push(reasoningEnded(SESSION_ID, "Observed one field_filled event."));
    stream.push(textEnded(SESSION_ID, fencedJson(profileResult)));
    stream.push(executionSucceeded(SESSION_ID));

    const events = await collectEvents(adapter, startInput("profile_inference"));

    expect(events.filter((event) => event.type === "reasoning")).toEqual([
      { type: "reasoning", text: "Observed one field_filled event." },
    ]);
    expect(host.events.subscribe).toHaveBeenCalledTimes(1);
    expect(host.events.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        types: expect.arrayContaining([
          "session.reasoning.ended",
          "session.text.ended",
          "session.execution.succeeded",
          "session.execution.failed",
          "session.execution.interrupted",
        ]),
      }),
    );
  });

  it("normalizes reasoning and the final answer into the shared agent event contract", async () => {
    const { host, stream } = createMockHost(SESSION_ID);
    opencodeSdk.create.mockResolvedValue(host);
    const adapter = new OpenCodeAgentAdapter({ dataDir: tempDataDir() });

    stream.push(serverConnected());
    stream.push(reasoningEnded(SESSION_ID, "Observed one field_filled event."));
    stream.push(textEnded(SESSION_ID, fencedJson(profileResult)));
    stream.push(executionSucceeded(SESSION_ID));

    const events = await collectEvents(adapter, startInput("profile_inference"));
    const result = events.find((event) => event.type === "result");

    expect(events).toEqual([
      { type: "status", status: "running" },
      { type: "reasoning", text: "Observed one field_filled event." },
      { type: "result", value: profileResult },
      { type: "status", status: "completed" },
    ]);
    expect(() => parseAgentResult("profile", result?.value)).not.toThrow();
  });

  it("fails the task when the final JSON breaks the profile schema", async () => {
    const { host, stream } = createMockHost(SESSION_ID);
    opencodeSdk.create.mockResolvedValue(host);
    const adapter = new OpenCodeAgentAdapter({ dataDir: tempDataDir() });
    const unsupported = {
      sections: [
        {
          section: "user_facts",
          entries: [
            {
              key: "full_name",
              value: "Invented Name",
              confidence: 0.9,
              sourceEventIds: [],
              reasoningTrace: "No observed event backs this value.",
            },
          ],
        },
      ],
    };

    stream.push(serverConnected());
    stream.push(reasoningEnded(SESSION_ID, "Not enough evidence for any user fact yet."));
    stream.push(textEnded(SESSION_ID, fencedJson(unsupported)));
    stream.push(executionSucceeded(SESSION_ID));

    const events = await collectEvents(adapter, startInput("profile_inference"));

    expect(events).toEqual([
      { type: "status", status: "running" },
      { type: "reasoning", text: "Not enough evidence for any user fact yet." },
      { type: "error", message: expect.stringContaining("Agent profile result failed validation") },
      { type: "status", status: "failed" },
    ]);
  });

  it("surfaces the provider failure and keeps the earlier reasoning", async () => {
    const { host, stream } = createMockHost(SESSION_ID);
    opencodeSdk.create.mockResolvedValue(host);
    const adapter = new OpenCodeAgentAdapter({ dataDir: tempDataDir() });

    stream.push(serverConnected());
    stream.push(reasoningEnded(SESSION_ID, "Reading the application form."));
    stream.push(executionFailed(SESSION_ID, "provider quota exhausted"));

    const events = await collectEvents(adapter, startInput("teaching"));

    expect(events).toEqual([
      { type: "status", status: "running" },
      { type: "reasoning", text: "Reading the application form." },
      { type: "error", message: "provider quota exhausted" },
      { type: "status", status: "failed" },
    ]);
  });

  it("cancels a running task through cancel() and interrupts the session", async () => {
    const { host, stream } = createMockHost(SESSION_ID);
    opencodeSdk.create.mockResolvedValue(host);
    const adapter = new OpenCodeAgentAdapter({ dataDir: tempDataDir() });
    const input = startInput("profile_inference");
    const taskStream = adapter.start(input)[Symbol.asyncIterator]();

    expect((await taskStream.next()).value).toEqual({ type: "status", status: "running" });

    stream.push(serverConnected());
    stream.push(reasoningEnded(SESSION_ID, "Reading the observed events."));
    expect((await taskStream.next()).value).toEqual({
      type: "reasoning",
      text: "Reading the observed events.",
    });

    await adapter.cancel(input.taskId);
    expect(host.sessions.interrupt).toHaveBeenCalledWith({ sessionID: SESSION_ID });

    stream.push(textEnded(SESSION_ID, fencedJson(profileResult)));
    expect((await taskStream.next()).value).toEqual({ type: "status", status: "cancelled" });
    expect((await taskStream.next()).done).toBe(true);
  });

  it("keeps the cancelled stream clean when the session interrupt fails", async () => {
    const { host, stream } = createMockHost(SESSION_ID);
    host.sessions.interrupt.mockRejectedValue(new Error("session already ended"));
    opencodeSdk.create.mockResolvedValue(host);
    const adapter = new OpenCodeAgentAdapter({ dataDir: tempDataDir() });
    const input = startInput("profile_inference");
    const taskStream = adapter.start(input)[Symbol.asyncIterator]();

    expect((await taskStream.next()).value).toEqual({ type: "status", status: "running" });

    stream.push(serverConnected());
    stream.push(reasoningEnded(SESSION_ID, "Reading the observed events."));
    expect((await taskStream.next()).value).toEqual({
      type: "reasoning",
      text: "Reading the observed events.",
    });

    await adapter.cancel(input.taskId);
    stream.push(textEnded(SESSION_ID, fencedJson(profileResult)));

    const rest: AgentEvent[] = [];
    for (;;) {
      const next = await taskStream.next();
      if (next.done) break;
      rest.push(normalizeAgentEvent(next.value));
    }
    expect(rest).toEqual([{ type: "status", status: "cancelled" }]);
  });

  it("cancels a running task when the AbortSignal aborts mid-task", async () => {
    const { host, stream } = createMockHost(SESSION_ID);
    opencodeSdk.create.mockResolvedValue(host);
    const adapter = new OpenCodeAgentAdapter({ dataDir: tempDataDir() });
    const controller = new AbortController();
    const input = startInput("profile_inference", controller.signal);
    const taskStream = adapter.start(input)[Symbol.asyncIterator]();

    expect((await taskStream.next()).value).toEqual({ type: "status", status: "running" });

    stream.push(serverConnected());
    stream.push(reasoningEnded(SESSION_ID, "Reading the observed events."));
    expect((await taskStream.next()).value).toEqual({
      type: "reasoning",
      text: "Reading the observed events.",
    });

    controller.abort();
    stream.push(textEnded(SESSION_ID, fencedJson(profileResult)));

    expect((await taskStream.next()).value).toEqual({ type: "status", status: "cancelled" });
    expect((await taskStream.next()).done).toBe(true);
    expect(host.sessions.interrupt).toHaveBeenCalledWith({ sessionID: SESSION_ID });
  });

  it("stops before any host work when the AbortSignal is already aborted", async () => {
    const { host } = createMockHost(SESSION_ID);
    opencodeSdk.create.mockResolvedValue(host);
    const adapter = new OpenCodeAgentAdapter({ dataDir: tempDataDir() });
    const controller = new AbortController();
    controller.abort();

    const events = await collectEvents(adapter, startInput("profile_inference", controller.signal));

    expect(events).toEqual([{ type: "status", status: "cancelled" }]);
    expect(opencodeSdk.create).not.toHaveBeenCalled();
    expect(host.sessions.create).not.toHaveBeenCalled();
  });

  it("cancels a task that has not started yet through cancel()", async () => {
    const { host } = createMockHost(SESSION_ID);
    opencodeSdk.create.mockResolvedValue(host);
    const adapter = new OpenCodeAgentAdapter({ dataDir: tempDataDir() });
    const input = startInput("correction_propagation");

    await adapter.cancel(input.taskId);
    const events = await collectEvents(adapter, input);

    expect(events).toEqual([{ type: "status", status: "cancelled" }]);
    expect(opencodeSdk.create).not.toHaveBeenCalled();
  });

  it("closes the created host on close()", async () => {
    const { host, stream } = createMockHost(SESSION_ID);
    opencodeSdk.create.mockResolvedValue(host);
    const adapter = new OpenCodeAgentAdapter({ dataDir: tempDataDir() });

    pushSuccessfulTask(stream, SESSION_ID, fencedJson(profileResult));
    await collectEvents(adapter, startInput("profile_inference"));

    await adapter.close();
    expect(host.close).toHaveBeenCalledTimes(1);
  });

  it("does not throw when close() runs before any host exists", async () => {
    const adapter = new OpenCodeAgentAdapter({ dataDir: tempDataDir() });

    await expect(adapter.close()).resolves.toBeUndefined();
    expect(opencodeSdk.create).not.toHaveBeenCalled();
  });
});
