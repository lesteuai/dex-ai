import type { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, openSqliteDatabase, runInTransaction, type ControlPlaneDb } from "./client";
import { runMigrations } from "./migrate";
import { events, sessions } from "./schema";

const TEMP_BASE = "/tmp/opencode";

const ALL_TABLES = [
  "agent_tasks",
  "evaluations",
  "events",
  "profile_entries",
  "rehearsal_actions",
  "rehearsals",
  "revisions",
  "rules",
  "sessions",
  "teaching_drafts",
  "traces",
];

let dbDir: string;
let dbPath: string;
let database: DatabaseSync;
let db: ControlPlaneDb;

beforeEach(async () => {
  dbDir = mkdtempSync(join(TEMP_BASE, "dex-ai-db-"));
  dbPath = join(dbDir, "control-plane.sqlite");
  database = openSqliteDatabase(dbPath);
  db = createDb(database);
  await runMigrations(database);
});

afterEach(() => {
  database.close();
  rmSync(dbDir, { recursive: true, force: true });
});

const baseSession = () => ({
  id: "session-1",
  browserKind: "chrome" as const,
  source: "https://example.com/jobs",
  postingUrl: null,
  status: "active" as const,
  startedAt: new Date("2026-11-21T10:00:00.000Z"),
  endedAt: null,
});

const baseEvent = () => ({
  id: "event-1",
  sessionId: "session-1",
  type: "search_filter" as const,
  capturedAt: new Date("2026-11-21T10:01:00.000Z"),
  sourceUrl: "https://example.com/jobs?q=typescript",
  payload: { query: "typescript", remoteOnly: true },
  dedupeKey: "dedupe-key-1",
});

const tableNames = (connection: DatabaseSync): string[] =>
  (connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
    name: string;
  }[]).map((row) => row.name);

describe("migrations", () => {
  it("creates every schema table on a fresh database file", () => {
    expect(tableNames(database)).toEqual(expect.arrayContaining(ALL_TABLES));
  });

  it("records exactly one migration entry and is idempotent when repeated", async () => {
    await db.insert(sessions).values(baseSession()).run();

    await runMigrations(database);

    const migrationCount = database
      .prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations")
      .get() as { count: number };
    expect(migrationCount.count).toBe(1);
    const storedSessions = await db.select().from(sessions);
    expect(storedSessions).toHaveLength(1);
  });
});

describe("session and event round-trip", () => {
  it("inserts and reads back a session", async () => {
    await db.insert(sessions).values(baseSession()).run();

    const [stored] = await db.select().from(sessions).where(eq(sessions.id, "session-1"));
    expect(stored).toEqual(baseSession());
  });

  it("inserts and reads back an event with its JSON payload intact", async () => {
    await db.insert(sessions).values(baseSession()).run();
    await db.insert(events).values(baseEvent()).run();

    const [stored] = await db.select().from(events).where(eq(events.id, "event-1"));
    expect(stored).toEqual(baseEvent());
  });
});

describe("event deduplication", () => {
  it("rejects a duplicate dedupe_key and keeps only the first row", async () => {
    await db.insert(sessions).values(baseSession()).run();
    await db.insert(events).values(baseEvent()).run();

    await expect(
      db
        .insert(events)
        .values({ ...baseEvent(), id: "event-2", capturedAt: new Date("2026-11-21T10:02:00.000Z") })
        .run(),
    ).rejects.toMatchObject({
      // Drizzle wraps driver failures, so the SQLite error rides on cause.
      cause: { code: "ERR_SQLITE_ERROR", message: "UNIQUE constraint failed: events.dedupe_key" },
    });

    const storedEvents = await db.select().from(events);
    expect(storedEvents.map((row) => row.id)).toEqual(["event-1"]);
  });
});

describe("transactions", () => {
  it("commits writes when the work succeeds", async () => {
    await runInTransaction(database, () => db.insert(sessions).values(baseSession()).run());

    const storedSessions = await db.select().from(sessions);
    expect(storedSessions).toHaveLength(1);
  });

  it("rolls back every write when the work fails", async () => {
    await expect(
      runInTransaction(database, async () => {
        await db.insert(sessions).values(baseSession()).run();
        await db
          .insert(events)
          .values({ ...baseEvent(), sessionId: "session-1" })
          .run();
        throw new Error("deliberate failure");
      }),
    ).rejects.toThrow("deliberate failure");

    expect(await db.select().from(sessions)).toHaveLength(0);
    expect(await db.select().from(events)).toHaveLength(0);
  });
});

describe("reopen persistence", () => {
  it("keeps data written before a close after reopening the same file", async () => {
    await db.insert(sessions).values(baseSession()).run();
    await db.insert(events).values(baseEvent()).run();
    database.close();

    database = openSqliteDatabase(dbPath);
    db = createDb(database);

    const [storedSession] = await db.select().from(sessions).where(eq(sessions.id, "session-1"));
    expect(storedSession).toEqual(baseSession());
    const [storedEvent] = await db.select().from(events).where(eq(events.id, "event-1"));
    expect(storedEvent).toEqual(baseEvent());
  });
});

describe("connection pragmas", () => {
  it("persists WAL journaling across close and reopen", () => {
    database.close();
    database = openSqliteDatabase(dbPath);
    db = createDb(database);

    const journalMode = database.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(journalMode.journal_mode).toBe("wal");
  });

  it("enforces foreign keys by rejecting an event without a session", async () => {
    await expect(
      db
        .insert(events)
        .values({ ...baseEvent(), sessionId: "missing-session" })
        .run(),
    ).rejects.toMatchObject({
      cause: { code: "ERR_SQLITE_ERROR", message: "FOREIGN KEY constraint failed" },
    });
  });

  it("re-enables foreign keys on every new connection", () => {
    database.close();
    database = openSqliteDatabase(dbPath);
    db = createDb(database);

    const foreignKeys = database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(foreignKeys.foreign_keys).toBe(1);
  });
});
