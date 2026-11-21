import { describe, expect, it } from "vitest";
import manifest, { CHROME_PUBLIC_KEY, FIREFOX_ADDON_ID } from "../manifest.config";

type ExtensionMode = "chrome" | "firefox";

// defineManifest returns a union type TS cannot call directly, so cast to the
// function shape the CRXJS plugin itself uses.
const buildManifest = (mode: ExtensionMode): Record<string, unknown> =>
  (manifest as unknown as (env: { mode: string }) => Record<string, unknown>)({ mode });

describe("shared manifest identity", () => {
  it("pins the extension name, version, permissions and loopback hosts", () => {
    for (const mode of ["chrome", "firefox"] as const) {
      const output = buildManifest(mode);
      expect(output.manifest_version).toBe(3);
      expect(output.name).toBe("Dex AI");
      expect(output.version).toBe("0.1.0");
      expect(output.permissions).toEqual(["storage", "tabs"]);
      expect(output.host_permissions).toEqual([
        "http://127.0.0.1:8787/*",
        "http://localhost:8787/*",
      ]);
      expect(output.description).toMatch(/control plane/);
    }
  });
});

describe("chrome build", () => {
  it("emits a module service worker with the pinned extension key", () => {
    const output = buildManifest("chrome");
    expect(output.background).toEqual({
      service_worker: "src/background/index.ts",
      type: "module",
    });
    expect(output.key).toBe(CHROME_PUBLIC_KEY);
    // A real RSA SubjectPublicKeyInfo keeps the extension id stable so the
    // control plane extensionOrigins allowlist keeps matching.
    expect(output.key).toMatch(/^MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A/);
    expect(output.browser_specific_settings).toBeUndefined();
  });
});

describe("firefox build", () => {
  it("emits background scripts with the pinned add-on id", () => {
    const output = buildManifest("firefox");
    expect(output.background).toEqual({ scripts: ["src/background/index.ts"] });
    expect(output.browser_specific_settings).toEqual({
      gecko: { id: FIREFOX_ADDON_ID, strict_min_version: "121.0" },
    });
    expect(FIREFOX_ADDON_ID).toMatch(/^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/);
    expect(output.key).toBeUndefined();
  });
});

it("keeps the identity stable across repeated builds", () => {
  expect(buildManifest("chrome").key).toBe(buildManifest("chrome").key);
  expect(buildManifest("firefox").browser_specific_settings).toEqual(
    buildManifest("firefox").browser_specific_settings,
  );
});
