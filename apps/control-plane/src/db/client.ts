import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { drizzle, type RemoteCallback, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import * as schema from "./schema";

export type ControlPlaneDb = SqliteRemoteDatabase<typeof schema>;

export function openSqliteDatabase(dbPath: string): DatabaseSync {
  const database = new DatabaseSync(dbPath);
  // WAL keeps the file durable across restarts; foreign keys enforce the
  // schema relationships declared in schema.ts.
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  return database;
}

function executeStatement(
  database: DatabaseSync,
  sql: string,
  params: readonly unknown[],
  method: "run" | "all" | "get" | "values",
): { rows: unknown[] } {
  const statement = database.prepare(sql);
  const bound = params as SQLInputValue[];
  switch (method) {
    case "run":
      statement.setReturnArrays(false);
      statement.run(...bound);
      return { rows: [] };
    // Drizzle maps typed results positionally, so every read comes back in
    // array mode; "get" hands Drizzle the single row (null when absent).
    case "all":
      statement.setReturnArrays(true);
      return { rows: statement.all(...bound) as unknown[] };
    case "get":
      statement.setReturnArrays(true);
      return { rows: (statement.get(...bound) ?? null) as unknown as unknown[] };
    case "values":
      statement.setReturnArrays(true);
      return { rows: statement.all(...bound) as unknown[] };
  }
}

export function createDb(database: DatabaseSync): ControlPlaneDb {
  const callback: RemoteCallback = async (sql, params, method) =>
    executeStatement(database, sql, params, method);
  return drizzle(callback, { schema });
}

// Multi-table writes stay atomic; node:sqlite executes synchronously, so the
// prepared BEGIN/COMMIT/ROLLBACK pair cannot interleave with other statements
// on this connection.
export async function runInTransaction<T>(
  database: DatabaseSync,
  work: () => T | Promise<T>,
): Promise<Awaited<T>> {
  const begin = database.prepare("BEGIN");
  const commit = database.prepare("COMMIT");
  const rollback = database.prepare("ROLLBACK");
  begin.run();
  try {
    const result = await work();
    commit.run();
    return result;
  } catch (error) {
    rollback.run();
    throw error;
  }
}
