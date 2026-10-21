import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * scripts/db/migrate.ts — the production migration path — LIVE Postgres proof (TASK-040E, OPS-016).
 *
 * Until this file, nothing exercised migrate.ts's own logic against a real database: the
 * RLS-isolation live suite (packages/db/migrations/__tests__/rls-isolation.live.test.ts) applies
 * the migration files itself via a hand-rolled loop, never through migrate.ts's `applyMigrations()`
 * or its checksum tracking. This proves: (1) the real runner applies the full chain cleanly to a
 * fresh database, (2) a second run is a true no-op (idempotent, per the tracking table), and (3)
 * `--strict` turns a checksum-drifted already-applied file into a hard failure — the default
 * (non-strict) mode still only warns, which is deliberate (see the file header on migrate.ts).
 *
 * Gated on a live DB, same convention as the RLS-isolation suite:
 *   - CI: the `migration-gate` job provides a postgres service + CHARTWARDEN_TEST_DATABASE_URL.
 *   - Local: CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:db:migrate:live
 * The URL must be a SUPERUSER connection to a THROWAWAY database (this suite drops and recreates
 * the public schema + every role the migrations create).
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, applyMigrations } from "../db/migrate";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;

// Every CREATE ROLE across the migration corpus (`grep -rh "CREATE ROLE" packages/db/migrations`),
// so resetSchema() can drop them all before each fresh-database assertion below.
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "wardenx_destruction",
  "mdm_canonical_writer",
  "billing_platform_loader",
  "cap_platform_loader",
  "consent_catalog_writer",
  "tenant_platform_writer",
  "terminology_loader",
  "report_writer",
];

describe.skipIf(!DB_URL)("scripts/db/migrate.ts — LIVE Postgres (OPS-016)", () => {
  let db: Client;

  async function resetSchema() {
    await db.query("DROP SCHEMA IF EXISTS public CASCADE");
    await db.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await db.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL });
    await db.connect();
    await resetSchema();
  }, 120_000);

  afterAll(async () => {
    await resetSchema();
    await db.end();
  });

  it("applies the full migration chain cleanly against a fresh database", async () => {
    const result = await applyMigrations(db, { migrationsDir: MIGRATIONS_DIR });
    expect(result.ran.length).toBeGreaterThan(100);
    expect(result.drifted).toEqual([]);

    const { rows } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM _wardenx_migration",
    );
    expect(rows[0]!.n).toBe(result.ran.length);
  }, 300_000);

  it("a second run against an already-migrated database is a true no-op", async () => {
    const result = await applyMigrations(db, { migrationsDir: MIGRATIONS_DIR });
    expect(result.ran).toEqual([]);
    expect(result.drifted).toEqual([]);
  }, 60_000);

  it("--strict fails on checksum drift in an already-applied file; the default mode only warns", async () => {
    const { rows } = await db.query<{ filename: string }>(
      "SELECT filename FROM _wardenx_migration ORDER BY filename LIMIT 1",
    );
    const target = rows[0]!.filename;
    await db.query(
      `UPDATE _wardenx_migration SET checksum = 'deliberately-corrupted' WHERE filename = $1`,
      [target],
    );

    // Default (non-strict): drift is reported in the result, but nothing throws.
    const lenient = await applyMigrations(db, { migrationsDir: MIGRATIONS_DIR });
    expect(lenient.drifted).toEqual([target]);

    // Strict: the identical drift is a hard failure — this is what the CI gate uses.
    await expect(
      applyMigrations(db, { migrationsDir: MIGRATIONS_DIR, strict: true }),
    ).rejects.toThrow(/checksum drift/i);
  }, 60_000);

  it("--strict detects drift before applying a later pending migration", async () => {
    const migrationsDir = await mkdtemp(join(tmpdir(), "wardenx-migrate-strict-"));
    const first = "9001_strict_preflight_first.sql";
    const second = "9002_strict_preflight_second.sql";
    const firstTable = "migrate_strict_preflight_first";
    const secondTable = "migrate_strict_preflight_second";

    try {
      await writeFile(join(migrationsDir, first), `CREATE TABLE ${firstTable} (id integer);\n`);
      await expect(applyMigrations(db, { migrationsDir })).resolves.toMatchObject({ ran: [first] });

      await db.query(
        `UPDATE _wardenx_migration SET checksum = 'deliberately-corrupted' WHERE filename = $1`,
        [first],
      );
      await writeFile(join(migrationsDir, second), `CREATE TABLE ${secondTable} (id integer);\n`);

      await expect(applyMigrations(db, { migrationsDir, strict: true })).rejects.toThrow(
        /checksum drift/i,
      );
      const { rows } = await db.query<{ relation: string | null }>(
        "SELECT to_regclass($1) AS relation",
        [`public.${secondTable}`],
      );
      expect(rows[0]!.relation).toBeNull();
    } finally {
      await db.query(`DROP TABLE IF EXISTS ${firstTable}, ${secondTable}`);
      await db.query("DELETE FROM _wardenx_migration WHERE filename = ANY($1)", [[first, second]]);
      await rm(migrationsDir, { force: true, recursive: true });
    }
  }, 60_000);
});
