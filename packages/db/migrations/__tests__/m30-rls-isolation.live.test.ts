/**
 * M30 HQRP & Quality — RLS cross-tenant denial: the LIVE Postgres proof (M30 §3.5 / §3.7;
 * M30-F02, ADR-0010, ARCH-211, SEC-053).
 *
 * §3.5 is the CI gate that proves the canonical `app.org_id` predicate (ADR-0010 / M34-F02) is
 * wired on EVERY one of M30's 18 org-scoped tables — cross-tenant-denial tests are not optional.
 * The pure unit suites in packages/quality exercise the calculators / lifecycle machines / workers /
 * eraser orchestration but never touch a database, so they cannot catch a wrong policy predicate, a
 * missing WITH CHECK, a base-table grant that leaks across tenants, or a stray DELETE grant that would
 * let the request-scoped app role hard-delete compliance evidence. This test applies the actual
 * migrations to a real Postgres and exercises the policies as the unprivileged `wardenx_app` role
 * (no BYPASSRLS), proving:
 *
 *   - cross-tenant denial for real on all 18 org-scoped M30 tables, including the 4 monthly-RANGE
 *     PARTITIONED PHI tables (incident_report / mortality_review / infection_surveillance_event /
 *     cahps_decedent_sample — rows seeded into the current-month leaf created by 0063–0066);
 *   - the canonical `app.org_id` predicate (§3.5 M30-F02): EVERY policy keys ONLY on the
 *     `app.org_id` session variable — no subquery, no EXISTS, no pg_has_role, no patient_id (M30 has
 *     NO patient-scope RLS predicate — patient-scope is the app-layer §4.7 `privacy_flag_redaction` /
 *     `part2Redisclosure` ABAC concern, deliberately NOT enforced at the RLS layer);
 *   - WITH CHECK rejects a cross-tenant write (org B cannot stamp a row with org A);
 *   - §3.7 destruction-block: wardenx_app has NO DELETE grant on ANY M30 table — SQL hard-delete by
 *     the request-scoped app role is impossible; destruction runs ONLY via the M4 eraseFn under
 *     wardenx_admin, which itself REFUSES the compliance-class evidence tables (the eraser package);
 *   - ADR-0010: a session that sets only the legacy `app.current_org_id` (not the canonical
 *     `app.org_id`) sees nothing.
 *
 * M30 adds NO custom DB role — every policy/grant targets the platform-floor `wardenx_app` /
 * `wardenx_admin` (and the M4 `wardenx_audit_writer` append path), so the role-reset list below is the
 * roles the FULL migration set creates, not an M30-specific one.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - CI: the `rls-live-m30` job provides a postgres service + WARDENX_TEST_DATABASE_URL.
 *   - Local: `WARDENX_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m30`
 * The URL must be a SUPERUSER connection to a THROWAWAY database (the suite drops and recreates the
 * public schema + roles). For a local PG without pgvector, set WARDENX_TEST_NO_PGVECTOR=1.
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
  "report_writer", // M33's MV-wrapper/catalog-writer role (0056) — created by the full set, dropped on reset
];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

/** Ids of org A's (and org B's) seeded row in each of the 18 org-scoped M30 tables — set in beforeAll. */
type SeedIds = {
  qualityMeasureValue: string;
  measureRecomputeQueue: string;
  cahpsVendorBinding: string;
  cahpsResultSummary: string;
  qapiProgram: string;
  qapiIndicator: string;
  qapiProject: string;
  qapiPip: string;
  qapiGovernanceMinutes: string;
  sraCycle: string;
  sraFinding: string;
  sraRemediation: string;
  copComplianceStatus: string;
  infectionOutbreakCase: string;
  incidentReport: string;
  mortalityReview: string;
  infectionSurveillanceEvent: string;
  cahpsDecedentSample: string;
};

// All 18 tenant-scoped M30 tables, proven through a direct base-table SELECT under wardenx_app. A
// row's `id` (the id half of the composite PK on the 4 partitioned tables) uniquely identifies org
// A's row. The last 4 are the monthly-RANGE PARTITIONED PHI tables (incident_report / mortality_review
// / infection_surveillance_event / cahps_decedent_sample).
const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "quality_measure_value", key: "qualityMeasureValue" },
  { table: "measure_recompute_queue", key: "measureRecomputeQueue" },
  { table: "cahps_vendor_binding", key: "cahpsVendorBinding" },
  { table: "cahps_result_summary", key: "cahpsResultSummary" },
  { table: "qapi_program", key: "qapiProgram" },
  { table: "qapi_indicator", key: "qapiIndicator" },
  { table: "qapi_project", key: "qapiProject" },
  { table: "qapi_pip", key: "qapiPip" },
  { table: "qapi_governance_minutes", key: "qapiGovernanceMinutes" },
  { table: "sra_cycle", key: "sraCycle" },
  { table: "sra_finding", key: "sraFinding" },
  { table: "sra_remediation", key: "sraRemediation" },
  { table: "cop_compliance_status", key: "copComplianceStatus" },
  { table: "infection_outbreak_case", key: "infectionOutbreakCase" },
  { table: "incident_report", key: "incidentReport" },
  { table: "mortality_review", key: "mortalityReview" },
  { table: "infection_surveillance_event", key: "infectionSurveillanceEvent" },
  { table: "cahps_decedent_sample", key: "cahpsDecedentSample" },
];

// The 4 monthly-RANGE PARTITIONED PHI tables (§3.3) — cross-tenant denial must still hold through the
// partitioned parent (a FOR ALL policy on the parent propagates to every leaf, PG11+).
const PHI_PARTITIONED = [
  "incident_report",
  "mortality_review",
  "infection_surveillance_event",
  "cahps_decedent_sample",
];

// The §3.7 compliance-class evidence tables the eraser REFUSES to destroy (counted for the
// certificate, never deleted). At the RLS layer this is enforced for the request-scoped role by the
// total absence of any DELETE grant to wardenx_app — proven below table-by-table.
const COMPLIANCE_EVIDENCE = [
  "incident_report",
  "mortality_review",
  "sra_cycle",
  "sra_finding",
  "sra_remediation",
  "qapi_program",
  "qapi_pip",
  "cop_compliance_status",
  "infection_surveillance_event",
  "cahps_result_summary",
];

describe.skipIf(!DB_URL)(
  "M30 HQRP & Quality — RLS cross-tenant denial — LIVE Postgres (§3.5 / §3.7)",
  () => {
    let db: Client;
    let a: SeedIds; // org A's seeded ids

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
     * Seed one full M30 row chain for `org` as superuser (RLS + grants bypassed). The 4 partitioned
     * tables (incident_report / mortality_review / infection_surveillance_event / cahps_decedent_sample)
     * are monthly-RANGE-partitioned with the current month's leaf already created by 0063–0066, so rows
     * stamped now() / the current month route into an existing leaf — no per-org partition creation
     * needed. provider_entity_id and every *_membership_id / patient_id / admission_id are cross-module
     * logical refs (plain uuid, no FK), so gen_random_uuid() satisfies them. Returns the row ids.
     */
    async function seedQuality(org: string, label: string): Promise<SeedIds> {
      const one = async (sql: string, params: unknown[]): Promise<string> =>
        (await db.query(sql, params)).rows[0].id as string;

      // ── measures subdomain ──────────────────────────────────────────────────────────────────────
      const qualityMeasureValue = await one(
        `INSERT INTO quality_measure_value
           (measure_code, provider_entity_id, organization_id, period_kind, period_start, period_end,
            numerator, denominator, ratio, threshold_met, computation_snapshot, snapshot_content_hash,
            calculator_version)
         VALUES ('hci_composite', gen_random_uuid(), $1, 'calendar_quarter',
                 now() - interval '90 days', now(), 8, 10, 0.8000, true, '{}'::jsonb, 'hash-${label}', 'v1')
         RETURNING id`,
        [org],
      );

      const measureRecomputeQueue = await one(
        `INSERT INTO measure_recompute_queue
           (measure_code, provider_entity_id, organization_id, period_start, period_end)
         VALUES ('hvldl', gen_random_uuid(), $1, now() - interval '90 days', now())
         RETURNING id`,
        [org],
      );

      const cahpsVendorBinding = await one(
        `INSERT INTO cahps_vendor_binding
           (organization_id, vendor_adapter_id, effective_from, configuration_cipher, configuration_key_version)
         VALUES ($1, 'shp', now(), 'cipher-${label}', 1)
         RETURNING id`,
        [org],
      );

      const cahpsResultSummary = await one(
        `INSERT INTO cahps_result_summary
           (organization_id, provider_entity_id, reporting_period_start, reporting_period_end,
            vendor_adapter_id, top_box_percentages, composite_scores, response_count,
            attempted_sample_count, vendor_response_payload_hash)
         VALUES ($1, gen_random_uuid(), now()::date - 90, now()::date, 'shp',
                 '{}'::jsonb, '{}'::jsonb, 42, 100, 'payload-${label}')
         RETURNING id`,
        [org],
      );

      // ── compliance-program subdomain (qapi_program parent → indicator/project/pip/minutes) ───────
      const qapiProgram = await one(
        `INSERT INTO qapi_program
           (organization_id, provider_entity_id, plan_year, program_description, governing_body_roster)
         VALUES ($1, gen_random_uuid(), 2026, 'QAPI ${label}', '[]'::jsonb)
         RETURNING id`,
        [org],
      );

      const qapiIndicator = await one(
        `INSERT INTO qapi_indicator
           (qapi_program_id, organization_id, indicator_name, data_path)
         VALUES ($1, $2, 'Pain control ${label}', 'measures.pain')
         RETURNING id`,
        [qapiProgram, org],
      );

      const qapiProject = await one(
        `INSERT INTO qapi_project
           (qapi_program_id, organization_id, title, goal_text, owner_membership_id, linked_indicator_id)
         VALUES ($1, $2, 'Project ${label}', 'Improve pain control', gen_random_uuid(), $3)
         RETURNING id`,
        [qapiProgram, org, qapiIndicator],
      );

      const qapiPip = await one(
        `INSERT INTO qapi_pip
           (qapi_program_id, linked_project_id, organization_id, title, charter_text)
         VALUES ($1, $2, $3, 'PIP ${label}', 'Charter text')
         RETURNING id`,
        [qapiProgram, qapiProject, org],
      );

      const qapiGovernanceMinutes = await one(
        `INSERT INTO qapi_governance_minutes
           (qapi_program_id, organization_id, meeting_at, attendee_roster, minutes_text,
            reviewed_project_ids, reviewed_pip_ids)
         VALUES ($1, $2, now(), '[]'::jsonb, 'Minutes ${label}', '[]'::jsonb, '[]'::jsonb)
         RETURNING id`,
        [qapiProgram, org],
      );

      // ── SRA chain (sra_cycle → sra_finding → sra_remediation) ────────────────────────────────────
      const sraCycle = await one(
        `INSERT INTO sra_cycle
           (organization_id, cycle_year, opened_by_membership_id, due_at)
         VALUES ($1, 2026, gen_random_uuid(), now() + interval '180 days')
         RETURNING id`,
        [org],
      );

      const sraFinding = await one(
        `INSERT INTO sra_finding
           (sra_cycle_id, organization_id, finding_number, threat_description, vulnerability_description,
            impact_description, affected_asset_category, inherent_5x5_score, residual_5x5_score)
         VALUES ($1, $2, 1, 'Threat', 'Vuln', 'Impact', 'workstation', 20, 8)
         RETURNING id`,
        [sraCycle, org],
      );

      const sraRemediation = await one(
        `INSERT INTO sra_remediation
           (sra_finding_id, organization_id, remediation_number, owner_membership_id, description_text, target_date)
         VALUES ($1, $2, 1, gen_random_uuid(), 'Patch hosts', now()::date + 30)
         RETURNING id`,
        [sraFinding, org],
      );

      const copComplianceStatus = await one(
        `INSERT INTO cop_compliance_status
           (organization_id, provider_entity_id, cop_citation, status, last_reviewed_at,
            last_reviewed_by_membership_id, next_review_due_at)
         VALUES ($1, gen_random_uuid(), '418.52', 'compliant', now(), gen_random_uuid(), now() + interval '180 days')
         RETURNING id`,
        [org],
      );

      // ── safety-surveillance subdomain (non-partitioned aggregate) ────────────────────────────────
      const infectionOutbreakCase = await one(
        `INSERT INTO infection_outbreak_case
           (organization_id, provider_entity_id, pathogen, body_site, window_start, window_end, triggering_event_count)
         VALUES ($1, gen_random_uuid(), 'influenza', 'respiratory', now() - interval '14 days', now(), 3)
         RETURNING id`,
        [org],
      );

      // ── the 4 monthly-RANGE PARTITIONED PHI tables (current-month leaf already exists) ───────────
      const incidentReport = await one(
        `INSERT INTO incident_report
           (organization_id, provider_entity_id, kind, kind_data, patient_id, occurred_at,
            reported_by_membership_id, severity)
         VALUES ($1, gen_random_uuid(), 'fall', '{}'::jsonb, gen_random_uuid(), now(), gen_random_uuid(), 'moderate')
         RETURNING id`,
        [org],
      );

      const mortalityReview = await one(
        `INSERT INTO mortality_review
           (organization_id, provider_entity_id, deceased_patient_id, admission_id, death_at,
            target_completion_at, created_via_event_idempotency_key)
         VALUES ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), now(),
                 now() + interval '30 days', gen_random_uuid())
         RETURNING id`,
        [org],
      );

      const infectionSurveillanceEvent = await one(
        `INSERT INTO infection_surveillance_event
           (organization_id, provider_entity_id, patient_id, observed_at, pathogen, body_site,
            transmission_context, filed_by_membership_id)
         VALUES ($1, gen_random_uuid(), gen_random_uuid(), now(), 'mrsa', 'skin', 'contact', gen_random_uuid())
         RETURNING id`,
        [org],
      );

      const cahpsDecedentSample = await one(
        `INSERT INTO cahps_decedent_sample
           (organization_id, provider_entity_id, sampling_cycle_month, deceased_admission_id,
            deceased_patient_id, primary_caregiver_contact_cipher, primary_caregiver_contact_key_version)
         VALUES ($1, gen_random_uuid(), date_trunc('month', now())::date, gen_random_uuid(),
                 gen_random_uuid(), 'contact-cipher-${label}', 1)
         RETURNING id`,
        [org],
      );

      return {
        qualityMeasureValue,
        measureRecomputeQueue,
        cahpsVendorBinding,
        cahpsResultSummary,
        qapiProgram,
        qapiIndicator,
        qapiProject,
        qapiPip,
        qapiGovernanceMinutes,
        sraCycle,
        sraFinding,
        sraRemediation,
        copComplianceStatus,
        infectionOutbreakCase,
        incidentReport,
        mortalityReview,
        infectionSurveillanceEvent,
        cahpsDecedentSample,
      };
    }

    beforeAll(async () => {
      // Runs in its OWN CI job (`rls-live-m30`) with a fresh Postgres service, so the schema/role
      // reset starts clean (a fresh cluster has no prior migration set / cluster-global roles to fight).
      db = new Client({ connectionString: DB_URL });
      await db.connect();
      await resetSchema();
      await applyMigrations();

      await db.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
        [ORG_A, ORG_B],
      );

      a = await seedQuality(ORG_A, "a");
      await seedQuality(ORG_B, "b");
    }, 120_000);

    afterAll(async () => {
      await db?.end();
    });

    // ── §3.5 canonical predicate (artifact fidelity) ─────────────────────────────────────────────
    // Every org-scoped table's policy must key ONLY on the canonical app.org_id session variable —
    // the same rule check-tenancy.ts enforces. A policy that joined on a parent table, used
    // pg_has_role(...), or keyed on patient_id would be the silent-cross-tenant-read (or a bogus
    // patient-scope) regression this test guards.
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
      const rls = readFileSync(join(MIGRATIONS_DIR, "0067_quality_m30_rls.sql"), "utf8");
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
          expect(bk).not.toMatch(/EXISTS\s*\(/i);
          // M30 has NO patient-scope RLS predicate — patient-scope is an app-layer ABAC concern
          // (§4.7 privacy_flag_redaction / part2Redisclosure), not a row-policy column.
          expect(bk).not.toMatch(/patient_id/i);
        }
      }
    });

    // §3.7: NO M30 table grants DELETE (or ALL) to the request-scoped wardenx_app role — SQL
    // hard-delete by the app role is impossible. wardenx_admin (the eraseFn role) gets GRANT ALL.
    it("§3.7 0067 grants wardenx_app only SELECT/INSERT/UPDATE (never DELETE/ALL); admin gets ALL", () => {
      const rls = readFileSync(join(MIGRATIONS_DIR, "0067_quality_m30_rls.sql"), "utf8");
      for (const { table } of COVERED) {
        expect(rls).toMatch(
          new RegExp(`GRANT SELECT, INSERT, UPDATE ON "${table}" TO wardenx_app`),
        );
        expect(rls).toMatch(new RegExp(`GRANT ALL ON "${table}" TO wardenx_admin`));
      }
      // No DELETE grant to wardenx_app anywhere, and no GRANT ALL ... TO wardenx_app.
      expect(rls).not.toMatch(/GRANT[^;]*\bDELETE\b[^;]*TO wardenx_app/i);
      expect(rls).not.toMatch(/GRANT ALL[^;]*TO wardenx_app/i);
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

    // ── PARTITIONED PHI tables: cross-tenant write is also blocked through the parent ────────────
    // A FOR ALL policy on the partitioned PARENT propagates to every leaf (PG11+), so org B cannot
    // UPDATE org A's PHI row even though the row exists in a shared current-month leaf — the UPDATE
    // matches zero rows under org B's predicate (RLS hides it; not an error).
    describe.each(PHI_PARTITIONED)(
      "%s — partitioned-parent policy hides cross-tenant rows",
      (table) => {
        it("org B's UPDATE of org A's PHI row matches zero rows (policy propagates to the leaf)", async () => {
          const id = a[COVERED.find((c) => c.table === table)!.key];
          // A no-op self-assignment on a column present on all four tables (not every partitioned PHI
          // table carries a `version` column) — what matters is the row count, not the SET expression.
          const res = await withOrg(ORG_B, () =>
            db.query(`UPDATE "${table}" SET organization_id = organization_id WHERE id = $1`, [id]),
          );
          expect(res.rowCount).toBe(0);
          // and org A still sees exactly its one row, unmutated by B's attempt
          const stillThere = await withOrg(ORG_A, () =>
            db.query(`SELECT count(*)::int AS n FROM "${table}" WHERE id = $1`, [id]),
          );
          expect(stillThere.rows[0].n).toBe(1);
        });
      },
    );

    // ── Cross-tenant WRITE rejection (WITH CHECK) ────────────────────────────────────────────────
    it("§3.5 org B cannot INSERT a qapi_program stamped with org A (WITH CHECK)", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO qapi_program (organization_id, provider_entity_id, plan_year, program_description, governing_body_roster)
             VALUES ($1, gen_random_uuid(), 2099, 'sneaky', '[]'::jsonb)`,
            [ORG_A],
          ),
        ),
      ).rejects.toThrow();
    });

    it("§3.5 org B cannot INSERT an incident_report stamped with org A (WITH CHECK, partitioned PHI)", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO incident_report
               (organization_id, provider_entity_id, kind, kind_data, occurred_at, reported_by_membership_id, severity)
             VALUES ($1, gen_random_uuid(), 'fall', '{}'::jsonb, now(), gen_random_uuid(), 'minor')`,
            [ORG_A],
          ),
        ),
      ).rejects.toThrow();
    });

    // ── §3.7 destruction-block: wardenx_app cannot DELETE M30 compliance evidence ────────────────
    // The request-scoped app role has no DELETE grant on ANY M30 table; the compliance-class
    // evidence tables are additionally never deletable even by the M4 eraseFn (the eraser package
    // REFUSES them). Here we prove the SQL-layer floor: wardenx_app DELETE → permission denied.
    describe.each(COMPLIANCE_EVIDENCE)(
      "%s — §3.7 destruction-blocked at the SQL layer",
      (table) => {
        it("wardenx_app cannot DELETE an own-org row (no DELETE grant)", async () => {
          const id = a[COVERED.find((c) => c.table === table)!.key];
          await expect(
            withOrg(ORG_A, () => db.query(`DELETE FROM "${table}" WHERE id = $1`, [id])),
          ).rejects.toThrow(/permission denied/i);
        });
      },
    );

    // ── GAP-088 / 0335: the closure CHECK distinguishes an attested close from a nominee close ──────
    // Runs on the superuser connection inside a transaction that is always rolled back (the CHECK is a
    // table constraint, independent of RLS). Each case is one UPDATE of org A's seeded row.
    describe.each([
      {
        table: "qapi_pip",
        key: "qapiPip" as const,
        slotA: "cosign_qapi_coordinator",
        slotB: "cosign_medical_director",
      },
      {
        table: "sra_cycle",
        key: "sraCycle" as const,
        slotA: "cosign_security_officer",
        slotB: "cosign_compliance_officer",
      },
    ])("$table — pending close + two-person close (0335/0701)", ({ table, key, slotA, slotB }) => {
      const M1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const M2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const closeWith = async (set: string): Promise<void> => {
        await db.query("BEGIN");
        try {
          await db.query(`UPDATE "${table}" SET closed_at = now(), ${set} WHERE id = $1`, [a[key]]);
        } finally {
          await db.query("ROLLBACK");
        }
      };
      const honest = (closer: string, nominee: string, closerSlot: string, nomineeSlot: string) =>
        `${closerSlot}_membership_id = '${closer}', ${closerSlot}_at = now(), ` +
        `${nomineeSlot}_membership_id = '${nominee}', ` +
        `closure_cosign_attested = false, closure_closed_by_membership_id = '${closer}', ` +
        `closure_nominee_membership_id = '${nominee}'`;

      it("defaults closure_cosign_attested to true so pre-existing rows keep 'both signed'", async () => {
        const { rows } = await db.query(
          `SELECT closure_cosign_attested AS v FROM "${table}" WHERE id = $1`,
          [a[key]],
        );
        expect(rows[0].v).toBe(true);
      });

      it("accepts an attested close with both slots stamped", async () => {
        await closeWith(
          `${slotA}_at = now(), ${slotA}_membership_id = '${M1}', ${slotB}_at = now(), ${slotB}_membership_id = '${M2}'`,
        );
      });

      // GAP-046 (0701): initiating leaves the row OPEN (closed_at NULL) with the nominee un-stamped; a CLOSED
      // row needs both slots stamped by two distinct members.
      const pendingWith = async (set: string): Promise<void> => {
        await db.query("BEGIN");
        try {
          await db.query(`UPDATE "${table}" SET ${set} WHERE id = $1`, [a[key]]);
        } finally {
          await db.query("ROLLBACK");
        }
      };

      it("accepts a PENDING close from either side (closer stamped, nominee _at NULL, closed_at NULL)", async () => {
        await pendingWith(honest(M1, M2, slotA, slotB));
        await pendingWith(honest(M2, M1, slotB, slotA));
      });

      it("rejects a nominee-only close: closed_at set while the nominee never stamped their slot", async () => {
        await expect(closeWith(honest(M1, M2, slotA, slotB))).rejects.toThrow(/check constraint/i);
        await expect(closeWith(honest(M2, M1, slotB, slotA))).rejects.toThrow(/check constraint/i);
      });

      it("rejects an attested close where both slots name the SAME member", async () => {
        await expect(
          closeWith(
            `${slotA}_at = now(), ${slotA}_membership_id = '${M1}', ${slotB}_at = now(), ${slotB}_membership_id = '${M1}'`,
          ),
        ).rejects.toThrow(/check constraint/i);
      });

      it("rejects a pending close whose closer slot is not stamped", async () => {
        await expect(
          pendingWith(
            `${slotA}_membership_id = '${M1}', ${slotB}_membership_id = '${M2}', ` +
              `closure_cosign_attested = false, closure_closed_by_membership_id = '${M1}', ` +
              `closure_nominee_membership_id = '${M2}'`,
          ),
        ).rejects.toThrow(/check constraint/i);
      });

      it("rejects an attested close with a missing slot stamp (old V-11/V-12 rule intact)", async () => {
        await expect(
          closeWith(`${slotA}_at = now(), ${slotA}_membership_id = '${M1}'`),
        ).rejects.toThrow(/check constraint/i);
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
        const r = await fresh.query("SELECT count(*)::int AS n FROM qapi_program WHERE id = $1", [
          a.qapiProgram,
        ]);
        expect(r.rows[0].n).toBe(0); // the wrong (legacy) variable grants no access
      } finally {
        await fresh.end();
      }
    });
  },
);
