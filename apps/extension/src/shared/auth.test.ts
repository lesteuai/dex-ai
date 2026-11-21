import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONTROL_PLANE_URL,
  getControlPlaneSettings,
  saveControlPlaneSettings,
} from "./auth";

const polyfill = vi.hoisted(() => {
  const storage = new Map<string, unknown>();
  return {
    storage,
    browser: {
      storage: {
        local: {
          get: async (key: string): Promise<Record<string, unknown>> =>
            storage.has(key) ? { [key]: storage.get(key) } : {},
          set: async (items: Record<string, unknown>): Promise<void> => {
            for (const [key, value] of Object.entries(items)) storage.set(key, value);
          },
        },
      },
    },
  };
});

vi.mock("webextension-polyfill", () => ({ default: polyfill.browser }));

beforeEach(() => {
  polyfill.storage.clear();
});

describe("settings defaults", () => {
  it("returns loopback defaults when nothing is stored", async () => {
    expect(await getControlPlaneSettings()).toEqual({
      baseUrl: DEFAULT_CONTROL_PLANE_URL,
      token: null,
    });
  });

  it("falls back to defaults when the stored value is not an object", async () => {
    polyfill.storage.set("controlPlaneSettings", "corrupted");
    expect(await getControlPlaneSettings()).toEqual({
      baseUrl: DEFAULT_CONTROL_PLANE_URL,
      token: null,
    });
  });
});

describe("token persistence", () => {
  it("stores a trimmed token that survives later reads", async () => {
    const saved = await saveControlPlaneSettings({ token: "  token-123  " });
    expect(saved).toEqual({ baseUrl: DEFAULT_CONTROL_PLANE_URL, token: "token-123" });
    expect(await getControlPlaneSettings()).toEqual(saved);
  });

  it("keeps the stored token when only the base URL changes", async () => {
    await saveControlPlaneSettings({ token: "token-123" });
    const saved = await saveControlPlaneSettings({ baseUrl: "http://localhost:8787/" });
    expect(saved).toEqual({ baseUrl: "http://localhost:8787", token: "token-123" });
  });

  it("clears the token on an explicit null or blank value", async () => {
    await saveControlPlaneSettings({ token: "token-123" });
    expect(await saveControlPlaneSettings({ token: null })).toEqual({
      baseUrl: DEFAULT_CONTROL_PLANE_URL,
      token: null,
    });

    await saveControlPlaneSettings({ token: "token-456" });
    expect(await saveControlPlaneSettings({ token: "   " })).toEqual({
      baseUrl: DEFAULT_CONTROL_PLANE_URL,
      token: null,
    });
  });
});

describe("base URL normalization", () => {
  it("strips trailing slashes", async () => {
    const saved = await saveControlPlaneSettings({ baseUrl: "http://localhost:8787///" });
    expect(saved.baseUrl).toBe("http://localhost:8787");
  });

  it("keeps the current base URL when given a blank one", async () => {
    await saveControlPlaneSettings({ baseUrl: "http://localhost:8787" });
    const saved = await saveControlPlaneSettings({ baseUrl: "   " });
    expect(saved.baseUrl).toBe("http://localhost:8787");
  });
});
