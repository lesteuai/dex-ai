import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAllowedHosts,
  getAllowedOrigins,
  getConfigFilePath,
  loadOrCreateConfig,
} from "./config";

const TEMP_BASE = "/tmp/opencode";

let dexAiHome: string;

const writeConfigFile = (overrides: Record<string, unknown>): void => {
  const config: Record<string, unknown> = {
    host: "127.0.0.1",
    port: 8787,
    token: "a".repeat(64),
    dataDir: join(dexAiHome, "data"),
    extensionOrigins: [
      "chrome-extension://abcdefghijklmnop",
      "moz-extension://01234567-89ab-cdef-0123-456789abcdef",
    ],
    localUiOrigin: "http://127.0.0.1:8787",
    lowConfidenceThreshold: 0.7,
    parakeetModelPath: join(dexAiHome, "models", "parakeet-tdt-0.6b-v3-int8"),
    ...overrides,
  };
  writeFileSync(getConfigFilePath(), `${JSON.stringify(config, null, 2)}\n`);
};

beforeEach(() => {
  dexAiHome = mkdtempSync(join(TEMP_BASE, "dex-ai-config-"));
  process.env.DEX_AI_HOME = dexAiHome;
});

afterEach(() => {
  delete process.env.DEX_AI_HOME;
  rmSync(dexAiHome, { recursive: true, force: true });
});

describe("first-run config", () => {
  it("creates a config file with loopback defaults when none exists", () => {
    const config = loadOrCreateConfig();

    expect(existsSync(getConfigFilePath())).toBe(true);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8787);
    expect(config.dataDir).toBe(join(dexAiHome, "data"));
    expect(config.extensionOrigins).toEqual([]);
    expect(config.token).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(config.dataDir)).toBe(true);
  });

  it("writes the config file with mode 0600", () => {
    loadOrCreateConfig();

    const mode = statSync(getConfigFilePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("defaults the confidence threshold to a number within [0, 1]", () => {
    const { lowConfidenceThreshold } = loadOrCreateConfig();

    expect(lowConfidenceThreshold).toBeGreaterThanOrEqual(0);
    expect(lowConfidenceThreshold).toBeLessThanOrEqual(1);
  });
});

describe("config reload", () => {
  it("reloads an existing config without regenerating the token", () => {
    const first = loadOrCreateConfig();
    const second = loadOrCreateConfig();

    expect(second.token).toBe(first.token);
    expect(second).toEqual(first);
  });

  it("preserves a pre-existing token on repeated config generation", () => {
    const existingToken = "b".repeat(64);
    writeConfigFile({ token: existingToken });

    expect(loadOrCreateConfig().token).toBe(existingToken);
  });

  it("preserves configured extension origins across reloads", () => {
    writeConfigFile({});
    const config = loadOrCreateConfig();

    expect(config.extensionOrigins).toEqual([
      "chrome-extension://abcdefghijklmnop",
      "moz-extension://01234567-89ab-cdef-0123-456789abcdef",
    ]);
  });
});

describe("invalid config rejection", () => {
  it("rejects malformed JSON with an unreadable-config error", () => {
    writeFileSync(getConfigFilePath(), "{ not json ");

    expect(() => loadOrCreateConfig()).toThrow(/Unreadable config file/);
  });

  it.each(["not-a-port", 0, 65536, 1.5])("rejects invalid port %s", (port) => {
    writeConfigFile({ port });

    expect(() => loadOrCreateConfig()).toThrow(/Invalid config file/);
  });

  it.each(["short", "", 42, "c".repeat(31)])("rejects an unusable token %j", (token) => {
    writeConfigFile({ token });

    expect(() => loadOrCreateConfig()).toThrow(/Invalid config file/);
  });
});

describe("agent kind parsing", () => {
  it("defaults to the OpenCode agent kind on first run", () => {
    expect(loadOrCreateConfig().agentKind).toBe("opencode");
  });

  it("accepts the deterministic agent kind from the config file", () => {
    writeConfigFile({ agentKind: "deterministic" });

    expect(loadOrCreateConfig().agentKind).toBe("deterministic");
  });

  it("still loads a config file written before agentKind existed", () => {
    // JSON.stringify drops the undefined value, matching an older config file.
    writeConfigFile({ agentKind: undefined });

    expect(loadOrCreateConfig().agentKind).toBeUndefined();
  });

  it.each(["claude", "codex", "auto", 1])("rejects an unsupported agentKind %s", (agentKind) => {
    writeConfigFile({ agentKind });

    expect(() => loadOrCreateConfig()).toThrow(/Invalid config file/);
  });
});

describe("threshold parsing", () => {
  it.each([0, 0.35, 1])("accepts threshold %s", (lowConfidenceThreshold) => {
    writeConfigFile({ lowConfidenceThreshold });

    expect(loadOrCreateConfig().lowConfidenceThreshold).toBe(lowConfidenceThreshold);
  });

  it.each([-0.1, 1.5, "0.7"])("rejects threshold %s", (lowConfidenceThreshold) => {
    writeConfigFile({ lowConfidenceThreshold });

    expect(() => loadOrCreateConfig()).toThrow(/Invalid config file/);
  });
});

describe("allowed origins and hosts", () => {
  it("includes the UI origin, its localhost alias, and extension origins", () => {
    writeConfigFile({});
    const origins = getAllowedOrigins(loadOrCreateConfig());

    expect(origins).toContain("http://127.0.0.1:8787");
    expect(origins).toContain("http://localhost:8787");
    expect(origins).toContain("chrome-extension://abcdefghijklmnop");
    expect(origins).toContain("moz-extension://01234567-89ab-cdef-0123-456789abcdef");
  });

  it("omits the localhost alias when the UI already binds localhost", () => {
    writeConfigFile({ host: "localhost", localUiOrigin: "http://localhost:8787" });
    const origins = getAllowedOrigins(loadOrCreateConfig());

    expect(origins).toEqual([
      "http://localhost:8787",
      "chrome-extension://abcdefghijklmnop",
      "moz-extension://01234567-89ab-cdef-0123-456789abcdef",
    ]);
  });

  it("derives allowed hosts from the configured host plus localhost", () => {
    writeConfigFile({});
    const hosts = getAllowedHosts(loadOrCreateConfig());

    expect(hosts).toEqual(["127.0.0.1", "localhost"]);
  });

  it("does not duplicate localhost when it is already the configured host", () => {
    writeConfigFile({ host: "localhost", localUiOrigin: "http://localhost:8787" });

    expect(getAllowedHosts(loadOrCreateConfig())).toEqual(["localhost"]);
  });
});
