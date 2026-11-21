import { defineManifest } from "@crxjs/vite-plugin";

/**
 * One manifest definition for both development builds.
 * The Vite mode selects the target: `--mode chrome` emits an MV3 service
 * worker, `--mode firefox` emits MV3 background event-page scripts.
 */

// The control plane binds loopback only; 8787 is the default port from
// apps/control-plane/src/config.ts. A custom port requires editing this.
const CONTROL_PLANE_HOST_PERMISSIONS = [
  "http://127.0.0.1:8787/*",
  "http://localhost:8787/*",
];

// Pinned public key keeps the Chrome extension ID stable across dev reloads:
// ffvdecqdiyveusqd, so the chrome-extension:// origin in the control plane
// extensionOrigins allowlist stays valid.
export const CHROME_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAw6RokKOWalSkdGWR+M1nsv0s2ARQQ59QPA/ExSQ0KlHupmPB5ZGkqpMjCOCGOxXgOGJQqMng/oJY5yKb0GbqRrKKbT/HTc07sWVAiJDgFHPTmThcght39jItd2RIVFCNjWniEgnkds886alIjxx0qWYqPt27i8hMnaHCGeB2GmjYt6DF2wHvmGS1tsVfHgpQkfEsBOKHTd+igWcQmq6wPP10tFwSF2W619a9AV0i+Sm7o6+LCN7izFYh5xDftG8UqIXoO98NNxnwie26lngoy3WdMVUldZgdYi8alaTb64vVdxJcwHQ4FtgXtXdI58ZkREswBX2Dbw0GRoeLcd3hSwIDAQAB";

// Pinned add-on identity for Firefox. Firefox still assigns a random
// moz-extension:// UUID per install, so setup must copy the origin shown in
// about:debugging into the control plane extensionOrigins config.
export const FIREFOX_ADDON_ID = "{b706199c-64b7-4d01-b09b-cffc908f95bd}";

const SHARED_MANIFEST = {
  manifest_version: 3 as const,
  name: "Dex AI",
  version: "0.1.0",
  description:
    "Development extension that observes job-search activity and executes approved rehearsal actions for the local Dex AI control plane.",
  permissions: ["storage", "tabs"],
  host_permissions: CONTROL_PLANE_HOST_PERMISSIONS,
  action: { default_popup: "src/popup/index.html" },
};

export default defineManifest(({ mode }) => {
  if (mode === "firefox") {
    return {
      ...SHARED_MANIFEST,
      background: { scripts: ["src/background/index.ts"] },
      browser_specific_settings: {
        gecko: { id: FIREFOX_ADDON_ID, strict_min_version: "121.0" },
      },
    };
  }

  return {
    ...SHARED_MANIFEST,
    background: { service_worker: "src/background/index.ts", type: "module" },
    key: CHROME_PUBLIC_KEY,
  };
});
