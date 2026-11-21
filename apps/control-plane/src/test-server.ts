import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ControlPlaneConfig } from "./config";
import { startControlPlane, type ControlPlaneHandle } from "./index";

const TEMP_BASE = "/tmp/opencode";

export const TEST_TOKEN = "t".repeat(64);

export const TEST_EXTENSION_ORIGINS = [
  "chrome-extension://abcdefghijklmnop",
  "moz-extension://01234567-89ab-cdef-0123-456789abcdef",
];

export interface TestControlPlane {
  config: ControlPlaneConfig;
  handle: ControlPlaneHandle;
  baseUrl: string;
  wsUrl: string;
}

/** In-memory config with an ephemeral port; no config file is read or written. */
export function buildTestConfig(): ControlPlaneConfig {
  const dataDir = mkdtempSync(join(TEMP_BASE, "dex-ai-control-plane-"));
  return {
    host: "127.0.0.1",
    // Port 0 makes the OS assign an ephemeral port for each test server.
    port: 0,
    token: TEST_TOKEN,
    dataDir,
    extensionOrigins: TEST_EXTENSION_ORIGINS,
    localUiOrigin: "http://127.0.0.1:8787",
    lowConfidenceThreshold: 0.7,
    parakeetModelPath: join(dataDir, "models"),
  };
}

export async function startTestControlPlane(): Promise<TestControlPlane> {
  const config = buildTestConfig();
  const handle = await startControlPlane(config);
  const address = handle.server.address();
  if (address === null || typeof address === "string") {
    await handle.close();
    throw new Error("Expected the control plane to report a bound loopback address");
  }
  return {
    config,
    handle,
    baseUrl: `http://${address.address}:${address.port}`,
    wsUrl: `ws://${address.address}:${address.port}/stream`,
  };
}

export async function closeTestControlPlane(controlPlane: TestControlPlane): Promise<void> {
  await controlPlane.handle.close();
  if (controlPlane.config.dataDir.startsWith(TEMP_BASE)) {
    rmSync(controlPlane.config.dataDir, { recursive: true, force: true });
  }
}
