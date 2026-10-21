/**
 * M27 Cost Report — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / ADR-0010).
 *
 * M27's pure suites exercise the cost-report state-machine, worksheet computation, and validation-rule
 * engine but never touch a database, so they cannot catch a wrong RLS predicate, a missing WITH CHECK, or
 * a base-table grant that leaks across tenants. This applies the real migrations to a real Postgres and
 * drives the policies as the unprivileged `chartwarden_app` role (no BYPASSRLS), covering all THIRTEEN
 * org-scoped M27 tables. (The fourteenth owned table, `cost_report_validation_rule`, is a PLATFORM/CATALOG
 * table: its `organization_id` is NULLABLE, its rows are platform-default, and 0071 grants an org-NULL
 * platform read branch — it is NON_ORG_SCOPED, so it is deliberately EXCLUDED from the tenant sweep.)
 *
 * The table that makes this worth more than a checkbox is `cost_report_snapshot`: the immutable, content-
 * hashed submission record CMS is filed against. A cross-tenant write would let one tenant manufacture
 * another's cost-report submission snapshot.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m27` (SUPERUSER to a THROWAWAY
 *     db; for a local PG without pgvector, set CHARTWARDEN_TEST_NO_PGVECTOR=1).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** `provider_entity_id` on cost_report / cost_center_mapping is a plain uuid (no FK) — but seeding a real
 * provider_entity keeps the chain honest and gives a literal that survives an accidental future FK. */
const USER = "33333333-3333-3333-3333-333333333333";
/** *_membership_id columns are NOT NULL but carry NO FK (cross-module ref convention) — literals are fine. */
const MEMBERSHIP = "44444444-4444-4444-4444-444444444444";

type SeedIds = {
  providerEntity: string;
  location: string;
  costReport: string;
  worksheet: string;
  snapshot: string;
  validation: string;
  validationRule: string;
  validationResult: string;
  validationOverride: string;
  badDebt: string;
  statisticData: string;
  trialBalanceImport: string;
  wageDataImport: string;
  costCenterMapping: string;
  ecrSubmission: string;
  complianceWindow: string;
};

// Only tables with an organization_id column AND a tenant `_org` RLS policy (0070). All 13 carry a direct
// `_org` policy and NONE are partitioned. `cost_report_validation_rule` is EXCLUDED — it is a
// platform/catalog table (nullable organization_id + the 0071 org-NULL platform read branch).
const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "cost_report", key: "costReport" },
  { table: "cost_report_worksheet", key: "worksheet" },
  { table: "cost_report_snapshot", key: "snapshot" },
  { table: "cost_report_validation", key: "validation" },
  { table: "cost_report_validation_result", key: "validationResult" },
  { table: "cost_report_validation_override", key: "validationOverride" },
  { table: "bad_debt_record", key: "badDebt" },
  { table: "statistic_data", key: "statisticData" },
  { table: "trial_balance_import", key: "trialBalanceImport" },
  { table: "wage_data_import", key: "wageDataImport" },
  { table: "cost_center_mapping", key: "costCenterMapping" },
  { table: "ecr_submission", key: "ecrSubmission" },
  { table: "cost_report_compliance_window", key: "complianceWindow" },
];

describe.skipIf(!DB_URL)("M27 Cost Report — RLS cross-tenant denial — LIVE Postgres (§3.5)", () => {
  let db: Client;
  let a: SeedIds;
  let b: SeedIds;

  async function withOrg<T>(org: string, fn: () => Promise<T>): Promise<T> {
    await db.query("SET ROLE chartwarden_app");
    await db.query("SELECT set_config('app.org_id', $1, false)", [org]);
    try {
      return await fn();
    } finally {
      await db.query("RESET ROLE");
    }
  }

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

  async function applyMigrations() {
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        sql = sql.replace(
          /^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm,
          "-- (vector extension stripped: CHARTWARDEN_TEST_NO_PGVECTOR set)",
        );
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw index stripped: no pgvector)");
      }
      await db.query(sql);
    }
  }

  /** Seed one full M27 cost-report chain for `org` as superuser (RLS + grants bypassed). */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const providerEntity = (
      await db.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-M27${n}`, `M27 Provider ${n}`, `NPI-M27${n}`],
      )
    ).rows[0].id as string;

    const location = (
      await db.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M27${n}`],
      )
    ).rows[0].id as string;

    const costReport = (
      await db.query(
        `INSERT INTO cost_report (organization_id, provider_entity_id, fiscal_year_start_date,
           fiscal_year_end_date, state)
         VALUES ($1,$2, now()::date, now()::date + 364, 'draft') RETURNING id`,
        [org, providerEntity],
      )
    ).rows[0].id as string;

    const worksheet = (
      await db.query(
        `INSERT INTO cost_report_worksheet (organization_id, cost_report_id, worksheet_code, data)
         VALUES ($1,$2,'S','{}'::jsonb) RETURNING id`,
        [org, costReport],
      )
    ).rows[0].id as string;

    const snapshot = (
      await db.query(
        `INSERT INTO cost_report_snapshot (organization_id, cost_report_id, content_hash_sha256,
           materialized_inputs, worksheet_snapshot, reason, created_by_membership_id)
         VALUES ($1,$2,$3,'{}'::jsonb,'{}'::jsonb,'submit',$4) RETURNING id`,
        [org, costReport, `hash-${n}`, MEMBERSHIP],
      )
    ).rows[0].id as string;

    const validation = (
      await db.query(
        `INSERT INTO cost_report_validation (organization_id, cost_report_id, snapshot_id,
           rule_set_version, status)
         VALUES ($1,$2,$3,1,'complete') RETURNING id`,
        [org, costReport, snapshot],
      )
    ).rows[0].id as string;

    // PLATFORM/CATALOG table — seeded only so the validation_result FK resolves; NOT in the tenant sweep.
    const validationRule = (
      await db.query(
        `INSERT INTO cost_report_validation_rule (organization_id, rule_code, category, description,
           rule_set_version, severity, predicate_spec)
         VALUES ($1,$2,'demographics_ownership','A rule',1,'block','{}'::jsonb) RETURNING id`,
        [org, `RULE-M27${n}`],
      )
    ).rows[0].id as string;

    const validationResult = (
      await db.query(
        `INSERT INTO cost_report_validation_result (organization_id, validation_id, rule_id, outcome, details)
         VALUES ($1,$2,$3,'pass','{}'::jsonb) RETURNING id`,
        [org, validation, validationRule],
      )
    ).rows[0].id as string;

    const validationOverride = (
      await db.query(
        `INSERT INTO cost_report_validation_override (organization_id, validation_result_id,
           overridden_by_membership_id, reason)
         VALUES ($1,$2,$3,'documented rationale') RETURNING id`,
        [org, validationResult, MEMBERSHIP],
      )
    ).rows[0].id as string;

    const badDebt = (
      await db.query(
        `INSERT INTO bad_debt_record (organization_id, cost_report_id, period_label, debt_kind,
           amount_cents, added_by_membership_id)
         VALUES ($1,$2,'2026-01','deductible',1000,$3) RETURNING id`,
        [org, costReport, MEMBERSHIP],
      )
    ).rows[0].id as string;

    const statisticData = (
      await db.query(
        `INSERT INTO statistic_data (organization_id, cost_report_id, monthly_breakdown,
           visit_counts_by_discipline, fte_calculations, bereavement_census)
         VALUES ($1,$2,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb) RETURNING id`,
        [org, costReport],
      )
    ).rows[0].id as string;

    const trialBalanceImport = (
      await db.query(
        `INSERT INTO trial_balance_import (organization_id, cost_report_id, source, status)
         VALUES ($1,$2,'manual_csv','complete') RETURNING id`,
        [org, costReport],
      )
    ).rows[0].id as string;

    const wageDataImport = (
      await db.query(
        `INSERT INTO wage_data_import (organization_id, cost_report_id, source, status)
         VALUES ($1,$2,'manual_csv','complete') RETURNING id`,
        [org, costReport],
      )
    ).rows[0].id as string;

    const costCenterMapping = (
      await db.query(
        `INSERT INTO cost_center_mapping (organization_id, provider_entity_id, fiscal_year_int,
           xero_account_code, xero_account_name, cms_cost_center_code, mapping_source)
         VALUES ($1,$2,2026,'6000','Salaries','A-1','tenant_override') RETURNING id`,
        [org, providerEntity],
      )
    ).rows[0].id as string;

    const ecrSubmission = (
      await db.query(
        `INSERT INTO ecr_submission (organization_id, cost_report_id, snapshot_id, status)
         VALUES ($1,$2,$3,'generating') RETURNING id`,
        [org, costReport, snapshot],
      )
    ).rows[0].id as string;

    const complianceWindow = (
      await db.query(
        `INSERT INTO cost_report_compliance_window (organization_id, cost_report_id, deadline_date,
           current_effective_deadline_date)
         VALUES ($1,$2, now()::date + 150, now()::date + 150) RETURNING id`,
        [org, costReport],
      )
    ).rows[0].id as string;

    return {
      providerEntity,
      location,
      costReport,
      worksheet,
      snapshot,
      validation,
      validationRule,
      validationResult,
      validationOverride,
      badDebt,
      statisticData,
      trialBalanceImport,
      wageDataImport,
      costCenterMapping,
      ecrSubmission,
      complianceWindow,
    };
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL });
    await db.connect();
    await resetSchema();
    await applyMigrations();
    await db.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m27-actor@x.test')`, [USER]);
    a = await seedOrg(ORG_A, 1);
    b = await seedOrg(ORG_B, 2);
  }, 120_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  // GUARD FOR EVERY CASE BELOW. RLS is not enforced for a role holding BYPASSRLS, so if the runtime
  // role ever gains it, every isolation assertion in this file passes VACUOUSLY and CI stays green.
  // scripts/db/migrate.ts grants exactly that behind CHARTWARDEN_DEV_BYPASSRLS=1, so this is reachable.
  it("chartwarden_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
    const { rows } = await db.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'chartwarden_app'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it("every M27 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
    const rls = readFileSync(join(MIGRATIONS_DIR, "0070_cost_report_m27_rls.sql"), "utf8");
    const policyBlocks = (rls.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? []).filter(
      (b) => COVERED.some((t) => b.includes(`"${t.table}"`)),
    );
    expect(policyBlocks.length).toBe(COVERED.length);
    for (const block of policyBlocks) {
      const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((m) => m[1]);
      expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
      expect(block).not.toMatch(/pg_has_role/i);
      expect(block).not.toMatch(/IS NULL/i);
    }
  });

  it.each(COVERED)(
    "$table: org A sees its row, org B cannot (cross-tenant denial)",
    async ({ table, key }) => {
      const id = a[key];
      const seenByA = await withOrg(ORG_A, () =>
        db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]),
      );
      expect(seenByA.rows[0].n).toBe(1); // isolation is not "deny everything"
      const seenByB = await withOrg(ORG_B, () =>
        db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]),
      );
      expect(seenByB.rows[0].n).toBe(0);
    },
  );

  it("a WITH CHECK refuses a snapshot forged into another tenant's cost report", async () => {
    // cost_report_snapshot is the immutable, content-hashed submission record CMS is filed against — a
    // cross-tenant write would let one tenant manufacture another's cost-report submission snapshot.
    await expect(
      withOrg(ORG_B, () =>
        db.query(
          `INSERT INTO cost_report_snapshot (organization_id, cost_report_id, content_hash_sha256,
             materialized_inputs, worksheet_snapshot, reason, created_by_membership_id)
           VALUES ($1,$2,'forged','{}'::jsonb,'{}'::jsonb,'submit',$3)`,
          [ORG_A, a.costReport, MEMBERSHIP],
        ),
      ),
    ).rejects.toThrow();
  });

  it("org B cannot UPDATE org A's cost_report (the USING clause covers writes too)", async () => {
    const res = await withOrg(ORG_B, () =>
      db.query("UPDATE cost_report SET state='closed' WHERE id=$1", [a.costReport]),
    );
    expect(res.rowCount).toBe(0);
    const still = await db.query("SELECT state FROM cost_report WHERE id=$1", [a.costReport]);
    expect(still.rows[0].state).toBe("draft");
  });

  it("the M4 write-audit trigger fired for the cost_report writes (§3.6)", async () => {
    const r = await db.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind = 'cost_report'",
    );
    expect(r.rows[0].n).toBeGreaterThan(0);
  });
});
