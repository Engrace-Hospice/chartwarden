// apps/web — Vite build/dev for the core staff app (F0-T03, ADR-0032/ADR-0030).
// Not part of `tsc -b` (outside the "src" include); type-checking is via the project graph.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Dev proxy: same-origin API calls (createApiClient baseUrl "") hit the Fastify backend.
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      "/webhooks": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
  // Output under dist/ (already git-ignored); tsc -b emits the type graph into dist/ alongside.
  build: { outDir: "dist/app", sourcemap: true, emptyOutDir: true },
});
