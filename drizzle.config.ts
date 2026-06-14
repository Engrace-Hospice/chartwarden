import { defineConfig } from "drizzle-kit";

/**
 * WardenX — Drizzle Kit config (Phase 0).
 * The central multi-tenant PostgreSQL schema barrel lives in packages/db (M1-owned).
 * No tables exist yet (Phase 0 is structure only); this wires the generator so the
 * first real schema in Phase 1 produces migrations under packages/db/migrations/.
 */
export default defineConfig({
  schema: "./packages/db/src/schema/index.ts",
  out: "./packages/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/wardenx",
  },
  strict: true,
  verbose: true,
});
