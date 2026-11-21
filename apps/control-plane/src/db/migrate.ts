import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/sqlite-proxy/migrator";
import { createDb, runInTransaction } from "./client";

const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function runMigrations(
  database: DatabaseSync,
  migrationsFolder: string = DEFAULT_MIGRATIONS_FOLDER,
): Promise<void> {
  const db = createDb(database);
  // Drizzle's migrator skips entries already recorded in __drizzle_migrations,
  // so repeated calls leave an up-to-date database unchanged.
  await migrate(
    db,
    async (queries) => {
      await runInTransaction(database, () => {
        for (const query of queries) {
          const statement = query.trim();
          if (statement === "") continue;
          database.prepare(statement).run();
        }
      });
    },
    { migrationsFolder },
  );
}
