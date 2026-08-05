// apps/web — Vite build/dev for the core staff app (F0-T03, ADR-0032/ADR-0030).
// Not part of `tsc -b` (outside the "src" include); type-checking is via the project graph.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Tailwind CSS v4 (architecture v0.11 §"Tailwind CSS v4"): the Vite plugin compiles the
  // `@import "tailwindcss"` entry (src/index.css) and auto-scans the module graph for class usage.
  plugins: [tailwindcss(), react()],
  server: {
    port: 5173,
    // Dev proxy: same-origin API calls (createApiClient baseUrl "") hit the Fastify backend.
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      "/webhooks": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
  // Output under dist/ (already git-ignored); tsc -b emits the type graph into dist/ alongside.
  // WX-PR-022 (PERF-001): source maps were unconditionally public (`sourcemap: true`) on every
  // build — a real source/stack-trace disclosure surface with no error-tracking service currently
  // configured to consume them privately. Off until one is (then: 'hidden' + private upload).
  build: { outDir: "dist/app", sourcemap: false, emptyOutDir: true },
});
