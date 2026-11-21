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
      expect(output.action).toEqual({ default_popup: "src/popup/index.html" });
      expect(output.description).toMatch(/control plane/);
    }
  });

  it("injects the observer and the MAIN-world submit bridge in both browsers", () => {
    const contentScripts = [
      { matches: ["http://*/*", "https://*/*"], js: ["src/content/index.ts"], run_at: "document_idle" },
      {
        matches: ["http://*/*", "https://*/*"],
        js: ["src/content/submit-bridge.ts"],
        run_at: "document_start",
        world: "MAIN",
      },
    ];
    for (const mode of ["chrome", "firefox"] as const) {
      expect(buildManifest(mode).content_scripts).toEqual(contentScripts);
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
    // Chrome's default extension CSP carries no upgrade directive, so the
    // manifest stays implicit there.
    expect(output.content_security_policy).toBeUndefined();
  });
});

describe("firefox build", () => {
  it("emits background scripts with the pinned add-on id", () => {
    const output = buildManifest("firefox");
    expect(output.background).toEqual({ scripts: ["src/background/index.ts"] });
    expect(output.browser_specific_settings).toEqual({
      // The MAIN-world content script needs Firefox 128 or newer.
      gecko: { id: FIREFOX_ADDON_ID, strict_min_version: "128.0" },
    });
    expect(FIREFOX_ADDON_ID).toMatch(/^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/);
    expect(output.key).toBeUndefined();
  });

  it("declares extension pages CSP without upgrade-insecure-requests", () => {
    const policy = buildManifest("firefox").content_security_policy as { extension_pages: string };
    // Firefox's default MV3 CSP would upgrade the loopback ws:// stream to
    // wss:// and break the control plane connection, so the policy must
    // exclude the directive while keeping scripts restricted to 'self'.
    expect(policy.extension_pages).toContain("script-src 'self'");
    expect(policy.extension_pages).not.toContain("upgrade-insecure-requests");
    expect(policy.extension_pages).not.toContain("unsafe-eval");
    expect(policy.extension_pages).not.toContain("unsafe-inline");
  });
});

it("keeps the identity stable across repeated builds", () => {
  expect(buildManifest("chrome").key).toBe(buildManifest("chrome").key);
  expect(buildManifest("firefox").browser_specific_settings).toEqual(
    buildManifest("firefox").browser_specific_settings,
  );
});
