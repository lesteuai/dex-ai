import { pathToFileURL } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { createControlPlaneApp } from "./app";
import { getConfigFilePath, loadOrCreateConfig, type ControlPlaneConfig } from "./config";
import { StreamHub } from "./stream/hub";

/** External in-process host (the agent adapter) joined to shutdown. */
export interface AgentHost {
  close(): Promise<void>;
}

export interface ControlPlaneHandle {
  server: ServerType;
  hub: StreamHub;
  close(): Promise<void>;
}

export function startControlPlane(
  config: ControlPlaneConfig,
  agentHost?: AgentHost,
): Promise<ControlPlaneHandle> {
  const hub = new StreamHub();
  const app = createControlPlaneApp(config, hub);
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
  return listening.then(() => ({
    server,
    hub,
    close: () => closeControlPlane(server, hub, agentHost),
  }));
}

async function closeControlPlane(
  server: ServerType,
  hub: StreamHub,
  agentHost?: AgentHost,
): Promise<void> {
  // Close stream clients first so server.close does not wait on live sockets.
  hub.close();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await agentHost?.close();
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
