/**
 * M26 Cap Management — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / ADR-0010).
 *
 * The pure unit suites (apps/backend/.../26-cap, packages/cap-management) exercise the domain but never
 * touch a database, so they cannot catch a wrong RLS predicate, a missing WITH CHECK, or a base-table grant
 * that leaks across tenants. This test applies the actual migrations to a real Postgres and exercises the
 * policies as the unprivileged `chartwarden_app` role (no BYPASSRLS), proving cross-tenant denial for real on
 * ALL 11 org-scoped M26 tables under the canonical `organization_id = current_setting('app.org_id')`
 * predicate — including the three LIST(cap_period_id)-partitioned tables (policy on the parent propagates to
 * every partition incl. DEFAULT, PG11+). cap_period_platform_constant is platform-shared (read-all) and is
 * intentionally NOT covered here.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live` (SUPERUSER to a THROWAWAY db;
 *     for a local PG without pgvector, set CHARTWARDEN_TEST_NO_PGVECTOR=1).
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

type SeedIds = {
  period: string;
  methodologyLock: string;
  benAccrual: string;
  benAccrualLine: string;
  inpAccrual: string;
  inpDayLine: string;
  snapshot: string;
  thresholdEvent: string;
  psrImport: string;
  psrRecon: string;
  settlement: string;
};

const COVERED: { table: string; key: keyof SeedIds; idCol?: string }[] = [
  { table: "cap_period", key: "period" },
  { table: "cap_period_methodology_lock", key: "methodologyLock", idCol: "cap_period_id" },
  { table: "cap_beneficiary_accrual", key: "benAccrual" },
  { table: "cap_beneficiary_accrual_line", key: "benAccrualLine" },
  { table: "cap_inpatient_accrual", key: "inpAccrual" },
  { table: "cap_inpatient_day_line", key: "inpDayLine" },
  { table: "cap_projection_snapshot", key: "snapshot" },
  { table: "cap_threshold_event", key: "thresholdEvent" },
  { table: "cap_psr_import", key: "psrImport" },
  { table: "cap_psr_reconciliation", key: "psrRecon" },
  { table: "cap_settlement", key: "settlement" },
];

// Migrations before 1139 are frozen history and spell the old wardenx_* role names; 1139 renamed those roles in the
// live catalog. A test that RE-APPLIES an old migration after 1139 must therefore spell the roles as the catalog now does.
const asCurrentRoles = (sql: string): string =>
  sql.replace(
    /\bwardenx_(app|admin|readonly|audit_writer|platform|platform_login|destruction|destruction_login|m36_reseal|body_backfill_login)\b/g,
    "chartwarden_$1",
  );

describe.skipIf(!DB_URL)(
  "M26 Cap Management — RLS cross-tenant denial — LIVE Postgres (§3.5)",
  () => {
    let db: Client;
    let a: SeedIds;

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
          sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
        }
        await db.query(sql);
      }
    }

    /** Seed one full M26 cap chain for `org` as superuser (RLS + grants bypassed). `n` distinguishes the year. */
    async function seedOrg(org: string, n: number): Promise<SeedIds> {
      const fy = `FY${2090 + n}`;
      const start = `${2089 + n}-10-01`;
      const end = `${2090 + n}-09-30`;
      const patient = "44444444-4444-4444-4444-444444444444";
      const period = (
        await db.query(
          `INSERT INTO cap_period (organization_id, ccn, cap_year, starts_on, ends_on, aggregate_cap_amount_cents,
           inpatient_cap_pct, methodology, status, opened_by)
         VALUES ($1,'000000',$2,$3,$4,3446534,0.2000,'streamlined','active',gen_random_uuid()) RETURNING id`,
          [org, fy, start, end],
        )
      ).rows[0].id as string;
      const methodologyLock = (
        await db.query(
          `INSERT INTO cap_period_methodology_lock (cap_period_id, organization_id, methodology, locked_by, reason, step_up_session_id)
         VALUES ($1,$2,'streamlined',gen_random_uuid(),'chosen',gen_random_uuid()) RETURNING cap_period_id AS id`,
          [period, org],
        )
      ).rows[0].id as string;
      const benAccrual = (
        await db.query(
          `INSERT INTO cap_beneficiary_accrual (organization_id, cap_period_id, patient_id, mbi_normalized, paid_cents, first_election_in_period)
         VALUES ($1,$2,$3,'1EG4TE5MK73',100000,$4) RETURNING id`,
          [org, period, patient, start],
        )
      ).rows[0].id as string;
      const benAccrualLine = (
        await db.query(
          `INSERT INTO cap_beneficiary_accrual_line (organization_id, cap_period_id, patient_id, source_kind, source_id,
           amount_cents, service_from, service_to, posted_at)
         VALUES ($1,$2,$3,'remittance',gen_random_uuid(),100000,$4,$5,now()) RETURNING id`,
          [org, period, patient, start, end],
        )
      ).rows[0].id as string;
      const inpAccrual = (
        await db.query(
          `INSERT INTO cap_inpatient_accrual (organization_id, cap_period_id, gip_days, irc_days, total_patient_days)
         VALUES ($1,$2,5,2,100) RETURNING id`,
          [org, period],
        )
      ).rows[0].id as string;
      const inpDayLine = (
        await db.query(
          `INSERT INTO cap_inpatient_day_line (organization_id, cap_period_id, patient_id, source_id, rev_code, days, service_from, service_to, posted_at)
         VALUES ($1,$2,$3,gen_random_uuid(),'0656',3,$4,$5,now()) RETURNING id`,
          [org, period, patient, start, end],
        )
      ).rows[0].id as string;
      const snapshot = (
        await db.query(
          `INSERT INTO cap_projection_snapshot (organization_id, cap_period_id, scope, methodology, paid_ytd_cents,
           projected_year_end_cents, pct_of_cap, alert_band, computed_by)
         VALUES ($1,$2,'agency_aggregate','streamlined',100000,120000,0.0348,'safe','nightly_batch') RETURNING id`,
          [org, period],
        )
      ).rows[0].id as string;
      const thresholdEvent = (
        await db.query(
          `INSERT INTO cap_threshold_event (organization_id, cap_period_id, scope, prior_band, current_band, snapshot_id)
         VALUES ($1,$2,'agency_aggregate','safe','watch_90',$3) RETURNING id`,
          [org, period, snapshot],
        )
      ).rows[0].id as string;
      const psrImport = (
        await db.query(
          `INSERT INTO cap_psr_import (organization_id, cap_period_id, mac_region, psr_period_from, psr_period_to,
           file_storage_key, file_sha256, imported_by)
         VALUES ($1,$2,'ngs',$3,$4,'k',repeat('a',64),gen_random_uuid()) RETURNING id`,
          [org, period, start, end],
        )
      ).rows[0].id as string;
      const psrRecon = (
        await db.query(
          `INSERT INTO cap_psr_reconciliation (organization_id, cap_period_id, psr_import_id, scope, variance_cents)
         VALUES ($1,$2,$3,'agency_aggregate',5000) RETURNING id`,
          [org, period, psrImport],
        )
      ).rows[0].id as string;
      const settlement = (
        await db.query(
          `INSERT INTO cap_settlement (organization_id, cap_period_id, paid_total_cents, beneficiary_count,
           aggregate_cap_amount_cents, aggregate_overage_cents, inpatient_total_days, inpatient_overage_days,
           inpatient_overage_cents, proposed_by)
         VALUES ($1,$2,100000,1,3446534,-3346534,7,0,0,gen_random_uuid()) RETURNING id`,
          [org, period],
        )
      ).rows[0].id as string;
      return {
        period,
        methodologyLock,
        benAccrual,
        benAccrualLine,
        inpAccrual,
        inpDayLine,
        snapshot,
        thresholdEvent,
        psrImport,
        psrRecon,
        settlement,
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
      a = await seedOrg(ORG_A, 1);
      await seedOrg(ORG_B, 2);
    }, 120_000);

    afterAll(async () => {
      if (db) await db.end();
    });

    // GUARD FOR EVERY CASE BELOW. RLS is not enforced for a role holding BYPASSRLS, so if the runtime
    // role ever gains it, every isolation assertion in this file passes VACUOUSLY and CI stays green.
    // scripts/db/migrate.ts grants exactly that behind CHARTWARDEN_DEV_BYPASSRLS=1, so this is reachable,
    // not theoretical. Six of fifteen suites asserted this and NONE of the four suites CI runs did.
    it("chartwarden_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
      const { rows } = await db.query<{ rolbypassrls: boolean }>(
        "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'chartwarden_app'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].rolbypassrls).toBe(false);
    });

    it("every M26 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
      const rls = readFileSync(join(MIGRATIONS_DIR, "0088_cap_m26_rls.sql"), "utf8");
      const policyBlocks = rls.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? [];
      expect(policyBlocks.length).toBe(11);
      for (const block of policyBlocks) {
        const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((m) => m[1]);
        expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
        expect(block).not.toMatch(/pg_has_role/i);
        expect(block).not.toMatch(/IS NULL/i);
      }
    });

    it.each(COVERED)(
      "$table: org A sees its row, org B cannot (cross-tenant denial)",
      async ({ table, key, idCol }) => {
        const id = a[key];
        const col = idCol ?? "id";
        const seenByA = await withOrg(ORG_A, () =>
          db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${col}=$1`, [id]),
        );
        expect(seenByA.rows[0].n).toBe(1); // isolation is not "deny everything"
        const seenByB = await withOrg(ORG_B, () =>
          db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${col}=$1`, [id]),
        );
        expect(seenByB.rows[0].n).toBe(0); // org B cannot read org A's row
      },
    );

    it("the platform cap constant is read-all (every tenant sees the seeded CMS amounts)", async () => {
      const seenByB = await withOrg(ORG_B, () =>
        db.query(
          "SELECT count(*)::int AS n FROM cap_period_platform_constant WHERE cap_year='FY2025'",
        ),
      );
      expect(seenByB.rows[0].n).toBe(1);
    });

    // ── FY2027 workstream E — the published cap constants (0393) and the D3 first-use guard (0392) ──
    async function constantRow(capYear: string) {
      const { rows } = await db.query<{
        cents: string | null;
        source_url: string | null;
        first_tenant_use_at: Date | null;
      }>(
        `SELECT aggregate_cap_amount_cents::text AS cents, source_url, first_tenant_use_at
           FROM cap_period_platform_constant WHERE cap_year = $1`,
        [capYear],
      );
      return rows[0];
    }
    const rerun = (file: string) =>
      db.query(asCurrentRoles(readFileSync(join(MIGRATIONS_DIR, file), "utf8")));

    it("0393 publishes FY2026 = $35,361.44 and FY2027 = $36,174.75 with their Federal Register sources", async () => {
      const fy26 = await constantRow("FY2026");
      expect(fy26?.cents).toBe("3536144");
      expect(fy26?.source_url).toBe("https://www.federalregister.gov/d/2025-14782");
      const fy27 = await constantRow("FY2027");
      expect(fy27?.cents).toBe("3617475");
      expect(fy27?.source_url).toBe("https://www.federalregister.gov/d/2026-15686");
      // Every tenant reads them (read-all policy) — the FY2026 open no longer fails CAP_AMOUNT_UNPUBLISHED.
      const seenByB = await withOrg(ORG_B, () =>
        db.query(
          "SELECT aggregate_cap_amount_cents::text AS c FROM cap_period_platform_constant WHERE cap_year='FY2026'",
        ),
      );
      expect(seenByB.rows[0].c).toBe("3536144");
    });

    it("0393 never overwrites a constant already in tenant use, nor one a platform admin published", async () => {
      // In use (first_tenant_use_at set) and unpublished: the guard must leave it alone.
      await db.query(
        "UPDATE cap_period_platform_constant SET aggregate_cap_amount_cents = NULL, first_tenant_use_at = now() WHERE cap_year = 'FY2026'",
      );
      // Unused but already published with a different value by the platform admin.
      await db.query(
        "UPDATE cap_period_platform_constant SET aggregate_cap_amount_cents = 3600000 WHERE cap_year = 'FY2027'",
      );
      try {
        await rerun("0393_m26_cap_constants_fy2026_fy2027.sql");
        expect((await constantRow("FY2026"))?.cents).toBeNull();
        expect((await constantRow("FY2027"))?.cents).toBe("3600000");
      } finally {
        await db.query(
          "UPDATE cap_period_platform_constant SET aggregate_cap_amount_cents = 3536144, first_tenant_use_at = NULL WHERE cap_year = 'FY2026'",
        );
        await db.query(
          "UPDATE cap_period_platform_constant SET aggregate_cap_amount_cents = 3617475 WHERE cap_year = 'FY2027'",
        );
      }
    });

    it("0392: chartwarden_app stamps first_tenant_use_at once through the SECURITY DEFINER function", async () => {
      expect((await constantRow("FY2027"))?.first_tenant_use_at).toBeNull();
      await withOrg(ORG_A, () =>
        db.query("SELECT cap_platform_loader_mark_constant_in_use('FY2027')"),
      );
      const first = (await constantRow("FY2027"))?.first_tenant_use_at;
      expect(first).toBeInstanceOf(Date);
      await withOrg(ORG_B, () =>
        db.query("SELECT cap_platform_loader_mark_constant_in_use('FY2027')"),
      );
      expect((await constantRow("FY2027"))?.first_tenant_use_at?.getTime()).toBe(first?.getTime());
      // ...and the app role still cannot write the platform table directly (0089 REVOKE stands).
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            "UPDATE cap_period_platform_constant SET first_tenant_use_at = NULL WHERE cap_year = 'FY2027'",
          ),
        ),
      ).rejects.toThrow();
      // The amend path's guard now bites: an in-use constant cannot be amended.
      const amended = await withOrg(ORG_A, () =>
        db.query(
          "SELECT * FROM cap_platform_loader_amend_constant('FY2027', 1, 'x', gen_random_uuid())",
        ),
      );
      expect(amended.rows).toHaveLength(0);
      expect((await constantRow("FY2027"))?.cents).toBe("3617475");
    });

    it("0392 backfills first_tenant_use_at from the earliest cap_period already opened for the year", async () => {
      // Org A's seeded period is FY2091 — publish a constant row for it, then replay the backfill.
      await db.query(
        `INSERT INTO cap_period_platform_constant (cap_year, aggregate_cap_amount_cents, recorded_by)
         VALUES ('FY2091', 3446534, '00000000-0000-0000-0000-000000000000') ON CONFLICT DO NOTHING`,
      );
      await rerun("0392_m26_cap_constant_first_tenant_use.sql");
      const { rows } = await db.query<{ same: boolean }>(
        `SELECT c.first_tenant_use_at = p.opened_at AS same
           FROM cap_period_platform_constant c JOIN cap_period p ON p.cap_year = c.cap_year
          WHERE c.cap_year = 'FY2091'`,
      );
      expect(rows[0].same).toBe(true);
    });

    it("a WITH CHECK refuses an INSERT into another tenant's scope", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO cap_inpatient_accrual (organization_id, cap_period_id, gip_days, irc_days, total_patient_days)
           VALUES ($1,$2,1,1,10)`,
            [ORG_A, a.period], // B tries to write a row scoped to A
          ),
        ),
      ).rejects.toThrow();
    });
  },
);
