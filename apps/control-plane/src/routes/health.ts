import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { isLoopbackRemoteAddress } from "../auth";
import type { ControlPlaneConfig } from "../config";

/** GET /api/health reports loopback status and readiness for local clients. */
export function createHealthRoute(config: ControlPlaneConfig): Hono<{ Bindings: HttpBindings }> {
  const health = new Hono<{ Bindings: HttpBindings }>();
  health.get("/", (c) =>
    c.json({
      ok: true,
      service: "dex-ai-control-plane",
      host: config.host,
      port: config.port,
      loopback: config.host === "localhost" || isLoopbackRemoteAddress(config.host),
    }),
  );
  return health;
}
