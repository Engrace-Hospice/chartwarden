// apps/admin — Vite build/dev for the WardenX-staff Platform-Ops console SPA (M34 §5.1 shell + the
// M35 §5.2 subscription-billing slice, ADR-0030). Not part of `tsc -b` (outside the "src" include);
// type-checking is via the project graph. Mirrors the apps/web + apps/portal config: Tailwind v4 plugin
// + React, and a dev proxy so same-origin API calls (createApiClient baseUrl "") reach the Fastify
// backend. Dev port 5175 is distinct from web (5173) and portal (5174) so all three can run at once.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    port: 5175,
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
