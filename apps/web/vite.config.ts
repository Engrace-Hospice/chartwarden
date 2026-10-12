// apps/web — Vite build/dev for the core staff app (F0-T03, ADR-0032/ADR-0030).
// Not part of `tsc -b` (outside the "src" include); type-checking is via the project graph.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `localhost` can resolve to IPv6 `[::1]` first, where another project's dev server may be listening; set
// VITE_API_PROXY_TARGET=http://127.0.0.1:3000 to pin the proxy to the IPv4 API (e.g. the Docker stack).
const API_PROXY_TARGET = process.env.VITE_API_PROXY_TARGET ?? "http://localhost:3000";

export default defineConfig({
  // Tailwind CSS v4 (architecture v0.11 §"Tailwind CSS v4"): the Vite plugin compiles the
  // `@import "tailwindcss"` entry (src/index.css) and auto-scans the module graph for class usage.
  plugins: [tailwindcss(), react()],
  server: {
    port: 5173,
    // Dev proxy: same-origin API calls (createApiClient baseUrl "") hit the Fastify backend.
    proxy: {
      "/api": { target: API_PROXY_TARGET, changeOrigin: true },
      "/webhooks": { target: API_PROXY_TARGET, changeOrigin: true },
      // ADR-0054 realtime hints; the backend serves it only when REALTIME_ENABLED is set (polling covers the rest).
      "/socket.io": { target: API_PROXY_TARGET, changeOrigin: true, ws: true },
    },
  },
  // Output under dist/ (already git-ignored); tsc -b emits the type graph into dist/ alongside.
  // WX-PR-022 (PERF-001): source maps were unconditionally public (`sourcemap: true`) on every
  // build — a real source/stack-trace disclosure surface with no error-tracking service currently
  // configured to consume them privately. Off until one is (then: 'hidden' + private upload).
  build: { outDir: "dist/app", sourcemap: false, emptyOutDir: true },
});
