// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SessionSummary, SessionTimelineItem } from "@dex-ai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ApiClient, queryKeys } from "../api/client";
import { SessionTimeline } from "./SessionTimeline";

const SESSION_ACTIVE: SessionSummary = {
  id: "11111111-1111-4111-8111-111111111111",
  browserKind: "chrome",
  sourceUrl: "https://jobs.example.com/search",
  postingUrl: null,
  status: "active",
  startedAt: "2026-11-21T10:00:00Z",
  endedAt: null,
};

const SESSION_ENDED: SessionSummary = {
  id: "22222222-2222-4222-8222-222222222222",
  browserKind: "firefox",
  sourceUrl: "https://jobs.example.com/search",
  postingUrl: null,
  status: "ended",
  startedAt: "2026-11-21T11:30:00Z",
  endedAt: "2026-11-21T11:45:00Z",
};

const FIELD_FILLED_EVENT_ITEM: SessionTimelineItem = {
  kind: "event",
  event: {
    type: "field_filled",
    id: "77777777-7777-4777-8777-777777777777",
    ts: "2026-11-21T10:00:10Z",
    payload: {
      pageUrl: "https://jobs.example.com/apply/42",
      selector: "#email",
      label: "Email",
      fieldType: "email",
      value: "ada@example.com",
    },
  },
};

const CITY_REVISION_ITEM: SessionTimelineItem = {
  kind: "revision",
  revision: {
    id: "44444444-4444-4444-8444-444444444444",
    entityType: "profile",
    entityId: "11111111-1111-4111-8111-111111111100",
    sourceSessionId: SESSION_ACTIVE.id,
    traceId: null,
    actor: "user",
    before: "Munich",
    after: "Berlin",
    reason: "City should be Berlin.",
    createdAt: "2026-11-21T10:00:20Z",
  },
};

const NAVIGATE_REHEARSAL_ITEM: SessionTimelineItem = {
  kind: "rehearsal_action",
  action: {
    id: "55555555-5555-4555-8555-555555555555",
    rehearsalId: "66666666-6666-4666-8666-666666666666",
    sequence: 1,
    action: { kind: "navigate", url: "https://jobs.example.com/postings/42" },
    confidence: 0.8,
    status: "executed",
    traceId: null,
    createdAt: "2026-11-21T10:00:30Z",
  },
};

const EMAIL_TRACE_ITEM: SessionTimelineItem = {
  kind: "trace",
  trace: {
    id: "33333333-3333-4333-8333-333333333333",
    taskId: null,
    sessionId: SESSION_ACTIVE.id,
    eventId: "77777777-7777-4777-8777-777777777777",
    step: 2,
    input: { selector: "#email" },
    reasoning: "Prefer postings that mention the tech stack.",
    output: { value: "ada@example.com" },
    confidence: 0.9,
    createdAt: "2026-11-21T10:00:40Z",
  },
};

const REMOTE_REASON_EVENT_ITEM: SessionTimelineItem = {
  kind: "event",
  event: {
    type: "reason_stated",
    id: "88888888-8888-4888-8888-888888888888",
    ts: "2026-11-21T10:02:00Z",
    payload: { input: "text", text: "I want fully remote roles." },
  },
};

/** Reverse chronological on purpose: the panel must sort before rendering. */
const UNSORTED_TIMELINE: SessionTimelineItem[] = [
  EMAIL_TRACE_ITEM,
  NAVIGATE_REHEARSAL_ITEM,
  CITY_REVISION_ITEM,
  FIELD_FILLED_EVENT_ITEM,
];

function createMockClient(
  sessions: SessionSummary[],
  timelineFor: (sessionId: string) => SessionTimelineItem[],
): { client: ApiClient; getSession: ReturnType<typeof vi.fn> } {
  const getSession = vi.fn(async (sessionId: string) => {
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (session === undefined) throw new Error(`Unknown session ${sessionId}`);
    return { session, timeline: timelineFor(sessionId) };
  });
  const client: ApiClient = {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    getHealth: vi.fn(async () => ({ ok: true })),
    getSessions: vi.fn(async () => ({ sessions })),
    getSession,
    getProfile: vi.fn(async () => ({ entries: [] })),
    getRules: vi.fn(async () => ({ rules: [] })),
    getRevisions: vi.fn(async () => ({ revisions: [] })),
  };
  return { client, getSession };
}

function renderPanel(client: ApiClient, queryClient: QueryClient = new QueryClient()): void {
  render(
    <QueryClientProvider client={queryClient}>
      <SessionTimeline client={client} />
    </QueryClientProvider>,
  );
}

function entryTexts(): string[] {
  return screen.getAllByRole("article").map((entry) => entry.textContent ?? "");
}

afterEach(cleanup);

describe("SessionTimeline", () => {
  it("shows the empty state when no session is selected", async () => {
    const { client } = createMockClient([SESSION_ACTIVE], () => []);
    renderPanel(client);

    await waitFor(() => expect(screen.getByRole("button", { name: /^chrome/ })).toBeTruthy());

    expect(screen.getByText(/Select a session to see its events/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Timeline for session/)).toBeNull();
  });

  it("tells the user to record a session when none are stored", async () => {
    const { client } = createMockClient([], () => []);
    renderPanel(client);

    expect(
      await screen.findByText(/No sessions captured yet/),
    ).toBeTruthy();
  });

  it("loads the selected session's detail", async () => {
    const { client, getSession } = createMockClient([SESSION_ACTIVE, SESSION_ENDED], (sessionId) =>
      sessionId === SESSION_ENDED.id ? [CITY_REVISION_ITEM] : UNSORTED_TIMELINE,
    );
    renderPanel(client);

    fireEvent.click(await screen.findByRole("button", { name: /^firefox/ }));

    expect(getSession).toHaveBeenCalledWith(SESSION_ENDED.id);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("City should be Berlin.")).toBeTruthy();
    expect(screen.getByText(/firefox session · ended/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^firefox/ }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: /^chrome/ }).getAttribute("aria-current")).toBe("false");
  });

  it("orders events, corrections, rehearsal actions and traces chronologically", async () => {
    const { client } = createMockClient([SESSION_ACTIVE], () => UNSORTED_TIMELINE);
    renderPanel(client);

    fireEvent.click(await screen.findByRole("button", { name: /^chrome/ }));

    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(4));
    const texts = entryTexts();
    expect(texts[0]).toContain('Filled Email with "ada@example.com"');
    expect(texts[1]).toContain("Correction on profile");
    expect(texts[2]).toContain("Navigate to https://jobs.example.com/postings/42 (executed, 80%)");
    expect(texts[3]).toContain("Trace step 2");
  });

  it("expands and collapses trace detail", async () => {
    const { client } = createMockClient([SESSION_ACTIVE], () => [EMAIL_TRACE_ITEM]);
    renderPanel(client);

    fireEvent.click(await screen.findByRole("button", { name: /^chrome/ }));

    const toggle = await screen.findByRole("button", { name: /Trace step 2/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Prefer postings that mention the tech stack.")).toBeNull();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Prefer postings that mention the tech stack.")).toBeTruthy();
    expect(screen.getByText("Input")).toBeTruthy();
    expect(screen.getByText("Output")).toBeTruthy();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Prefer postings that mention the tech stack.")).toBeNull();
  });

  it("inserts live events through query invalidation without a reload", async () => {
    // The mock closes over this array, like the control plane's growing store.
    const timeline: SessionTimelineItem[] = [EMAIL_TRACE_ITEM];
    const { client, getSession } = createMockClient([SESSION_ACTIVE], () => [...timeline]);
    const queryClient = new QueryClient();
    renderPanel(client, queryClient);

    fireEvent.click(await screen.findByRole("button", { name: /^chrome/ }));

    await waitFor(() => expect(screen.getByText(/chrome session · live now/)).toBeTruthy());

    // Expanded traces keep their expansion only if the panel never remounts.
    const toggle = await screen.findByRole("button", { name: /Trace step 2/ });
    fireEvent.click(toggle);
    expect(screen.getByText("Prefer postings that mention the tech stack.")).toBeTruthy();

    const callsBeforeInvalidation = getSession.mock.calls.length;
    timeline.push(REMOTE_REASON_EVENT_ITEM);

    await act(async () => {
      // Same invalidation useDexStream performs on session.updated events.
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    });

    expect(getSession.mock.calls.length).toBeGreaterThan(callsBeforeInvalidation);
    // Refetched data reaches React on a later scheduler tick, so await it.
    expect(await screen.findByText("Reason by text: I want fully remote roles.")).toBeTruthy();
    expect(screen.getByText("Prefer postings that mention the tech stack.")).toBeTruthy();

    const texts = entryTexts();
    expect(texts[0]).toContain("Trace step 2");
    expect(texts[1]).toContain("Reason by text: I want fully remote roles.");
  });
});
