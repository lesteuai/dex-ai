import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const controlPlaneTarget = process.env.DEX_AI_CONTROL_PLANE_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  // Dev-server proxy: the built app is same-origin with the control plane,
  // and `vite dev` forwards API, fixture and stream traffic to it.
  server: {
    proxy: {
      "/api": controlPlaneTarget,
      "/fixtures": controlPlaneTarget,
      "/stream": { target: controlPlaneTarget, ws: true },
    },
  },
});
