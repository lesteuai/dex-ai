import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import {
  getRehearsalResponseSchema,
  startRehearsalResponseSchema,
  type RehearsalActionRecord,
  type RehearsalRecord,
} from "@dex-ai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeterministicAgentAdapter } from "../agent/deterministic-adapter";
import { insertEvents } from "../repositories/events";
import { insertRehearsal } from "../repositories/rehearsals";
import { upsertSession } from "../repositories/sessions";
import { StreamHub } from "../stream/hub";
import { makeSessionDescriptor, openTestDatabase, type TestDatabase } from "../test-server";
import { createRehearsalsRoute } from "./rehearsals";

const POSTING_URL = "http://127.0.0.1:8787/fixtures/job/posting.html";

interface StartedBody {
  rehearsal: RehearsalRecord;
  autonomy?: { autonomous: boolean; reason: string };
}
interface ViewBody {
  rehearsal: RehearsalRecord;
  actions: RehearsalActionRecord[];
}

let testDb: TestDatabase;
let sessionId: string;

beforeEach(async () => {
  testDb = await openTestDatabase();
  const session = makeSessionDescriptor();
  await upsertSession(testDb.db, session, new Date());
  sessionId = session.id;
});

afterEach(() => {
  testDb.dispose();
});

function mountRehearsalsRoute(confidenceThreshold = 0.7): Hono {
  const app = new Hono();
  app.route(
    "/api/rehearsals",
    createRehearsalsRoute({
      database: testDb.database,
      db: testDb.db,
      hub: new StreamHub(),
      adapter: new DeterministicAgentAdapter(),
      confidenceThreshold,
      autonomyRequiredCount: 3,
    }),
  );
  return app;
}

async function postJson(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function startRehearsal(app: Hono, body: unknown = { sessionId, postingUrl: POSTING_URL }) {
  const response = await postJson(app, "/api/rehearsals", body);
  return { response, started: (await response.json()) as StartedBody };
}

async function getRehearsalView(app: Hono, id: string): Promise<ViewBody> {
  const response = await app.request(`/api/rehearsals/${id}`);
  return (await response.json()) as ViewBody;
}

describe("rehearsals routes", () => {
  it("starts a rehearsal with the requested confidence threshold", async () => {
    const app = mountRehearsalsRoute();
    const { response, started } = await startRehearsal(app, {
      sessionId,
      postingUrl: POSTING_URL,
      confidenceThreshold: 0.99,
    });

    expect(response.status).toBe(200);
    expect(() => startRehearsalResponseSchema.parse(started)).not.toThrow();
    // The scripted plan's best confidence is 0.95, so 0.99 pauses it.
    expect(started.rehearsal.status).toBe("paused");
    expect(started.rehearsal.confidenceThreshold).toBe(0.99);
  });

  it("auto mode skips confidence pauses only on a familiar platform and role type", async () => {
    const app = mountRehearsalsRoute();
    await insertEvents(testDb.db, sessionId, [
      {
        type: "posting_opened",
        id: randomUUID(),
        ts: "2026-11-22T10:00:00.000Z",
        payload: { pageUrl: POSTING_URL, title: "Senior Frontend Engineer at Acme" },
      },
    ]);
    const autoBody = { sessionId, postingUrl: POSTING_URL, confidenceThreshold: 0.99, mode: "auto" };

    const fresh = await startRehearsal(app, autoBody);
    expect(fresh.started.autonomy).toMatchObject({ autonomous: false });
    expect(fresh.started.rehearsal.status).toBe("paused");

    for (let index = 0; index < 3; index += 1) {
      await insertRehearsal(testDb.db, {
        id: randomUUID(),
        sessionId,
        postingUrl: POSTING_URL,
        browserKind: "chrome",
        status: "completed",
        confidenceThreshold: 0.7,
        currentActionId: null,
        startedAt: new Date(),
      });
    }
    const familiar = await startRehearsal(app, autoBody);
    expect(familiar.started.autonomy).toMatchObject({ autonomous: true });
    expect(familiar.started.rehearsal.confidenceThreshold).toBe(0);
    expect(familiar.started.rehearsal.status).toBe("running");
  });

  it("rejects an unknown session and an invalid request body", async () => {
    const app = mountRehearsalsRoute();

    const unknown = await startRehearsal(app, { sessionId: randomUUID(), postingUrl: POSTING_URL });
    expect(unknown.response.status).toBe(404);
    expect(unknown.started).toMatchObject({ error: "not_found" });

    const invalid = await startRehearsal(app, { postingUrl: POSTING_URL });
    expect(invalid.response.status).toBe(400);
    expect(invalid.started).toMatchObject({ error: "invalid_request" });
  });

  it("returns the rehearsal with its actions for inspection", async () => {
    const app = mountRehearsalsRoute();
    const { started } = await startRehearsal(app);
    const id = started.rehearsal.id;

    const response = await app.request(`/api/rehearsals/${id}`);
    expect(response.status).toBe(200);
    const view = (await response.json()) as ViewBody;
    expect(() => getRehearsalResponseSchema.parse(view)).not.toThrow();
    expect(view.rehearsal.status).toBe("running");
    expect(view.actions.map((action) => action.status)).toEqual([
      "approved",
      "proposed",
      "proposed",
    ]);

    expect((await app.request(`/api/rehearsals/${randomUUID()}`)).status).toBe(404);
  });

  it("rejects a decision that tries to create a submit action", async () => {
    const app = mountRehearsalsRoute(0.99);
    const { started } = await startRehearsal(app);
    const id = started.rehearsal.id;
    const view = await getRehearsalView(app, id);

    const response = await postJson(app, `/api/rehearsals/${id}/decisions`, {
      type: "correct",
      actionId: view.rehearsal.currentActionId,
      action: { kind: "submit", selector: "#apply" },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(
      testDb.database.prepare("SELECT COUNT(*) AS count FROM rehearsal_actions WHERE kind = 'submit'").get(),
    ).toEqual({ count: 0 });
  });

  it("records a submit attempt reported by the extension guard", async () => {
    const app = mountRehearsalsRoute();
    const { started } = await startRehearsal(app);
    const id = started.rehearsal.id;

    const response = await postJson(app, `/api/rehearsals/${id}/blocked-attempts`, {
      reason: "submit_control",
      selector: "#apply-now",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { action: RehearsalActionRecord };
    expect(body.action.status).toBe("blocked");
    expect(body.action.action).toEqual({ kind: "click_non_submit", selector: "#apply-now" });

    // Only the three submit refusal reasons are accepted.
    const invalid = await postJson(app, `/api/rehearsals/${id}/blocked-attempts`, {
      reason: "navigation",
      selector: "#apply-now",
    });
    expect(invalid.status).toBe(400);
  });

  it("requires an explicit resume decision after a disconnect", async () => {
    const app = mountRehearsalsRoute();
    const { started } = await startRehearsal(app);
    const id = started.rehearsal.id;

    const disconnected = await postJson(app, `/api/rehearsals/${id}/disconnect`, {});
    expect(((await disconnected.json()) as StartedBody).rehearsal.status).toBe("paused");

    const view = await getRehearsalView(app, id);
    const actionId = view.rehearsal.currentActionId;
    expect(view.actions.find((action) => action.id === actionId)?.status).toBe("proposed");

    // Approval alone does not resume a disconnected rehearsal.
    const approved = await postJson(app, `/api/rehearsals/${id}/decisions`, {
      type: "approve",
      actionId,
    });
    expect(((await approved.json()) as StartedBody).rehearsal.status).toBe("paused");

    const executedWhilePaused = await postJson(app, `/api/rehearsals/${id}/actions/${actionId}/executed`, {});
    expect(executedWhilePaused.status).toBe(409);

    const resumed = await postJson(app, `/api/rehearsals/${id}/decisions`, { type: "resume" });
    expect(((await resumed.json()) as StartedBody).rehearsal.status).toBe("running");

    const executed = await postJson(app, `/api/rehearsals/${id}/actions/${actionId}/executed`, {});
    expect(executed.status).toBe(200);
    const executedBody = (await executed.json()) as { action: RehearsalActionRecord };
    expect(executedBody.action.status).toBe("executed");
  });
});
