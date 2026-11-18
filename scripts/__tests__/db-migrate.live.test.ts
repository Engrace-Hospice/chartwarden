import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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
    expect(result.ran).toContain("1508_m25_835_group_identity_dates.sql");
  }, 300_000);

  it("upgrades a historical M25 schema without rewriting financial or ambiguous date data", async () => {
    await resetSchema();
    const historicalDir = await mkdtemp(join(tmpdir(), "chartwarden-m25-835-historical-"));
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".sql") && file !== "1508_m25_835_group_identity_dates.sql")
      .sort();
    const organizationId = "71000000-0000-4000-8000-000000000001";
    const providerEntityId = "72000000-0000-4000-8000-000000000001";
    const payerId = "73000000-0000-4000-8000-000000000001";

    try {
      for (const file of files)
        await writeFile(
          join(historicalDir, file),
          readFileSync(join(MIGRATIONS_DIR, file), "utf8"),
        );
      const before = await applyMigrations(db, { migrationsDir: historicalDir });
      expect(before.ran.some((file) => Number(file.slice(0, 4)) >= 1500)).toBe(true);
      expect(before.ran).not.toContain("1508_m25_835_group_identity_dates.sql");

      await db.query(
        `INSERT INTO organization (id, slug, legal_name, display_name)
         VALUES ($1, 'm25-835-historical-upgrade', 'Synthetic Historical Org', 'Synthetic Historical Org')`,
        [organizationId],
      );
      await db.query(
        `INSERT INTO remittance_advice (
          organization_id, provider_entity_id, payer_id, payer_kind,
          interchange_control_number, transaction_set_control_number, payment_method,
          total_payment_amount, plb_total_amount, production_date, minio_object_key, file_sha256
        ) VALUES ($1, $2, $3, 'medicare', '700000001', '700000001', 'check', 12.34, 0.01,
          '2025-02-03T00:00:00Z', 'synthetic/historical-835', repeat('a', 64))`,
        [organizationId, providerEntityId, payerId],
      );

      const upgraded = await applyMigrations(db, { migrationsDir: MIGRATIONS_DIR });
      expect(upgraded.ran).toEqual(["1508_m25_835_group_identity_dates.sql"]);
      expect((await applyMigrations(db, { migrationsDir: MIGRATIONS_DIR })).ran).toEqual([]);

      const historical = await db.query<{
        total_payment_amount: string;
        plb_total_amount: string;
        production_date: Date | null;
        payment_effective_date: string | null;
        adjudication_cutoff_date: string | null;
        interchange_sender_code: string | null;
        functional_group_control_number: string | null;
        payee_identity_evidence: unknown;
      }>(
        `SELECT total_payment_amount, plb_total_amount, production_date, payment_effective_date,
                adjudication_cutoff_date, interchange_sender_code, functional_group_control_number,
                payee_identity_evidence FROM remittance_advice WHERE organization_id=$1`,
        [organizationId],
      );
      expect(historical.rows).toHaveLength(1);
      expect(historical.rows[0]).toMatchObject({
        total_payment_amount: "12.34",
        plb_total_amount: "0.01",
        payment_effective_date: null,
        adjudication_cutoff_date: null,
        interchange_sender_code: null,
        functional_group_control_number: null,
        payee_identity_evidence: null,
      });
      expect(historical.rows[0]!.production_date?.toISOString()).toBe("2025-02-03T00:00:00.000Z");

      const index = await db.query<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='ux_remittance_envelope_dedupe'",
      );
      expect(index.rows[0]?.indexdef).toContain("NULLS NOT DISTINCT");
      for (const group of ["700000101", "700000102"]) {
        await db.query(
          `INSERT INTO remittance_advice (
            organization_id, provider_entity_id, payer_id, payer_kind, interchange_control_number,
            interchange_sender_code, interchange_receiver_code, functional_group_control_number,
            transaction_set_control_number, payment_method, total_payment_amount, production_date,
            minio_object_key, file_sha256
          ) VALUES ($1,$2,$3,'medicare','700000002','SYNTH-PAYER','SYNTH-PROVIDER',$4,'700000001',
            'check',12.34,'2025-02-03T00:00:00Z',$5,repeat('b',64))`,
          [organizationId, providerEntityId, payerId, group, `synthetic/group-${group}`],
        );
      }
      const grouped = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM remittance_advice WHERE organization_id=$1 AND interchange_control_number='700000002'",
        [organizationId],
      );
      expect(grouped.rows[0]!.n).toBe(2);

      await expect(
        db.query(
          `INSERT INTO remittance_advice (
          organization_id, provider_entity_id, payer_id, payer_kind, interchange_control_number,
          transaction_set_control_number, payment_method, total_payment_amount, production_date,
          minio_object_key, file_sha256
        ) VALUES ($1,$2,$3,'medicare','700000003','700000001','check',12.34,'2025-02-03T00:00:00Z',
          'synthetic/old-writer',repeat('c',64))
        ON CONFLICT (interchange_control_number, transaction_set_control_number, provider_entity_id) DO NOTHING`,
          [organizationId, providerEntityId, payerId],
        ),
      ).rejects.toMatchObject({ code: "42P10" });
    } finally {
      await rm(historicalDir, { force: true, recursive: true });
    }
  }, 600_000);

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

  const relationOf = async (table: string): Promise<string | null> =>
    (
      await db.query<{ relation: string | null }>("SELECT to_regclass($1) AS relation", [
        `public.${table}`,
      ])
    ).rows[0]!.relation;

  it("--hold-contract refuses a batch with a non-expand migration before running any of it", async () => {
    const migrationsDir = await mkdtemp(join(tmpdir(), "chartwarden-migrate-hold-"));
    const expandFile = "9011_hold_expand_first.sql";
    const contractFile = "9012_hold_contract_second.sql";
    const expandTable = "migrate_hold_expand_first";
    const contractTable = "migrate_hold_contract_second";
    const contractSql = `-- compat: contract\nCREATE TABLE ${contractTable} (id integer);\n`;

    try {
      await writeFile(
        join(migrationsDir, expandFile),
        `-- compat: expand\nCREATE TABLE ${expandTable} (id integer);\n`,
      );
      await writeFile(join(migrationsDir, contractFile), contractSql);

      // The ledger holds the full chain, so old writers may exist: the whole batch is refused, the expand
      // file that sorts BEFORE the contract one included (a mid-batch hold would half-advance the schema).
      await expect(
        applyMigrations(db, { migrationsDir, holdContract: true }),
      ).rejects.toMatchObject({ name: "ContractMigrationHold", files: [contractFile] });
      expect(await relationOf(expandTable)).toBeNull();
      expect(await relationOf(contractTable)).toBeNull();

      // An expand-only batch passes the hold.
      await rm(join(migrationsDir, contractFile));
      await expect(
        applyMigrations(db, { migrationsDir, holdContract: true }),
      ).resolves.toMatchObject({ ran: [expandFile] });

      // The operator applies the held migration by hand, after the drain: no flag, no hold.
      await writeFile(join(migrationsDir, contractFile), contractSql);
      await expect(applyMigrations(db, { migrationsDir })).resolves.toMatchObject({
        ran: [contractFile],
      });
    } finally {
      await db.query(`DROP TABLE IF EXISTS ${expandTable}, ${contractTable}`);
      await db.query("DELETE FROM _chartwarden_migration WHERE filename = ANY($1)", [
        [expandFile, contractFile],
      ]);
      await rm(migrationsDir, { force: true, recursive: true });
    }
  }, 60_000);

  it.skipIf(spawnSync("bun", ["--version"]).status !== 0)(
    "the real CLI exits 75 (what deploy.sh keys on) and changes nothing when 1508 is pending",
    async () => {
      // deploy.sh and migrate.ts share the number only by convention (two constants), and the runner function is
      // proven above; this runs the actual process so a drift between them fails here, not on a production deploy.
      const held = "1508_m25_835_group_identity_dates.sql";
      const { rows: ledgerRow } = await db.query<{
        filename: string;
        checksum: string;
        applied_at: Date;
      }>("SELECT filename, checksum, applied_at FROM _chartwarden_migration WHERE filename = $1", [
        held,
      ]);
      expect(ledgerRow).toHaveLength(1); // the full chain was applied by the first test of this block
      const ledgerCount = async () =>
        (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM _chartwarden_migration"))
          .rows[0]!.n;
      // The drift test above leaves one ledger row corrupted on purpose, and the CLI runs --strict exactly as deploy.sh
      // does, so a corrupted checksum would (correctly) stop it before the hold. Put the real checksum back first.
      const { rows: corrupted } = await db.query<{ filename: string }>(
        "SELECT filename FROM _chartwarden_migration WHERE checksum = 'deliberately-corrupted'",
      );
      for (const { filename } of corrupted)
        await db.query("UPDATE _chartwarden_migration SET checksum = $2 WHERE filename = $1", [
          filename,
          createHash("sha256")
            .update(readFileSync(join(MIGRATIONS_DIR, filename), "utf8"))
            .digest("hex"),
        ]);
      const before = await ledgerCount();
      await db.query("DELETE FROM _chartwarden_migration WHERE filename = $1", [held]);
      try {
        const run = spawnSync(
          "bun",
          ["run", "scripts/db/migrate.ts", "--strict", "--schema-only", "--hold-contract"],
          {
            cwd: REPO_ROOT,
            env: { ...process.env, DATABASE_ADMIN_URL: DB_URL },
            encoding: "utf8",
            timeout: 120_000,
          },
        );
        expect(run.status, run.stderr).toBe(75);
        expect(run.stderr).toContain("DEPLOY HOLD");
        expect(run.stderr).toContain(held);
        expect(run.stdout).not.toContain("migrations complete");
        // refused before any DDL: the ledger is exactly as the operator left it (1508 still not recorded)
        expect(await ledgerCount()).toBe(before - 1);
      } finally {
        await db.query(
          "INSERT INTO _chartwarden_migration (filename, checksum, applied_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
          [ledgerRow[0]!.filename, ledgerRow[0]!.checksum, ledgerRow[0]!.applied_at],
        );
      }
      expect(await ledgerCount()).toBe(before);
    },
    180_000,
  );

  it("--hold-contract exempts a database with an empty ledger (a fresh environment has no old writers)", async () => {
    // Last test of this block: it empties the schema, which the later tests do not depend on.
    await resetSchema();
    const migrationsDir = await mkdtemp(join(tmpdir(), "chartwarden-migrate-hold-fresh-"));
    const file = "9013_hold_fresh_contract.sql";
    try {
      await writeFile(
        join(migrationsDir, file),
        "-- compat: contract\nCREATE TABLE migrate_hold_fresh (id integer);\n",
      );
      await expect(
        applyMigrations(db, { migrationsDir, holdContract: true }),
      ).resolves.toMatchObject({ ran: [file] });
    } finally {
      await rm(migrationsDir, { force: true, recursive: true });
    }
  }, 60_000);
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
