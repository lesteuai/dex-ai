import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Revision } from "@dex-ai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeterministicAgentAdapter } from "../agent/deterministic-adapter";
import { applyProfileEntryCorrection, listProfileEntries } from "../repositories/profile";
import { createUserRule } from "../repositories/rules";
import { inferProfileForSession } from "../services/profile-inference";
import { openTestDatabase, seedFixtureInferenceSession, type TestDatabase } from "../test-server";
import { createRevisionsRoute } from "./revisions";

let testDb: TestDatabase;

beforeEach(async () => {
  testDb = await openTestDatabase();
});

afterEach(() => {
  testDb.dispose();
});

function mountRevisionsRoute(): Hono {
  const app = new Hono();
  app.route("/api/revisions", createRevisionsRoute({ db: testDb.db }));
  return app;
}

async function getRevisions(app: Hono, query = ""): Promise<Revision[]> {
  const response = await app.request(`/api/revisions${query}`);
  if (response.status !== 200) throw new Error(`Expected a 200 revision history, got ${response.status}`);
  return ((await response.json()) as { revisions: Revision[] }).revisions;
}

/** Seeds a real history: four agent inferences, one correction, one user rule. */
async function seedRevisionHistory(): Promise<{ sessionId: string }> {
  const session = await seedFixtureInferenceSession(testDb);
  await inferProfileForSession(
    { database: testDb.database, db: testDb.db, adapter: new DeterministicAgentAdapter() },
    session.id,
  );

  const entries = await listProfileEntries(testDb.db);
  const fullName = entries.find((entry) => entry.section === "user_facts");
  if (!fullName) throw new Error("Expected the inference to store a user_facts entry");
  const corrected = await applyProfileEntryCorrection(testDb.database, testDb.db, fullName.id, {
    value: "Casey Lee",
    reason: "The inferred name is wrong",
  });
  if (!corrected) throw new Error("Expected the correction to apply");

  await createUserRule(testDb.database, testDb.db, {
    scope: "rehearsal.fill",
    condition: { fieldLabelContains: "salary" },
    action: { fillValueFrom: "profile.salary_range" },
    reason: "Always answer salary with the stored range",
  });

  return { sessionId: session.id };
}

describe("GET /api/revisions", () => {
  it("returns the history newest first with actor and the session that caused each change", async () => {
    const app = mountRevisionsRoute();
    const { sessionId } = await seedRevisionHistory();

    const revisions = await getRevisions(app);

    expect(revisions).toHaveLength(6);
    const createdAt = revisions.map((revision) => Date.parse(revision.createdAt));
    expect(createdAt).toEqual([...createdAt].sort((a, b) => b - a));

    const agentRevisions = revisions.filter((revision) => revision.actor === "agent");
    expect(agentRevisions).toHaveLength(4);
    const entryIds = new Set((await listProfileEntries(testDb.db)).map((entry) => entry.id));
    for (const revision of agentRevisions) {
      expect(revision.entityType).toBe("profile_entry");
      expect(revision.sourceSessionId).toBe(sessionId);
      expect(revision.traceId?.length).toBeGreaterThan(0);
      expect(entryIds.has(revision.entityId)).toBe(true);
      expect(revision.reason.length).toBeGreaterThan(0);
    }

    const [correction] = revisions.filter(
      (revision) => revision.actor === "user" && revision.entityType === "profile_entry",
    );
    expect(correction.before).toMatchObject({ value: "Jordan Lee" });
    expect(correction.after).toMatchObject({ value: "Casey Lee" });
    expect(correction.sourceSessionId).toBeNull();
    expect(correction.traceId).toBeNull();
  });

  it("filters the history by entity type and by session", async () => {
    const app = mountRevisionsRoute();
    const { sessionId } = await seedRevisionHistory();

    const ruleRevisions = await getRevisions(app, "?entityType=rule");
    expect(ruleRevisions).toHaveLength(1);
    expect(ruleRevisions[0].entityType).toBe("rule");
    expect(ruleRevisions[0].sourceSessionId).toBeNull();

    const sessionRevisions = await getRevisions(app, `?sessionId=${sessionId}`);
    expect(sessionRevisions).toHaveLength(4);
    for (const revision of sessionRevisions) {
      expect(revision.actor).toBe("agent");
      expect(revision.sourceSessionId).toBe(sessionId);
    }

    expect(await getRevisions(app, `?sessionId=${randomUUID()}`)).toEqual([]);
  });
});
