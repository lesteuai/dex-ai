import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

const TOKEN_PROTOCOL_PREFIX = "dex-ai.";
const BEARER_TOKEN_PATTERN = /^bearer\s+(.+)$/i;

function isSameSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function parseHostname(headerHost: string): string | null {
  try {
    const { hostname } = new URL(`http://${headerHost}`);
    // WHATWG URL keeps brackets on IPv6 hostnames; normalize them away.
    return hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

export function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const address = remoteAddress.toLowerCase();
  if (address === "::1") return true;
  if (address.startsWith("::ffff:")) {
    return isLoopbackRemoteAddress(address.slice("::ffff:".length));
  }
  // The whole 127.0.0.0/8 block is IPv4 loopback.
  return address.startsWith("127.");
}

export function isAllowedHost(headerHost: string | undefined, allowedHosts: readonly string[]): boolean {
  if (!headerHost) return false;
  const hostname = parseHostname(headerHost);
  if (!hostname) return false;
  const allowed = new Set(allowedHosts.map((host) => host.toLowerCase()));
  return allowed.has(hostname);
}

export function isValidBearerToken(
  authorizationHeader: string | undefined,
  expectedToken: string,
): boolean {
  if (!authorizationHeader) return false;
  const match = BEARER_TOKEN_PATTERN.exec(authorizationHeader);
  if (!match) return false;
  return isSameSecret(match[1].trim(), expectedToken);
}

export function isAllowedOrigin(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  if (!origin) return false;
  const requested = origin.trim().toLowerCase();
  return allowedOrigins.some((allowed) => allowed.toLowerCase() === requested);
}

export function matchWebSocketTokenProtocol(
  requestedProtocols: string | readonly string[] | undefined,
  expectedToken: string,
): string | null {
  const expected = `${TOKEN_PROTOCOL_PREFIX}${expectedToken}`;
  const rawList = typeof requestedProtocols === "string"
    ? requestedProtocols.split(",")
    : [...(requestedProtocols ?? [])];
  const candidates = rawList.map((protocol) => protocol.trim());
  return candidates.includes(expected) ? expected : null;
}
