import browser from "webextension-polyfill";

/** Stored control plane connection settings owned by the background coordinator. */

export const DEFAULT_CONTROL_PLANE_URL = "http://127.0.0.1:8787";

const SETTINGS_STORAGE_KEY = "controlPlaneSettings";

export interface ControlPlaneSettings {
  baseUrl: string;
  token: string | null;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/** Read the control plane base URL and the local token. */
export async function getControlPlaneSettings(): Promise<ControlPlaneSettings> {
  const stored = await browser.storage.local.get(SETTINGS_STORAGE_KEY);
  const raw = (stored as Record<string, unknown>)[SETTINGS_STORAGE_KEY];
  if (typeof raw !== "object" || raw === null) {
    return { baseUrl: DEFAULT_CONTROL_PLANE_URL, token: null };
  }
  const record = raw as Record<string, unknown>;
  const baseUrl = typeof record.baseUrl === "string" && record.baseUrl.trim() !== ""
    ? normalizeBaseUrl(record.baseUrl)
    : DEFAULT_CONTROL_PLANE_URL;
  const token = typeof record.token === "string" && record.token.trim() !== ""
    ? record.token.trim()
    : null;
  return { baseUrl, token };
}

/** Persist a new base URL or token and return the effective settings. */
export async function saveControlPlaneSettings(
  update: { baseUrl?: string; token?: string | null },
): Promise<ControlPlaneSettings> {
  const current = await getControlPlaneSettings();
  const baseUrl = typeof update.baseUrl === "string" && update.baseUrl.trim() !== ""
    ? normalizeBaseUrl(update.baseUrl)
    : current.baseUrl;
  const token = update.token === undefined
    ? current.token
    : update.token === null || update.token.trim() === ""
      ? null
      : update.token.trim();
  const next: ControlPlaneSettings = { baseUrl, token };
  await browser.storage.local.set({ [SETTINGS_STORAGE_KEY]: next });
  return next;
}
