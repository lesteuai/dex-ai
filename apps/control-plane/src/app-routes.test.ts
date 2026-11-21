import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ProfileEntry,
  RehearsalActionRecord,
  RehearsalRecord,
  Revision,
  SessionDescriptor,
  TeachingDraft,
} from "@dex-ai/shared";
import {
  TEST_TOKEN,
  closeTestControlPlane,
  fetchApi,
  getSessionTimeline,
  makeFixtureInferenceEvents,
  makeSearchEvent,
  makeSessionDescriptor,
  postEventBatch,
  POSTING_PAGE_URL,
  startTestControlPlane,
  type TestControlPlane,
} from "./test-server";

const TEACHING_TRANSCRIPT = "always answer the salary question with my stored range";

let controlPlane: TestControlPlane;

beforeEach(async () => {
  controlPlane = await startTestControlPlane();
});

afterEach(async () => {
  await closeTestControlPlane(controlPlane);
});

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${controlPlane.baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedSession(events = false): Promise<SessionDescriptor> {
  const session = makeSessionDescriptor();
  const response = await postEventBatch(
    controlPlane,
    session,
    events ? makeFixtureInferenceEvents() : [makeSearchEvent(new Date().toISOString())],
  );
  expect(response.status).toBe(200);
  return session;
}

describe("mounted routes through one authenticated app", () => {
  it("lists empty profile, rules and revision collections on a fresh database", async () => {
    const profile = await fetchApi(controlPlane, "/api/profile");
    expect(profile.status).toBe(200);
    expect(await profile.json()).toEqual({ entries: [] });

    const rules = await fetchApi(controlPlane, "/api/rules");
    expect(rules.status).toBe(200);
    expect(await rules.json()).toEqual({ rules: [] });

    const revisions = await fetchApi(controlPlane, "/api/revisions");
    expect(revisions.status).toBe(200);
    expect(await revisions.json()).toEqual({ revisions: [] });
  });

  it("runs deterministic profile inference end to end over the events API", async () => {
    const session = await seedSession(true);

    const inference = await postJson("/api/profile/inference", { sessionId: session.id });
    expect(inference.status).toBe(200);
    const { entries } = (await inference.json()) as { entries: ProfileEntry[] };
    expect(entries).toHaveLength(4);

    const listed = await fetchApi(controlPlane, "/api/profile");
    expect(((await listed.json()) as { entries: ProfileEntry[] }).entries).toHaveLength(4);

    const revisions = await fetchApi(controlPlane, "/api/revisions");
    const body = (await revisions.json()) as { revisions: Revision[] };
    expect(body.revisions).toHaveLength(4);
    expect(body.revisions.every((revision) => revision.actor === "agent")).toBe(true);
    expect(body.revisions.every((revision) => revision.sourceSessionId === session.id)).toBe(true);
  });

  it("stores, confirms and applies a typed teaching draft through one session", async () => {
    const session = await seedSession();

    const draftResponse = await postJson("/api/teaching/drafts", {
      source: "text",
      transcript: TEACHING_TRANSCRIPT,
      sessionId: session.id,
    });
    expect(draftResponse.status).toBe(200);
    const { draft } = (await draftResponse.json()) as { draft: TeachingDraft };
    expect(draft).toMatchObject({ status: "pending", sessionId: session.id });

    const pending = await fetchApi(controlPlane, "/api/teaching/drafts");
    expect(((await pending.json()) as { drafts: TeachingDraft[] }).drafts.map((item) => item.id)).toContain(
      draft.id,
    );

    const applied = await postJson("/api/teaching", { draftId: draft.id });
    expect(applied.status).toBe(200);
    const run = (await applied.json()) as { status: string; draft: TeachingDraft | null };
    expect(run.status).toBe("completed");
    expect(run.draft).toMatchObject({ id: draft.id, status: "confirmed" });

    // The confirmed transcript becomes one reason_stated event on the timeline.
    const timeline = await getSessionTimeline(controlPlane, session.id);
    const stated = timeline.timeline.filter(
      (item) => item.kind === "event" && item.event.type === "reason_stated",
    );
    expect(stated).toHaveLength(1);
  });

  it("rejects an invalid WAV body without loading the local model", async () => {
    const response = await fetch(`${controlPlane.baseUrl}/api/stt/transcribe`, {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      body: "not a riff header",
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_wav");
  });

  it("starts and inspects a rehearsal planned by the deterministic adapter", async () => {
    const session = await seedSession();

    const started = await postJson("/api/rehearsals", {
      sessionId: session.id,
      postingUrl: POSTING_PAGE_URL,
    });
    expect(started.status).toBe(200);
    const { rehearsal } = (await started.json()) as { rehearsal: RehearsalRecord };
    expect(rehearsal).toMatchObject({ status: "running", postingUrl: POSTING_PAGE_URL });

    const viewResponse = await fetchApi(controlPlane, `/api/rehearsals/${rehearsal.id}`);
    expect(viewResponse.status).toBe(200);
    const view = (await viewResponse.json()) as {
      rehearsal: RehearsalRecord;
      actions: RehearsalActionRecord[];
    };
    expect(view.rehearsal.id).toBe(rehearsal.id);
    expect(view.actions).toHaveLength(3);
    // The confident navigate action is auto-approved; the fills wait as proposals.
    expect(view.actions[0].status).toBe("approved");
    expect(view.actions.slice(1).every((action) => action.status === "proposed")).toBe(true);
    expect(view.rehearsal.currentActionId).toBe(view.actions[0].id);
  });

  it("runs the fixture evaluation and reports the three error counters", async () => {
    const response = await postJson("/api/evaluations/run", {});

    expect(response.status).toBe(200);
    const { evaluation } = (await response.json()) as {
      evaluation: { errorsUnchanged: number; errorsCorrected: number; errorsNew: number };
    };
    // The default deterministic plan matches the declared expected session.
    expect(evaluation).toMatchObject({ errorsUnchanged: 0, errorsCorrected: 0, errorsNew: 0 });
  });
});

describe("unauthenticated requests to mounted routes", () => {
  const mountedRoutes: Array<[string, string]> = [
    ["GET", "/api/profile"],
    ["POST", "/api/profile/inference"],
    ["GET", "/api/rules"],
    ["GET", "/api/revisions"],
    ["GET", "/api/teaching/drafts"],
    ["POST", "/api/teaching/drafts"],
    ["POST", "/api/teaching"],
    ["POST", "/api/stt/transcribe"],
    ["POST", "/api/rehearsals"],
    ["POST", "/api/evaluations/run"],
  ];

  it.each(mountedRoutes)("rejects an unauthenticated %s %s request", async (method, path) => {
    const response = await fetch(`${controlPlane.baseUrl}${path}`, { method });

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe("unauthorized");
  });

  it("rejects without changing stored state", async () => {
    const rejection = await fetch(`${controlPlane.baseUrl}/api/teaching/drafts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "text", transcript: "teaching without a token" }),
    });
    expect(rejection.status).toBe(401);

    const drafts = await fetchApi(controlPlane, "/api/teaching/drafts");
    expect(((await drafts.json()) as { drafts: unknown[] }).drafts).toEqual([]);

    const sessions = await fetchApi(controlPlane, "/api/sessions");
    expect(((await sessions.json()) as { sessions: unknown[] }).sessions).toEqual([]);
  });
});
