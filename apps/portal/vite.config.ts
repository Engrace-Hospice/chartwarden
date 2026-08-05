// apps/portal — Vite build/dev for the consumer-facing Patient/Family Portal PWA (M31 §5.1, ADR-0030/0008).
// Not part of `tsc -b` (outside the "src" include); type-checking is via the project graph. Mirrors the
// apps/web config: Tailwind v4 plugin + React, and a dev proxy so same-origin API calls (createApiClient
// baseUrl "") reach the Fastify backend.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    port: 5174,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      "/webhooks": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
  // WX-PR-022 (PERF-001): source maps were unconditionally public — a real source/stack-trace
  // disclosure surface with no error-tracking service currently configured to consume them
  // privately. Off until one is (then: 'hidden' + private upload).
  build: { outDir: "dist/app", sourcemap: false, emptyOutDir: true },
});
