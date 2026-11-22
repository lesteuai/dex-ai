import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  E2E_REPO_ROOT,
  E2E_TOKEN,
  E2E_WS_PROTOCOL,
  e2eOrigins,
  type E2eBrowserName,
} from "../playwright.config";
import { fixtureEventIds } from "../../../apps/control-plane/src/agent/deterministic-adapter";

const TEMP_ROOT = "/tmp/opencode";
const RESTART_TOKEN =
  "restart5f8a2c91d4e7b6a3c0f1e2d3b4a5968776543210ffeeddccbbaa9988776655";
const RESTART_SESSION_ID = "7ea1b2c3-0000-4000-8000-0000000000c7";
const CORRECTED_NAME = "Jordan Corinne Lee";
const TEACHING_TRANSCRIPT = "Always answer the salary question with the stored range.";
const EDITED_TRANSCRIPT =
  "Edited transcript: always answer the salary question with the stored range.";
const VOICE_TRANSCRIPT = "Always skip postings that hide the salary range.";

const fixtureSessionIds = {
  chromium: "6ea7f111-0000-4000-8000-0000000000c1",
  firefox: "6ea7f222-0000-4000-8000-0000000000f2",
} as const;

function originFor(browserName: string): string {
  const origin = e2eOrigins[browserName as E2eBrowserName];
  if (origin === undefined) throw new Error(`No e2e origin configured for browser ${browserName}`);
  return origin;
}

function apiUrl(browserName: string, path: string): string {
  return `${originFor(browserName)}${path}`;
}

async function apiFetch(
  browserName: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(apiUrl(browserName, path), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

async function authorizedFetch(
  browserName: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return apiFetch(browserName, path, {
    ...init,
    headers: { authorization: `Bearer ${E2E_TOKEN}`, ...(init.headers ?? {}) },
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function fixtureEvents(origin: string): Record<string, unknown>[] {
  const applyUrl = `${origin}/fixtures/job/apply.html`;
  return [
    {
      type: "search_filter",
      id: fixtureEventIds.search,
      ts: "2026-11-21T10:00:00.000Z",
      payload: { pageUrl: `${origin}/fixtures/job/search.html`, query: "frontend engineer", filters: {} },
    },
    {
      type: "field_filled",
      id: fixtureEventIds.nameField,
      ts: "2026-11-21T10:01:00.000Z",
      payload: { pageUrl: applyUrl, selector: "#full-name", label: "Full name", value: "Jordan Lee" },
    },
    {
      type: "field_filled",
      id: fixtureEventIds.secondNameField,
      ts: "2026-11-21T10:02:00.000Z",
      payload: { pageUrl: applyUrl, selector: "#full-name", label: "Full name", value: "Jordan Lee" },
    },
    {
      type: "field_filled",
      id: fixtureEventIds.emailField,
      ts: "2026-11-21T10:03:00.000Z",
      payload: { pageUrl: applyUrl, selector: "#email", label: "Email address", value: "jordan.lee@example.com" },
    },
    {
      type: "reason_stated",
      id: fixtureEventIds.coverLetterReason,
      ts: "2026-11-21T10:04:00.000Z",
      payload: { pageUrl: applyUrl, input: "voice", text: "Reuse the stored cover letter paragraph." },
    },
  ];
}

function fixtureSessionId(browserName: string): string {
  return browserName === "firefox" ? fixtureSessionIds.firefox : fixtureSessionIds.chromium;
}

/** Seed the deterministic adapter's scripted session; replays count as duplicates. */
async function seedFixtureSession(browserName: string): Promise<string> {
  const origin = originFor(browserName);
  const sessionId = fixtureSessionId(browserName);
  const response = await authorizedFetch(browserName, "/api/events/batches", {
    method: "POST",
    body: JSON.stringify({
      session: {
        id: sessionId,
        browserKind: browserName === "firefox" ? "firefox" : "chrome",
        sourceUrl: `${origin}/fixtures/job/search.html`,
        postingUrl: `${origin}/fixtures/job/posting.html`,
      },
      events: fixtureEvents(origin),
    }),
  });
  expect(response.status).toBe(200);
  return sessionId;
}

async function sessionTimeline(
  browserName: string,
  sessionId: string,
): Promise<{ kind: string; [key: string]: unknown }[]> {
  const response = await authorizedFetch(browserName, `/api/sessions/${sessionId}`);
  expect(response.status).toBe(200);
  const body = await readJson(response);
  return body.timeline as { kind: string; [key: string]: unknown }[];
}

interface StreamEnvelope {
  type: string;
  payload: { session?: { id: string }; [key: string]: unknown };
}

function streamUrl(origin: string): string {
  return `${origin.replace(/^http/, "ws")}/stream`;
}

async function openStream(origin: string): Promise<WebSocket> {
  const socket = new WebSocket(streamUrl(origin), E2E_WS_PROTOCOL);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out opening the control plane stream")),
      10_000,
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("The control plane rejected the stream connection"));
      },
      { once: true },
    );
  });
  return socket;
}

function readEnvelope(
  socket: WebSocket,
  matches: (envelope: StreamEnvelope) => boolean,
): Promise<StreamEnvelope> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for a stream envelope")),
      15_000,
    );
    const fail = () => {
      clearTimeout(timer);
      reject(new Error("The stream connection dropped before the expected envelope"));
    };
    socket.addEventListener("message", (event) => {
      const envelope = JSON.parse(String(event.data)) as StreamEnvelope;
      if (matches(envelope)) {
        clearTimeout(timer);
        resolve(envelope);
      }
    });
    socket.addEventListener("error", fail, { once: true });
    socket.addEventListener("close", fail, { once: true });
  });
}

/** The upgrade must fail closed: no open event without the token subprotocol. */
async function expectStreamRejected(origin: string): Promise<void> {
  const socket = new WebSocket(streamUrl(origin));
  let opened = false;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for the rejected stream upgrade")),
      10_000,
    );
    const finish = () => {
      clearTimeout(timer);
      if (opened) reject(new Error("The stream opened without a token"));
      else resolve();
    };
    socket.addEventListener(
      "open",
      () => {
        opened = true;
        socket.close();
      },
      { once: true },
    );
    socket.addEventListener("error", finish, { once: true });
    socket.addEventListener("close", finish, { once: true });
  });
}

async function openControlPlaneUi(page: Page, browserName: string): Promise<void> {
  await page.goto(`${originFor(browserName)}/`);
  await page.locator("#token-input").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Open control plane" }).click();
  await expect(page.locator(".stream-status")).toHaveAttribute("data-status", "open");
}

async function assertNoSubmissionRecorded(origin: string): Promise<void> {
  const response = await fetch(`${origin}/fixtures/job/submissions.json`);
  expect(response.status).toBe(200);
  expect((await response.text()).trim()).toBe("[]");
}

/** Minimal 16 kHz mono 16-bit PCM WAV; the recorder route validates the header. */
function buildWav(): Uint8Array {
  const bytes = new Uint8Array(44 + 32);
  const view = new DataView(bytes.buffer);
  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + 32, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, 32, true);
  return bytes;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function spawnControlPlane(home: string): ChildProcess {
  return spawn(join(E2E_REPO_ROOT, "apps/control-plane/node_modules/.bin/tsx"), ["src/index.ts"], {
    cwd: join(E2E_REPO_ROOT, "apps/control-plane"),
    env: { ...process.env, DEX_AI_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForHealth(port: number, child: ChildProcess): Promise<void> {
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Control plane exited early: ${stderr}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: { authorization: `Bearer ${RESTART_TOKEN}` },
      });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Control plane did not become healthy: ${stderr}`);
}

async function stopControlPlane(child: ChildProcess): Promise<void> {
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
  child.kill("SIGTERM");
  const outcome = await Promise.race([
    exited,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
  ]);
  if (outcome === "timeout") child.kill("SIGKILL");
}

test("serves the interface and reports a loopback-only control plane", async ({ browserName, page }) => {
  await page.goto(`${originFor(browserName)}/`);
  await expect(page.getByRole("heading", { name: "Dex AI Control Plane" })).toBeVisible();

  const health = await authorizedFetch(browserName, "/api/health");
  expect(health.status).toBe(200);
  const body = await readJson(health);
  expect(body.ok).toBe(true);
  expect(body.host).toBe("127.0.0.1");
  expect(body.loopback).toBe(true);

  expect((await apiFetch(browserName, "/api/health")).status).toBe(401);
});

test("the token gate rejects an invalid token and stores nothing", async ({ browserName, page }) => {
  await page.goto(`${originFor(browserName)}/`);
  await page.locator("#token-input").fill("0123456789abcdef0123456789abcdef");
  await page.getByRole("button", { name: "Open control plane" }).click();
  await expect(page.getByRole("alert")).toContainText("rejected this token");
  const stored = await page.evaluate(() => window.localStorage.getItem("dex-ai.control-plane-token"));
  expect(stored).toBeNull();
});

test("an authenticated client sees the four panels and the privacy disclosure", async ({ browserName, page }) => {
  await openControlPlaneUi(page, browserName);

  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveCount(4);
  await expect(page.getByRole("tab", { name: "Profile & Rules" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Session Timeline" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Teaching Console" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Rehearsal Observer" })).toBeVisible();
  await page.getByRole("tab", { name: "Session Timeline" }).click();
  await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "tab-session-timeline");

  const notice = page.locator(".privacy-notice");
  await expect(notice).toContainText("LLM prompts are sent to the provider selected in your OpenCode config");
  await expect(notice).toContainText("persist in the local SQLite database");
  await expect(notice).toContainText("Voice audio never leaves this device");
  await expect(notice).toContainText("Dex AI stores no API keys and runs no remote storage service");
});

test("missing or invalid tokens and disallowed origins change no stored state", async ({ browserName }) => {
  const before = await readJson(await authorizedFetch(browserName, "/api/sessions"));

  expect((await apiFetch(browserName, "/api/sessions")).status).toBe(401);
  const invalidToken = await fetch(apiUrl(browserName, "/api/sessions"), {
    headers: { authorization: "Bearer definitely-not-the-configured-token" },
  });
  expect(invalidToken.status).toBe(401);

  const evilOrigin = await authorizedFetch(browserName, "/api/sessions", {
    headers: { origin: "https://attacker.example" },
  });
  expect(evilOrigin.status).toBe(403);
  const evilOriginError = await readJson(evilOrigin);
  expect(evilOriginError.error).toBe("forbidden");

  const extensionOrigin = await authorizedFetch(browserName, "/api/sessions", {
    headers: { origin: "chrome-extension://e2e0chrome0extension0origin0000000000" },
  });
  expect(extensionOrigin.status).toBe(200);

  await expectStreamRejected(originFor(browserName));

  const after = await readJson(await authorizedFetch(browserName, "/api/sessions"));
  expect(after.sessions).toEqual(before.sessions);
});

test("profile inference links entries to source events and leaves unsupported sections empty", async ({ browserName }) => {
  const sessionId = await seedFixtureSession(browserName);

  const inference = await authorizedFetch(browserName, "/api/profile/inference", {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
  expect(inference.status).toBe(200);

  const profile = await readJson(await authorizedFetch(browserName, "/api/profile"));
  const entries = profile.entries as {
    id: string;
    section: string;
    key: string;
    value: unknown;
    sourceEventIds: string[];
  }[];
  const fullName = entries.find((entry) => entry.section === "user_facts" && entry.key === "full_name");
  expect(fullName).toBeDefined();
  expect(fullName?.value).toBe("Jordan Lee");
  expect(fullName?.sourceEventIds).toEqual([fixtureEventIds.nameField, fixtureEventIds.secondNameField]);
  expect(entries.some((entry) => entry.section === "criteria")).toBe(false);

  const timeline = await sessionTimeline(browserName, sessionId);
  const traceItems = timeline.filter((item) => item.kind === "trace");
  const nameTrace = traceItems.find((item) =>
    ((item.trace as { reasoning: string | null }).reasoning ?? "").includes("full name"),
  );
  expect(nameTrace).toBeDefined();
  expect((nameTrace?.trace as { sessionId: string }).sessionId).toBe(sessionId);
  const revisionItems = timeline.filter((item) => item.kind === "revision");
  expect(revisionItems.length).toBeGreaterThan(0);
  expect((revisionItems[0].revision as { actor: string }).actor).toBe("agent");
});

test("a profile correction persists in revision history and wins over later inference", async ({ browserName }) => {
  const sessionId = await seedFixtureSession(browserName);
  const firstRun = await authorizedFetch(browserName, "/api/profile/inference", {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
  expect(firstRun.status).toBe(200);

  const profile = await readJson(await authorizedFetch(browserName, "/api/profile"));
  const entry = (profile.entries as { id: string; key: string; value: unknown }[]).find(
    (candidate) => candidate.key === "full_name",
  );
  expect(entry).toBeDefined();

  const correction = await authorizedFetch(browserName, `/api/profile/${entry?.id}`, {
    method: "PATCH",
    body: JSON.stringify({ value: CORRECTED_NAME, reason: "Middle name belongs in the profile" }),
  });
  expect(correction.status).toBe(200);
  const correctedEntry = (await readJson(correction)).entry as { value: unknown; status: string };
  expect(correctedEntry.value).toBe(CORRECTED_NAME);
  expect(correctedEntry.status).toBe("corrected");

  const secondRun = await authorizedFetch(browserName, "/api/profile/inference", {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
  expect(secondRun.status).toBe(200);
  const afterReinference = await readJson(await authorizedFetch(browserName, "/api/profile"));
  const reInferred = (afterReinference.entries as { key: string; value: unknown; status: string }[]).find(
    (candidate) => candidate.key === "full_name",
  );
  expect(reInferred?.value).toBe(CORRECTED_NAME);
  expect(reInferred?.status).toBe("corrected");

  const revisions = await readJson(
    await authorizedFetch(browserName, "/api/revisions?entityType=profile_entry"),
  );
  const userRevision = (revisions.revisions as {
    entityId: string;
    actor: string;
    reason: string;
    before?: { value: unknown };
    after?: { value: unknown };
    sourceSessionId: string | null;
  }[]).find((candidate) => candidate.entityId === entry?.id && candidate.actor === "user");
  expect(userRevision).toBeDefined();
  expect(userRevision?.before?.value).toBe("Jordan Lee");
  expect(userRevision?.after?.value).toBe(CORRECTED_NAME);
  expect(userRevision?.reason).toContain("Middle name");
});

test("a rule edit creates its own linked revision entry", async ({ browserName }) => {
  const created = await authorizedFetch(browserName, "/api/rules", {
    method: "POST",
    body: JSON.stringify({
      scope: "rehearsal.fill",
      condition: { fieldLabelContains: "salary" },
      action: { fillValueFrom: "profile.salary_range" },
      reason: "E2E rule creation",
    }),
  });
  expect(created.status).toBe(200);
  const rule = (await readJson(created)).rule as { id: string };

  const edited = await authorizedFetch(browserName, `/api/rules/${rule.id}`, {
    method: "PATCH",
    body: JSON.stringify({ confidence: 0.95, reason: "E2E rule confidence update" }),
  });
  expect(edited.status).toBe(200);

  const revisions = await readJson(await authorizedFetch(browserName, "/api/revisions?entityType=rule"));
  const ruleRevisions = (revisions.revisions as { entityId: string; actor: string; reason: string }[]).filter(
    (candidate) => candidate.entityId === rule.id,
  );
  expect(ruleRevisions.length).toBeGreaterThanOrEqual(2);
  expect(ruleRevisions.some((candidate) => candidate.actor === "user")).toBe(true);
  expect(ruleRevisions.every((candidate) => candidate.reason.length > 0)).toBe(true);
});

test("the timeline lists a session's items in chronological order", async ({ browserName }) => {
  const origin = originFor(browserName);
  const sessionId = randomUUID();
  const response = await authorizedFetch(browserName, "/api/events/batches", {
    method: "POST",
    body: JSON.stringify({
      session: { id: sessionId, browserKind: "chrome", postingUrl: `${origin}/fixtures/job/posting.html` },
      events: [
        {
          type: "field_filled",
          id: randomUUID(),
          ts: "2026-11-21T11:05:00.000Z",
          payload: { pageUrl: `${origin}/fixtures/job/apply.html`, selector: "#email", value: "a@example.com" },
        },
        {
          type: "field_filled",
          id: randomUUID(),
          ts: "2026-11-21T11:01:00.000Z",
          payload: { pageUrl: `${origin}/fixtures/job/apply.html`, selector: "#full-name", value: "Jordan Lee" },
        },
      ],
    }),
  });
  expect(response.status).toBe(200);

  const sessions = await readJson(await authorizedFetch(browserName, "/api/sessions"));
  expect(
    (sessions.sessions as { id: string; status: string }[]).some(
      (candidate) => candidate.id === sessionId && candidate.status === "active",
    ),
  ).toBe(true);

  const timeline = await sessionTimeline(browserName, sessionId);
  const eventItems = timeline.filter((item) => item.kind === "event");
  const timestamps = eventItems.map((item) => (item.event as { ts: string }).ts);
  expect(timestamps[0]).toBe("2026-11-21T11:01:00.000Z");
  expect(timestamps[1]).toBe("2026-11-21T11:05:00.000Z");
});

test("the timeline streams live updates while a session is active", async ({ browserName }) => {
  const origin = originFor(browserName);
  const sessionId = await seedFixtureSession(browserName);
  const socket = await openStream(origin);
  try {
    const update = readEnvelope(
      socket,
      (envelope) => envelope.type === "session.updated" && envelope.payload.session?.id === sessionId,
    );

    const response = await authorizedFetch(browserName, "/api/events/batches", {
      method: "POST",
      body: JSON.stringify({
        session: { id: sessionId, browserKind: "chrome", postingUrl: `${origin}/fixtures/job/posting.html` },
        events: [
          {
            type: "field_filled",
            id: randomUUID(),
            ts: "2026-11-21T12:00:00.000Z",
            payload: { pageUrl: `${origin}/fixtures/job/apply.html`, selector: "#phone", value: "555-0100" },
          },
        ],
      }),
    });
    expect(response.status).toBe(200);

    const envelope = await update;
    expect(envelope.payload.session?.id).toBe(sessionId);

    const timeline = await sessionTimeline(browserName, sessionId);
    expect(timeline.some((item) => (item.event as { payload?: { value?: string } })?.payload?.value === "555-0100")).toBe(true);
  } finally {
    socket.close();
  }
});

test("typed teaching becomes a reason event with a normalized reasoning trace", async ({ browserName }) => {
  const sessionId = await seedFixtureSession(browserName);
  const teaching = await authorizedFetch(browserName, "/api/teaching", {
    method: "POST",
    body: JSON.stringify({ text: TEACHING_TRANSCRIPT, sessionId }),
  });
  expect(teaching.status).toBe(200);
  const run = await readJson(teaching);
  expect(run.status).toBe("completed");
  expect(run.draft).toBeNull();

  const timeline = await sessionTimeline(browserName, sessionId);
  const taught = timeline.find(
    (item) => (item.event as { payload?: { text?: string } })?.payload?.text === TEACHING_TRANSCRIPT,
  );
  expect(taught?.kind).toBe("event");
  expect((taught?.event as { id: string }).id).toBe(run.eventId);
  expect((taught?.event as { payload: { input: string } }).payload.input).toBe("text");

  const traceItems = timeline.filter((item) => item.kind === "trace");
  const teachingTrace = traceItems.find((item) =>
    ((item.trace as { reasoning: string | null }).reasoning ?? "").includes("salary"),
  );
  expect(teachingTrace).toBeDefined();
  const output = (teachingTrace?.trace as { output?: { rules?: { scope: string }[] } }).output;
  expect(output?.rules?.[0]?.scope).toBe("rehearsal.fill");
});

test("a voice draft is shown for confirmation before it becomes a teaching event", async ({ browserName }) => {
  const sessionId = await seedFixtureSession(browserName);

  const draftResponse = await authorizedFetch(browserName, "/api/teaching/drafts", {
    method: "POST",
    body: JSON.stringify({ source: "voice", transcript: VOICE_TRANSCRIPT, sessionId }),
  });
  expect(draftResponse.status).toBe(200);
  const draft = (await readJson(draftResponse)).draft as { id: string; status: string; transcript: string };

  const pending = await readJson(await authorizedFetch(browserName, "/api/teaching/drafts"));
  const pendingDrafts = pending.drafts as { id: string; transcript: string }[];
  expect(pendingDrafts.some((candidate) => candidate.id === draft.id && candidate.transcript === VOICE_TRANSCRIPT)).toBe(true);

  let timeline = await sessionTimeline(browserName, sessionId);
  expect(
    timeline.some((item) => (item.event as { payload?: { text?: string } })?.payload?.text === VOICE_TRANSCRIPT),
  ).toBe(false);

  const confirmed = await authorizedFetch(browserName, "/api/teaching", {
    method: "POST",
    body: JSON.stringify({ draftId: draft.id, text: EDITED_TRANSCRIPT }),
  });
  expect(confirmed.status).toBe(200);
  expect((await readJson(confirmed)).status).toBe("completed");

  const stillPending = await readJson(await authorizedFetch(browserName, "/api/teaching/drafts"));
  expect((stillPending.drafts as { id: string }[]).some((candidate) => candidate.id === draft.id)).toBe(false);

  timeline = await sessionTimeline(browserName, sessionId);
  const taught = timeline.find(
    (item) => (item.event as { payload?: { text?: string } })?.payload?.text === EDITED_TRANSCRIPT,
  );
  expect(taught?.kind).toBe("event");
  expect((taught?.event as { payload: { input: string } }).payload.input).toBe("voice");

  const discardedResponse = await authorizedFetch(browserName, "/api/teaching/drafts", {
    method: "POST",
    body: JSON.stringify({ source: "voice", transcript: "Discard this draft.", sessionId }),
  });
  const discardedDraft = (await readJson(discardedResponse)).draft as { id: string };
  const discard = await authorizedFetch(browserName, `/api/teaching/drafts/${discardedDraft.id}/discard`, {
    method: "POST",
  });
  expect(discard.status).toBe(200);
  const reapply = await authorizedFetch(browserName, "/api/teaching", {
    method: "POST",
    body: JSON.stringify({ draftId: discardedDraft.id }),
  });
  expect(reapply.status).toBe(409);
});

test("an unavailable local speech model keeps typed teaching usable", async ({ browserName }) => {
  const response = await authorizedFetch(browserName, "/api/stt/transcribe", {
    method: "POST",
    headers: { "content-type": "audio/wav" },
    body: buildWav(),
  });
  expect(response.status).toBe(503);
  const failure = await readJson(response);
  expect(failure.error).toBe("stt_unavailable");

  const sessionId = await seedFixtureSession(browserName);
  const teaching = await authorizedFetch(browserName, "/api/teaching", {
    method: "POST",
    body: JSON.stringify({ text: TEACHING_TRANSCRIPT, sessionId }),
  });
  expect(teaching.status).toBe(200);
  expect((await readJson(teaching)).status).toBe("completed");
});

test("a low-confidence rehearsal pauses and executes only after approval or correction", async ({ browserName }) => {
  const sessionId = await seedFixtureSession(browserName);

  const started = await authorizedFetch(browserName, "/api/rehearsals", {
    method: "POST",
    body: JSON.stringify({ sessionId, confidenceThreshold: 0.99 }),
  });
  expect(started.status).toBe(200);
  const rehearsal = (await readJson(started)).rehearsal as { id: string; status: string; currentActionId: string };

  const view = await readJson(await authorizedFetch(browserName, `/api/rehearsals/${rehearsal.id}`));
  const actions = view.actions as { id: string; status: string; action: Record<string, unknown>; confidence: number }[];
  expect(actions.length).toBe(3);
  expect(rehearsal.status).toBe("paused");

  const approve = await authorizedFetch(browserName, `/api/rehearsals/${rehearsal.id}/decisions`, {
    method: "POST",
    body: JSON.stringify({ type: "approve", actionId: rehearsal.currentActionId }),
  });
  expect(approve.status).toBe(200);
  expect((await readJson(approve)).rehearsal.status).toBe("running");

  const executed = await authorizedFetch(
    browserName,
    `/api/rehearsals/${rehearsal.id}/actions/${rehearsal.currentActionId}/executed`,
    { method: "POST" },
  );
  expect(executed.status).toBe(200);
  const afterFirst = (await readJson(executed)).rehearsal as { status: string; currentActionId: string };
  expect(afterFirst.status).toBe("paused");

  const correctedAction = { kind: "fill", selector: "#email", value: "corrected.lee@example.com" };
  const correction = await authorizedFetch(browserName, `/api/rehearsals/${rehearsal.id}/decisions`, {
    method: "POST",
    body: JSON.stringify({ type: "correct", actionId: afterFirst.currentActionId, action: correctedAction }),
  });
  expect(correction.status).toBe(200);
  expect((await readJson(correction)).rehearsal.status).toBe("running");

  const afterCorrection = await readJson(await authorizedFetch(browserName, `/api/rehearsals/${rehearsal.id}`));
  const corrected = (afterCorrection.actions as {
    id: string;
    status: string;
    confidence: number;
    action: Record<string, unknown>;
  }[]).find((action) => action.id === afterFirst.currentActionId);
  expect(corrected).toBeDefined();
  expect(corrected?.status).toBe("approved");
  expect(corrected?.confidence).toBe(1);
  expect(corrected?.action).toEqual(correctedAction);
  expect((afterCorrection.actions as { traceId: string | null }[]).every((action) => action.traceId !== null)).toBe(true);

  await assertNoSubmissionRecorded(originFor(browserName));
});

test("an interrupted rehearsal stays paused and every submit attempt is blocked", async ({ browserName }) => {
  const sessionId = await seedFixtureSession(browserName);
  const started = await readJson(
    await authorizedFetch(browserName, "/api/rehearsals", {
      method: "POST",
      body: JSON.stringify({ sessionId, confidenceThreshold: 0.99 }),
    }),
  );
  const rehearsal = started.rehearsal as { id: string; status: string; currentActionId: string };

  const submitCorrection = await authorizedFetch(browserName, `/api/rehearsals/${rehearsal.id}/decisions`, {
    method: "POST",
    body: JSON.stringify({
      type: "correct",
      actionId: rehearsal.currentActionId,
      action: { kind: "navigate", url: `${originFor(browserName)}/fixtures/job/submit-application` },
    }),
  });
  expect(submitCorrection.status).toBe(200);
  const afterBlock = await readJson(await authorizedFetch(browserName, `/api/rehearsals/${rehearsal.id}`));
  const blockedAction = (afterBlock.actions as { id: string; status: string }[]).find(
    (action) => action.id === rehearsal.currentActionId,
  );
  expect(blockedAction?.status).toBe("blocked");

  const approveBlocked = await authorizedFetch(browserName, `/api/rehearsals/${rehearsal.id}/decisions`, {
    method: "POST",
    body: JSON.stringify({ type: "approve", actionId: rehearsal.currentActionId }),
  });
  expect(approveBlocked.status).toBe(409);
  expect((await readJson(approveBlocked)).error).toBe("submit_blocked");

  const submitSchema = await authorizedFetch(browserName, `/api/rehearsals/${rehearsal.id}/decisions`, {
    method: "POST",
    body: JSON.stringify({
      type: "correct",
      actionId: rehearsal.currentActionId,
      action: { kind: "submit", selector: "#submit-application" },
    }),
  });
  expect(submitSchema.status).toBe(400);

  const rejected = await authorizedFetch(browserName, `/api/rehearsals/${rehearsal.id}/decisions`, {
    method: "POST",
    body: JSON.stringify({ type: "reject", actionId: rehearsal.currentActionId }),
  });
  expect(rejected.status).toBe(200);
  const advanced = (await readJson(rejected)).rehearsal as { status: string; currentActionId: string };
  expect(advanced.status).toBe("paused");

  const disconnected = await authorizedFetch(browserName, `/api/rehearsals/${rehearsal.id}/disconnect`, {
    method: "POST",
  });
  expect(((await readJson(disconnected)).rehearsal as { status: string }).status).toBe("paused");

  const executeWhilePaused = await authorizedFetch(
    browserName,
    `/api/rehearsals/${rehearsal.id}/actions/${advanced.currentActionId}/executed`,
    { method: "POST" },
  );
  expect(executeWhilePaused.status).toBe(409);

  const resumed = await authorizedFetch(browserName, `/api/rehearsals/${rehearsal.id}/decisions`, {
    method: "POST",
    body: JSON.stringify({ type: "resume" }),
  });
  expect(resumed.status).toBe(200);
  const running = (await readJson(resumed)).rehearsal as { status: string };
  // The below-threshold proposal pauses again right after the explicit resume.
  expect(running.status).toBe("paused");

  const guardReport = await authorizedFetch(browserName, `/api/rehearsals/${rehearsal.id}/blocked-attempts`, {
    method: "POST",
    body: JSON.stringify({ reason: "submit_control", selector: "#submit-application" }),
  });
  expect(guardReport.status).toBe(200);
  const guardAction = (await readJson(guardReport)).action as { status: string };
  expect(guardAction.status).toBe("blocked");

  const view = await readJson(await authorizedFetch(browserName, `/api/rehearsals/${rehearsal.id}`));
  const storedActions = view.actions as {
    status: string;
    action: { kind: string; url?: string; selector?: string };
  }[];
  expect(storedActions.some((action) => action.status === "blocked")).toBe(true);
  // The stored plan never contains a submit action, even after user corrections.
  expect(
    storedActions.every((action) => action.action.kind !== "submit" && action.action.kind !== "requestSubmit"),
  ).toBe(true);

  await assertNoSubmissionRecorded(originFor(browserName));
});

test("stored state survives a control-plane restart", async () => {
  test.setTimeout(120_000);
  const home = mkdtempSync(join(TEMP_ROOT, "dex-ai-e2e-restart-"));
  const port = await findFreePort();
  const dataDir = join(home, "data");
  writeFileSync(
    join(home, "config.json"),
    `${JSON.stringify(
      {
        host: "127.0.0.1",
        port,
        token: RESTART_TOKEN,
        dataDir,
        extensionOrigins: [],
        localUiOrigin: `http://127.0.0.1:${port}`,
        lowConfidenceThreshold: 0.7,
        parakeetModelPath: join(dataDir, "models", "parakeet-tdt-0.6b-v3-int8"),
        agentKind: "deterministic",
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const restartApi = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${RESTART_TOKEN}`, ...(init.headers ?? {}) },
    });

  let child: ChildProcess | null = null;
  try {
    child = spawnControlPlane(home);
    await waitForHealth(port, child);

    const seed = await restartApi("/api/events/batches", {
      method: "POST",
      body: JSON.stringify({
        session: {
          id: RESTART_SESSION_ID,
          browserKind: "chrome",
          postingUrl: `http://127.0.0.1:${port}/fixtures/job/posting.html`,
        },
        events: fixtureEvents(`http://127.0.0.1:${port}`),
      }),
    });
    expect(seed.status).toBe(200);
    expect((await restartApi("/api/profile/inference", {
      method: "POST",
      body: JSON.stringify({ sessionId: RESTART_SESSION_ID }),
    })).status).toBe(200);
    const profileBefore = await readJson(await restartApi("/api/profile"));
    const entryBefore = (profileBefore.entries as { id: string; key: string }[]).find(
      (candidate) => candidate.key === "full_name",
    );
    expect(entryBefore).toBeDefined();
    const patch = await restartApi(`/api/profile/${entryBefore?.id}`, {
      method: "PATCH",
      body: JSON.stringify({ value: CORRECTED_NAME, reason: "Correction before restart" }),
    });
    expect(patch.status).toBe(200);

    await stopControlPlane(child);
    child = spawnControlPlane(home);
    await waitForHealth(port, child);

    const profileAfter = await readJson(await restartApi("/api/profile"));
    const entryAfter = (profileAfter.entries as { key: string; value: unknown; status: string }[]).find(
      (candidate) => candidate.key === "full_name",
    );
    expect(entryAfter?.value).toBe(CORRECTED_NAME);
    expect(entryAfter?.status).toBe("corrected");

    const sessions = await readJson(await restartApi("/api/sessions"));
    expect(
      (sessions.sessions as { id: string }[]).some((candidate) => candidate.id === RESTART_SESSION_ID),
    ).toBe(true);

    const detail = await readJson(await restartApi(`/api/sessions/${RESTART_SESSION_ID}`));
    const timeline = detail.timeline as { kind: string }[];
    expect(timeline.some((item) => item.kind === "event")).toBe(true);
    expect(timeline.some((item) => item.kind === "trace")).toBe(true);
    expect(timeline.some((item) => item.kind === "revision")).toBe(true);

    const revisions = await readJson(await restartApi("/api/revisions?entityType=profile_entry"));
    const forEntry = (revisions.revisions as {
      entityId: string;
      actor: string;
      reason: string;
      sourceSessionId: string | null;
    }[]).filter((candidate) => candidate.entityId === entryBefore?.id);
    expect(
      forEntry.some((candidate) => candidate.actor === "agent" && candidate.sourceSessionId === RESTART_SESSION_ID),
    ).toBe(true);
    expect(forEntry.some((candidate) => candidate.actor === "user" && candidate.reason.length > 0)).toBe(true);

    await assertNoSubmissionRecorded(`http://127.0.0.1:${port}`);
  } finally {
    if (child !== null && child.exitCode === null) await stopControlPlane(child);
    rmSync(home, { recursive: true, force: true });
  }
});
