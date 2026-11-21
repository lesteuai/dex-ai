import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TEST_TOKEN,
  closeTestControlPlane,
  startTestControlPlane,
  type TestControlPlane,
} from "./test-server";

let controlPlane: TestControlPlane;

beforeEach(async () => {
  controlPlane = await startTestControlPlane();
});

afterEach(async () => {
  await closeTestControlPlane(controlPlane);
});

const fetchApi = (path: string, headers: Record<string, string>): Promise<Response> =>
  fetch(`${controlPlane.baseUrl}${path}`, { headers });

const readFixtureFile = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/job-site/${name}`, import.meta.url)), "utf8");

describe("health route", () => {
  it("reports readiness and a loopback host for an authorized request", async () => {
    const response = await fetchApi("/api/health", { authorization: `Bearer ${TEST_TOKEN}` });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; host: string; loopback: boolean };
    expect(body).toMatchObject({ ok: true, host: "127.0.0.1", loopback: true });
  });
});

describe("API bearer token guard", () => {
  it("rejects a request without an Authorization header", async () => {
    const response = await fetchApi("/api/health", {});

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("unauthorized");
    expect(body.message).toContain("bearer token");
  });

  it("rejects a request with an invalid bearer token", async () => {
    const response = await fetchApi("/api/health", { authorization: `Bearer ${"x".repeat(64)}` });

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe("unauthorized");
  });
});

describe("origin allowlist", () => {
  it("rejects an authorized request from a disallowed origin", async () => {
    const response = await fetchApi("/api/health", {
      authorization: `Bearer ${TEST_TOKEN}`,
      origin: "https://evil.example",
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("forbidden");
    expect(body.message).toContain("Origin");
  });

  it("accepts an authorized request from an allowed extension origin", async () => {
    const response = await fetchApi("/api/health", {
      authorization: `Bearer ${TEST_TOKEN}`,
      origin: "chrome-extension://abcdefghijklmnop",
    });

    expect(response.status).toBe(200);
  });
});

describe("loopback binding", () => {
  it("binds to 127.0.0.1 on an ephemeral port", () => {
    const address = controlPlane.handle.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected the control plane to report a bound address");
    }

    expect(address.address).toBe("127.0.0.1");
    expect(address.port).toBeGreaterThan(0);
  });
});

describe("job-site fixture serving", () => {
  it("redirects /fixtures/job to the fixture index", async () => {
    const response = await fetch(`${controlPlane.baseUrl}/fixtures/job`, { redirect: "manual" });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/fixtures/job/");
  });

  it("serves the deterministic job-site pages under /fixtures/job/*", async () => {
    const response = await fetch(`${controlPlane.baseUrl}/fixtures/job/search.html`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe(readFixtureFile("search.html"));
  });

  it("serves the fixture stylesheet under /fixtures/job/*", async () => {
    const response = await fetch(`${controlPlane.baseUrl}/fixtures/job/styles.css`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(readFixtureFile("styles.css"));
  });
});
