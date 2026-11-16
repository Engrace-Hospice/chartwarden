import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dropLiveRoles } from "../../packages/db/migrations/__tests__/_live-roles";
import { MIGRATIONS_DIR, applyMigrations, ensureLedger } from "../db/migrate";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;

// Every CREATE ROLE across the migration corpus (`grep -rh "CREATE ROLE" packages/db/migrations`),
// so resetSchema() can drop them all before each fresh-database assertion below.

describe.skipIf(!DB_URL)("scripts/db/migrate.ts — LIVE Postgres (OPS-016)", () => {
  let db: Client;

  async function resetSchema() {
    await db.query("DROP SCHEMA IF EXISTS public CASCADE");
    await db.query("CREATE SCHEMA public");
    await dropLiveRoles(db);
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
      "SELECT count(*)::int AS n FROM _chartwarden_migration",
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
      "SELECT filename FROM _chartwarden_migration ORDER BY filename LIMIT 1",
    );
    const target = rows[0]!.filename;
    await db.query(
      `UPDATE _chartwarden_migration SET checksum = 'deliberately-corrupted' WHERE filename = $1`,
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
    const migrationsDir = await mkdtemp(join(tmpdir(), "chartwarden-migrate-strict-"));
    const first = "9001_strict_preflight_first.sql";
    const second = "9002_strict_preflight_second.sql";
    const firstTable = "migrate_strict_preflight_first";
    const secondTable = "migrate_strict_preflight_second";

    try {
      await writeFile(join(migrationsDir, first), `CREATE TABLE ${firstTable} (id integer);\n`);
      await expect(applyMigrations(db, { migrationsDir })).resolves.toMatchObject({ ran: [first] });

      await db.query(
        `UPDATE _chartwarden_migration SET checksum = 'deliberately-corrupted' WHERE filename = $1`,
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
      await db.query("DELETE FROM _chartwarden_migration WHERE filename = ANY($1)", [
        [first, second],
      ]);
      await rm(migrationsDir, { force: true, recursive: true });
    }
  }, 60_000);

  it("rolls back a failed migration body and does not record its ledger row", async () => {
    const migrationsDir = await mkdtemp(join(tmpdir(), "chartwarden-migrate-rollback-"));
    const filename = "9003_rollback_probe.sql";
    const tableName = "migrate_rollback_probe";

    try {
      await writeFile(
        join(migrationsDir, filename),
        `CREATE TABLE ${tableName} (id integer);\nSELECT 1 / 0;\n`,
      );
      await expect(applyMigrations(db, { migrationsDir })).rejects.toThrow(
        /9003_rollback_probe\.sql failed \(rolled back\)/,
      );
      const relation = await db.query<{ relation: string | null }>(
        "SELECT to_regclass($1) AS relation",
        [`public.${tableName}`],
      );
      expect(relation.rows[0]!.relation).toBeNull();
      const ledger = await db.query(
        "SELECT 1 FROM _chartwarden_migration WHERE filename = $1",
        [filename],
      );
      expect(ledger.rowCount).toBe(0);
    } finally {
      await db.query(`DROP TABLE IF EXISTS ${tableName}`);
      await db.query("DELETE FROM _chartwarden_migration WHERE filename = $1", [filename]);
      await rm(migrationsDir, { force: true, recursive: true });
    }
  }, 60_000);

  it("upgrades a deployed-through-1494 schema with historical remittances and late 1475", async () => {
    await resetSchema();
    const earlyDir = await mkdtemp(join(tmpdir(), "chartwarden-migrate-historical-early-"));
    const lateDir = await mkdtemp(join(tmpdir(), "chartwarden-migrate-historical-late-"));
    const repairDir = await mkdtemp(join(tmpdir(), "chartwarden-migrate-historical-repair-"));
    const m25Dir = await mkdtemp(join(tmpdir(), "chartwarden-migrate-historical-m25-"));
    const allFiles = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const writeMigration = async (dir: string, filename: string) =>
      writeFile(join(dir, filename), readFileSync(join(MIGRATIONS_DIR, filename), "utf8"));

    try {
      for (const file of allFiles.filter((name) => Number(name.slice(0, 4)) <= 74)) {
        await writeMigration(earlyDir, file);
      }
      await applyMigrations(db, { migrationsDir: earlyDir });

      // Model deployed installations where the distinct enum/cast existed before 1489/1490,
      // while this repository's repair file 1475 was absent from the migration ledger.
      await db.query(`CREATE TYPE public.m23_mac_jurisdiction AS ENUM (
        'ngs_j6','ngs_jk','cgs_j15','palmetto_jj','palmetto_jm','noridian_jf','noridian_je'
      )`);
      await db.query(`CREATE FUNCTION public.m23_mac_jurisdiction_from_legacy(value public.mac_jurisdiction)
        RETURNS public.m23_mac_jurisdiction LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
        AS $$ SELECT value::text::public.m23_mac_jurisdiction $$`);
      await db.query(`CREATE CAST (public.mac_jurisdiction AS public.m23_mac_jurisdiction)
        WITH FUNCTION public.m23_mac_jurisdiction_from_legacy(public.mac_jurisdiction) AS ASSIGNMENT`);

      for (const file of allFiles.filter((name) => {
        const ordinal = Number(name.slice(0, 4));
        return ordinal > 74 && ordinal <= 1494 && ordinal !== 1475;
      })) {
        await writeMigration(lateDir, file);
      }
      const preUpgrade = await applyMigrations(db, { migrationsDir: lateDir });
      expect(preUpgrade.ran).toContain("1494_m25_835_date_provenance.sql");
      expect(preUpgrade.ran).not.toContain("1475_m23_mac_jurisdiction_type.sql");

      const organizationId = "71000000-0000-4000-8000-000000000001";
      await db.query(
        `INSERT INTO organization (id, slug, legal_name, display_name)
         VALUES ($1, 'm25-historical-upgrade-test', 'Synthetic Historical Org', 'Synthetic Historical Org')`,
        [organizationId],
      );
      await db.query(
        `INSERT INTO remittance_advice (
          organization_id, provider_entity_id, payer_id, payer_kind,
          interchange_control_number, transaction_set_control_number, payment_method,
          total_payment_amount, production_date, minio_object_key, file_sha256
        ) VALUES ($1, $2, $3, 'medicare', '700000001', '700000001', 'check', 12.34,
          '2025-02-03T00:00:00Z', 'synthetic/historical-835', repeat('a', 64))`,
        [
          organizationId,
          "72000000-0000-4000-8000-000000000001",
          "73000000-0000-4000-8000-000000000001",
        ],
      );

      await writeMigration(repairDir, "1475_m23_mac_jurisdiction_type.sql");
      const lateRepair = await applyMigrations(db, { migrationsDir: repairDir });
      expect(lateRepair.ran).toEqual(["1475_m23_mac_jurisdiction_type.sql"]);
      const enumLabels = await db.query<{ label: string }>(
        `SELECT e.enumlabel AS label FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = 'public' AND t.typname = 'm23_mac_jurisdiction'
         ORDER BY e.enumsortorder`,
      );
      expect(enumLabels.rows.map((row) => row.label)).toEqual([
        "ngs_j6",
        "ngs_jk",
        "cgs_j15",
        "palmetto_jj",
        "palmetto_jm",
        "noridian_jf",
        "noridian_je",
      ]);

      await writeMigration(m25Dir, "1495_m25_835_group_scoped_identity.sql");
      await writeMigration(m25Dir, "1496_m25_835_payee_identity_evidence.sql");
      const m25Upgrade = await applyMigrations(db, { migrationsDir: m25Dir });
      expect(m25Upgrade.ran).toEqual([
        "1495_m25_835_group_scoped_identity.sql",
        "1496_m25_835_payee_identity_evidence.sql",
      ]);

      const historical = await db.query<{
        interchange_sender_code: string | null;
        interchange_receiver_code: string | null;
        functional_group_control_number: string | null;
        payment_effective_date: string | null;
        adjudication_cutoff_date: string | null;
        payee_identity_evidence: unknown;
        production_date: Date;
      }>(
        `SELECT interchange_sender_code, interchange_receiver_code, functional_group_control_number,
                payment_effective_date, adjudication_cutoff_date, payee_identity_evidence, production_date
           FROM remittance_advice WHERE organization_id = $1`,
        [organizationId],
      );
      expect(historical.rows).toHaveLength(1);
      expect(historical.rows[0]).toMatchObject({
        interchange_sender_code: null,
        interchange_receiver_code: null,
        functional_group_control_number: null,
        payment_effective_date: null,
        adjudication_cutoff_date: null,
        payee_identity_evidence: null,
      });
      expect(historical.rows[0]!.production_date.toISOString()).toBe("2025-02-03T00:00:00.000Z");

      const index = await db.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ux_remittance_envelope_dedupe'`,
      );
      expect(index.rows[0]?.indexdef).toContain("NULLS NOT DISTINCT");

      const duplicateHistorical = await db.query(
        `INSERT INTO remittance_advice (
          organization_id, provider_entity_id, payer_id, payer_kind,
          interchange_control_number, transaction_set_control_number, payment_method,
          total_payment_amount, production_date, minio_object_key, file_sha256
        ) VALUES ($1, $2, $3, 'medicare', '700000001', '700000001', 'check', 12.34,
          '2025-02-03T00:00:00Z', 'synthetic/historical-duplicate', repeat('b', 64))
        ON CONFLICT DO NOTHING RETURNING id`,
        [
          organizationId,
          "72000000-0000-4000-8000-000000000001",
          "73000000-0000-4000-8000-000000000001",
        ],
      );
      expect(duplicateHistorical.rowCount).toBe(0);

      for (const [group, fileKey, digest] of [
        ["700000101", "synthetic/group-a", "c"],
        ["700000102", "synthetic/group-b", "d"],
      ] as const) {
        await db.query(
          `INSERT INTO remittance_advice (
            organization_id, provider_entity_id, payer_id, payer_kind,
            interchange_control_number, interchange_sender_code, interchange_receiver_code,
            functional_group_control_number, transaction_set_control_number,
            payment_method, total_payment_amount, production_date, minio_object_key, file_sha256
          ) VALUES ($1, $2, $3, 'medicare', '700000002', 'SYNTH-PAYER', 'SYNTH-PROVIDER',
            $4, '700000001', 'check', 12.34, '2025-02-03T00:00:00Z', $5, repeat($6, 64))`,
          [
            organizationId,
            "72000000-0000-4000-8000-000000000001",
            "73000000-0000-4000-8000-000000000001",
            group,
            fileKey,
            digest,
          ],
        );
      }
      const groupedCount = await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM remittance_advice
          WHERE organization_id = $1 AND interchange_control_number = '700000002'`,
        [organizationId],
      );
      expect(groupedCount.rows[0]!.count).toBe(2);

      // The old release targets the old three-column index. Its writes cannot cross the 1495
      // contract boundary, which is why production must drain old writers before this migration.
      await expect(
        db.query(
          `INSERT INTO remittance_advice (
            organization_id, provider_entity_id, payer_id, payer_kind,
            interchange_control_number, transaction_set_control_number, payment_method,
            total_payment_amount, production_date, minio_object_key, file_sha256
          ) VALUES ($1, $2, $3, 'medicare', '700000003', '700000001', 'check', 12.34,
            '2025-02-03T00:00:00Z', 'synthetic/old-app-target', repeat('e', 64))
          ON CONFLICT (interchange_control_number, transaction_set_control_number, provider_entity_id)
          DO NOTHING`,
          [
            organizationId,
            "72000000-0000-4000-8000-000000000001",
            "73000000-0000-4000-8000-000000000001",
          ],
        ),
      ).rejects.toMatchObject({ code: "42P10" });
    } finally {
      await rm(earlyDir, { force: true, recursive: true });
      await rm(lateDir, { force: true, recursive: true });
      await rm(repairDir, { force: true, recursive: true });
      await rm(m25Dir, { force: true, recursive: true });
    }
  }, 300_000);
});

// The ledger rename (_wardenx_migration -> _chartwarden_migration) must keep rows/checksums, and the
// former rollback-compat view must be dropped (never a real table). Uses a tiny temp migrations dir
// so it does not depend on the full chain.
describe.skipIf(!DB_URL)(
  "scripts/db/migrate.ts — ledger rename + compat view removal (LIVE Postgres)",
  () => {
    const OLD = "_wardenx_migration";
    const NEW = "_chartwarden_migration";
    const FILE_A = "9101_ledger_a.sql";
    const FILE_B = "9102_ledger_b.sql";
    let db: Client;
    let dir: string;

    const kindOf = async (name: string) =>
      (
        await db.query<{ relkind: string }>(
          "SELECT relkind FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = $1",
          [name],
        )
      ).rows[0]?.relkind ?? null;

    async function legacyLedger(rows: readonly (readonly [string, string])[]) {
      await db.query(
        `CREATE TABLE ${OLD} (filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
      );
      for (const [f, c] of rows) {
        await db.query(`INSERT INTO ${OLD}(filename, checksum) VALUES ($1,$2)`, [f, c]);
      }
    }

    beforeAll(async () => {
      db = new Client({ connectionString: DB_URL });
      await db.connect();
      dir = await mkdtemp(join(tmpdir(), "chartwarden-ledger-"));
      await writeFile(join(dir, FILE_A), "SELECT 1;\n");
      await writeFile(join(dir, FILE_B), "SELECT 2;\n");
    });

    beforeEach(async () => {
      await db.query("DROP SCHEMA IF EXISTS public CASCADE");
      await db.query("CREATE SCHEMA public");
    });

    afterAll(async () => {
      await db.query("DROP SCHEMA IF EXISTS public CASCADE");
      await db.query("CREATE SCHEMA public");
      await db.end();
      await rm(dir, { force: true, recursive: true });
    });

    const sha = (s: string) => createHash("sha256").update(s).digest("hex");

    it("renames a populated legacy ledger, preserving rows and checksums, and leaves no legacy relation", async () => {
      await legacyLedger([[FILE_A, sha("SELECT 1;\n")]]);

      const result = await applyMigrations(db, { migrationsDir: dir, strict: true });

      expect(result.ran).toEqual([FILE_B]);
      expect(await kindOf(NEW)).toBe("r");
      expect(await kindOf(OLD)).toBeNull();
      const { rows } = await db.query(
        "SELECT filename, checksum FROM _chartwarden_migration ORDER BY filename",
      );
      expect(rows).toEqual([
        { filename: FILE_A, checksum: sha("SELECT 1;\n") },
        { filename: FILE_B, checksum: sha("SELECT 2;\n") },
      ]);
    });

    it("a second run is a no-op", async () => {
      await legacyLedger([]);
      await applyMigrations(db, { migrationsDir: dir });
      const again = await applyMigrations(db, { migrationsDir: dir });
      expect(again.ran).toEqual([]);
      expect(await kindOf(NEW)).toBe("r");
      expect(await kindOf(OLD)).toBeNull();
    });

    it("a fresh database gets the ledger table and no compat view", async () => {
      await applyMigrations(db, { migrationsDir: dir });
      expect(await kindOf(NEW)).toBe("r");
      expect(await kindOf(OLD)).toBeNull();
    });

    it("drops a pre-existing compat view over the new ledger, idempotently", async () => {
      await applyMigrations(db, { migrationsDir: dir });
      await db.query(`CREATE VIEW ${OLD} WITH (security_invoker = true) AS SELECT * FROM ${NEW}`);

      await ensureLedger(db);
      expect(await kindOf(OLD)).toBeNull();
      await ensureLedger(db);
      expect(await kindOf(OLD)).toBeNull();
      expect(await kindOf(NEW)).toBe("r");
    });

    it("keeps the rows of a populated ledger when the compat view is dropped", async () => {
      await applyMigrations(db, { migrationsDir: dir });
      await db.query(`CREATE VIEW ${OLD} WITH (security_invoker = true) AS SELECT * FROM ${NEW}`);

      await ensureLedger(db);

      expect(await kindOf(OLD)).toBeNull();
      const { rows } = await db.query(`SELECT filename FROM ${NEW} ORDER BY filename`);
      expect(rows.map((r) => r.filename)).toEqual([FILE_A, FILE_B]);
    });

    it("still detects a tampered checksum after the rename", async () => {
      await legacyLedger([[FILE_A, "deliberately-corrupted"]]);
      const lenient = await applyMigrations(db, { migrationsDir: dir });
      expect(lenient.drifted).toEqual([FILE_A]);
      await expect(applyMigrations(db, { migrationsDir: dir, strict: true })).rejects.toThrow(
        /checksum drift/i,
      );
    });

    it("refuses to guess when both ledgers are tables", async () => {
      await legacyLedger([]);
      await db.query(
        `CREATE TABLE ${NEW} (filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
      );
      await expect(applyMigrations(db, { migrationsDir: dir })).rejects.toThrow(
        /both .* are tables/,
      );
      expect(await kindOf(OLD)).toBe("r");
    });
    it("is a no-op when the new table exists and the legacy name is absent", async () => {
      await db.query(
        `CREATE TABLE ${NEW} (filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
      );
      await ensureLedger(db);
      expect(await kindOf(NEW)).toBe("r");
      expect(await kindOf(OLD)).toBeNull();
    });

    it("throws when the legacy name is a view and the new table does not exist", async () => {
      await db.query(`CREATE VIEW ${OLD} AS SELECT 1 AS filename`);
      await expect(ensureLedger(db)).rejects.toThrow(/non-table relation/);
      expect(await kindOf(NEW)).toBeNull();
    });
  },
);
