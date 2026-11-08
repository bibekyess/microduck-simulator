import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// OPENROUTER_API_KEY from app/.env, read here on the dev server only (no
// VITE_ prefix, so it is never inlined into the client bundle).
const { OPENROUTER_API_KEY } = loadEnv("development", process.cwd(), "");

export default defineConfig({
  // Deploy prefix: "/" standalone (the HF Space), "/play/" when the bundle
  // is served under the Microduck Academy (VITE_BASE=/play/ npm run build).
  // Runtime asset URLs are base-relative ("./assets", "./policies") so
  // only the bundle references in index.html depend on this.
  base: process.env.VITE_BASE || "/",
  plugins: [react()],
  // MuJoCo WASM and onnxruntime-web stay on the CDN (dynamic import with
  // @vite-ignore in game/boot.js), exactly like the pre-Vite app: their
  // .wasm sidecars resolve relative to the CDN URL and never touch the
  // bundle.
  server: {
    port: 5173,
    // Agent harness -> System One (src/agent/system-one.js), key added here.
    proxy: {
      "/api/s1": {
        target: "https://openrouter.ai",
        changeOrigin: true,
        rewrite: () => "/api/alpha/decisions",
        headers: { Authorization: `Bearer ${OPENROUTER_API_KEY ?? ""}` },
      },
    },
  },
  build: {
    // Keep the JS/CSS bundle out of dist/assets/: the game's static assets
    // (public/assets/) land there and must keep their historical URLs.
    assetsDir: "bundle",
    chunkSizeWarningLimit: 1500,
  },
});
