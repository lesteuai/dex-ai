// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  RehearsalActionRecord,
  RehearsalDecisionRequest,
  RehearsalRecord,
  SessionSummary,
  SessionTimelineItem,
} from "@dex-ai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client";
import { RehearsalObserver } from "./RehearsalObserver";

const TS = "2026-11-21T10:00:00.000Z";
const CHROME_SESSION_ID = "0197a0f0-0000-7000-8000-000000000101";
const SESSION_ID = "0197a0f0-0000-7000-8000-000000000102";
const REHEARSAL_ID = "0197a0f0-0000-7000-8000-000000000201";
const ACTION_ID = "0197a0f0-0000-7000-8000-000000000301";
const BLOCKED_ACTION_ID = "0197a0f0-0000-7000-8000-000000000302";
const TRACE_ID = "0197a0f0-0000-7000-8000-000000000401";
const POSTING_URL = "https://jobs.example.com/postings/42/apply";
const DECISIONS_PATH = `/rehearsals/${REHEARSAL_ID}/decisions`;
const PAUSED_NOTE =
  "The rehearsal is paused, including after a disconnect. Nothing executes until you explicitly resume it.";
const REASONING = "The observed session filled the first name field with the profile name.";

/** Decision types the rehearsal decision route supports. */
const SUPPORTED_DECISION_TYPES = new Set(["approve", "correct", "reject", "pause", "resume"]);

type RehearsalView = { rehearsal: RehearsalRecord; actions: RehearsalActionRecord[] };

function makeSessionSummary(): SessionSummary {
  return {
    id: SESSION_ID,
    browserKind: "firefox",
    sourceUrl: "https://jobs.example.com/search?q=typescript",
    postingUrl: POSTING_URL,
    status: "active",
    startedAt: TS,
    endedAt: null,
  };
}

function makeSessions(): SessionSummary[] {
  return [
    {
      id: CHROME_SESSION_ID,
      browserKind: "chrome",
      sourceUrl: "https://jobs.example.com/search?q=typescript",
      postingUrl: null,
      status: "ended",
      startedAt: TS,
      endedAt: TS,
    },
    makeSessionSummary(),
  ];
}

function makeRehearsal(overrides: Partial<RehearsalRecord> = {}): RehearsalRecord {
  return {
    id: REHEARSAL_ID,
    sessionId: SESSION_ID,
    postingUrl: POSTING_URL,
    browserKind: "firefox",
    status: "running",
    confidenceThreshold: 0.8,
    currentActionId: ACTION_ID,
    startedAt: TS,
    ...overrides,
  };
}

function makeAction(overrides: Partial<RehearsalActionRecord> = {}): RehearsalActionRecord {
  return {
    id: ACTION_ID,
    rehearsalId: REHEARSAL_ID,
    sequence: 1,
    action: { kind: "fill", selector: "#first-name", value: "Ada" },
    confidence: 0.6,
    status: "proposed",
    traceId: TRACE_ID,
    createdAt: TS,
    ...overrides,
  };
}

/** Timeline trace that carries the reasoning behind the proposed action. */
const timeline: SessionTimelineItem[] = [
  {
    kind: "trace",
    trace: {
      id: TRACE_ID,
      taskId: null,
      sessionId: SESSION_ID,
      eventId: null,
      step: 0,
      reasoning: REASONING,
      confidence: 0.6,
      createdAt: TS,
    },
  },
];

/** Mock client answering only the endpoints the panel touches. */
function createMockClient(view: RehearsalView) {
  const getSessions = vi.fn(async () => ({ sessions: makeSessions() }));
  const getSession = vi.fn(async () => ({ session: makeSessionSummary(), timeline }));
  const get = vi.fn(async (path: string): Promise<unknown> => {
    if (path === `/rehearsals/${REHEARSAL_ID}`) return view;
    throw new Error(`Unexpected GET ${path}`);
  });
  const post = vi.fn(async (path: string, body: unknown): Promise<unknown> => {
    if (path === "/rehearsals") return { rehearsal: view.rehearsal };
    const decision = body as RehearsalDecisionRequest;
    if (path === DECISIONS_PATH && SUPPORTED_DECISION_TYPES.has(decision.type)) {
      return { rehearsal: view.rehearsal };
    }
    throw new Error(`Unexpected POST ${path}`);
  });
  return { client: { getSessions, getSession, get, post } as unknown as ApiClient, post };
}

function makeBlockedAttemptView(): RehearsalView {
  const executedFill = makeAction({ sequence: 1, status: "executed" });
  const blockedClick = makeAction({
    id: BLOCKED_ACTION_ID,
    sequence: 2,
    action: { kind: "click_non_submit", selector: "#apply-button" },
    confidence: 0.95,
    status: "blocked",
  });
  return {
    rehearsal: makeRehearsal({ currentActionId: BLOCKED_ACTION_ID }),
    actions: [executedFill, blockedClick],
  };
}

function renderObserver(client: ApiClient): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RehearsalObserver client={client} />
    </QueryClientProvider>,
  );
}

/** Starts the rehearsal and waits for the active view with the given status heading. */
async function renderStartedRehearsal(view: RehearsalView, statusHeading: string) {
  const { client, post } = createMockClient(view);
  renderObserver(client);
  const start = (await screen.findByRole("button", { name: "Start rehearsal" })) as HTMLButtonElement;
  await waitFor(() => expect(start.disabled).toBe(false));
  fireEvent.click(start);
  await screen.findByText(statusHeading);
  return post;
}

describe("RehearsalObserver", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows the low-confidence pause before execution with reasoning and decision controls", async () => {
    const view = { rehearsal: makeRehearsal({ status: "paused" }), actions: [makeAction()] };
    await renderStartedRehearsal(view, "Paused rehearsal");

    expect(screen.getByText(PAUSED_NOTE)).toBeTruthy();
    expect(
      screen.getByText("Low confidence paused this action before execution. Approve, correct or reject it."),
    ).toBeTruthy();
    expect(screen.getByText(/firefox rehearsal of/)).toBeTruthy();
    expect(screen.getByText('#1 fill #first-name with "Ada"')).toBeTruthy();
    expect(screen.getByText("proposed (current)")).toBeTruthy();
    expect(screen.getByText("confidence 0.60")).toBeTruthy();
    expect(screen.getByText("below the threshold")).toBeTruthy();
    // The reasoning trace arrives with the session timeline, one query after the rehearsal view.
    expect(await screen.findByText(`Reasoning: ${REASONING}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply correction" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });

  it("sends a correct decision carrying the corrected action payload", async () => {
    const view = { rehearsal: makeRehearsal({ status: "paused" }), actions: [makeAction()] };
    const post = await renderStartedRehearsal(view, "Paused rehearsal");

    fireEvent.change(screen.getByLabelText("selector"), { target: { value: "#full-name" } });
    fireEvent.change(screen.getByLabelText("value"), { target: { value: "Ada Lovelace" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply correction" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(DECISIONS_PATH, {
        type: "correct",
        actionId: ACTION_ID,
        action: { kind: "fill", selector: "#full-name", value: "Ada Lovelace" },
      }),
    );
    expect(screen.queryByText(/failed/)).toBeNull();
  });

  it("sends a reject decision for the current proposed action", async () => {
    const view = { rehearsal: makeRehearsal({ status: "paused" }), actions: [makeAction()] };
    const post = await renderStartedRehearsal(view, "Paused rehearsal");

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(DECISIONS_PATH, { type: "reject", actionId: ACTION_ID }),
    );
    expect(screen.queryByText(/failed/)).toBeNull();
  });

  it("requires an explicit resume while the rehearsal is paused", async () => {
    const view = { rehearsal: makeRehearsal({ status: "paused" }), actions: [makeAction()] };
    const post = await renderStartedRehearsal(view, "Paused rehearsal");

    expect(screen.getByText(PAUSED_NOTE)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    await waitFor(() => expect(post).toHaveBeenCalledWith(DECISIONS_PATH, { type: "resume" }));
    expect(screen.queryByText(/failed/)).toBeNull();
  });

  it("sends a pause decision from the running rehearsal", async () => {
    const view = { rehearsal: makeRehearsal(), actions: [makeAction({ status: "executed" })] };
    const post = await renderStartedRehearsal(view, "Running rehearsal");

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() => expect(post).toHaveBeenCalledWith(DECISIONS_PATH, { type: "pause" }));
    expect(screen.queryByText(/failed/)).toBeNull();
  });

  it("shows the blocked submission banner and records approval without submitting", async () => {
    const post = await renderStartedRehearsal(makeBlockedAttemptView(), "Running rehearsal");

    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("Blocked submission attempts");
    expect(banner.textContent).toContain("Blocked submission attempt: click #apply-button");
    expect(banner.textContent).toContain("A blocked attempt stays blocked even after approval.");

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(DECISIONS_PATH, {
        type: "approve",
        actionId: BLOCKED_ACTION_ID,
      }),
    );
    expect(screen.queryByText(/failed/)).toBeNull();
  });

  it("exposes no submit control among the panel actions", async () => {
    await renderStartedRehearsal(makeBlockedAttemptView(), "Running rehearsal");

    const names = screen.getAllByRole("button").map((button) => button.textContent ?? "");
    for (const name of names) expect(name.toLowerCase()).not.toContain("submit");
    expect(new Set(names)).toEqual(
      new Set(["Start rehearsal", "Pause", "Approve", "Reject", "Apply correction"]),
    );
  });

  it("sends the expected start request with and without a confidence threshold", async () => {
    const { client, post } = createMockClient({ rehearsal: makeRehearsal(), actions: [] });
    renderObserver(client);
    const start = (await screen.findByRole("button", { name: "Start rehearsal" })) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));

    fireEvent.click(start);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/rehearsals", {
        sessionId: SESSION_ID,
        postingUrl: POSTING_URL,
      }),
    );

    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Confidence threshold (optional)"), { target: { value: "9" } });
    fireEvent.click(start);
    expect(screen.getByText("The confidence threshold must be a number between 0 and 1")).toBeTruthy();
    expect(post).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Confidence threshold (optional)"), { target: { value: "0.75" } });
    fireEvent.click(start);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/rehearsals", {
        sessionId: SESSION_ID,
        postingUrl: POSTING_URL,
        confidenceThreshold: 0.75,
      }),
    );
    expect(post).toHaveBeenCalledTimes(2);
  });
});
