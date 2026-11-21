import browser from "webextension-polyfill";
import {
  wsEventSchema,
  type ObservedEventEnvelope,
  type PostEventsBatchRequest,
  type SessionDescriptor,
  type WsEvent,
} from "@dex-ai/shared";
import {
  getControlPlaneSettings,
  saveControlPlaneSettings,
  type ControlPlaneSettings,
} from "../shared/auth";
import {
  ControlPlaneRequestError,
  postEventBatch,
  postRehearsalDecision,
  startRehearsal,
} from "../shared/api-client";
import {
  isExtensionMessage,
  type CoordinatorResponse,
  type ExtensionMessage,
  type StartRehearsalResponse,
  type TabMessage,
} from "../shared/messages";

/**
 * Background coordinator. It owns the local token, buffers observed events,
 * posts authenticated batches, keeps the /stream WebSocket open, routes
 * rehearsal decisions to the active tab, and marks the control plane
 * rehearsal paused when the stream disconnects.
 */

const FLUSH_INTERVAL_MS = 5000;
const MAX_BATCH_EVENTS = 200;
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000];
const TOKEN_PROTOCOL_PREFIX = "dex-ai.";

/** Buffers observed events per session, deduplicating by event id. */
export class EventBatchBuffer {
  private readonly sessions = new Map<
    string,
    { session: SessionDescriptor; events: Map<string, ObservedEventEnvelope> }
  >();

  add(session: SessionDescriptor, events: readonly ObservedEventEnvelope[]): number {
    if (events.length === 0) return 0;
    let entry = this.sessions.get(session.id);
    if (!entry) {
      entry = { session, events: new Map() };
      this.sessions.set(session.id, entry);
    } else {
      entry.session = session;
    }
    let queued = 0;
    for (const event of events) {
      if (!entry.events.has(event.id)) {
        entry.events.set(event.id, event);
        queued += 1;
      }
    }
    return queued;
  }

  get size(): number {
    let total = 0;
    for (const { events } of this.sessions.values()) total += events.size;
    return total;
  }

  /** Remove and return batches of at most MAX_BATCH_EVENTS events per session. */
  drain(): PostEventsBatchRequest[] {
    const batches: PostEventsBatchRequest[] = [];
    for (const { session, events } of this.sessions.values()) {
      const all = [...events.values()];
      for (let start = 0; start < all.length; start += MAX_BATCH_EVENTS) {
        batches.push({ session, events: all.slice(start, start + MAX_BATCH_EVENTS) });
      }
    }
    this.sessions.clear();
    return batches;
  }

  /** Put failed batches back; deduplication drops events flushed meanwhile. */
  requeue(batches: readonly PostEventsBatchRequest[]): void {
    for (const batch of batches) this.add(batch.session, batch.events);
  }
}

const eventBuffer = new EventBatchBuffer();
let activeSession: SessionDescriptor | null = null;
let activeRehearsalId: string | null = null;
let pendingPauseRehearsalId: string | null = null;
let streamSocket: WebSocket | null = null;
let streamReconnectAttempt = 0;
let streamReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushInFlight = false;

function errorText(error: unknown): string {
  if (error instanceof ControlPlaneRequestError) {
    const details = Object.entries(error.fieldErrors).map(
      ([field, messages]) => `${field}: ${messages.join(", ")}`,
    );
    const suffix = details.length > 0 ? ` (${details.join("; ")})` : "";
    return `${error.message}${suffix}`;
  }
  return error instanceof Error ? error.message : String(error);
}

// Event batch flush loop.

function scheduleFlush(): void {
  if (flushTimer === null) {
    flushTimer = setInterval(() => {
      void flushBufferedEvents();
    }, FLUSH_INTERVAL_MS);
  }
}

function stopFlushTimer(): void {
  if (flushTimer !== null) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

async function flushBufferedEvents(): Promise<void> {
  if (flushInFlight) return;
  flushInFlight = true;
  try {
    if (eventBuffer.size === 0) {
      stopFlushTimer();
      return;
    }
    const settings = await getControlPlaneSettings();
    // Events stay buffered until setup stores a token.
    if (!settings.token) return;
    const batches = eventBuffer.drain();
    const failed: PostEventsBatchRequest[] = [];
    for (const batch of batches) {
      try {
        await postEventBatch(settings, batch);
      } catch (error) {
        console.warn("dex-ai: event batch post failed, will retry", errorText(error));
        failed.push(batch);
      }
    }
    if (failed.length > 0) eventBuffer.requeue(failed);
  } finally {
    flushInFlight = false;
  }
}

// /stream WebSocket connection with token subprotocol and reconnect backoff.

function buildStreamUrl(baseUrl: string): string {
  const url = new URL("/stream", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function connectStream(settings: ControlPlaneSettings): void {
  disconnectStream();
  if (!settings.token) return;
  const socket = new WebSocket(buildStreamUrl(settings.baseUrl), `${TOKEN_PROTOCOL_PREFIX}${settings.token}`);
  streamSocket = socket;
  socket.onopen = handleStreamOpen;
  socket.onmessage = handleStreamMessage;
  socket.onclose = handleStreamClose;
}

function disconnectStream(): void {
  if (streamReconnectTimer !== null) {
    clearTimeout(streamReconnectTimer);
    streamReconnectTimer = null;
  }
  if (streamSocket !== null) {
    streamSocket.onclose = null;
    streamSocket.close();
    streamSocket = null;
  }
}

function handleStreamOpen(): void {
  streamReconnectAttempt = 0;
  void deliverPendingPause();
  void flushBufferedEvents();
}

function handleStreamMessage(message: MessageEvent<string>): void {
  let raw: unknown;
  try {
    raw = JSON.parse(message.data);
  } catch {
    console.warn("dex-ai: stream message is not valid JSON");
    return;
  }
  const parsed = wsEventSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn("dex-ai: stream message failed the envelope schema");
    return;
  }
  void routeStreamEvent(parsed.data);
}

function handleStreamClose(): void {
  streamSocket = null;
  pauseActiveRehearsal("disconnected");
  scheduleStreamReconnect();
}

function scheduleStreamReconnect(): void {
  const delay = RECONNECT_DELAYS_MS[Math.min(streamReconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
  streamReconnectAttempt += 1;
  streamReconnectTimer = setTimeout(() => {
    streamReconnectTimer = null;
    void getControlPlaneSettings().then(connectStream);
  }, delay);
}

// Rehearsal routing and disconnect pause.

async function sendToActiveTab(message: TabMessage): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await browser.tabs.sendMessage(tab.id, message);
  } catch (error) {
    console.warn("dex-ai: no content script in the active tab", errorText(error));
  }
}

async function routeStreamEvent(event: WsEvent): Promise<void> {
  switch (event.type) {
    case "rehearsal.proposed":
      activeRehearsalId = event.payload.action.rehearsalId;
      return;
    case "rehearsal.executed":
      activeRehearsalId = event.payload.action.rehearsalId;
      await sendToActiveTab({
        type: "dex-ai:execute-action",
        actionId: event.payload.action.id,
        action: event.payload.action.action,
      });
      return;
    case "rehearsal.paused":
      activeRehearsalId = event.payload.rehearsalId;
      await sendToActiveTab({
        type: "dex-ai:rehearsal-paused",
        rehearsalId: event.payload.rehearsalId,
        reason: event.payload.reason,
      });
      return;
    default:
      // Timeline, trace, profile and revision events feed the web panels only.
      return;
  }
}

// Edge case: an interrupted rehearsal runs no further browser action until it
// is explicitly resumed, so a disconnect must leave the rehearsal paused.
function pauseActiveRehearsal(reason: "disconnected"): void {
  if (activeRehearsalId === null) return;
  const rehearsalId = activeRehearsalId;
  pendingPauseRehearsalId ??= rehearsalId;
  void sendToActiveTab({ type: "dex-ai:rehearsal-paused", rehearsalId, reason });
  void deliverPendingPause();
}

async function deliverPendingPause(): Promise<void> {
  const rehearsalId = pendingPauseRehearsalId;
  if (rehearsalId === null) return;
  const settings = await getControlPlaneSettings();
  if (!settings.token) return;
  try {
    await postRehearsalDecision(settings, rehearsalId, { type: "pause" });
    pendingPauseRehearsalId = null;
  } catch (error) {
    // Retried when the stream reconnects and the control plane answers again.
    console.warn("dex-ai: pause decision not delivered yet", errorText(error));
  }
}

// Runtime messages from the popup and content scripts.

async function handleStartRehearsal(message: Extract<ExtensionMessage, { type: "dex-ai:start-rehearsal" }>): Promise<StartRehearsalResponse> {
  const settings = await getControlPlaneSettings();
  if (!settings.token) return { ok: false, error: "No control plane token is stored" };
  if (!activeSession) return { ok: false, error: "No observed session yet; open a posting first" };
  try {
    const rehearsal = await startRehearsal(settings, {
      sessionId: activeSession.id,
      postingUrl: message.postingUrl ?? activeSession.postingUrl,
    });
    activeRehearsalId = rehearsal.id;
    return { ok: true, rehearsal };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

async function handleRuntimeMessage(message: ExtensionMessage): Promise<CoordinatorResponse> {
  switch (message.type) {
    case "dex-ai:get-settings":
      return getControlPlaneSettings();
    case "dex-ai:set-settings": {
      const settings = await saveControlPlaneSettings(message);
      connectStream(settings);
      return { ok: true };
    }
    case "dex-ai:observed-events": {
      activeSession = message.session;
      const queued = eventBuffer.add(message.session, message.events);
      scheduleFlush();
      return { ok: true, queued };
    }
    case "dex-ai:start-rehearsal":
      return handleStartRehearsal(message);
  }
}

browser.runtime.onMessage.addListener((rawMessage: unknown) => {
  if (!isExtensionMessage(rawMessage)) return undefined;
  return handleRuntimeMessage(rawMessage).catch((error: unknown): CoordinatorResponse => {
    console.error("dex-ai: coordinator message failed", error);
    return { ok: false, error: errorText(error) };
  });
});

void (async () => {
  connectStream(await getControlPlaneSettings());
})();
