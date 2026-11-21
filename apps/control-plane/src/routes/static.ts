import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

const routesDir = fileURLToPath(new URL(".", import.meta.url));
const webDistDir = join(routesDir, "../../../web/dist");
const jobSiteDir = join(routesDir, "../../fixtures/job-site");

export const FIXTURE_URL_PREFIX = "/fixtures/job";

/** GET /fixtures/job/* serves the deterministic local job-site pages. */
export function createFixtureRoute(): Hono<{ Bindings: HttpBindings }> {
  const fixture = new Hono<{ Bindings: HttpBindings }>();
  fixture.get(FIXTURE_URL_PREFIX, (c) => c.redirect(`${FIXTURE_URL_PREFIX}/`));
  fixture.get(
    `${FIXTURE_URL_PREFIX}/*`,
    serveStatic({
      root: jobSiteDir,
      rewriteRequestPath: (path) => path.slice(FIXTURE_URL_PREFIX.length),
    }),
  );
  return fixture;
}

/** GET /* serves the built web interface with an index.html fallback. */
export function createWebRoute(): Hono<{ Bindings: HttpBindings }> {
  const web = new Hono<{ Bindings: HttpBindings }>();
  if (!existsSync(webDistDir)) {
    console.warn(`Web build not found at ${webDistDir}; build apps/web to enable the interface.`);
    return web;
  }
  web.get("*", serveStatic({ root: webDistDir, index: "index.html" }));
  // Client-side routes fall back to index.html; reserved server paths 404.
  const indexFile = serveStatic({ path: join(webDistDir, "index.html") });
  web.get("*", (c, next) => {
    const path = c.req.path;
    if (path === "/api" || path.startsWith("/api/")) return next();
    if (path === "/stream" || path.startsWith("/fixtures/")) return next();
    return indexFile(c, next);
  });
  return web;
}
