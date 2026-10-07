import { defineConfig } from "drizzle-kit";

/**
 * WardenX — Drizzle Kit config.
 * The central multi-tenant PostgreSQL schema barrel lives in packages/db (M1-owned); generated
 * migrations land under packages/db/migrations/ (table counts: see the generated audit reports).
 *
 * MIGRATION AUTHORITY (audit #8): `scripts/db/migrate.ts` is the SOLE authoritative migrator — it
 * applies EVERY `packages/db/migrations/*.sql` in lexical order, so it covers all SQL regardless of
 * the Drizzle journal. The Drizzle `meta/_journal.json` is INTENTIONALLY FROZEN (it trails the SQL
 * corpus) because parallel feature branches reserve disjoint migration-number ranges and the
 * lexical-apply migrator tolerates the gaps; `drizzle-kit migrate` (which reads the journal) is NOT
 * the project's migration path. Use `drizzle-kit` only to GENERATE new migration SQL, never to apply.
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
