// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProfileEntry, Revision, Rule, SessionSummary } from "@dex-ai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileEditor } from "./ProfileEditor";

const TOKEN = "t".repeat(64);
const TS = "2026-11-21T10:00:00.000Z";
const SESSION_ID = "0197a1b0-0000-7000-8000-000000000001";
const RULE_SESSION_ID = "0197a1b0-0000-7000-8000-000000000002";
const EVENT_ID = "0197a1b0-0000-7000-8000-0000000000e1";
const ENTRY_FACTS_ID = "0197a1b0-0000-7000-8000-000000000101";
const ENTRY_SOURCES_ID = "0197a1b0-0000-7000-8000-000000000102";
const ENTRY_PREFERENCES_ID = "0197a1b0-0000-7000-8000-000000000103";
const ENTRY_CRITERIA_ID = "0197a1b0-0000-7000-8000-000000000104";
const ENTRY_FORM_RULES_ID = "0197a1b0-0000-7000-8000-000000000105";
const RULE_ID = "0197a1b0-0000-7000-8000-000000000201";
const REVISION_ID = "0197a1b0-0000-7000-8000-000000000301";
const TRACE_ID = "0aa7a1b0-0000-7000-8000-000000000401";

const REASONING = "Every observed application filled the full name with the same value.";

/** One entry per supported section, as an observed session would infer them. */
const ALL_SECTION_ENTRIES: ProfileEntry[] = [
  {
    id: ENTRY_FACTS_ID,
    section: "user_facts",
    key: "full_name",
    value: "Ada Lovelace",
    confidence: 0.92,
    status: "inferred",
    sourceEventIds: [EVENT_ID],
    updatedAt: TS,
  },
  {
    id: ENTRY_SOURCES_ID,
    section: "job_sources",
    key: "preferred_board",
    value: "https://jobs.example.com",
    confidence: 0.8,
    status: "inferred",
    sourceEventIds: [EVENT_ID],
    updatedAt: TS,
  },
  {
    id: ENTRY_PREFERENCES_ID,
    section: "preferences",
    key: "work_mode",
    value: "remote",
    confidence: 0.75,
    status: "inferred",
    sourceEventIds: [EVENT_ID],
    updatedAt: TS,
  },
  {
    id: ENTRY_CRITERIA_ID,
    section: "criteria",
    key: "min_base_salary_usd",
    value: 90000,
    confidence: 0.6,
    status: "inferred",
    sourceEventIds: [EVENT_ID],
    updatedAt: TS,
  },
  {
    id: ENTRY_FORM_RULES_ID,
    section: "form_rules",
    key: "email_field",
    value: "use profile email",
    confidence: 0.5,
    status: "inferred",
    sourceEventIds: [EVENT_ID],
    updatedAt: TS,
  },
];

const EMAIL_FILL_RULE: Rule = {
  id: RULE_ID,
  scope: "form#email",
  condition: { fieldType: "email" },
  action: { kind: "fill", source: "profile.email" },
  confidence: 0.7,
  status: "inferred",
  sourceSessionId: RULE_SESSION_ID,
  contributingRuleIds: [],
  updatedAt: TS,
};

const FULL_NAME_REVISION: Revision = {
  id: REVISION_ID,
  entityType: "profile",
  entityId: ENTRY_FACTS_ID,
  sourceSessionId: SESSION_ID,
  traceId: TRACE_ID,
  actor: "agent",
  before: null,
  after: "Ada Lovelace",
  reason: REASONING,
  createdAt: TS,
};

const CHROME_SESSION: SessionSummary = {
  id: SESSION_ID,
  browserKind: "chrome",
  sourceUrl: "https://jobs.example.com/search",
  postingUrl: null,
  status: "ended",
  startedAt: TS,
  endedAt: TS,
};

const FIREFOX_SESSION: SessionSummary = {
  id: RULE_SESSION_ID,
  browserKind: "firefox",
  sourceUrl: "https://jobs.example.com/search",
  postingUrl: null,
  status: "ended",
  startedAt: "2026-11-21T09:00:00.000Z",
  endedAt: "2026-11-21T09:30:00.000Z",
};

interface ApiFixture {
  entries: ProfileEntry[];
  rules: Rule[];
  revisions: Revision[];
  sessions: SessionSummary[];
  inferenceEntries: ProfileEntry[];
}

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };
type FetchMock = ReturnType<typeof createApiFetch>;

function makeApiData(entries: ProfileEntry[], overrides: Partial<ApiFixture> = {}): ApiFixture {
  return {
    entries,
    rules: [EMAIL_FILL_RULE],
    revisions: [FULL_NAME_REVISION],
    sessions: [CHROME_SESSION, FIREFOX_SESSION],
    inferenceEntries: [ALL_SECTION_ENTRIES[0]],
    ...overrides,
  };
}

/** Global-fetch stub routing the endpoints the panel touches; no control plane runs. */
function createApiFetch(data: ApiFixture) {
  return vi.fn(async (url: string, init?: FetchInit) => {
    const method = init?.method ?? "GET";
    const respond = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (method === "GET" && url === "/api/profile") return respond({ entries: data.entries });
    if (method === "GET" && url === "/api/rules") return respond({ rules: data.rules });
    if (method === "GET" && url === "/api/revisions") return respond({ revisions: data.revisions });
    if (method === "GET" && url === "/api/sessions") return respond({ sessions: data.sessions });
    if (method === "POST" && url === "/api/profile/inference") {
      return respond({ entries: data.inferenceEntries });
    }
    if (method === "PATCH" && url === `/api/profile/${ENTRY_FACTS_ID}`) {
      return respond({ entry: data.entries[0] });
    }
    if (method === "PATCH" && url === `/api/rules/${RULE_ID}`) return respond({ rule: data.rules[0] });
    throw new Error(`Unexpected ${method} ${url}`);
  });
}

function findCalls(fetchMock: FetchMock, url: string, method: string): FetchInit[] {
  return fetchMock.mock.calls
    .filter(([callUrl, init]) => callUrl === url && init?.method === method)
    .map(([, init]) => init as FetchInit);
}

function parseBody(init: FetchInit): unknown {
  return JSON.parse(String(init.body));
}

function renderPanel(data: ApiFixture): FetchMock {
  const fetchMock = createApiFetch(data);
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ProfileEditor token={TOKEN} />
    </QueryClientProvider>,
  );
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProfileEditor", () => {
  it("renders every supported section with its entries, rules and source events", async () => {
    renderPanel(makeApiData(ALL_SECTION_ENTRIES));

    expect(await screen.findByText("full_name")).toBeTruthy();
    for (const heading of [
      "Facts about you",
      "Job-source habits",
      "Preferences",
      "Criteria",
      "Form-filling rules",
    ]) {
      expect(screen.getByRole("heading", { level: 3, name: heading })).toBeTruthy();
    }
    // The entry value also appears as the revision history's new value.
    expect(screen.getAllByText("Ada Lovelace")).toHaveLength(2);
    expect(screen.getByText("preferred_board")).toBeTruthy();
    expect(screen.getByText("work_mode")).toBeTruthy();
    expect(screen.getByText("min_base_salary_usd")).toBeTruthy();
    expect(screen.getByText("email_field")).toBeTruthy();
    // Every entry links the same source event, so five links render.
    expect(screen.getAllByText(EVENT_ID)).toHaveLength(5);
    expect(screen.getByText("form#email")).toBeTruthy();
    expect(screen.getByText(/70% confidence/)).toBeTruthy();
  });

  it("shows a section with no supported entries as empty by design", async () => {
    renderPanel(
      makeApiData(ALL_SECTION_ENTRIES.filter((entry) => entry.id !== ENTRY_CRITERIA_ID)),
    );

    expect(await screen.findByText(/Empty by design/)).toBeTruthy();
    expect(screen.getAllByText(/Empty by design/)).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 3, name: "Criteria" })).toBeTruthy();
    expect(screen.queryByText("min_base_salary_usd")).toBeNull();
    expect(screen.getByText("full_name")).toBeTruthy();
  });

  it("sends entry corrections to PATCH /api/profile/:id", async () => {
    const fetchMock = renderPanel(makeApiData(ALL_SECTION_ENTRIES));

    fireEvent.click((await screen.findAllByRole("button", { name: "Correct value" }))[0]);
    fireEvent.change(screen.getByLabelText(/New value/), {
      target: { value: "Ada King, Countess of Lovelace" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));

    await waitFor(() =>
      expect(findCalls(fetchMock, `/api/profile/${ENTRY_FACTS_ID}`, "PATCH")).toHaveLength(1),
    );
    const corrections = findCalls(fetchMock, `/api/profile/${ENTRY_FACTS_ID}`, "PATCH");
    expect(parseBody(corrections[0])).toEqual({ value: "Ada King, Countess of Lovelace" });
    expect(corrections[0].headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Mark confirmed" })[0]);

    await waitFor(() =>
      expect(findCalls(fetchMock, `/api/profile/${ENTRY_FACTS_ID}`, "PATCH")).toHaveLength(2),
    );
    const confirmations = findCalls(fetchMock, `/api/profile/${ENTRY_FACTS_ID}`, "PATCH");
    expect(parseBody(confirmations[1])).toEqual({ status: "confirmed" });
  });

  it("sends a rule edit to PATCH /api/rules/:id", async () => {
    const fetchMock = renderPanel(makeApiData(ALL_SECTION_ENTRIES));

    fireEvent.click(await screen.findByRole("button", { name: "Edit rule" }));
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "form#cover-letter" } });
    fireEvent.change(screen.getByLabelText("Confidence (0 to 1)"), { target: { value: "0.95" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));

    await waitFor(() => expect(findCalls(fetchMock, `/api/rules/${RULE_ID}`, "PATCH")).toHaveLength(1));
    const edits = findCalls(fetchMock, `/api/rules/${RULE_ID}`, "PATCH");
    expect(parseBody(edits[0])).toEqual({
      scope: "form#cover-letter",
      condition: { fieldType: "email" },
      action: { kind: "fill", source: "profile.email" },
      confidence: 0.95,
    });
  });

  it("expands the reasoning trace with actor, trace id and source session", async () => {
    renderPanel(makeApiData(ALL_SECTION_ENTRIES));

    const toggle = await screen.findByRole("button", { name: "Show reasoning" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    // The reasoning also appears in the revision history section below.
    expect(screen.getAllByText(REASONING)).toHaveLength(2);
    expect(screen.getByText("Changed by")).toBeTruthy();
    expect(screen.getByText("Agent")).toBeTruthy();
    expect(screen.getByText(TRACE_ID)).toBeTruthy();
    expect(screen.getByText(SESSION_ID)).toBeTruthy();
    expect(screen.getByText("Recorded")).toBeTruthy();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // Only the revision history copy remains once the trace is collapsed.
    expect(screen.getAllByText(REASONING)).toHaveLength(1);  });

  it("posts profile inference for the selected session", async () => {
    const fetchMock = renderPanel(makeApiData(ALL_SECTION_ENTRIES));

    await screen.findByRole("option", { name: /chrome session started/ });
    const runButton = screen.getByRole("button", { name: "Run profile inference" });
    expect(runButton.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("Infer from session"), { target: { value: SESSION_ID } });
    fireEvent.click(runButton);

    await waitFor(() => expect(findCalls(fetchMock, "/api/profile/inference", "POST")).toHaveLength(1));
    const posts = findCalls(fetchMock, "/api/profile/inference", "POST");
    expect(parseBody(posts[0])).toEqual({ sessionId: SESSION_ID });
    expect(await screen.findByText(/Inference stored 1 entries/)).toBeTruthy();
  });
});
