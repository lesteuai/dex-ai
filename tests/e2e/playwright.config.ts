import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HOST = "127.0.0.1";
const TEMP_ROOT = "/tmp/opencode";

/** One known token for both browser homes; the config schema needs 32+ characters. */
export const E2E_TOKEN = "e2e61d7d1c4b4a49b8c3d2e1f0a998877665544332211ffeeddccbbaa998877";
export const E2E_WS_PROTOCOL = `dex-ai.${E2E_TOKEN}`;

/** Each browser project talks to its own control plane so repeat runs stay deterministic. */
export const e2eOrigins = {
  chromium: "http://127.0.0.1:8791",
  firefox: "http://127.0.0.1:8792",
} as const;

export type E2eBrowserName = keyof typeof e2eOrigins;

/** The control plane under test runs from this repository checkout. */
export const E2E_REPO_ROOT = REPO_ROOT;

const e2eHomes = {
  chromium: join(TEMP_ROOT, "dex-ai-e2e-web-chromium"),
  firefox: join(TEMP_ROOT, "dex-ai-e2e-web-firefox"),
} as const;

function buildControlPlaneConfig(home: string, port: number): Record<string, unknown> {
  const dataDir = join(home, "data");
  return {
    host: HOST,
    port,
    token: E2E_TOKEN,
    dataDir,
    extensionOrigins: [
      "chrome-extension://e2e0chrome0extension0origin0000000000",
      "moz-extension://e2e0firefox0extension0origin00000000000",
    ],
    localUiOrigin: `http://${HOST}:${port}`,
    lowConfidenceThreshold: 0.7,
    parakeetModelPath: join(dataDir, "models", "parakeet-tdt-0.6b-v3-int8"),
    // Automated runs never touch OpenCode or the network.
    agentKind: "deterministic",
  };
}

/**
 * Wipe both homes and rebuild the web app once per run. Worker processes
 * inherit the guard variable, so only the main Playwright process prepares.
 */
function prepareE2eHomes(): void {
  for (const browserName of Object.keys(e2eHomes) as E2eBrowserName[]) {
    const home = e2eHomes[browserName];
    const port = Number(new URL(e2eOrigins[browserName]).port);
    rmSync(home, { recursive: true, force: true });
    mkdirSync(join(home, "data"), { recursive: true });
    const config = buildControlPlaneConfig(home, port);
    // 0600 matches the control plane's own first-run config write.
    writeFileSync(join(home, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }
  // The control plane serves the built web interface from apps/web/dist.
  execFileSync("bun", ["run", "--filter=./apps/web", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
}

const PREPARED_ENV = "DEX_AI_E2E_WEB_PREPARED";
if (process.env[PREPARED_ENV] === undefined) {
  prepareE2eHomes();
  process.env[PREPARED_ENV] = "1";
}

function webServerFor(browserName: E2eBrowserName) {
  return {
    command: "node_modules/.bin/tsx src/index.ts",
    cwd: join(REPO_ROOT, "apps/control-plane"),
    env: { DEX_AI_HOME: e2eHomes[browserName] },
    url: `${e2eOrigins[browserName]}/`,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM" as const, timeout: 5000 },
    timeout: 120_000,
  };
}

export default defineConfig({
  testDir: "./web",
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], baseURL: e2eOrigins.chromium },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"], baseURL: e2eOrigins.firefox },
    },
  ],
  webServer: [webServerFor("chromium"), webServerFor("firefox")],
});
