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
// browser target and a separate output directory under dist/.
export default defineConfig(({ mode }) => {
  const browser = resolveBrowserTarget(mode);
  return {
    plugins: [crx({ manifest, browser })],
    build: { outDir: `dist/${browser}`, emptyOutDir: true },
  };
});
