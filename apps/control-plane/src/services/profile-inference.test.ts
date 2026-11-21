import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionDescriptor } from "@dex-ai/shared";
import { DeterministicAgentAdapter } from "../agent/deterministic-adapter";
import { PROFILE_SECTIONS } from "../agent/results";
import { runInTransaction } from "../db/client";
import { storeEventBatch } from "../repositories/events";
import {
  applyProfileEntryCorrection,
  findProfileEntryByKey,
  insertProfileEntry,
  listProfileEntries,
} from "../repositories/profile";
import { listSessionRevisions } from "../repositories/revisions";
import { insertTrace, listSessionTraces } from "../repositories/traces";
import {
  makeFixtureInferenceEvents,
  makeSearchEvent,
  makeSessionDescriptor,
  openTestDatabase,
  seedFixtureInferenceSession,
  type TestDatabase,
} from "../test-server";
import {
  inferProfileForSession,
  ProfileInferenceError,
  type ProfileInferenceDeps,
} from "./profile-inference";

let testDb: TestDatabase;

beforeEach(async () => {
  testDb = await openTestDatabase();
});

afterEach(() => {
  testDb.dispose();
});

function inferenceDeps(adapter: DeterministicAgentAdapter): ProfileInferenceDeps {
  return { database: testDb.database, db: testDb.db, adapter };
}

interface ScriptedEntry {
  key: string;
  value: unknown;
  sourceEventIds: string[];
}

function scriptedProfileAdapter(
  sections: { section: string; entries: ScriptedEntry[] }[],
): DeterministicAgentAdapter {
  return new DeterministicAgentAdapter({
    profile: {
      reasoning: ["Scripted fixture reasoning"],
      result: {
        sections: sections.map((section) => ({
          section: section.section,
          entries: section.entries.map((entry) => ({
            key: entry.key,
            value: entry.value,
            confidence: 0.9,
            sourceEventIds: entry.sourceEventIds,
            reasoningTrace: `Scripted reasoning for ${entry.key}`,
          })),
        })),
      },
    },
  });
}

async function seedSessionWithSearchEvent(): Promise<{ session: SessionDescriptor; eventId: string }> {
  const session = makeSessionDescriptor();
  const event = makeSearchEvent("2026-11-21T10:00:00.000Z");
  await storeEventBatch(testDb.database, testDb.db, session, [event]);
  return { session, eventId: event.id };
}

describe("inferProfileForSession", () => {
  it("populates the four supported sections and leaves the unsupported one empty", async () => {
    const deps = inferenceDeps(new DeterministicAgentAdapter());
    const session = await seedFixtureInferenceSession(deps);

    const write = await inferProfileForSession(deps, session.id);

    expect(write.entries.map((entry) => entry.section).sort()).toEqual([
      "form_rules",
      "job_sources",
      "preferences",
      "user_facts",
    ]);
    expect(write.entries.map((entry) => entry.section)).not.toContain("criteria");

    const seededEventIds = new Set(makeFixtureInferenceEvents().map((event) => event.id));
    for (const entry of write.entries) {
      expect(entry.status).toBe("inferred");
      expect(entry.sourceEventIds.every((id) => seededEventIds.has(id))).toBe(true);
    }
    for (const trace of write.traces) {
      expect(trace.sessionId).toBe(session.id);
      expect(trace.reasoning?.length).toBeGreaterThan(0);
    }
    for (const revision of write.revisions) {
      expect(revision.actor).toBe("agent");
      expect(revision.sourceSessionId).toBe(session.id);
    }

    expect(await listProfileEntries(testDb.db)).toHaveLength(4);
    const storedTraces = await listSessionTraces(testDb.db, session.id);
    expect(storedTraces).toHaveLength(4);
    const storedRevisions = await listSessionRevisions(testDb.db, session.id);
    expect(storedRevisions).toHaveLength(4);
    for (const revision of storedRevisions) {
      // Every populated entry links to its trace, and a first value has no prior value.
      expect(storedTraces.some((trace) => trace.id === revision.traceId)).toBe(true);
      expect(revision.before).toBeFalsy();
    }
    expect(
      testDb.database.prepare("SELECT kind, status FROM agent_tasks").all(),
    ).toEqual([{ kind: "profile_inference", status: "completed" }]);
  });

  it("leaves every section empty when the result reports insufficient evidence", async () => {
    const emptySections = PROFILE_SECTIONS.map((section) => ({ section, entries: [] }));
    const deps = inferenceDeps(scriptedProfileAdapter(emptySections));
    const session = await seedFixtureInferenceSession(deps);

    const write = await inferProfileForSession(deps, session.id);

    expect(write.entries).toEqual([]);
    expect(write.traces).toEqual([]);
    expect(write.revisions).toEqual([]);
    expect(await listProfileEntries(testDb.db)).toEqual([]);
  });

  it("discards a proposed entry that cites an event the session never stored", async () => {
    const seeded = await seedSessionWithSearchEvent();
    const deps = inferenceDeps(
      scriptedProfileAdapter([
        {
          section: "user_facts",
          entries: [
            { key: "supported", value: "Ada", sourceEventIds: [seeded.eventId] },
            { key: "fabricated", value: "ghost fact", sourceEventIds: [randomUUID()] },
          ],
        },
      ]),
    );

    const write = await inferProfileForSession(deps, seeded.session.id);

    expect(write.entries.map((entry) => entry.key)).toEqual(["supported"]);
    expect(await findProfileEntryByKey(testDb.db, "user_facts", "fabricated")).toBeNull();
  });

  it("records a failed task and trace, then rejects without storing entries", async () => {
    const adapter = new DeterministicAgentAdapter({
      profile: { reasoning: ["thinking"], result: {}, failWith: "the provider connection dropped" },
    });
    const deps = inferenceDeps(adapter);
    const session = await seedFixtureInferenceSession(deps);

    await expect(inferProfileForSession(deps, session.id)).rejects.toMatchObject({
      code: "agent_failed",
      httpStatus: 502,
    } satisfies Partial<ProfileInferenceError>);

    expect(testDb.database.prepare("SELECT status, error FROM agent_tasks").all()).toEqual([
      { status: "failed", error: "the provider connection dropped" },
    ]);
    const traces = await listSessionTraces(testDb.db, session.id);
    expect(traces).toHaveLength(1);
    expect(traces[0].reasoning).toBe("the provider connection dropped");
    expect(await listProfileEntries(testDb.db)).toEqual([]);
  });

  it("keeps an explicit correction over a new inference proposing the same key", async () => {
    const deps = inferenceDeps(new DeterministicAgentAdapter());
    const session = await seedFixtureInferenceSession(deps);
    const first = await inferProfileForSession(deps, session.id);

    const fullNameEntry = first.entries.find((entry) => entry.section === "user_facts");
    if (!fullNameEntry) throw new Error("Expected a user_facts entry from the first inference");

    const corrected = await applyProfileEntryCorrection(testDb.database, testDb.db, fullNameEntry.id, {
      value: "Casey Lee",
      reason: "The inferred name is wrong",
    });
    if (!corrected) throw new Error("Expected the correction to apply");
    expect(corrected.after.value).toBe("Casey Lee");
    expect(corrected.after.status).toBe("corrected");
    expect(corrected.revision.actor).toBe("user");
    expect(corrected.revision.before).toMatchObject({ value: "Jordan Lee" });

    const second = await inferProfileForSession(deps, session.id);
    expect(second.entries.map((entry) => [entry.section, entry.key])).not.toContainEqual([
      "user_facts",
      "full_name",
    ]);

    const stored = await findProfileEntryByKey(testDb.db, "user_facts", "full_name");
    expect(stored?.value).toBe("Casey Lee");
    expect(stored?.status).toBe("corrected");
  });
});

describe("profile write atomicity", () => {
  it("rolls back every table when a multi-table write fails partway", async () => {
    const session = await seedFixtureInferenceSession(testDb);

    await expect(
      runInTransaction(testDb.database, async () => {
        await insertProfileEntry(testDb.db, {
          id: randomUUID(),
          section: "user_facts",
          key: "partial",
          value: "never stored",
          confidence: 0.5,
          status: "inferred",
          sourceEventIds: [],
          updatedAt: new Date(),
        });
        await insertTrace(testDb.db, {
          id: randomUUID(),
          taskId: null,
          sessionId: session.id,
          eventId: null,
          step: 0,
          input: {},
          reasoning: "partial write",
          output: {},
          confidence: null,
          createdAt: new Date(),
        });
        throw new Error("mid-write failure");
      }),
    ).rejects.toThrow("mid-write failure");

    expect(await listProfileEntries(testDb.db)).toEqual([]);
    expect(await listSessionTraces(testDb.db, session.id)).toEqual([]);
    expect(await listSessionRevisions(testDb.db, session.id)).toEqual([]);

    // The rollback released the transaction, so the next write succeeds.
    await insertProfileEntry(testDb.db, {
      id: randomUUID(),
      section: "user_facts",
      key: "after-rollback",
      value: "stored",
      confidence: 0.5,
      status: "inferred",
      sourceEventIds: [],
      updatedAt: new Date(),
    });
    expect(await listProfileEntries(testDb.db)).toHaveLength(1);
  });

  it("keeps each concurrent inference write all-or-nothing", async () => {
    const first = await seedSessionWithSearchEvent();
    const second = await seedSessionWithSearchEvent();
    const firstDeps = inferenceDeps(
      scriptedProfileAdapter([
        { section: "user_facts", entries: [{ key: "concurrent_first", value: "a", sourceEventIds: [first.eventId] }] },
      ]),
    );
    const secondDeps = inferenceDeps(
      scriptedProfileAdapter([
        { section: "user_facts", entries: [{ key: "concurrent_second", value: "b", sourceEventIds: [second.eventId] }] },
      ]),
    );

    const settled = await Promise.allSettled([
      inferProfileForSession(firstDeps, first.session.id),
      inferProfileForSession(secondDeps, second.session.id),
    ]);

    // Whichever write lost the race stored no partial rows.
    const seededByKey: Record<string, { key: string; sessionId: string }> = {
      "0": { key: "concurrent_first", sessionId: first.session.id },
      "1": { key: "concurrent_second", sessionId: second.session.id },
    };
    for (const [index, result] of settled.entries()) {
      const seeded = seededByKey[index];
      const entry = await findProfileEntryByKey(testDb.db, "user_facts", seeded.key);
      const revisions = await listSessionRevisions(testDb.db, seeded.sessionId);
      if (result.status === "fulfilled") {
        expect(result.value.entries).toHaveLength(1);
        expect(entry).not.toBeNull();
        expect(revisions).toHaveLength(1);
      } else {
        expect(entry).toBeNull();
        expect(revisions).toHaveLength(0);
      }
    }

    // The race left the connection usable for the next write.
    const retried = await inferProfileForSession(secondDeps, second.session.id);
    expect(retried.entries).toHaveLength(1);
  });
});
