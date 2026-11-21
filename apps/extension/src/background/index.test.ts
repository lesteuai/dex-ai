import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  batchOk,
  eventUuid,
  fieldFilledEvent,
  jsonResponse,
  postingOpenedEvent,
  TEST_REHEARSAL,
  TEST_REHEARSAL_ID,
  TEST_SESSION,
} from "../testing/fixtures";

const polyfill = vi.hoisted(() => {
  class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    readonly url: string;
    readonly subprotocol: string;
    closed = false;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(url: string, protocols?: string | string[]) {
      this.url = url;
      this.subprotocol = typeof protocols === "string" ? protocols : protocols?.[0] ?? "";
      FakeWebSocket.instances.push(this);
    }

    close(): void {
      this.closed = true;
    }
  }

  const storage = new Map<string, unknown>();
  const messageListeners: Array<(message: unknown) => unknown> = [];
  const sentTabMessages: Array<{ tabId: number; message: unknown }> = [];
  const tabs: Array<{ id?: number }> = [{ id: 7 }];

  const browser = {
    runtime: {
      onMessage: {
        addListener: (listener: (message: unknown) => unknown): void => {
          messageListeners.push(listener);
        },
      },
    },
    storage: {
      local: {
        get: async (key: string): Promise<Record<string, unknown>> =>
          storage.has(key) ? { [key]: storage.get(key) } : {},
        set: async (items: Record<string, unknown>): Promise<void> => {
          for (const [key, value] of Object.entries(items)) storage.set(key, value);
        },
      },
    },
    tabs: {
      query: async (): Promise<Array<{ id?: number }>> => tabs,
      sendMessage: async (tabId: number, message: unknown): Promise<void> => {
        sentTabMessages.push({ tabId, message });
      },
    },
  };

  return {
    FakeWebSocket,
    browser,
    storage,
    tabs,
    messageListeners,
    sentTabMessages,
    reset(): void {
      FakeWebSocket.instances.length = 0;
      storage.clear();
      messageListeners.length = 0;
      sentTabMessages.length = 0;
      tabs.splice(0, tabs.length, { id: 7 });
    },
  };
});

vi.mock("webextension-polyfill", () => ({ default: polyfill.browser }));

const streamEnvelope = (type: string, payload: unknown): string =>
  JSON.stringify({
    type,
    id: "33333333-3333-4333-8333-333333333333",
    ts: "2026-11-21T10:02:00.000Z",
    payload,
  });

const rehearsalActionRecord = (status: "proposed" | "executed") => ({
  id: "22222222-2222-4222-8222-222222222222",
  rehearsalId: TEST_REHEARSAL_ID,
  sequence: 1,
  action: { kind: "fill", selector: "#full-name", value: "Ada Lovelace" },
  confidence: 0.92,
  status,
  traceId: null,
  createdAt: "2026-11-21T10:02:00.000Z",
});

let coordinator: typeof import("./index");
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  polyfill.reset();
  vi.useFakeTimers();
  vi.clearAllTimers();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("WebSocket", polyfill.FakeWebSocket);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.resetModules();
  coordinator = await import("./index");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function settleMicrotasks(): Promise<void> {
  for (let step = 0; step < 10; step += 1) await Promise.resolve();
}

function sendRuntimeMessage(message: unknown): Promise<unknown> {
  const listener = polyfill.messageListeners[0];
  if (!listener) throw new Error("coordinator runtime listener is missing");
  return listener(message) as Promise<unknown>;
}

async function storeToken(token: string): Promise<void> {
  await sendRuntimeMessage({ type: "dex-ai:set-settings", token });
}

function currentSocket(): InstanceType<typeof polyfill.FakeWebSocket> {
  const socket = polyfill.FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("no stream socket was created");
  return socket;
}

describe("event batch buffering", () => {
  it("deduplicates by event id and keeps insertion order", () => {
    const buffer = new coordinator.EventBatchBuffer();
    const first = postingOpenedEvent(eventUuid(1));
    const second = fieldFilledEvent(eventUuid(2));
    const third = postingOpenedEvent(eventUuid(3));

    expect(buffer.add(TEST_SESSION, [first, second])).toBe(2);
    expect(buffer.add(TEST_SESSION, [second, third])).toBe(1);
    expect(buffer.size).toBe(3);

    const batches = buffer.drain();
    expect(batches).toHaveLength(1);
    expect(batches[0].events.map((event) => event.id)).toEqual([
      eventUuid(1),
      eventUuid(2),
      eventUuid(3),
    ]);
    expect(buffer.size).toBe(0);
  });

  it("splits drained batches at the batch size limit", () => {
    const buffer = new coordinator.EventBatchBuffer();
    const events = Array.from({ length: 205 }, (_, index) => postingOpenedEvent(eventUuid(index)));
    buffer.add(TEST_SESSION, events);

    const batches = buffer.drain();
    expect(batches.map((batch) => batch.events.length)).toEqual([200, 5]);
    expect(buffer.size).toBe(0);
  });

  it("requeues failed batches and drops events buffered meanwhile", () => {
    const buffer = new coordinator.EventBatchBuffer();
    const first = postingOpenedEvent(eventUuid(1));
    const second = fieldFilledEvent(eventUuid(2));
    buffer.add(TEST_SESSION, [first, second]);
    const [batch] = buffer.drain();

    buffer.add(TEST_SESSION, [first]);
    buffer.requeue([batch]);

    expect(buffer.size).toBe(2);
    const [requeued] = buffer.drain();
    expect(requeued.events).toHaveLength(2);
  });
});

describe("event batch flush", () => {
  it("posts buffered events as one authenticated batch, deduplicated by id", async () => {
    await storeToken("token-123");
    fetchMock.mockResolvedValue(jsonResponse(200, batchOk(3)));

    const first = await sendRuntimeMessage({
      type: "dex-ai:observed-events",
      session: TEST_SESSION,
      events: [postingOpenedEvent(eventUuid(1)), fieldFilledEvent(eventUuid(2))],
    });
    expect(first).toEqual({ ok: true, queued: 2 });

    const duplicate = await sendRuntimeMessage({
      type: "dex-ai:observed-events",
      session: TEST_SESSION,
      events: [postingOpenedEvent(eventUuid(1)), postingOpenedEvent(eventUuid(3))],
    });
    expect(duplicate).toEqual({ ok: true, queued: 1 });
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    await settleMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/api/events/batches");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-123");
    const body = JSON.parse(init.body as string) as {
      session: typeof TEST_SESSION;
      events: Array<{ id: string }>;
    };
    expect(body.events.map((event) => event.id)).toEqual([
      eventUuid(1),
      eventUuid(2),
      eventUuid(3),
    ]);
    expect(body.session).toEqual(TEST_SESSION);

    // The flush loop parks itself once the buffer is empty.
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps events buffered without a token and flushes once a token is stored", async () => {
    await sendRuntimeMessage({
      type: "dex-ai:observed-events",
      session: TEST_SESSION,
      events: [postingOpenedEvent(eventUuid(1))],
    });
    await vi.advanceTimersByTimeAsync(20000);

    expect(fetchMock).not.toHaveBeenCalled();

    await storeToken("token-123");
    fetchMock.mockResolvedValue(jsonResponse(200, batchOk(1)));
    await vi.advanceTimersByTimeAsync(5000);
    await settleMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { events: Array<{ id: string }> };
    expect(body.events.map((event) => event.id)).toEqual([eventUuid(1)]);
  });

  it("retries a failed batch with the same body on the next flush tick", async () => {
    await storeToken("token-123");
    await sendRuntimeMessage({
      type: "dex-ai:observed-events",
      session: TEST_SESSION,
      events: [postingOpenedEvent(eventUuid(1))],
    });
    fetchMock
      .mockRejectedValueOnce(new Error("control plane unreachable"))
      .mockResolvedValue(jsonResponse(200, batchOk(1)));

    await vi.advanceTimersByTimeAsync(5000);
    await settleMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    await settleMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [, firstInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [, secondInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(secondInit.body).toEqual(firstInit.body);
  });
});

describe("stream connection", () => {
  it("opens the stream with the token subprotocol", async () => {
    await storeToken("token-123");
    const socket = currentSocket();
    expect(socket.url).toBe("ws://127.0.0.1:8787/stream");
    expect(socket.subprotocol).toBe("dex-ai.token-123");
  });

  it("uses wss for an https control plane URL", async () => {
    await sendRuntimeMessage({
      type: "dex-ai:set-settings",
      baseUrl: "https://127.0.0.1:8788",
      token: "token-123",
    });
    expect(currentSocket().url).toBe("wss://127.0.0.1:8788/stream");
  });

  it("does not open a stream without a stored token", async () => {
    await settleMicrotasks();
    expect(polyfill.FakeWebSocket.instances).toHaveLength(0);
    await sendRuntimeMessage({ type: "dex-ai:set-settings", token: null });
    expect(polyfill.FakeWebSocket.instances).toHaveLength(0);
  });

  it("closes the old socket and reconnects with the same token after a drop", async () => {
    await storeToken("token-123");
    await sendRuntimeMessage({ type: "dex-ai:set-settings", token: "token-456" });
    expect(polyfill.FakeWebSocket.instances).toHaveLength(2);
    expect(polyfill.FakeWebSocket.instances[0].closed).toBe(true);
    expect(polyfill.FakeWebSocket.instances[1].subprotocol).toBe("dex-ai.token-456");

    polyfill.FakeWebSocket.instances[1].onclose?.();
    await vi.advanceTimersByTimeAsync(1000);
    await settleMicrotasks();

    expect(polyfill.FakeWebSocket.instances).toHaveLength(3);
    const reconnected = polyfill.FakeWebSocket.instances[2];
    expect(reconnected.url).toBe("ws://127.0.0.1:8787/stream");
    expect(reconnected.subprotocol).toBe("dex-ai.token-456");

    // A second drop waits for the longer backoff delay.
    reconnected.onclose?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(polyfill.FakeWebSocket.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(polyfill.FakeWebSocket.instances).toHaveLength(4);
  });
});

describe("active-tab rehearsal routing", () => {
  it("sends executed rehearsal actions to the active tab", async () => {
    await storeToken("token-123");
    currentSocket().onmessage?.({
      data: streamEnvelope("rehearsal.executed", { action: rehearsalActionRecord("executed") }),
    });
    await settleMicrotasks();

    expect(polyfill.sentTabMessages).toEqual([
      {
        tabId: 7,
        message: {
          type: "dex-ai:execute-action",
          actionId: "22222222-2222-4222-8222-222222222222",
          action: { kind: "fill", selector: "#full-name", value: "Ada Lovelace" },
        },
      },
    ]);
  });

  it("forwards control-plane pauses to the active tab", async () => {
    await storeToken("token-123");
    currentSocket().onmessage?.({
      data: streamEnvelope("rehearsal.paused", {
        rehearsalId: TEST_REHEARSAL_ID,
        actionId: null,
        reason: "low_confidence",
      }),
    });
    await settleMicrotasks();

    expect(polyfill.sentTabMessages).toEqual([
      {
        tabId: 7,
        message: {
          type: "dex-ai:rehearsal-paused",
          rehearsalId: TEST_REHEARSAL_ID,
          reason: "low_confidence",
        },
      },
    ]);
  });

  it("ignores proposed actions, other event types and malformed stream messages", async () => {
    await storeToken("token-123");
    const socket = currentSocket();
    socket.onmessage?.({
      data: streamEnvelope("rehearsal.proposed", { action: rehearsalActionRecord("proposed") }),
    });
    socket.onmessage?.({ data: streamEnvelope("session.updated", {}) });
    socket.onmessage?.({ data: "not json" });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "rehearsal.executed",
        id: "33333333-3333-4333-8333-333333333333",
        ts: "2026-11-21T10:02:00.000Z",
        payload: { action: { broken: true } },
      }),
    });
    await settleMicrotasks();

    expect(polyfill.sentTabMessages).toEqual([]);
  });

  it("survives a window with no active tab", async () => {
    polyfill.tabs.length = 0;
    await storeToken("token-123");
    currentSocket().onmessage?.({
      data: streamEnvelope("rehearsal.executed", { action: rehearsalActionRecord("executed") }),
    });
    await settleMicrotasks();

    expect(polyfill.sentTabMessages).toEqual([]);
  });
});

describe("rehearsal pause on stream disconnect", () => {
  it("marks the rehearsal paused on the control plane when the stream drops", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { rehearsal: TEST_REHEARSAL }));
    await storeToken("token-123");
    const socket = currentSocket();
    socket.onmessage?.({
      data: streamEnvelope("rehearsal.proposed", { action: rehearsalActionRecord("proposed") }),
    });

    socket.onclose?.();
    await settleMicrotasks();

    expect(polyfill.sentTabMessages).toEqual([
      {
        tabId: 7,
        message: {
          type: "dex-ai:rehearsal-paused",
          rehearsalId: TEST_REHEARSAL_ID,
          reason: "disconnected",
        },
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:8787/api/rehearsals/${TEST_REHEARSAL_ID}/decisions`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-123");
    expect(JSON.parse(init.body as string)).toEqual({ type: "pause" });
  });

  it("retries the pending pause decision after the stream reconnects", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("control plane unreachable"))
      .mockResolvedValue(jsonResponse(200, { rehearsal: TEST_REHEARSAL }));
    await storeToken("token-123");
    const socket = currentSocket();
    socket.onmessage?.({
      data: streamEnvelope("rehearsal.proposed", { action: rehearsalActionRecord("proposed") }),
    });

    socket.onclose?.();
    await settleMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    await settleMicrotasks();
    const reconnected = currentSocket();
    reconnected.onopen?.();
    await settleMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:8787/api/rehearsals/${TEST_REHEARSAL_ID}/decisions`);
    expect(JSON.parse(init.body as string)).toEqual({ type: "pause" });
  });
});

describe("rehearsal start gate", () => {
  it("refuses to start a rehearsal without a stored token", async () => {
    const response = await sendRuntimeMessage({ type: "dex-ai:start-rehearsal" });

    expect(response).toEqual({ ok: false, error: "No control plane token is stored" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("starts a rehearsal for the observed session with the local token", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { rehearsal: TEST_REHEARSAL }));
    await storeToken("token-123");
    await sendRuntimeMessage({
      type: "dex-ai:observed-events",
      session: TEST_SESSION,
      events: [postingOpenedEvent(eventUuid(1))],
    });

    const response = await sendRuntimeMessage({ type: "dex-ai:start-rehearsal" });

    expect(response).toEqual({ ok: true, rehearsal: TEST_REHEARSAL });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/api/rehearsals");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-123");
    const body = JSON.parse(init.body as string) as { sessionId: string; postingUrl: string };
    expect(body.sessionId).toBe(TEST_SESSION.id);
    expect(body.postingUrl).toBe(TEST_SESSION.postingUrl);
  });
});

describe("blocked attempt forwarding", () => {
  it("forwards a guard-refused attempt to the active rehearsal's blocked-attempts endpoint", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { rehearsal: TEST_REHEARSAL, action: null }));
    await storeToken("token-123");
    // The stream tells the coordinator which rehearsal is active.
    currentSocket().onmessage?.({
      data: streamEnvelope("rehearsal.executed", { action: rehearsalActionRecord("executed") }),
    });
    await settleMicrotasks();

    const response = await sendRuntimeMessage({
      type: "dex-ai:blocked-attempt",
      rehearsalId: null,
      actionId: null,
      attempt: { reason: "submit_activation", selector: "#submit-application" },
    });

    expect(response).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:8787/api/rehearsals/${TEST_REHEARSAL_ID}/blocked-attempts`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-123");
    // Only the discriminated attempt reaches the control plane; the report
    // metadata stays with the coordinator.
    expect(JSON.parse(init.body as string)).toEqual({
      reason: "submit_activation",
      selector: "#submit-application",
    });
  });

  it("prefers the rehearsal id the tab reported itself", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { rehearsal: TEST_REHEARSAL, action: null }));
    await storeToken("token-123");
    const reportedRehearsalId = "77777777-7777-4777-8777-777777777777";

    const response = await sendRuntimeMessage({
      type: "dex-ai:blocked-attempt",
      rehearsalId: reportedRehearsalId,
      actionId: null,
      attempt: { reason: "submit_navigation", url: "https://jobs.example.test/apply/submit" },
    });

    expect(response).toEqual({ ok: true });
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:8787/api/rehearsals/${reportedRehearsalId}/blocked-attempts`);
  });

  it("refuses a report when no rehearsal is active", async () => {
    await storeToken("token-123");

    const response = await sendRuntimeMessage({
      type: "dex-ai:blocked-attempt",
      rehearsalId: null,
      actionId: null,
      attempt: { reason: "submit_control", selector: "[data-testid='application-form']" },
    });

    expect(response).toEqual({ ok: false, error: "No rehearsal is active" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a failed forward with the control plane error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("control plane unreachable"));
    await storeToken("token-123");
    currentSocket().onmessage?.({
      data: streamEnvelope("rehearsal.executed", { action: rehearsalActionRecord("executed") }),
    });
    await settleMicrotasks();

    const response = await sendRuntimeMessage({
      type: "dex-ai:blocked-attempt",
      rehearsalId: null,
      actionId: null,
      attempt: { reason: "submit_control", selector: "[data-testid='application-form']" },
    });

    expect(response).toEqual({ ok: false, error: "control plane unreachable" });
  });
});
