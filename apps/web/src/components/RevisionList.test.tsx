// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Revision, SessionSummary } from "@dex-ai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ApiClient } from "../api/client";
import { RevisionList } from "./RevisionList";

const TS = "2026-11-21T10:00:00.000Z";
const SESSION_ID = "0197a1c0-0000-7000-8000-000000000001";
const ORPHAN_SESSION_ID = "0bb7a1c0-0000-7000-8000-000000000002";
const ENTRY_ID = "0197a1c0-0000-7000-8000-000000000101";
const TRACE_ID = "0aa7a1c0-0000-7000-8000-000000000401";

const REASON_INFERRED = "Three observed sessions searched for roles in Berlin.";
const REASON_USER = "I am relocating to London in January.";

const CHROME_SESSION: SessionSummary = {
  id: SESSION_ID,
  browserKind: "chrome",
  sourceUrl: "https://jobs.example.com/search",
  postingUrl: "https://jobs.example.com/postings/42",
  status: "ended",
  startedAt: TS,
  endedAt: TS,
};

const INFERRED_CITY_REVISION: Revision = {
  id: "0197a1c0-0000-7000-8000-000000000201",
  entityType: "profile",
  entityId: ENTRY_ID,
  sourceSessionId: SESSION_ID,
  traceId: TRACE_ID,
  actor: "agent",
  before: "Munich",
  after: "Berlin",
  reason: REASON_INFERRED,
  createdAt: TS,
};

const USER_RELOCATION_REVISION: Revision = {
  id: "0197a1c0-0000-7000-8000-000000000202",
  entityType: "profile",
  entityId: ENTRY_ID,
  sourceSessionId: null,
  traceId: null,
  actor: "user",
  before: "Berlin",
  after: "London",
  reason: REASON_USER,
  createdAt: "2026-11-21T11:00:00.000Z",
};

const ORPHAN_REVISION: Revision = {
  id: "0197a1c0-0000-7000-8000-000000000203",
  entityType: "rule",
  entityId: "0197a1c0-0000-7000-8000-000000000301",
  sourceSessionId: ORPHAN_SESSION_ID,
  traceId: null,
  actor: "agent",
  reason: "Followed the observed apply flow.",
  createdAt: TS,
};

/** Mock client answering only the endpoints the list touches. */
function createMockClient(revisions: Revision[], sessions: SessionSummary[]): ApiClient {
  const unexpected = (label: string) =>
    vi.fn(async () => {
      throw new Error(`Unexpected ${label}`);
    });
  return {
    get: unexpected("GET"),
    post: unexpected("POST"),
    patch: unexpected("PATCH"),
    getHealth: vi.fn(async () => ({ ok: true })),
    getSessions: vi.fn(async () => ({ sessions })),
    getSession: unexpected("session detail"),
    getProfile: vi.fn(async () => ({ entries: [] })),
    getRules: vi.fn(async () => ({ rules: [] })),
    getRevisions: vi.fn(async () => ({ revisions })),
  };
}

function renderList(client: ApiClient): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RevisionList client={client} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("RevisionList", () => {
  it("shows actor, reason, prior and new values with the recording timestamp", async () => {
    renderList(createMockClient([USER_RELOCATION_REVISION, INFERRED_CITY_REVISION], []));

    expect(await screen.findByText(REASON_INFERRED)).toBeTruthy();
    expect(screen.getByText(REASON_USER)).toBeTruthy();
    expect(screen.getByText(/changed by Agent/)).toBeTruthy();
    expect(screen.getByText(/changed by You/)).toBeTruthy();
    expect(screen.getAllByText("Prior value")).toHaveLength(2);
    expect(screen.getAllByText("New value")).toHaveLength(2);
    expect(screen.getByText("Munich")).toBeTruthy();
    // Berlin is both the inference's new value and the correction's prior value.
    expect(screen.getAllByText("Berlin")).toHaveLength(2);
    expect(screen.getByText("London")).toBeTruthy();
    expect(screen.getByText(TRACE_ID.slice(0, 8))).toBeTruthy();
    expect(screen.getByText(/changed by Agent/).textContent).toContain(new Date(TS).toLocaleString());
  });

  it("links each revision to the session that caused it", async () => {
    renderList(
      createMockClient(
        [INFERRED_CITY_REVISION, USER_RELOCATION_REVISION, ORPHAN_REVISION],
        [CHROME_SESSION],
      ),
    );

    const sessionButton = await screen.findByRole("button", { name: /chrome session started/ });
    expect(sessionButton.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(SESSION_ID)).toBeNull();

    fireEvent.click(sessionButton);

    expect(sessionButton.getAttribute("aria-expanded")).toBe("true");
    const sessionDetail = screen.getByText(/· ended/);
    expect(sessionDetail.textContent).toContain(SESSION_ID);
    expect(sessionDetail.textContent).toContain(CHROME_SESSION.postingUrl ?? "");

    fireEvent.click(sessionButton);
    expect(screen.queryByText(SESSION_ID)).toBeNull();

    // A direct user edit has no source session to link.
    expect(screen.getByText("No source session, direct edit")).toBeTruthy();

    // An unknown session id stays inspectable even without a stored summary.
    const orphanButton = screen.getByRole("button", { name: /^Session 0bb7a1c0/ });
    fireEvent.click(orphanButton);
    expect(screen.getByText(ORPHAN_SESSION_ID)).toBeTruthy();
    expect(screen.getByText(/no stored session summary/)).toBeTruthy();
  });

  it("shows the empty state before any revision exists", async () => {
    renderList(createMockClient([], []));

    expect(await screen.findByText(/No revisions yet/)).toBeTruthy();
  });

  it("surfaces an unavailable revision history", async () => {
    const client = createMockClient([], []);
    client.getRevisions = vi.fn(async () => {
      throw new Error("database is closed");
    });
    renderList(client);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Revision history unavailable: database is closed/)).toBeTruthy();
  });
});
