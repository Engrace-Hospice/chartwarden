/**
 * M15 Discipline Care Plans — RLS cross-tenant denial: the LIVE Postgres proof (§3.7 / §9.3 / ADR-0010).
 *
 * The pure suites (apps/backend/__tests__/discipline-plans-*.test.ts, packages/discipline-plans) exercise the
 * §2.2 lifecycle, the 418.78 volunteer domain and the §4.1 authz composition, but they never touch a
 * database — so they cannot catch a wrong RLS predicate, a missing WITH CHECK, or a base-table grant that
 * leaks across tenants. This test applies the real migrations to a real Postgres and exercises the policies
 * as the unprivileged `chartwarden_app` role, proving cross-tenant denial for real on ALL 11 org-scoped M15
 * tables under the canonical `organization_id = current_setting('app.org_id')` ONE-SHAPE policy (ADR-0010
 * D3 — no second PERMISSIVE provider-entity policy; the PE/location narrowing the eight patient-bearing
 * tables carry is M3 ABAC at the handler, never a second policy that would OR rather than AND).
 *
 * `chartwarden_app` MUST be NOBYPASSRLS for any of this to mean anything: a role with BYPASSRLS satisfies every
 * assertion below vacuously. That is asserted first, before a single isolation case runs.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m15` (SUPERUSER to a THROWAWAY
 *     db; for a local PG without pgvector, set CHARTWARDEN_TEST_NO_PGVECTOR=1).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ROLES = [
  "chartwarden_app",
  "chartwarden_admin",
  "chartwarden_readonly",
  "chartwarden_audit_writer",
];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** A membership sentinel — M15 stores membership ids without a cross-module FK (M2 owns that table). */
const MEMBERSHIP = "00000000-0000-0000-0000-000000000000";

type SeedIds = {
  pe: string;
  location: string;
  plan: string;
  version: string;
  signature: string;
  goal: string;
  intervention: string;
  assessment: string;
  supervisoryVisit: string;
  assignment: string;
  gate: string;
  ledger: string;
  hourEntry: string;
  idgApplication: string;
};

/** The 11 manifest-owned M15 tables, each with the seeded row the isolation case looks for. */
const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "discipline_care_plan", key: "plan" },
  { table: "discipline_care_plan_version", key: "version" },
  { table: "discipline_care_plan_signature", key: "signature" },
  { table: "discipline_goal", key: "goal" },
  { table: "discipline_intervention", key: "intervention" },
  { table: "discipline_assessment", key: "assessment" },
  { table: "aide_supervisory_visit", key: "supervisoryVisit" },
  { table: "volunteer_assignment", key: "assignment" },
  { table: "volunteer_compliance_gate", key: "gate" },
  { table: "volunteer_hour_ledger", key: "ledger" },
  { table: "volunteer_hour_entry", key: "hourEntry" },
  // F-234 (0307) — the IDG-decision application record (its policy is in 0307, judged below).
  { table: "discipline_plan_idg_decision_application", key: "idgApplication" },
];

describe.skipIf(!DB_URL)(
  "M15 Discipline Care Plans — RLS cross-tenant denial — LIVE Postgres (§3.7)",
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

    /** Seed one full M15 chain for `org` as superuser (RLS + grants bypassed). `n` distinguishes the rows. */
    async function seedOrg(org: string, n: number): Promise<SeedIds> {
      const patient = `4444444${n}-4444-4444-4444-444444444444`;
      const admission = `5555555${n}-5555-5555-5555-555555555555`;
      const pe = (
        await db.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'00000${n}','PE','123456789${n}','enc','0930') RETURNING id`,
          [org],
        )
      ).rows[0].id as string;
      const location = (
        await db.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Main Office','1 Main St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [pe],
        )
      ).rows[0].id as string;
      const plan = (
        await db.query(
          `INSERT INTO discipline_care_plan (organization_id, patient_id, admission_id, provider_entity_id,
           location_id, kind, status, aide_membership_id, supervising_rn_membership_id, next_supervisory_due_at,
           initial_assessment_clock_started_at)
         VALUES ($1,$2,$3,$4,$5,'aide_poc','active',$6,$6, now() + interval '14 days', now()) RETURNING id`,
          [org, patient, admission, pe, location, MEMBERSHIP],
        )
      ).rows[0].id as string;
      const version = (
        await db.query(
          `INSERT INTO discipline_care_plan_version (organization_id, provider_entity_id, location_id, plan_id,
           sequence, status, kind, state_snapshot, required_signer_set, finalized_at)
         VALUES ($1,$2,$3,$4,1,'in_review','initial','{"goals":[]}'::jsonb,
           '[{"role":"rn_case_manager","count":1,"isAcknowledgment":false}]'::jsonb, now()) RETURNING id`,
          [org, pe, location, plan],
        )
      ).rows[0].id as string;
      const signature = (
        await db.query(
          `INSERT INTO discipline_care_plan_signature (organization_id, provider_entity_id, location_id,
           version_id, signer_membership_id, signer_role, attestation_text)
         VALUES ($1,$2,$3,$4,$5,'rn_case_manager','I attest to this plan of care.') RETURNING id`,
          [org, pe, location, version, MEMBERSHIP],
        )
      ).rows[0].id as string;
      const goal = (
        await db.query(
          `INSERT INTO discipline_goal (organization_id, provider_entity_id, location_id, plan_id, source,
           original_text, added_by_membership_id, added_by_discipline)
         VALUES ($1,$2,$3,$4,'clinical','Patient bathes with standby assist.',$5,'aide') RETURNING id`,
          [org, pe, location, plan, MEMBERSHIP],
        )
      ).rows[0].id as string;
      const intervention = (
        await db.query(
          `INSERT INTO discipline_intervention (organization_id, provider_entity_id, location_id, plan_id,
           scope_text, frequency_text, frequency_value, discipline, added_by_membership_id, added_by_discipline)
         VALUES ($1,$2,$3,$4,'Assist with bathing','three times weekly','3:visit:week','aide',$5,'aide')
         RETURNING id`,
          [org, pe, location, plan, MEMBERSHIP],
        )
      ).rows[0].id as string;
      const assessment = (
        await db.query(
          `INSERT INTO discipline_assessment (organization_id, provider_entity_id, location_id, plan_id, kind,
           status, captured_at, is_initial, data, captured_by_membership_id)
         VALUES ($1,$2,$3,$4,'aide_environmental','draft', now(), true, '{"notes":"home is safe"}'::jsonb,$5)
         RETURNING id`,
          [org, pe, location, plan, MEMBERSHIP],
        )
      ).rows[0].id as string;
      const supervisoryVisit = (
        await db.query(
          `INSERT INTO aide_supervisory_visit (organization_id, provider_entity_id, location_id, plan_id,
           aide_membership_id, supervising_rn_membership_id, supervisory_at, attestation_mode,
           aide_performance_satisfactory, supervisory_narrative, next_due_at, cadence_days_at_insert,
           captured_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,$5, now(),'aide_present', true,
           'Observed the aide provide personal care; technique and infection control were appropriate.',
           now() + interval '14 days', 14, $5) RETURNING id`,
          [org, pe, location, plan, MEMBERSHIP],
        )
      ).rows[0].id as string;
      const assignment = (
        await db.query(
          `INSERT INTO volunteer_assignment (organization_id, provider_entity_id, location_id, plan_id,
           volunteer_membership_id, coordinator_membership_id, activities, starts_at)
         VALUES ($1,$2,$3,$4,$5,$5,'["companionship"]'::jsonb, now()) RETURNING id`,
          [org, pe, location, plan, MEMBERSHIP],
        )
      ).rows[0].id as string;
      const gate = (
        await db.query(
          `INSERT INTO volunteer_compliance_gate (organization_id, volunteer_membership_id, gate_kind, status,
           valid_from, valid_until, recorded_by_membership_id)
         VALUES ($1,$2,'tb_screening','satisfied', now(), now() + interval '365 days', $2) RETURNING id`,
          [org, MEMBERSHIP],
        )
      ).rows[0].id as string;
      const ledger = (
        await db.query(
          `INSERT INTO volunteer_hour_ledger (organization_id, provider_entity_id, fiscal_year,
           total_volunteer_hour_minutes)
         VALUES ($1,$2,2026,600) RETURNING id`,
          [org, pe],
        )
      ).rows[0].id as string;
      const hourEntry = (
        await db.query(
          `INSERT INTO volunteer_hour_entry (organization_id, ledger_id, volunteer_membership_id, source,
           duration_minutes, occurred_at)
         VALUES ($1,$2,$3,'volunteer_admin_hours',120, now()) RETURNING id`,
          [org, ledger, MEMBERSHIP],
        )
      ).rows[0].id as string;
      const idgApplication = (
        await db.query(
          `INSERT INTO discipline_plan_idg_decision_application (organization_id, provider_entity_id,
           location_id, patient_id, plan_id, version_id, idg_decision_id, idg_meeting_id,
           source_outbox_event_id, status, mutations_applied)
         VALUES ($1,$2,$3,$4,$5,$6,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'applied',1)
         RETURNING id`,
          [org, pe, location, patient, plan, version],
        )
      ).rows[0].id as string;
      return {
        pe,
        location,
        plan,
        version,
        signature,
        goal,
        intervention,
        assessment,
        supervisoryVisit,
        assignment,
        gate,
        ledger,
        hourEntry,
        idgApplication,
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

    it("chartwarden_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
      const { rows } = await db.query<{ rolbypassrls: boolean }>(
        "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'chartwarden_app'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].rolbypassrls).toBe(false);
    });

    it("every M15 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
      const rls = readFileSync(
        join(MIGRATIONS_DIR, "0099_discipline_plans_m15_rls_audit_triggers.sql"),
        "utf8",
      );
      const policyBlocks = rls.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? [];
      expect(policyBlocks.length).toBe(11);
      // 0307 (F-234) adds one more tenant policy (the chartwarden_destruction one is a different role's).
      const applicationPolicy = (
        readFileSync(
          join(MIGRATIONS_DIR, "0307_m15_discipline_plan_idg_decision_application.sql"),
          "utf8",
        ).match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? []
      ).filter((b) => /TO (?:wardenx|chartwarden)_app/.test(b));
      expect(applicationPolicy).toHaveLength(1);
      for (const block of [...policyBlocks, ...applicationPolicy]) {
        const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((mm) => mm[1]);
        expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
        expect(block).not.toMatch(/pg_has_role/i);
        expect(block).not.toMatch(/IS NULL/i);
        // The PE narrowing the patient-bearing tables carry is ABAC at the handler, never a second pivot.
        expect(block).not.toMatch(/provider_entity_id\s*=/i);
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
        expect(seenByB.rows[0].n).toBe(0); // org B cannot read org A's row
      },
    );

    it("an UPDATE from the wrong tenant touches zero rows (not just an unreadable SELECT)", async () => {
      const res = await withOrg(ORG_B, () =>
        db.query("UPDATE discipline_goal SET measurable_outcome = 'tampered' WHERE id=$1", [
          a.goal,
        ]),
      );
      expect(res.rowCount).toBe(0);
      const check = await db.query("SELECT measurable_outcome FROM discipline_goal WHERE id=$1", [
        a.goal,
      ]);
      expect(check.rows[0].measurable_outcome).toBeNull();
    });

    it("GAP-045 (0329): one membership cannot fill a second signer slot of the same version", async () => {
      const { rows } = await db.query<{ provider_entity_id: string; location_id: string }>(
        "SELECT provider_entity_id, location_id FROM discipline_care_plan_signature WHERE id=$1",
        [a.signature],
      );
      const insertSecondSlot = (membership: string) =>
        withOrg(ORG_A, () =>
          db.query(
            `INSERT INTO discipline_care_plan_signature (organization_id, provider_entity_id, location_id,
             version_id, signer_membership_id, signer_role, attestation_text)
             SELECT organization_id, $2, $3, version_id, $4, 'msw', 'second slot'
               FROM discipline_care_plan_signature WHERE id=$1`,
            [a.signature, rows[0].provider_entity_id, rows[0].location_id, membership],
          ),
        );
      // the same membership as the seeded rn_case_manager signature, claiming a DIFFERENT role: refused.
      await expect(insertSecondSlot(MEMBERSHIP)).rejects.toMatchObject({
        code: "23505",
        constraint: "discipline_care_plan_signature_version_membership_uq",
      });
      // a different membership may fill the other slot.
      await expect(insertSecondSlot("99999999-9999-4999-8999-999999999999")).resolves.toBeDefined();
    });

    it("a WITH CHECK refuses an INSERT into another tenant's scope", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO volunteer_compliance_gate (organization_id, volunteer_membership_id, gate_kind, status,
             valid_from, recorded_by_membership_id)
           VALUES ($1,$2,'annual_ce','satisfied', now(), $2)`,
            [ORG_A, MEMBERSHIP], // B tries to write a row scoped to A
          ),
        ),
      ).rejects.toThrow();
    });

    it("chartwarden_app holds no DELETE on the M15 tables — destruction runs through the eraser (§8.5)", async () => {
      const { rows } = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.role_table_grants
       WHERE grantee='chartwarden_app' AND privilege_type='DELETE' AND table_name = ANY($1)`,
        [COVERED.map((c) => c.table)],
      );
      expect(rows.map((r) => r.table_name)).toEqual([]);
    });
  },
);
