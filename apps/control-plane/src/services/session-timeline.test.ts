import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionDescriptor } from "@dex-ai/shared";
import { createDb, openSqliteDatabase, type ControlPlaneDb } from "../db/client";
import { runMigrations } from "../db/migrate";
import { storeEventBatch } from "../repositories/events";
import { insertRevision } from "../repositories/revisions";
import { insertTrace } from "../repositories/traces";
import { buildSessionTimeline, type SessionTimeline } from "./session-timeline";

const TEMP_BASE = "/tmp/opencode";

// Deliberately interleaved: the batch arrives with the later event first.
const TS = {
  search: "2026-11-21T10:00:00.000Z",
  trace: "2026-11-21T10:05:00.000Z",
  field: "2026-11-21T10:10:00.000Z",
  revision: "2026-11-21T10:15:00.000Z",
};

const TRACE_REASONING = "The posting allows remote work and lists TypeScript.";
const REVISION_REASON = "the user corrected the preferred work mode";

interface SeededActivity {
  session: SessionDescriptor;
  eventIds: string[];
  traceId: string;
  revisionId: string;
}

let dbDir: string;
let dbPath: string;
let database: DatabaseSync;
let db: ControlPlaneDb;

beforeEach(async () => {
  dbDir = mkdtempSync(join(TEMP_BASE, "dex-ai-timeline-"));
  dbPath = join(dbDir, "control-plane.sqlite");
  database = openSqliteDatabase(dbPath);
  db = createDb(database);
  await runMigrations(database);
});

afterEach(() => {
  database.close();
  rmSync(dbDir, { recursive: true, force: true });
});

async function seedSessionActivity(): Promise<SeededActivity> {
  const session: SessionDescriptor = {
    id: randomUUID(),
    browserKind: "firefox",
    sourceUrl: "https://jobs.example/listings",
  };
  const searchEvent = {
    type: "search_filter" as const,
    id: randomUUID(),
    ts: TS.search,
    payload: { pageUrl: "https://jobs.example/listings", query: "typescript", filters: {} },
  };
  const fieldEvent = {
    type: "field_filled" as const,
    id: randomUUID(),
    ts: TS.field,
    payload: {
      pageUrl: "https://jobs.example/listings/senior-frontend",
      selector: "#first-name",
      value: "Ada",
    },
  };
  // Posted out of chronological order on purpose.
  await storeEventBatch(database, db, session, [fieldEvent, searchEvent]);

  const traceId = randomUUID();
  await insertTrace(db, {
    id: traceId,
    taskId: null,
    sessionId: session.id,
    eventId: searchEvent.id,
    step: 1,
    input: { prompt: "Does this posting fit the profile?" },
    reasoning: TRACE_REASONING,
    output: { fit: true },
    confidence: 0.9,
    createdAt: new Date(TS.trace),
  });

  const revisionId = randomUUID();
  await insertRevision(db, {
    id: revisionId,
    entityType: "profile_entry",
    entityId: randomUUID(),
    sourceSessionId: session.id,
    traceId,
    actor: "user",
    before: { value: "Hybrid" },
    after: { value: "Remote only" },
    reason: REVISION_REASON,
    createdAt: new Date(TS.revision),
  });

  return { session, eventIds: [searchEvent.id, fieldEvent.id], traceId, revisionId };
}

function expectSeededTimeline(timeline: SessionTimeline | null, seeded: SeededActivity): void {
  if (timeline === null) throw new Error("Expected the session timeline to exist");
  expect(timeline.session.id).toBe(seeded.session.id);
  expect(timeline.session.browserKind).toBe("firefox");
  expect(timeline.timeline.map((item) => item.kind)).toEqual(["event", "trace", "event", "revision"]);
  expect(
    timeline.timeline.map((item) => {
      if (item.kind === "event") return item.event.id;
      if (item.kind === "trace") return item.trace.id;
      if (item.kind === "revision") return item.revision.id;
      return item.action.id;
    }),
  ).toEqual([seeded.eventIds[0], seeded.traceId, seeded.eventIds[1], seeded.revisionId]);
}

describe("buildSessionTimeline", () => {
  it("includes trace and revision entries in chronological order from out-of-order writes", async () => {
    const seeded = await seedSessionActivity();

    const timeline = await buildSessionTimeline(db, seeded.session.id);

    expectSeededTimeline(timeline, seeded);
    const traceEntry = timeline?.timeline[1];
    const revisionEntry = timeline?.timeline[3];
    if (traceEntry?.kind !== "trace" || revisionEntry?.kind !== "revision") {
      throw new Error("Expected a trace and a revision timeline entry");
    }
    expect(traceEntry.trace.reasoning).toBe(TRACE_REASONING);
    expect(revisionEntry.revision.reason).toBe(REVISION_REASON);
  });

  it("returns null for an unknown session", async () => {
    expect(await buildSessionTimeline(db, randomUUID())).toBeNull();
  });

  it("keeps events, traces and revisions after closing and reopening the database", async () => {
    const seeded = await seedSessionActivity();
    database.close();

    database = openSqliteDatabase(dbPath);
    db = createDb(database);

    expectSeededTimeline(await buildSessionTimeline(db, seeded.session.id), seeded);
  });
});
