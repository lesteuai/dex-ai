import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import type { DatabaseSync } from "node:sqlite";
import { WebSocketServer } from "ws";
import { createControlPlaneApp } from "./app";
import { createAgentAdapter, type AgentAdapterHost } from "./agent/factory";
import { getConfigFilePath, loadOrCreateConfig, type ControlPlaneConfig } from "./config";
import { createDb, openSqliteDatabase, type ControlPlaneDb } from "./db/client";
import { runMigrations } from "./db/migrate";
import { StreamHub } from "./stream/hub";

const DATABASE_FILE_NAME = "control-plane.sqlite";

export interface ControlPlaneHandle {
  server: ServerType;
  hub: StreamHub;
  database: DatabaseSync;
  db: ControlPlaneDb;
  close(): Promise<void>;
}

export async function startControlPlane(config: ControlPlaneConfig): Promise<ControlPlaneHandle> {
  const hub = new StreamHub();
  const database = openSqliteDatabase(join(config.dataDir, DATABASE_FILE_NAME));
  const db = createDb(database);
  await runMigrations(database);
  const agentHost = createAgentAdapter(
    config.agentKind === "deterministic"
      ? { kind: "deterministic" }
      : { kind: "opencode", dataDir: config.dataDir, model: config.opencodeModel },
  );
  const app = createControlPlaneApp(config, hub, db, database, agentHost);
  // noServer mode: @hono/node-server drives upgrades through serve().
  const wss = new WebSocketServer({ noServer: true });
  const server = serve(
    {
      fetch: app.fetch,
      hostname: config.host,
      port: config.port,
      websocket: { server: wss },
    },
    (info) => {
      console.log(`Dex AI control plane listening on http://${info.address}:${info.port}`);
      console.log(`Config file: ${getConfigFilePath()}`);
    },
  );
  const listening = new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  try {
    await listening;
  } catch (error) {
    database.close();
    await agentHost.close();
    throw error;
  }
  return {
    server,
    hub,
    database,
    db,
    close: () => closeControlPlane(server, hub, database, agentHost),
  };
}

async function closeControlPlane(
  server: ServerType,
  hub: StreamHub,
  database: DatabaseSync,
  agentHost: AgentAdapterHost,
): Promise<void> {
  // Close stream clients first so server.close does not wait on live sockets.
  hub.close();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  // Closing twice is legal for server and hub; keep the database idempotent too.
  if (database.isOpen) database.close();
  await agentHost.close();
}

function runMain(): void {
  const config = loadOrCreateConfig();
  let closing = false;
  const shutdown = (handle: ControlPlaneHandle, signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`${signal} received, shutting down`);
    handle
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error("Shutdown failed", error);
        process.exit(1);
      });
  };
  startControlPlane(config)
    .then((handle) => {
      process.on("SIGINT", () => shutdown(handle, "SIGINT"));
      process.on("SIGTERM", () => shutdown(handle, "SIGTERM"));
    })
    .catch((error: unknown) => {
      console.error("Control plane failed to start", error);
      process.exit(1);
    });
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runMain();
}
