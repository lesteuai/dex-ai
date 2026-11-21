import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  ObservedEventEnvelope,
  PostEventsBatchResponse,
  SessionDescriptor,
  SessionSummary,
  SessionTimelineItem,
} from "@dex-ai/shared";
import type { ControlPlaneConfig } from "./config";
import { startControlPlane, type ControlPlaneHandle } from "./index";
import type { SessionTimeline } from "./services/session-timeline";

const TEMP_BASE = "/tmp/opencode";

export const TEST_TOKEN = "t".repeat(64);

export const TEST_EXTENSION_ORIGINS = [
  "chrome-extension://abcdefghijklmnop",
  "moz-extension://01234567-89ab-cdef-0123-456789abcdef",
];

export const SEARCH_PAGE_URL = "https://jobs.example/listings";
export const POSTING_PAGE_URL = "https://jobs.example/listings/senior-frontend";

export interface TestControlPlane {
  config: ControlPlaneConfig;
  handle: ControlPlaneHandle;
  baseUrl: string;
  wsUrl: string;
}

/** In-memory config with an ephemeral port; no config file is read or written. */
export function buildTestConfig(): ControlPlaneConfig {
  const dataDir = mkdtempSync(join(TEMP_BASE, "dex-ai-control-plane-"));
  return {
    host: "127.0.0.1",
    // Port 0 makes the OS assign an ephemeral port for each test server.
    port: 0,
    token: TEST_TOKEN,
    dataDir,
    extensionOrigins: TEST_EXTENSION_ORIGINS,
    localUiOrigin: "http://127.0.0.1:8787",
    lowConfidenceThreshold: 0.7,
    parakeetModelPath: join(dataDir, "models"),
  };
}

export async function startTestControlPlane(
  config: ControlPlaneConfig = buildTestConfig(),
): Promise<TestControlPlane> {
  const handle = await startControlPlane(config);
  const address = handle.server.address();
  if (address === null || typeof address === "string") {
    await handle.close();
    throw new Error("Expected the control plane to report a bound loopback address");
  }
  return {
    config,
    handle,
    baseUrl: `http://${address.address}:${address.port}`,
    wsUrl: `ws://${address.address}:${address.port}/stream`,
  };
}

export async function closeTestControlPlane(controlPlane: TestControlPlane): Promise<void> {
  await controlPlane.handle.close();
  if (controlPlane.config.dataDir.startsWith(TEMP_BASE)) {
    rmSync(controlPlane.config.dataDir, { recursive: true, force: true });
  }
}

// Fixtures and request helpers shared by route tests.

export function makeSessionDescriptor(overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: randomUUID(),
    browserKind: "chrome",
    sourceUrl: SEARCH_PAGE_URL,
    ...overrides,
  };
}

export function makeSearchEvent(ts: string, query = "typescript"): ObservedEventEnvelope {
  return {
    type: "search_filter",
    id: randomUUID(),
    ts,
    payload: { pageUrl: SEARCH_PAGE_URL, query, filters: {} },
  };
}

export function makePostingOpenedEvent(
  ts: string,
  title = "Senior Frontend Engineer",
): ObservedEventEnvelope {
  return {
    type: "posting_opened",
    id: randomUUID(),
    ts,
    payload: { pageUrl: POSTING_PAGE_URL, title },
  };
}

export function makeFieldFilledEvent(
  ts: string,
  selector = "#first-name",
  value = "Ada",
): ObservedEventEnvelope {
  return {
    type: "field_filled",
    id: randomUUID(),
    ts,
    payload: { pageUrl: POSTING_PAGE_URL, selector, value },
  };
}

export function makeReasonStatedEvent(ts: string, text: string): ObservedEventEnvelope {
  return {
    type: "reason_stated",
    id: randomUUID(),
    ts,
    payload: { pageUrl: POSTING_PAGE_URL, input: "text", text },
  };
}

interface ApiRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

async function requestApi(
  controlPlane: TestControlPlane,
  path: string,
  init: ApiRequestInit,
): Promise<Response> {
  return fetch(`${controlPlane.baseUrl}${path}`, {
    method: init.method,
    body: init.body,
    headers: { authorization: `Bearer ${TEST_TOKEN}`, ...init.headers },
  });
}

export function fetchApi(controlPlane: TestControlPlane, path: string): Promise<Response> {
  return requestApi(controlPlane, path, {});
}

export function postEventBatchBody(
  controlPlane: TestControlPlane,
  body: unknown,
): Promise<Response> {
  return requestApi(controlPlane, "/api/events/batches", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function postEventBatch(
  controlPlane: TestControlPlane,
  session: SessionDescriptor,
  events: unknown[],
): Promise<Response> {
  return postEventBatchBody(controlPlane, { session, events });
}

export async function readBatchResponse(response: Response): Promise<PostEventsBatchResponse> {
  return (await response.json()) as PostEventsBatchResponse;
}

export async function getSessionList(controlPlane: TestControlPlane): Promise<SessionSummary[]> {
  const response = await fetchApi(controlPlane, "/api/sessions");
  return ((await response.json()) as { sessions: SessionSummary[] }).sessions;
}

export async function getSessionTimeline(
  controlPlane: TestControlPlane,
  sessionId: string,
): Promise<SessionTimeline> {
  const response = await fetchApi(controlPlane, `/api/sessions/${sessionId}`);
  if (response.status !== 200) {
    throw new Error(`Expected a 200 session timeline, got ${response.status}`);
  }
  return (await response.json()) as SessionTimeline;
}

export const storedEventIds = (timeline: SessionTimelineItem[]): string[] =>
  timeline.flatMap((item) => (item.kind === "event" ? [item.event.id] : []));
