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
import { unclassifiedRefColumns } from "../lib/backup/object-refs";
import { liveRefs } from "../lib/backup/verify-restore";
import { extractCatalogPredicate } from "../lib/object-key-rename-predicate";

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
          total_payment_amount, plb_total_amount, production_date, object_key, file_sha256
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
            object_key, file_sha256
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
          object_key, file_sha256
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

  describe("migration 1546 (object-key column rename) over a populated previous schema", () => {
    const OBJECT_KEY_MIGRATION = "1546_object_key_column_rename.sql";
    const ORG = "91000000-0000-4000-8000-000000000001";
    const DOCUMENT = "92000000-0000-4000-8000-000000000001";
    const MEMBERSHIP = "93000000-0000-4000-8000-000000000001";
    const RENAMED_TABLES = [
      "document_version",
      "remittance_advice",
      "fhir_bulk_export_artifact",
      "dsar_export_job",
      "tenant_export_job",
    ];
    const migrationSql = readFileSync(join(MIGRATIONS_DIR, OBJECT_KEY_MIGRATION), "utf8");
    let previousDir = "";

    /** Everything the migration's end-of-file check would report, by the SAME predicate the runbook has the operator run. */
    const leftovers = async (): Promise<string[]> =>
      (
        await db.query<{ what: string }>(
          `SELECT what FROM (${extractCatalogPredicate(migrationSql)}) found ORDER BY what`,
        )
      ).rows.map((r) => r.what);

    /** Run `body` inside a transaction that is always rolled back (DDL is transactional): a scenario leaves no trace. */
    async function rehearse(plant: string, body: () => Promise<void>): Promise<void> {
      await db.query("BEGIN");
      try {
        if (plant) await db.query(plant);
        await body();
      } finally {
        await db.query("ROLLBACK");
      }
    }

    const tablesWithRefs = (found: { refs: readonly { table: string }[] }): string[] =>
      [...new Set(found.refs.map((r) => r.table))].sort();

    /** The pre-window query reports `reported`, and 1546 then aborts naming exactly those (the transaction is rolled back). */
    async function expectBlocks(plant: string, reported: string[]): Promise<void> {
      await rehearse(plant, async () => {
        expect(await leftovers()).toEqual(reported);
        await expect(db.query(migrationSql)).rejects.toThrow(
          `still naming the minio_object_key columns: ${reported.join(", ")}`,
        );
      });
    }

    /**
     * The pre-window query reports `reportedBefore` (it reads the definition as it stands, before the rename rewrites it),
     * 1546 then applies, and nothing is left afterwards.
     */
    async function expectApplies(plant: string, reportedBefore: string[]): Promise<void> {
      await rehearse(plant, async () => {
        expect(await leftovers()).toEqual(reportedBefore);
        await db.query(migrationSql);
        expect(await leftovers()).toEqual([]);
      });
    }

    const columnsOf = async (table: string): Promise<string[]> =>
      (
        await db.query<{ attname: string }>(
          `SELECT attname FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped AND attname ~ 'object_key'`,
          [table],
        )
      ).rows.map((r) => r.attname);

    beforeAll(async () => {
      await resetSchema();
      previousDir = await mkdtemp(join(tmpdir(), "chartwarden-object-key-previous-"));
      for (const file of readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql") && f !== OBJECT_KEY_MIGRATION)
        .sort())
        await writeFile(join(previousDir, file), readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      const before = await applyMigrations(db, { migrationsDir: previousDir });
      expect(before.ran).not.toContain(OBJECT_KEY_MIGRATION);

      // Synthetic rows only. The parent rows go in with FK checks and triggers off; document_version goes in with the
      // audit trigger on (the old function, the old scrub list), so the pre-migration audit rows exist too.
      await db.query("SET session_replication_role = replica");
      await db.query(
        `INSERT INTO organization (id, slug, legal_name, display_name) VALUES ($1, 'object-key-rename', 'Synthetic Org', 'Synthetic Org')`,
        [ORG],
      );
      await db.query(
        `INSERT INTO document (id, organization_id, retention_class, source_kind, aggregate_type, title, created_by_membership_id)
         VALUES ($1, $2, 'operational', 'user_upload', 'other', 'Synthetic document', $3)`,
        [DOCUMENT, ORG, MEMBERSHIP],
      );
      await db.query(
        `INSERT INTO fhir_bulk_export_artifact (organization_id, job_id, resource_type, minio_object_key, byte_size, row_count, checksum_sha256)
         VALUES ($1, '95000000-0000-4000-8000-000000000001', 'Patient', 'tenants/synthetic/fhir/Patient.ndjson', 10, 2, repeat('a', 64))`,
        [ORG],
      );
      await db.query(
        `INSERT INTO remittance_advice (organization_id, provider_entity_id, payer_id, payer_kind, interchange_control_number,
           transaction_set_control_number, payment_method, total_payment_amount, minio_object_key, file_sha256)
         VALUES ($1, '97000000-0000-4000-8000-000000000001', '98000000-0000-4000-8000-000000000001', 'medicare', '000000001', '0001', 'check', 12.34,
           'clearinghouse/synthetic/rem-1', repeat('b', 64))`,
        [ORG],
      );
      await db.query(
        `INSERT INTO dsar_export_job (organization_id, patient_id, request_source, requestor_identity_verification_evidence,
           requesting_membership_id, sla_due_at, status, bundle_minio_object_key)
         VALUES ($1, '9a000000-0000-4000-8000-000000000001', 'patient', 'synthetic evidence', $2, now() + interval '30 days',
           'fulfilled', 'tenants/synthetic/exports/dsar/job-1.ndjson.gz')`,
        [ORG, MEMBERSHIP],
      );
      await db.query(
        `INSERT INTO tenant_export_job (organization_id, requested_purpose, requesting_membership_id, status, bundle_minio_object_key)
         VALUES ($1, 'compliance_audit', $2, 'fulfilled', 'tenants/synthetic/exports/tenant/job-1.ndjson.gz')`,
        [ORG, MEMBERSHIP],
      );
      await db.query("SET session_replication_role = origin");
      for (const [n, key] of [
        ["1", "tenants/synthetic/patients/p1/doc-1.pdf"],
        ["2", "tenants/synthetic/patients/p1/doc-2.pdf"],
      ] as const)
        await db.query(
          `INSERT INTO document_version (organization_id, document_id, version_number, minio_object_key, mime_type, byte_size, sha256_hex, uploaded_by_kind)
           VALUES ($1, $2, $3, $4, 'application/pdf', '123', repeat('c', 64), 'api')`,
          [ORG, DOCUMENT, n, key],
        );
    }, 600_000);

    afterAll(async () => {
      await rm(previousDir, { force: true, recursive: true });
    });

    it("the previous schema has nothing the rename cannot rewrite (the pre-window query returns no row)", async () => {
      expect(await leftovers()).toEqual([]);
    });

    it("the predicate reports what the rename cannot rewrite, and not an unrelated scratch copy or an ad hoc index on the column", async () => {
      // A scratch copy of the table, and an ad hoc index on the renamed column: harmless (the rename rewrites the index).
      await rehearse(
        `CREATE TABLE document_version_bak AS TABLE document_version;
         CREATE INDEX document_version_adhoc_key_ix ON document_version (minio_object_key);`,
        async () => expect(await leftovers()).toEqual([]),
      );
      // A function that names the column in its text, an index and a constraint named after the old vendor: not rewritten.
      await rehearse(
        `CREATE FUNCTION scratch_scrub() RETURNS text LANGUAGE sql AS $$ SELECT 'minio_object_key' $$`,
        async () => expect(await leftovers()).toEqual(["function scratch_scrub()"]),
      );
      await rehearse(
        `CREATE INDEX document_version_minio_scratch_ix ON document_version (sha256_hex);
         ALTER TABLE remittance_advice ADD CONSTRAINT remittance_advice_minio_chk CHECK (file_sha256 <> '')`,
        async () =>
          expect(await leftovers()).toEqual([
            "constraint remittance_advice.remittance_advice_minio_chk",
            "index document_version_minio_scratch_ix",
          ]),
      );
    });

    const SCRATCH_TRIGGER_FUNCTION = `CREATE FUNCTION scratch_trg_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`;

    it("blocks on a view that exposes the old output name", async () => {
      await expectBlocks(
        "CREATE VIEW scratch_exposing_view AS SELECT id, minio_object_key FROM remittance_advice",
        ["view public.scratch_exposing_view"],
      );
    });

    it("blocks on a materialized view that exposes the old output name", async () => {
      await expectBlocks(
        "CREATE MATERIALIZED VIEW scratch_exposing_mv AS SELECT id, minio_object_key FROM fhir_bulk_export_artifact",
        ["matview public.scratch_exposing_mv"],
      );
    });

    it("blocks on a trigger that names the old column, in its name or in its arguments", async () => {
      await expectBlocks(
        `${SCRATCH_TRIGGER_FUNCTION}
         CREATE TRIGGER scratch_arg_trg BEFORE UPDATE ON document_version FOR EACH ROW EXECUTE FUNCTION scratch_trg_fn('minio_object_key');
         CREATE TRIGGER scratch_minio_object_key_trg BEFORE UPDATE ON document_version FOR EACH ROW EXECUTE FUNCTION scratch_trg_fn();`,
        [
          "trigger document_version.scratch_arg_trg",
          "trigger document_version.scratch_minio_object_key_trg",
        ],
      );
    });

    it("blocks on a policy that names the old column of a table the rename does not touch", async () => {
      await expectBlocks(
        `CREATE TABLE document_version_bak AS TABLE document_version;
         ALTER TABLE document_version_bak ENABLE ROW LEVEL SECURITY;
         CREATE POLICY scratch_bak_pol ON document_version_bak FOR SELECT USING (minio_object_key <> '')`,
        ["policy document_version_bak.scratch_bak_pol"],
      );
    });

    it("blocks on an extra column named with minio on one of the five tables", async () => {
      await expectBlocks("ALTER TABLE remittance_advice ADD COLUMN legacy_minio_note text", [
        "column remittance_advice.legacy_minio_note",
      ]);
    });

    it("applies over a view that aliases the column to the new name or only uses it inside an expression", async () => {
      await expectApplies(
        "CREATE VIEW scratch_alias_view AS SELECT id, minio_object_key AS object_key FROM remittance_advice",
        ["view public.scratch_alias_view"],
      );
      await expectApplies(
        "CREATE VIEW scratch_expression_view AS SELECT id, length(minio_object_key) AS key_length FROM remittance_advice",
        ["view public.scratch_expression_view"],
      );
    });

    it("applies over a policy and an UPDATE OF trigger on the old column: the rename rewrites their definitions", async () => {
      await expectApplies(
        "CREATE POLICY scratch_pol ON document_version FOR SELECT USING (minio_object_key <> '')",
        ["policy document_version.scratch_pol"],
      );
      await expectApplies(
        `${SCRATCH_TRIGGER_FUNCTION}
         CREATE TRIGGER scratch_upd_of BEFORE UPDATE OF minio_object_key ON document_version FOR EACH ROW EXECUTE FUNCTION scratch_trg_fn();`,
        ["trigger document_version.scratch_upd_of"],
      );
    });

    it("applies over an unrelated scratch copy and an ad hoc index, and aborts (rolled back) on a leftover function", async () => {
      await rehearse(
        `CREATE TABLE document_version_bak AS TABLE document_version;
         CREATE INDEX document_version_adhoc_key_ix ON document_version (minio_object_key);`,
        async () => {
          await db.query(migrationSql);
          expect(await columnsOf("document_version")).toEqual(["object_key"]);
        },
      );
      await rehearse(
        `CREATE FUNCTION scratch_scrub() RETURNS text LANGUAGE sql AS $$ SELECT 'minio_object_key' $$`,
        async () =>
          await expect(db.query(migrationSql)).rejects.toThrow(
            /object-key rename incomplete.*function scratch_scrub\(\)/,
          ),
      );
      // Rolled back whole: the previous names are all still there.
      expect(await columnsOf("document_version")).toEqual(["minio_object_key"]);
    });

    it("gives up on a lock it cannot get within its lock_timeout, and changes nothing", async () => {
      const blocker = new Client({ connectionString: DB_URL });
      await blocker.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query("LOCK TABLE document_version IN ACCESS SHARE MODE");
        const startedAt = Date.now();
        await db.query("BEGIN");
        try {
          await expect(db.query(migrationSql)).rejects.toMatchObject({ code: "55P03" });
        } finally {
          await db.query("ROLLBACK");
        }
        expect(Date.now() - startedAt).toBeLessThan(25_000);
      } finally {
        await blocker.query("ROLLBACK");
        await blocker.end();
      }
      expect(await columnsOf("document_version")).toEqual(["minio_object_key"]);
    }, 60_000);

    it("renames the five columns in place, keeps every row, and the audit scrub still hides the key", async () => {
      // Arrange: what the restore verifier sees on the previous schema (legacy names), and the rows themselves.
      const refsBefore = await liveRefs(db);
      expect(unclassifiedRefColumns(refsBefore.discovered)).toEqual([]);
      // Every renamed table contributes live references (the export jobs count only when fulfilled), so the
      // before/after comparison below cannot pass on two empty lists.
      expect(tablesWithRefs(refsBefore)).toEqual([...RENAMED_TABLES].sort());
      const keysBefore = async (sql: string) => (await db.query<{ k: string }>(sql)).rows;
      const documentKeys = await keysBefore(
        "SELECT minio_object_key AS k FROM document_version ORDER BY version_number",
      );
      expect(documentKeys).toHaveLength(2);

      // Act: the real runner, on the real ledger (only 1546 is pending).
      const result = await applyMigrations(db, { migrationsDir: MIGRATIONS_DIR, strict: true });

      // Assert
      expect(result.ran).toEqual([OBJECT_KEY_MIGRATION]);
      expect(
        await keysBefore("SELECT object_key AS k FROM document_version ORDER BY version_number"),
      ).toEqual(documentKeys);
      expect(await keysBefore("SELECT object_key AS k FROM remittance_advice")).toEqual([
        { k: "clearinghouse/synthetic/rem-1" },
      ]);
      expect(await keysBefore("SELECT object_key AS k FROM fhir_bulk_export_artifact")).toEqual([
        { k: "tenants/synthetic/fhir/Patient.ndjson" },
      ]);
      expect(await keysBefore("SELECT bundle_object_key AS k FROM dsar_export_job")).toEqual([
        { k: "tenants/synthetic/exports/dsar/job-1.ndjson.gz" },
      ]);
      expect(await keysBefore("SELECT bundle_object_key AS k FROM tenant_export_job")).toEqual([
        { k: "tenants/synthetic/exports/tenant/job-1.ndjson.gz" },
      ]);
      for (const table of RENAMED_TABLES)
        expect(
          (await columnsOf(table)).filter((c) => c.includes("minio")),
          table,
        ).toEqual([]);
      expect(await leftovers()).toEqual([]);

      // The restore verifier reads the same rows through the new names.
      const refsAfter = await liveRefs(db);
      expect(unclassifiedRefColumns(refsAfter.discovered)).toEqual([]);
      expect(tablesWithRefs(refsAfter)).toEqual([...RENAMED_TABLES].sort());
      expect(refsAfter.refs.map((r) => r.key).sort()).toEqual(
        refsBefore.refs.map((r) => r.key).sort(),
      );

      // The unique index is rebuilt over the new name and still enforces uniqueness.
      const index = await db.query<{ attname: string }>(
        `SELECT a.attname FROM pg_attribute a WHERE a.attrelid = 'document_version_object_key_uk'::regclass AND a.attnum > 0`,
      );
      expect(index.rows).toEqual([{ attname: "object_key" }]);
      await expect(
        db.query(
          `INSERT INTO document_version (organization_id, document_id, version_number, object_key, mime_type, byte_size, sha256_hex, uploaded_by_kind)
           VALUES ($1, $2, '9', $3, 'application/pdf', '1', repeat('d', 64), 'api')`,
          [ORG, DOCUMENT, documentKeys[0]!.k],
        ),
      ).rejects.toMatchObject({ code: "23505" });

      // The NOT NULL constraints follow the columns.
      const notNull = await db.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE contype = 'n' AND conrelid = ANY ($1::regclass[]) AND conname ~ 'object_key' ORDER BY conname`,
        [`{${RENAMED_TABLES.join(",")}}`],
      );
      expect(notNull.rows.map((r) => r.conname)).toEqual([
        "document_version_object_key_not_null",
        "fhir_bulk_export_artifact_object_key_not_null",
        "remittance_advice_object_key_not_null",
      ]);

      // The audit scrub list names the new column: a new INSERT and an UPDATE both audit `object_key` as scrubbed.
      await db.query(
        `INSERT INTO document_version (id, organization_id, document_id, version_number, object_key, mime_type, byte_size, sha256_hex, uploaded_by_kind)
         VALUES ('9c000000-0000-4000-8000-000000000003', $1, $2, '3', 'tenants/synthetic/patients/p1/doc-3.pdf', 'application/pdf', '1', repeat('e', 64), 'api')`,
        [ORG, DOCUMENT],
      );
      await db.query(
        `UPDATE document_version SET mime_type = 'application/pdf; charset=binary' WHERE id = '9c000000-0000-4000-8000-000000000003'`,
      );
      const audit = await db.query<{
        event_type: string;
        after_key: string | null;
        before_key: string | null;
        old_name_in_after: boolean;
      }>(
        `SELECT event_type, after ->> 'object_key' AS after_key, before ->> 'object_key' AS before_key,
                coalesce(after ? 'minio_object_key', false) AS old_name_in_after
           FROM audit_event WHERE resource_kind = 'document_version' AND resource_id = '9c000000-0000-4000-8000-000000000003' ORDER BY created_at, event_type`,
      );
      expect(audit.rows).toEqual([
        {
          event_type: "document_version.insert",
          after_key: "<changed>",
          before_key: null,
          old_name_in_after: false,
        },
        {
          event_type: "document_version.update",
          after_key: "<changed>",
          before_key: "<changed>",
          old_name_in_after: false,
        },
      ]);
      const leaked = await db.query(
        `SELECT 1 FROM audit_event WHERE resource_kind = 'document_version' AND (before::text LIKE '%tenants/synthetic%' OR after::text LIKE '%tenants/synthetic%')`,
      );
      expect(leaked.rows).toEqual([]);
    }, 300_000);
  });

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
