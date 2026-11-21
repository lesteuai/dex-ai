import type {
  ObservedEventEnvelope,
  PostEventsBatchResponse,
  RehearsalRecord,
  SessionDescriptor,
  TeachingDraft,
} from "@dex-ai/shared";

/** Pure data fixtures shared by the extension unit tests. */

export const TEST_SESSION: SessionDescriptor = {
  id: "11111111-1111-4111-8111-111111111111",
  browserKind: "chrome",
  postingUrl: "https://jobs.example.test/postings/1",
};

export const eventUuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const postingOpenedEvent = (id: string): ObservedEventEnvelope => ({
  type: "posting_opened",
  id,
  ts: "2026-11-21T10:00:00.000Z",
  payload: { pageUrl: "https://jobs.example.test/postings/1", title: "Backend Engineer" },
});

export const fieldFilledEvent = (id: string): ObservedEventEnvelope => ({
  type: "field_filled",
  id,
  ts: "2026-11-21T10:01:00.000Z",
  payload: {
    pageUrl: "https://jobs.example.test/postings/1",
    selector: "#full-name",
    value: "Ada Lovelace",
  },
});

export const batchOk = (accepted: number): PostEventsBatchResponse => ({
  sessionId: TEST_SESSION.id,
  accepted,
  duplicates: 0,
  rejected: [],
});

export const TEST_REHEARSAL_ID = "44444444-4444-4444-8444-444444444444";

export const TEST_REHEARSAL: RehearsalRecord = {
  id: TEST_REHEARSAL_ID,
  sessionId: TEST_SESSION.id,
  postingUrl: "https://jobs.example.test/postings/1",
  browserKind: "chrome",
  status: "paused",
  confidenceThreshold: 0.7,
  currentActionId: null,
  startedAt: "2026-11-21T10:02:00.000Z",
};

export const TEST_DRAFT_ID = "55555555-5555-4555-8555-555555555555";

export const TEST_DRAFT: TeachingDraft = {
  id: TEST_DRAFT_ID,
  source: "text",
  transcript: "Prefer concise cover letters",
  status: "pending",
  sessionId: null,
  createdAt: "2026-11-21T10:03:00.000Z",
};

/** Control plane response body for POST /api/teaching/drafts. */
export const draftResponse = (draft: TeachingDraft): { draft: TeachingDraft } => ({ draft });

/** Control plane response body for POST /api/stt/transcribe. */
export const sttResponse = (text: string): { text: string } => ({ text });

/** Minimal Response-like object for the fetch mock; api-client reads ok, status and text only. */
export const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as unknown as Response;
