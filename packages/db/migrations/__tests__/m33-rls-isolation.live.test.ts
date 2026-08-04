/**
 * M33 Reporting & Dashboards — RLS cross-tenant denial: the LIVE Postgres proof (M33 §3.5;
 * M33-T03, ADR-0010, ARCH-211, SEC-053).
 *
 * §3.5 is the CI gate that proves the canonical `app.org_id` predicate (ADR-0010 / M34-F02) is
 * wired on EVERY tenant-scoped M33 table — cross-tenant-denial tests are not optional. The pure
 * unit suites in packages/reporting exercise the translator/refresh/scheduled/drilldown/eraser
 * orchestration but never touch a database, so they cannot catch a wrong policy predicate, a
 * missing WITH CHECK, a base-table grant that leaks across tenants, or a SECURITY DEFINER wrapper
 * that forgets its org-assertion. This test applies the actual migrations to a real Postgres and
 * exercises the policies as the unprivileged `wardenx_app` role (no BYPASSRLS), proving:
 *
 *   - cross-tenant denial for real on all 9 org-scoped M33 tables (report_definition ·
 *     report_definition_version · report_view · report_share · report_schedule ·
 *     report_schedule_run · report_run · dashboard_tile_cache · report_drilldown_audit);
 *   - the 3 PLATFORM-global catalogs (materialized_view_metadata · report_base_catalog ·
 *     report_metric_catalog) are read-all cross-org (SELECT USING(true));
 *   - report_run's NULLABLE-org (platform-wide refresh) rows are hidden from tenants by the
 *     canonical predicate;
 *   - report_drilldown_audit is INSERT-ONLY (no UPDATE/DELETE path for wardenx_app);
 *   - the §3.5 "no direct MV SELECT" rule: wardenx_app cannot SELECT a report_mv.* materialized
 *     view directly, and the report_mv.select_<mv_key>(p_org_id) SECURITY DEFINER wrapper REFUSES
 *     (returns nothing) when p_org_id != the caller's app.org_id (the org-assertion);
 *   - ADR-0010: a session that sets only the legacy `app.current_org_id` (not the canonical
 *     `app.org_id`) sees nothing.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - CI: the `rls-live-m33` job provides a postgres service + WARDENX_TEST_DATABASE_URL.
 *   - Local: `WARDENX_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m33`
 * The URL must be a SUPERUSER connection to a THROWAWAY database (the suite drops and recreates
 * the public schema + roles). For a local PG without pgvector, set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "mdm_canonical_writer",
  "tenant_platform_writer",
  "report_writer", // M33's SECURITY DEFINER MV-wrapper / catalog-writer role (0056)
];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

/** Ids of org A's (and org B's) seeded row in each org-scoped table — resolved in beforeAll. */
type SeedIds = {
  reportDefinition: string;
  reportDefinitionVersion: string;
  reportView: string;
  reportShare: string;
  reportSchedule: string;
  reportScheduleRun: string;
  reportRun: string;
  dashboardTileCache: string;
  reportDrilldownAudit: string;
};

// The 9 tenant-scoped M33 tables, proven through a direct base-table SELECT under wardenx_app. A
// row's `id` PK (or the id half of a partitioned composite PK) uniquely identifies org A's row.
const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "report_definition", key: "reportDefinition" },
  { table: "report_definition_version", key: "reportDefinitionVersion" },
  { table: "report_view", key: "reportView" },
  { table: "report_share", key: "reportShare" },
  { table: "report_schedule", key: "reportSchedule" },
  { table: "report_schedule_run", key: "reportScheduleRun" },
  { table: "report_run", key: "reportRun" },
  { table: "dashboard_tile_cache", key: "dashboardTileCache" },
  { table: "report_drilldown_audit", key: "reportDrilldownAudit" },
];

// The 3 platform-global catalogs (no organization_id): identical rows for every tenant (SELECT
// USING(true)). Proven readable cross-org with a representative non-empty count.
const PLATFORM_CATALOGS = [
  "materialized_view_metadata",
  "report_base_catalog",
  "report_metric_catalog",
];

describe.skipIf(!DB_URL)(
  "M33 Reporting & Dashboards — RLS cross-tenant denial — LIVE Postgres (§3.5)",
  () => {
    let db: Client;
    let a: SeedIds; // org A's seeded ids
    let nullOrgRun: string; // a platform-wide (organization_id IS NULL) report_run id

    /** Run `fn` as the unprivileged app role with app.org_id = `org` (RLS enforced). */
    async function withOrg<T>(org: string, fn: () => Promise<T>): Promise<T> {
      await db.query("SET ROLE wardenx_app");
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
      const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
      const files = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      for (const f of files) {
        let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
        if (stripVector) {
          sql = sql.replace(
            /^.*EXTENSION IF NOT EXISTS "vector".*$/m,
            "-- (vector extension stripped: WARDENX_TEST_NO_PGVECTOR set; local PG without pgvector)",
          );
        }
        await db.query(sql);
      }
    }

    /**
     * Seed one full M33 reporting row chain for `org` as superuser (RLS + grants bypassed). The
     * three partitioned tables (report_schedule_run / report_run / report_drilldown_audit) are
     * RANGE-partitioned with the current month's child already created by 0057, so rows stamped
     * `now()` route into an existing leaf — no per-org partition creation needed (unlike M34's LIST
     * partitions). base_key 'census_org_daily' and mv_key 'mv_census_org_daily' come from the 0061
     * platform-catalog seed. Returns the row ids for assertions.
     */
    async function seedReporting(org: string, label: string): Promise<SeedIds> {
      const reportDefinition = (
        await db.query(
          `INSERT INTO report_definition (organization_id, authorship, base_key, display_name)
         VALUES ($1,'tenant','census_org_daily','Daily Census ${label}') RETURNING id`,
          [org],
        )
      ).rows[0].id as string;

      const reportDefinitionVersion = (
        await db.query(
          `INSERT INTO report_definition_version (definition_id, organization_id, version_number, spec, status)
         VALUES ($1,$2,1,'{}'::jsonb,'published') RETURNING id`,
          [reportDefinition, org],
        )
      ).rows[0].id as string;

      const reportView = (
        await db.query(
          `INSERT INTO report_view (organization_id, definition_version_id, owner_membership_id, display_name)
         VALUES ($1,$2, gen_random_uuid(),'My Census ${label}') RETURNING id`,
          [org, reportDefinitionVersion],
        )
      ).rows[0].id as string;

      const reportShare = (
        await db.query(
          `INSERT INTO report_share (organization_id, report_view_id, shared_with_membership_id)
         VALUES ($1,$2, gen_random_uuid()) RETURNING id`,
          [org, reportView],
        )
      ).rows[0].id as string;

      const reportSchedule = (
        await db.query(
          `INSERT INTO report_schedule (organization_id, report_view_id, owner_membership_id, cron_expression, tenant_timezone, format, recipient_membership_ids)
         VALUES ($1,$2, gen_random_uuid(),'0 6 * * *','America/New_York','pdf','[]'::jsonb) RETURNING id`,
          [org, reportView],
        )
      ).rows[0].id as string;

      const reportScheduleRun = (
        await db.query(
          `INSERT INTO report_schedule_run (schedule_id, organization_id, scheduled_for, status)
         VALUES ($1,$2, now(),'queued') RETURNING id`,
          [reportSchedule, org],
        )
      ).rows[0].id as string;

      const reportRun = (
        await db.query(
          `INSERT INTO report_run (mv_key, organization_id, trigger_kind, started_at, status)
         VALUES ('mv_census_org_daily',$1,'on_demand', now(),'succeeded') RETURNING id`,
          [org],
        )
      ).rows[0].id as string;

      const dashboardTileCache = (
        await db.query(
          `INSERT INTO dashboard_tile_cache (organization_id, cache_key, result_json, expires_at, freshness_seconds_at_compute)
         VALUES ($1,'tile-${label}','{}'::jsonb, now() + interval '1 hour', 0) RETURNING id`,
          [org],
        )
      ).rows[0].id as string;

      const reportDrilldownAudit = (
        await db.query(
          `INSERT INTO report_drilldown_audit (organization_id, actor_membership_id, source_tile_key, drilldown_target_module, drilldown_target_surface, query_filters_cipher, drilldown_trace_id, accessed_at)
         VALUES ($1, gen_random_uuid(),'census_tile',6,'patient-list','cipher-${label}', gen_random_uuid(), now()) RETURNING id`,
          [org],
        )
      ).rows[0].id as string;

      return {
        reportDefinition,
        reportDefinitionVersion,
        reportView,
        reportShare,
        reportSchedule,
        reportScheduleRun,
        reportRun,
        dashboardTileCache,
        reportDrilldownAudit,
      };
    }

    /**
     * Populate report_mv.mv_census_org_daily with ONE org-A census row so the SECURITY DEFINER
     * wrapper's org-assertion is provable behaviorally (matching org → row, mismatched org → none),
     * not just vacuously empty. The MV reads public.admission WHERE status='active'; admission FKs
     * provider_entity + location, so seed that minimal chain (patient_id / physician_id have no FK).
     */
    async function seedCensusMv(org: string): Promise<void> {
      const providerEntity = (
        await db.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'123456','Census Provider','1234567890','enc','12-31') RETURNING id`,
          [org],
        )
      ).rows[0].id as string;

      const location = (
        await db.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Main Office','1 Main St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [providerEntity],
        )
      ).rows[0].id as string;

      await db.query(
        `INSERT INTO admission (organization_id, provider_entity_id, location_id, patient_id, admitted_by_physician_id, status, activated_at)
         VALUES ($1,$2,$3, gen_random_uuid(), gen_random_uuid(),'active', now())`,
        [org, providerEntity, location],
      );

      // Refresh as superuser (MV owner) so the wrapper reads a populated MV.
      await db.query("REFRESH MATERIALIZED VIEW report_mv.mv_census_org_daily");
    }

    beforeAll(async () => {
      // Runs in its OWN CI job (`rls-live-m33`) with a fresh Postgres service, so the schema/role
      // reset starts clean (a fresh cluster has no prior migration set / cluster-global roles to fight).
      db = new Client({ connectionString: DB_URL });
      await db.connect();
      await resetSchema();
      await applyMigrations();

      await db.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
        [ORG_A, ORG_B],
      );

      a = await seedReporting(ORG_A, "a");
      await seedReporting(ORG_B, "b");

      // A platform-wide (organization_id IS NULL) refresh row — must be invisible to BOTH tenants
      // under the canonical predicate (§3.5: NULL-org rows live in the platform-admin context).
      nullOrgRun = (
        await db.query(
          `INSERT INTO report_run (mv_key, organization_id, trigger_kind, started_at, status)
         VALUES ('mv_census_org_daily', NULL,'nightly_cron', now(),'succeeded') RETURNING id`,
        )
      ).rows[0].id as string;

      await seedCensusMv(ORG_A);
    }, 120_000);

    afterAll(async () => {
      await db?.end();
    });

    // ── §3.5 canonical predicate (artifact fidelity) ─────────────────────────────────────────────
    // Every org-scoped table's policy must key ONLY on the canonical app.org_id session variable —
    // the same rule check-tenancy.ts enforces. A policy that joined on a parent table or used
    // pg_has_role(...) would be the silent-cross-tenant-read regression this test guards.
    // GUARD FOR EVERY CASE BELOW. RLS is not enforced for a role holding BYPASSRLS, so if the runtime
    // role ever gains it, every isolation assertion in this file passes VACUOUSLY and CI stays green.
    // scripts/db/migrate.ts grants exactly that behind WARDENX_DEV_BYPASSRLS=1, so this is reachable,
    // not theoretical. Six of fifteen suites asserted this and NONE of the four suites CI runs did.
    it("wardenx_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
      const { rows } = await db.query<{ rolbypassrls: boolean }>(
        "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'wardenx_app'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].rolbypassrls).toBe(false);
    });

    it("§3.5 every org-scoped policy keys ONLY on the canonical app.org_id variable", () => {
      const rls = readFileSync(join(MIGRATIONS_DIR, "0058_reporting_rls.sql"), "utf8");
      for (const { table } of COVERED) {
        const blocks = [...rls.matchAll(/CREATE POLICY[\s\S]*?;/g)]
          .map((m) => m[0])
          .filter((bk) => new RegExp(`ON "${table}"`).test(bk));
        expect(blocks.length).toBeGreaterThan(0);
        for (const bk of blocks) {
          const vars = [...bk.matchAll(/current_setting\(\s*'(app\.[a-z_]+)'/g)].map((m) => m[1]);
          expect(vars.length).toBeGreaterThan(0);
          expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
          expect(bk).not.toMatch(/pg_has_role/i);
        }
      }
    });

    // The 3 platform read-all catalogs must key on USING(true) (no org session var) — they are the
    // intentional cross-org exception (NON_ORG_SCOPED allowlist), not a leak.
    it("§3.5 each platform catalog policy is read-all (USING (true), no app.* var)", () => {
      const rls = readFileSync(join(MIGRATIONS_DIR, "0058_reporting_rls.sql"), "utf8");
      for (const table of PLATFORM_CATALOGS) {
        const blocks = [...rls.matchAll(/CREATE POLICY[\s\S]*?;/g)]
          .map((m) => m[0])
          .filter((bk) => new RegExp(`ON "${table}"`).test(bk));
        expect(blocks.length).toBeGreaterThan(0);
        for (const bk of blocks) {
          expect(bk).toMatch(/USING\s*\(true\)/i);
          expect(bk).not.toMatch(/current_setting\(\s*'app\./);
        }
      }
    });

    // Every report_mv.select_*() wrapper must be SECURITY DEFINER and carry the org-assertion.
    it("§3.5 every MV wrapper is SECURITY DEFINER and asserts p_org_id = app.org_id", () => {
      const mv = readFileSync(join(MIGRATIONS_DIR, "0060_reporting_mv.sql"), "utf8");
      const wrappers = [...mv.matchAll(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;/g)].map(
        (m) => m[0],
      );
      expect(wrappers.length).toBeGreaterThan(0);
      for (const fn of wrappers) {
        expect(fn).toMatch(/SECURITY DEFINER/);
        expect(fn).toMatch(/p_org_id\s*=\s*current_setting\(\s*'app\.org_id'/);
      }
    });

    // ── Per-table cross-tenant denial (§3.5) ─────────────────────────────────────────────────────
    // Org A reads its own row; org B's session sees NONE of org A's rows (RLS silently returns
    // empty, the correct behavior — not a 403).
    describe.each(COVERED)("$table — cross-tenant denial (§3.5)", ({ table, key }) => {
      it("org A sees its own row; org B sees none of it", async () => {
        const id = a[key];
        const seenByA = await withOrg(ORG_A, () =>
          db.query(`SELECT count(*)::int AS n FROM "${table}" WHERE id = $1`, [id]),
        );
        const seenByB = await withOrg(ORG_B, () =>
          db.query(`SELECT count(*)::int AS n FROM "${table}" WHERE id = $1`, [id]),
        );
        expect(seenByA.rows[0].n).toBe(1); // isolation is not "deny everything"
        expect(seenByB.rows[0].n).toBe(0); // org B cannot read org A's row
      });
    });

    // ── report_run NULL-org (platform-wide refresh) invisibility (§3.5) ───────────────────────────
    it("§3.5 the platform-wide (NULL-org) report_run row is invisible to BOTH tenants", async () => {
      const byA = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM report_run WHERE id = $1", [nullOrgRun]),
      );
      const byB = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM report_run WHERE id = $1", [nullOrgRun]),
      );
      expect(byA.rows[0].n).toBe(0);
      expect(byB.rows[0].n).toBe(0);
    });

    // ── Platform catalogs read-all cross-org (§3.5) ──────────────────────────────────────────────
    describe.each(PLATFORM_CATALOGS)("%s — platform read-all (cross-org)", (table) => {
      it("both org A and org B read the identical (non-empty) catalog", async () => {
        const byA = await withOrg(ORG_A, () =>
          db.query(`SELECT count(*)::int AS n FROM "${table}"`),
        );
        const byB = await withOrg(ORG_B, () =>
          db.query(`SELECT count(*)::int AS n FROM "${table}"`),
        );
        expect(byA.rows[0].n).toBeGreaterThan(0);
        expect(byB.rows[0].n).toBe(byA.rows[0].n); // identical rows for every tenant
      });
    });

    // ── Cross-tenant WRITE rejection (WITH CHECK) ────────────────────────────────────────────────
    it("§3.5 org B cannot INSERT a report_definition stamped with org A (WITH CHECK)", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO report_definition (organization_id, authorship, base_key, display_name)
           VALUES ($1,'tenant','census_org_daily','sneaky')`,
            [ORG_A],
          ),
        ),
      ).rejects.toThrow();
    });

    it("§3.5 org B cannot INSERT a dashboard_tile_cache stamped with org A (WITH CHECK)", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO dashboard_tile_cache (organization_id, cache_key, result_json, expires_at, freshness_seconds_at_compute)
           VALUES ($1,'sneaky','{}'::jsonb, now() + interval '1 hour', 0)`,
            [ORG_A],
          ),
        ),
      ).rejects.toThrow();
    });

    // ── report_drilldown_audit INSERT-ONLY ledger (§3.5) ─────────────────────────────────────────
    describe("report_drilldown_audit — insert-only (no UPDATE/DELETE path for wardenx_app)", () => {
      it("wardenx_app cannot UPDATE an own-org drilldown audit row (no UPDATE grant)", async () => {
        await expect(
          withOrg(ORG_A, () =>
            db.query("UPDATE report_drilldown_audit SET source_tile_key = 'x' WHERE id = $1", [
              a.reportDrilldownAudit,
            ]),
          ),
        ).rejects.toThrow(/permission denied/i);
      });

      it("wardenx_app cannot DELETE an own-org drilldown audit row (no DELETE grant)", async () => {
        await expect(
          withOrg(ORG_A, () =>
            db.query("DELETE FROM report_drilldown_audit WHERE id = $1", [a.reportDrilldownAudit]),
          ),
        ).rejects.toThrow(/permission denied/i);
      });
    });

    // ── §3.5 "no direct MV SELECT" + SECURITY DEFINER org-assertion ──────────────────────────────
    describe("report_mv — direct SELECT denied; wrapper enforces the org-assertion (§3.5)", () => {
      it("wardenx_app cannot SELECT the materialized view directly (no MV SELECT grant)", async () => {
        await expect(
          withOrg(ORG_A, () => db.query("SELECT count(*) FROM report_mv.mv_census_org_daily")),
        ).rejects.toThrow(/permission denied/i);
      });

      it("the wrapper returns the org's own census row when p_org_id = app.org_id", async () => {
        const r = await withOrg(ORG_A, () =>
          db.query("SELECT count(*)::int AS n FROM report_mv.select_mv_census_org_daily($1)", [
            ORG_A,
          ]),
        );
        expect(r.rows[0].n).toBe(1); // org A has one seeded active-census day
      });

      it("the wrapper REFUSES (returns nothing) when org B asks for org A's data", async () => {
        // org B's session calling select_…($ORG_A): organization_id matches the data, but the
        // SECURITY DEFINER body's `p_org_id = current_setting('app.org_id')` assertion (A = B) is
        // false → empty set. The cross-tenant read is denied even though org A HAS data.
        const r = await withOrg(ORG_B, () =>
          db.query("SELECT count(*)::int AS n FROM report_mv.select_mv_census_org_daily($1)", [
            ORG_A,
          ]),
        );
        expect(r.rows[0].n).toBe(0);
      });

      it("the wrapper REFUSES when the caller passes another org's id (p_org_id != app.org_id)", async () => {
        const r = await withOrg(ORG_A, () =>
          db.query("SELECT count(*)::int AS n FROM report_mv.select_mv_census_org_daily($1)", [
            ORG_B,
          ]),
        );
        expect(r.rows[0].n).toBe(0);
      });
    });

    // ── ADR-0010 mixed session variable — only `app.org_id` grants access ────────────────────────
    it("ADR-0010 a session that sets the legacy app.current_org_id (not app.org_id) sees NOTHING", async () => {
      // A FRESH connection where app.org_id was never set: current_setting('app.org_id', true)
      // returns NULL → the canonical predicate filters every row, regardless of app.current_org_id.
      const fresh = new Client({ connectionString: DB_URL });
      await fresh.connect();
      try {
        await fresh.query("SET ROLE wardenx_app");
        await fresh.query("SELECT set_config('app.current_org_id', $1, false)", [ORG_A]);
        const r = await fresh.query(
          "SELECT count(*)::int AS n FROM report_definition WHERE id = $1",
          [a.reportDefinition],
        );
        expect(r.rows[0].n).toBe(0); // the wrong (legacy) variable grants no access
      } finally {
        await fresh.end();
      }
    });
  },
);
