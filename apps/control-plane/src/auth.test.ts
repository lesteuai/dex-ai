import { describe, expect, it } from "vitest";
import {
  isAllowedHost,
  isAllowedOrigin,
  isLoopbackRemoteAddress,
  isValidBearerToken,
  matchWebSocketTokenProtocol,
} from "./auth";

const TOKEN = "t".repeat(64);

const ALLOWED_ORIGINS = [
  "http://127.0.0.1:8787",
  "chrome-extension://abcdefghijklmnop",
  "moz-extension://01234567-89ab-cdef-0123-456789abcdef",
];

describe("loopback remote addresses", () => {
  it.each([
    ["127.0.0.1", true],
    ["127.0.0.10", true],
    ["127.255.255.254", true],
    ["::1", true],
    ["::ffff:127.0.0.1", true],
    ["::FFFF:127.0.0.1", true],
  ])("accepts loopback address %s", (remoteAddress, expected) => {
    expect(isLoopbackRemoteAddress(remoteAddress)).toBe(expected);
  });

  it.each([
    ["10.0.0.1", false],
    ["192.168.1.5", false],
    ["172.16.0.9", false],
    ["::ffff:10.0.0.1", false],
    ["0.0.0.0", false],
    ["::", false],
    ["fe80::1", false],
    ["localhost", false],
    [undefined, false],
  ])("rejects non-loopback address %s", (remoteAddress, expected) => {
    expect(isLoopbackRemoteAddress(remoteAddress)).toBe(expected);
  });
});

describe("Host allowlist", () => {
  const allowedHosts = ["127.0.0.1", "localhost"];

  it.each([
    ["127.0.0.1:8787", true],
    ["127.0.0.1", true],
    ["localhost:8787", true],
    ["localhost", true],
    ["LOCALHOST:8787", true],
    ["[::1]:8787", false],
    ["example.com:8787", false],
    ["127.0.0.1.evil.com:8787", false],
    ["evil.com#localhost", false],
    ["", false],
    [undefined, false],
  ])("treats Host %s as allowed=%s", (headerHost, expected) => {
    expect(isAllowedHost(headerHost, allowedHosts)).toBe(expected);
  });

  it("accepts an IPv6 Host when it is in the allowlist", () => {
    expect(isAllowedHost("[::1]:8787", ["::1"])).toBe(true);
  });
});

describe("bearer token validation", () => {
  it("accepts the correct token with a Bearer scheme", () => {
    expect(isValidBearerToken(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it("accepts a case-insensitive Bearer scheme", () => {
    expect(isValidBearerToken(`BEARER ${TOKEN}`, TOKEN)).toBe(true);
  });

  it.each([
    [undefined],
    [""],
    [`Token ${TOKEN}`],
    ["Bearer"],
    [`Bearer ${"x".repeat(64)}`],
    [TOKEN],
  ])("rejects authorization header %j", (authorizationHeader) => {
    expect(isValidBearerToken(authorizationHeader, TOKEN)).toBe(false);
  });
});

describe("origin allowlist", () => {
  it.each([
    ["chrome-extension://abcdefghijklmnop", true],
    ["moz-extension://01234567-89ab-cdef-0123-456789abcdef", true],
    ["http://127.0.0.1:8787", true],
  ])("accepts allowed origin %s", (origin, expected) => {
    expect(isAllowedOrigin(origin, ALLOWED_ORIGINS)).toBe(expected);
  });

  it.each([
    [undefined],
    [""],
    ["https://evil.com"],
    ["chrome-extension://otherid"],
    ["moz-extension://01234567-89ab-cdef-0123-456789abcdeg"],
    ["http://127.0.0.1:9999"],
  ])("rejects origin %j", (origin) => {
    expect(isAllowedOrigin(origin, ALLOWED_ORIGINS)).toBe(false);
  });
});

describe("WebSocket token subprotocol", () => {
  it("matches the token subprotocol from a single string", () => {
    expect(matchWebSocketTokenProtocol(`dex-ai.${TOKEN}`, TOKEN)).toBe(`dex-ai.${TOKEN}`);
  });

  it("matches the token subprotocol inside a comma-separated string", () => {
    expect(matchWebSocketTokenProtocol(`chat, dex-ai.${TOKEN}`, TOKEN)).toBe(`dex-ai.${TOKEN}`);
  });

  it("matches the token subprotocol inside an array", () => {
    expect(matchWebSocketTokenProtocol(["chat", `dex-ai.${TOKEN}`], TOKEN)).toBe(`dex-ai.${TOKEN}`);
  });

  it.each([
    [`dex-ai.${"x".repeat(64)}`],
    ["dex-ai."],
    ["dex-ai"],
    ["chat"],
    ["dex-ai chat"],
    [undefined],
    [[]],
  ])("rejects subprotocols %j", (requestedProtocols) => {
    expect(matchWebSocketTokenProtocol(requestedProtocols, TOKEN)).toBeNull();
  });
});
