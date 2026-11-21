import { crx } from "@crxjs/vite-plugin";
import { defineConfig } from "vite";
import manifest from "./manifest.config";

const BROWSERS = ["chrome", "firefox"] as const;
type ExtensionBrowser = (typeof BROWSERS)[number];

function resolveBrowserTarget(mode: string): ExtensionBrowser {
  const target = mode as ExtensionBrowser;
  return BROWSERS.includes(target) ? target : "chrome";
}

// One source, two targets: the Vite mode (chrome or firefox) picks the CRXJS
// browser target and a separate output directory under dist/. The MAIN-world
// submit bridge is built as a standalone IIFE: the CRXJS content-script
// loader relies on extension APIs the page world cannot use.
export default defineConfig(({ mode }) => {
  const browser = resolveBrowserTarget(mode);
  return {
    plugins: [
      crx({
        manifest,
        browser,
        contentScripts: { standaloneFiles: ["src/content/submit-bridge.ts"] },
      }),
    ],
    build: { outDir: `dist/${browser}`, emptyOutDir: true },
  };
});
