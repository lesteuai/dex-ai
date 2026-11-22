import type { DatabaseSync } from "node:sqlite";
import { upgradeWebSocket, type HttpBindings } from "@hono/node-server";
import { type Context, type MiddlewareHandler, Hono } from "hono";
import { cors } from "hono/cors";
import type { AgentAdapter } from "./agent/adapter";
import {
  isAllowedHost,
  isAllowedOrigin,
  isLoopbackRemoteAddress,
  isValidBearerToken,
  matchWebSocketTokenProtocol,
} from "./auth";
import {
  DEFAULT_AUTONOMY_THRESHOLD,
  getAllowedHosts,
  getAllowedOrigins,
  type ControlPlaneConfig,
} from "./config";
import type { ControlPlaneDb } from "./db/client";
import { createEvaluationsRoute } from "./routes/evaluations";
import { createEventsRoute } from "./routes/events";
import { createHealthRoute } from "./routes/health";
import { createProfileRoute } from "./routes/profile";
import { createRehearsalsRoute } from "./routes/rehearsals";
import { createMatchRoute } from "./routes/match";
import { createRevisionsRoute } from "./routes/revisions";
import { createRulesRoute } from "./routes/rules";
import { createSessionsRoute } from "./routes/sessions";
import { createSttRoute } from "./routes/stt";
import { createTeachingRoute } from "./routes/teaching";
import { createFixtureRoute, createWebRoute } from "./routes/static";
import type { StreamHub } from "./stream/hub";

type AppEnv = { Bindings: HttpBindings };
type AppContext = Context<AppEnv>;

function rejectRequest(c: AppContext, status: 401 | 403, error: string, message: string) {
  return c.json({ error, message }, status);
}

function rejectDisallowedClient(c: AppContext, config: ControlPlaneConfig): Response | null {
  if (!isLoopbackRemoteAddress(c.env.incoming.socket.remoteAddress)) {
    return rejectRequest(c, 403, "forbidden", "Only loopback clients may reach the control plane");
  }
  if (!isAllowedHost(c.req.header("host"), getAllowedHosts(config))) {
    return rejectRequest(c, 403, "forbidden", "The request Host is not allowed");
  }
  const origin = c.req.header("origin");
  if (origin && !isAllowedOrigin(origin, getAllowedOrigins(config))) {
    return rejectRequest(c, 403, "forbidden", "The request Origin is not allowed");
  }
  return null;
}

function requireApiAccess(config: ControlPlaneConfig): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const rejection = rejectDisallowedClient(c, config);
    if (rejection) return rejection;
    if (!isValidBearerToken(c.req.header("authorization"), config.token)) {
      return rejectRequest(c, 401, "unauthorized", "Missing or invalid bearer token");
    }
    await next();
  };
}

function requireStreamAccess(config: ControlPlaneConfig): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const rejection = rejectDisallowedClient(c, config);
    if (rejection) return rejection;
    if (!matchWebSocketTokenProtocol(c.req.header("sec-websocket-protocol"), config.token)) {
      return rejectRequest(c, 401, "unauthorized", "Missing or invalid dex-ai token subprotocol");
    }
    await next();
  };
}

/** Build the Hono app for the HTTP API, WebSocket stream and static assets. */
export function createControlPlaneApp(
  config: ControlPlaneConfig,
  hub: StreamHub,
  db: ControlPlaneDb,
  database: DatabaseSync,
  adapter: AgentAdapter,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const api = new Hono<AppEnv>();
  // CORS covers HTTP API routes only; the WebSocket upgrade path must keep
  // mutable response headers, so /stream stays outside this group.
  api.use(
    "*",
    cors({
      origin: getAllowedOrigins(config),
      allowHeaders: ["Authorization", "Content-Type"],
    }),
  );
  api.use("*", requireApiAccess(config));
  api.route("/health", createHealthRoute(config));
  api.route("/events", createEventsRoute({ database, db, hub }));
  api.route("/sessions", createSessionsRoute({ db }));
  api.route("/profile", createProfileRoute({ database, db, adapter, hub }));
  api.route("/rules", createRulesRoute({ database, db, hub }));
  api.route("/revisions", createRevisionsRoute({ db }));
  api.route("/match", createMatchRoute({ db }));
  api.route("/teaching", createTeachingRoute({ database, db, hub, adapter }));
  api.route("/stt", createSttRoute(config));
  api.route(
    "/rehearsals",
    createRehearsalsRoute({
      database,
      db,
      hub,
      adapter,
      confidenceThreshold: config.lowConfidenceThreshold,
      autonomyRequiredCount: config.autonomyThreshold ?? DEFAULT_AUTONOMY_THRESHOLD,
    }),
  );
  api.route("/evaluations", createEvaluationsRoute({ database, db, adapter }));
  app.route("/api", api);

  app.use("/stream", requireStreamAccess(config));
  app.get(
    "/stream",
    upgradeWebSocket(() => ({
      onOpen: (_event, ws) => {
        if (ws.raw) hub.subscribe(ws.raw);
      },
      onClose: (_event, ws) => {
        if (ws.raw) hub.unsubscribe(ws.raw);
      },
    })),
  );

  app.route("/", createFixtureRoute());
  app.route("/", createWebRoute());

  return app;
}
