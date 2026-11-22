import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.7;
const PARAKEET_MODEL_DIR_NAME = "parakeet-tdt-0.6b-v3-int8";
const MIN_TOKEN_LENGTH = 32;
export const DEFAULT_AUTONOMY_THRESHOLD = 3;

/** "deterministic" exists for automated runs; production runs use OpenCode. */
export const agentKindSchema = z.enum(["opencode", "deterministic"]);

export type AgentKind = z.infer<typeof agentKindSchema>;

export const configSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  token: z.string().min(MIN_TOKEN_LENGTH),
  dataDir: z.string().min(1),
  extensionOrigins: z.array(z.string().min(1)),
  localUiOrigin: z.string().min(1),
  lowConfidenceThreshold: z.number().min(0).max(1),
  parakeetModelPath: z.string().min(1),
  // Optional so config files written before this field existed still load.
  agentKind: agentKindSchema.optional(),
  // Completed rehearsals needed on a platform and role type before auto mode skips pauses.
  autonomyThreshold: z.number().int().min(1).optional(),
});

export type ControlPlaneConfig = z.infer<typeof configSchema>;

function getDexAiHome(): string | undefined {
  const override = process.env.DEX_AI_HOME?.trim();
  return override ? override : undefined;
}

export function getConfigFilePath(): string {
  const home = getDexAiHome();
  return home ? join(home, "config.json") : join(homedir(), ".config", "dex-ai", "config.json");
}

function getDefaultDataDir(): string {
  const home = getDexAiHome();
  return home ? join(home, "data") : join(homedir(), ".local", "share", "dex-ai");
}

function buildDefaultConfig(): ControlPlaneConfig {
  const dataDir = getDefaultDataDir();
  return {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    token: randomBytes(32).toString("hex"),
    dataDir,
    // Install-time extension IDs are unknowable at first run (Firefox assigns a
    // random moz-extension UUID per install), so setup appends real origins.
    extensionOrigins: [],
    localUiOrigin: `http://${DEFAULT_HOST}:${DEFAULT_PORT}`,
    lowConfidenceThreshold: DEFAULT_LOW_CONFIDENCE_THRESHOLD,
    parakeetModelPath: join(dataDir, "models", PARAKEET_MODEL_DIR_NAME),
    agentKind: "opencode",
  };
}

function readConfigFile(configPath: string): ControlPlaneConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Unreadable config file at ${configPath}: ${(error as Error).message}`, { cause: error });
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const details = JSON.stringify(z.flattenError(parsed.error));
    throw new Error(`Invalid config file at ${configPath}: ${details}`);
  }
  return parsed.data;
}

function createFirstRunConfig(configPath: string): ControlPlaneConfig {
  const config = buildDefaultConfig();
  mkdirSync(dirname(configPath), { recursive: true });
  // 0600 keeps the local token readable by the owning user only.
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return config;
}

export function loadOrCreateConfig(): ControlPlaneConfig {
  const configPath = getConfigFilePath();
  const config = existsSync(configPath) ? readConfigFile(configPath) : createFirstRunConfig(configPath);
  mkdirSync(config.dataDir, { recursive: true });
  return config;
}

export function getAllowedOrigins(config: ControlPlaneConfig): string[] {
  // Accept the localhost alias of the UI origin; it still resolves to loopback.
  const uiOrigins = config.host === "localhost"
    ? [config.localUiOrigin]
    : [config.localUiOrigin, `http://localhost:${config.port}`];
  return [...uiOrigins, ...config.extensionOrigins];
}

export function getAllowedHosts(config: ControlPlaneConfig): string[] {
  return [...new Set([config.host, "localhost"])];
}
