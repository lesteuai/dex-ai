import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { ProfileEntry } from "@dex-ai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeterministicAgentAdapter } from "../agent/deterministic-adapter";
import type { ControlPlaneDb } from "../db/client";
import { StreamHub } from "../stream/hub";
import {
  openTestDatabase,
  recordingStreamClient,
  reopenTestDatabase,
  seedFixtureInferenceSession,
  streamMessagesOfType,
  type TestDatabase,
} from "../test-server";
import { createProfileRoute } from "./profile";

let testDb: TestDatabase;
let hub: StreamHub;

beforeEach(async () => {
  testDb = await openTestDatabase();
  hub = new StreamHub();
});

afterEach(() => {
  hub.close();
  testDb.dispose();
});

function mountProfileRoute(target: { database: DatabaseSync; db: ControlPlaneDb }): Hono {
  const app = new Hono();
  app.route(
    "/api/profile",
    createProfileRoute({
      database: target.database,
      db: target.db,
      adapter: new DeterministicAgentAdapter(),
      hub,
    }),
  );
  return app;
}

async function callRoute(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, { ...init, headers: { "content-type": "application/json", ...init.headers } });
}

describe("GET /api/profile", () => {
  it("lists stored profile entries", async () => {
    const app = mountProfileRoute(testDb);

    const empty = await callRoute(app, "/api/profile");
    expect(empty.status).toBe(200);
    expect((await empty.json()) as { entries: ProfileEntry[] }).toEqual({ entries: [] });
  });
});

describe("POST /api/profile/inference", () => {
  it("runs deterministic inference and publishes trace, profile and revision envelopes", async () => {
    const app = mountProfileRoute(testDb);
    const client = recordingStreamClient();
    hub.subscribe(client);
    const session = await seedFixtureInferenceSession(testDb);

    const response = await callRoute(app, "/api/profile/inference", {
      method: "POST",
      body: JSON.stringify({ sessionId: session.id }),
    });

    expect(response.status).toBe(200);
    const { entries } = (await response.json()) as { entries: ProfileEntry[] };
    expect(entries.map((entry) => entry.section).sort()).toEqual([
      "form_rules",
      "job_sources",
      "preferences",
      "user_facts",
    ]);

    const traceMessages = streamMessagesOfType(client.messages, "trace.completed");
    expect(traceMessages).toHaveLength(4);
    for (const message of traceMessages) {
      expect(message.payload.trace.sessionId).toBe(session.id);
      expect(message.payload.trace.reasoning?.length).toBeGreaterThan(0);
    }

    const profileMessages = streamMessagesOfType(client.messages, "profile.updated");
    expect(profileMessages).toHaveLength(4);
    for (const message of profileMessages) {
      expect(message.payload.entry.status).toBe("inferred");
      expect(entries.map((entry) => entry.id)).toContain(message.payload.entry.id);
    }

    const revisionMessages = streamMessagesOfType(client.messages, "revision.created");
    expect(revisionMessages).toHaveLength(4);
    for (const message of revisionMessages) {
      expect(message.payload.revision.actor).toBe("agent");
      expect(message.payload.revision.sourceSessionId).toBe(session.id);
    }

    const listed = await callRoute(app, "/api/profile");
    expect(((await listed.json()) as { entries: ProfileEntry[] }).entries).toHaveLength(4);
  });

  it("rejects an unknown session without publishing anything", async () => {
    const app = mountProfileRoute(testDb);
    const client = recordingStreamClient();
    hub.subscribe(client);

    const response = await callRoute(app, "/api/profile/inference", {
      method: "POST",
      body: JSON.stringify({ sessionId: randomUUID() }),
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("session_not_found");
    expect(client.messages).toEqual([]);
  });

  it("rejects an invalid inference request with field errors", async () => {
    const app = mountProfileRoute(testDb);

    const response = await callRoute(app, "/api/profile/inference", {
      method: "POST",
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; fieldErrors: Record<string, string[]> };
    expect(body.error).toBe("invalid_request");
    expect(body.fieldErrors.sessionId?.length).toBeGreaterThan(0);
  });
});

describe("PATCH /api/profile/:id", () => {
  async function inferOneSession(): Promise<ProfileEntry> {
    const app = mountProfileRoute(testDb);
    const session = await seedFixtureInferenceSession(testDb);
    const response = await callRoute(app, "/api/profile/inference", {
      method: "POST",
      body: JSON.stringify({ sessionId: session.id }),
    });
    const { entries } = (await response.json()) as { entries: ProfileEntry[] };
    if (entries.length === 0) throw new Error("Expected the inference to store entries");
    return entries[0];
  }

  it("persists a correction, records a user revision and survives a database reopen", async () => {
    const app = mountProfileRoute(testDb);
    const client = recordingStreamClient();
    hub.subscribe(client);
    const entry = await inferOneSession();

    const response = await callRoute(app, `/api/profile/${entry.id}`, {
      method: "PATCH",
      body: JSON.stringify({ value: "Casey Lee", reason: "The inferred name is wrong" }),
    });

    expect(response.status).toBe(200);
    const { entry: corrected } = (await response.json()) as { entry: ProfileEntry };
    expect(corrected).toMatchObject({ id: entry.id, value: "Casey Lee", status: "corrected" });

    const profileMessages = streamMessagesOfType(client.messages, "profile.updated");
    const lastUpdate = profileMessages[profileMessages.length - 1];
    expect(lastUpdate.payload.entry).toMatchObject({ id: entry.id, value: "Casey Lee" });

    const userRevisions = streamMessagesOfType(client.messages, "revision.created").filter(
      (message) => message.payload.revision.actor === "user",
    );
    expect(userRevisions).toHaveLength(1);
    expect(userRevisions[0].payload.revision.before).toMatchObject({ id: entry.id });
    expect(userRevisions[0].payload.revision.after).toMatchObject({ value: "Casey Lee" });
    expect(userRevisions[0].payload.revision.sourceSessionId).toBeNull();

    // The correction must survive a control-plane restart on the same file.
    testDb.close();
    const reopened = reopenTestDatabase(testDb.dbPath);
    try {
      const remounted = mountProfileRoute(reopened);
      const listed = await callRoute(remounted, "/api/profile");
      const stored = ((await listed.json()) as { entries: ProfileEntry[] }).entries.find(
        (candidate) => candidate.id === entry.id,
      );
      expect(stored).toMatchObject({ value: "Casey Lee", status: "corrected" });
    } finally {
      reopened.database.close();
    }
  });

  it("returns 404 when correcting an unknown entry", async () => {
    const app = mountProfileRoute(testDb);

    const response = await callRoute(app, `/api/profile/${randomUUID()}`, {
      method: "PATCH",
      body: JSON.stringify({ value: "Ada" }),
    });

    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe("not_found");
  });

  it("rejects a correction with no field to change and an invalid status", async () => {
    const app = mountProfileRoute(testDb);

    const empty = await callRoute(app, `/api/profile/${randomUUID()}`, {
      method: "PATCH",
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { message: string }).message).toContain("value or status");

    const invalid = await callRoute(app, `/api/profile/${randomUUID()}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "bogus" }),
    });
    expect(invalid.status).toBe(400);
    const body = (await invalid.json()) as { error: string; fieldErrors: Record<string, string[]> };
    expect(body.error).toBe("invalid_request");
    expect(body.fieldErrors.status?.length).toBeGreaterThan(0);
  });
});
