/**
 * M37 Inpatient Unit (IPU) Management — RLS cross-tenant denial: the LIVE Postgres proof (§3.5/§3.6).
 *
 * The pure unit/domain suites never touch a database, so they cannot catch a wrong RLS predicate, a
 * missing WITH CHECK, or a base-table grant that leaks across tenants. This test applies the actual
 * migrations to a real Postgres and exercises the policies as the unprivileged `chartwarden_app` role (no
 * BYPASSRLS), proving cross-tenant denial for real on ALL 27 owned M37 tables under the canonical
 * `organization_id = current_setting('app.org_id')` predicate — including the four monthly-partitioned
 * tables (`ipu_admission_state_history`, `ipu_bed_cleaning_event`, `ipu_visitor`, `ipu_meal_service`):
 * the policy on the parent propagates to every partition incl. DEFAULT (PG11+). All 27 M37 tables are
 * tenant-scoped PHI/compliance data (0153's §1 comment; `ipu_rn_break_glass` joined in 0230) — unlike M26, there is no platform-shared table
 * to carve out here.
 *
 * Also ports the §3.6 (D11) audit-scrub assertion from the superseded partial suite
 * (apps/backend/__tests__/m37-ipu-rls-isolation.live.test.ts, now deleted): the restraint-event
 * free-text justification must never land in `audit_event` in the clear.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m37` (SUPERUSER to a
 *     THROWAWAY db; for a local PG without pgvector, set CHARTWARDEN_TEST_NO_PGVECTOR=1).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropLiveRoles } from "../../../../apps/backend/__tests__/_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

type SeedIds = {
  unit: string;
  room: string;
  bed: string;
  admission: string;
  admissionIrc: string;
  admissionArranged: string;
  bedAssignment: string;
  admissionTransition: string;
  gipCriteria: string;
  gipReassessment: string;
  ircEpisode: string;
  remoteEpisode: string;
  shift: string;
  staffAssignment: string;
  rnCoverageWindow: string;
  rnBreakGlass: string;
  ivSafetyOverlay: string;
  restraintEvent: string;
  restraintReassessment: string;
  visitorRestriction: string;
  equipment: string;
  equipmentMaintenance: string;
  equipmentInspection: string;
  bodyRelease: string;
  censusSnapshot: string;
  admissionStateHistory: string;
  bedCleaningEvent: string;
  visitor: string;
  mealService: string;
};

const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "inpatient_unit", key: "unit" },
  { table: "ipu_room", key: "room" },
  { table: "ipu_bed", key: "bed" },
  { table: "ipu_admission", key: "admission" },
  { table: "ipu_bed_assignment", key: "bedAssignment" },
  { table: "ipu_admission_transition", key: "admissionTransition" },
  { table: "gip_admission_criteria", key: "gipCriteria" },
  { table: "gip_criteria_reassessment", key: "gipReassessment" },
  { table: "irc_episode", key: "ircEpisode" },
  { table: "ipu_remote_inpatient_episode", key: "remoteEpisode" },
  { table: "ipu_shift", key: "shift" },
  { table: "ipu_staff_assignment", key: "staffAssignment" },
  { table: "ipu_rn_coverage_window", key: "rnCoverageWindow" },
  // GAP-170 — added by 0230 (after the 0153 sweep); a staffing override is a compliance trail.
  { table: "ipu_rn_break_glass", key: "rnBreakGlass" },
  { table: "ipu_iv_safety_overlay", key: "ivSafetyOverlay" },
  { table: "ipu_restraint_event", key: "restraintEvent" },
  { table: "ipu_restraint_reassessment", key: "restraintReassessment" },
  { table: "ipu_visitor_restriction", key: "visitorRestriction" },
  { table: "ipu_equipment", key: "equipment" },
  { table: "ipu_equipment_maintenance", key: "equipmentMaintenance" },
  { table: "ipu_equipment_inspection", key: "equipmentInspection" },
  { table: "ipu_body_release", key: "bodyRelease" },
  { table: "ipu_census_snapshot", key: "censusSnapshot" },
  { table: "ipu_admission_state_history", key: "admissionStateHistory" },
  { table: "ipu_bed_cleaning_event", key: "bedCleaningEvent" },
  { table: "ipu_visitor", key: "visitor" },
  { table: "ipu_meal_service", key: "mealService" },
];

describe.skipIf(!DB_URL)(
  "M37 IPU Management — RLS cross-tenant denial — LIVE Postgres (§3.5)",
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
      await dropLiveRoles(db);
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

    /** Seed one full M37 IPU chain for `org` as superuser (RLS + grants bypassed). `n` distinguishes rows. */
    async function seedOrg(org: string, n: number): Promise<SeedIds> {
      const facility = "44444444-4444-4444-4444-444444444444";
      const patient = "55555555-5555-5555-5555-555555555555";
      const remoteFacility = "66666666-6666-6666-6666-666666666666";

      const unit = (
        await db.query(
          `INSERT INTO inpatient_unit (organization_id,facility_id,display_name,bed_count)
         VALUES ($1,$2,$3,8) RETURNING id`,
          [org, facility, `Unit ${n}`],
        )
      ).rows[0].id as string;

      const room = (
        await db.query(
          `INSERT INTO ipu_room (organization_id,unit_id,room_number,kind,bed_count)
         VALUES ($1,$2,$3,'private',1) RETURNING id`,
          [org, unit, `10${n}`],
        )
      ).rows[0].id as string;

      const bed = (
        await db.query(
          `INSERT INTO ipu_bed (organization_id,room_id,unit_id,bed_label)
         VALUES ($1,$2,$3,'A') RETURNING id`,
          [org, room, unit],
        )
      ).rows[0].id as string;

      // Three admissions covering the three `kind`s the unit_xor_remote CHECK distinguishes.
      const admission = (
        await db.query(
          `INSERT INTO ipu_admission (organization_id,provider_entity_id,patient_id,admission_id,level_of_care_period_id,unit_id,kind,created_by)
         VALUES ($1,gen_random_uuid(),$2,gen_random_uuid(),gen_random_uuid(),$3,'gip',gen_random_uuid()) RETURNING id`,
          [org, patient, unit],
        )
      ).rows[0].id as string;

      const admissionIrc = (
        await db.query(
          `INSERT INTO ipu_admission (organization_id,provider_entity_id,patient_id,admission_id,level_of_care_period_id,unit_id,kind,created_by)
         VALUES ($1,gen_random_uuid(),$2,gen_random_uuid(),gen_random_uuid(),$3,'irc',gen_random_uuid()) RETURNING id`,
          [org, patient, unit],
        )
      ).rows[0].id as string;

      const admissionArranged = (
        await db.query(
          `INSERT INTO ipu_admission (organization_id,provider_entity_id,patient_id,admission_id,level_of_care_period_id,remote_facility_id,kind,created_by)
         VALUES ($1,gen_random_uuid(),$2,gen_random_uuid(),gen_random_uuid(),$3,'arranged',gen_random_uuid()) RETURNING id`,
          [org, patient, remoteFacility],
        )
      ).rows[0].id as string;

      const bedAssignment = (
        await db.query(
          `INSERT INTO ipu_bed_assignment (organization_id,ipu_admission_id,bed_id,assigned_by)
         VALUES ($1,$2,$3,gen_random_uuid()) RETURNING id`,
          [org, admission, bed],
        )
      ).rows[0].id as string;

      const admissionTransition = (
        await db.query(
          `INSERT INTO ipu_admission_transition (organization_id,ipu_admission_id,kind,initiated_by)
         VALUES ($1,$2,'to_home',gen_random_uuid()) RETURNING id`,
          [org, admission],
        )
      ).rows[0].id as string;

      const gipCriteria = (
        await db.query(
          `INSERT INTO gip_admission_criteria (organization_id,ipu_admission_id,criterion_kind,data,attesting_physician_id,attesting_membership_id,step_up_assertion_id)
         VALUES ($1,$2,'acute_symptom_management','{}'::jsonb,gen_random_uuid(),gen_random_uuid(),gen_random_uuid()) RETURNING id`,
          [org, admission],
        )
      ).rows[0].id as string;

      const gipReassessment = (
        await db.query(
          `INSERT INTO gip_criteria_reassessment (organization_id,gip_admission_criteria_id,ipu_admission_id,reassessed_by_membership_id,criterion_still_met,rationale)
         VALUES ($1,$2,$3,gen_random_uuid(),true,$4) RETURNING id`,
          [
            org,
            gipCriteria,
            admission,
            "Patient continues to require acute symptom management per IDG review of trends.".padEnd(
              60,
              " ",
            ),
          ],
        )
      ).rows[0].id as string;

      const ircEpisode = (
        await db.query(
          `INSERT INTO irc_episode (organization_id,ipu_admission_id,provider_entity_id,patient_id,expected_end_at)
         VALUES ($1,$2,gen_random_uuid(),$3,now() + interval '5 days') RETURNING id`,
          [org, admissionIrc, patient],
        )
      ).rows[0].id as string;

      const remoteEpisode = (
        await db.query(
          `INSERT INTO ipu_remote_inpatient_episode (organization_id,ipu_admission_id,provider_entity_id,patient_id,level_of_care_period_id,remote_facility_id,kind,started_at)
         VALUES ($1,$2,gen_random_uuid(),$3,gen_random_uuid(),$4,'gip',now()) RETURNING id`,
          [org, admissionArranged, patient, remoteFacility],
        )
      ).rows[0].id as string;

      const shift = (
        await db.query(
          `INSERT INTO ipu_shift (organization_id,unit_id,shift_start_at,shift_end_at,created_by)
         VALUES ($1,$2,now(),now() + interval '8 hours',gen_random_uuid()) RETURNING id`,
          [org, unit],
        )
      ).rows[0].id as string;

      const staffAssignment = (
        await db.query(
          `INSERT INTO ipu_staff_assignment (organization_id,shift_id,membership_id,role)
         VALUES ($1,$2,gen_random_uuid(),'rn') RETURNING id`,
          [org, shift],
        )
      ).rows[0].id as string;

      const rnCoverageWindow = (
        await db.query(
          `INSERT INTO ipu_rn_coverage_window (organization_id,unit_id,hour_start_at,is_covered,rn_assignment_ids)
         VALUES ($1,$2,date_trunc('hour', now()),true,ARRAY[gen_random_uuid()]::uuid[]) RETURNING id`,
          [org, unit],
        )
      ).rows[0].id as string;

      const rnBreakGlass = (
        await db.query(
          `INSERT INTO ipu_rn_break_glass (organization_id,unit_id,invoked_by_membership_id,expires_at,reason)
         VALUES ($1,$2,gen_random_uuid(),now() + interval '2 hours',$3) RETURNING id`,
          [org, unit, "Night shift RN call-outs left the unit below the 24-hour RN floor."],
        )
      ).rows[0].id as string;

      const ivSafetyOverlay = (
        await db.query(
          `INSERT INTO ipu_iv_safety_overlay (organization_id,ipu_admission_id,order_id,medication_rx_norm_code,rate_unit,bedside_check_interval_minutes)
         VALUES ($1,$2,gen_random_uuid(),'RX123','mL/hr',30) RETURNING id`,
          [org, admission],
        )
      ).rows[0].id as string;

      const restraintJustification = `SECRET-PHI-${"x".repeat(110)}`;
      const restraintEvent = (
        await db.query(
          `INSERT INTO ipu_restraint_event (organization_id,ipu_admission_id,restraint_kind,restraint_justification_text,ordering_physician_id,ordering_order_id,applied_by_membership_id,applied_step_up_assertion_id,reassessment_interval_minutes)
         VALUES ($1,$2,'soft_limb',$3,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),60) RETURNING id`,
          [org, admission, restraintJustification],
        )
      ).rows[0].id as string;

      const restraintReassessment = (
        await db.query(
          `INSERT INTO ipu_restraint_reassessment (organization_id,restraint_event_id,reassessed_by_membership_id,outcome,next_due_at)
         VALUES ($1,$2,gen_random_uuid(),'continue',now() + interval '2 hours') RETURNING id`,
          [org, restraintEvent],
        )
      ).rows[0].id as string;

      const visitorRestriction = (
        await db.query(
          `INSERT INTO ipu_visitor_restriction (organization_id,scope,unit_id,restriction_kind,rationale,applied_by,source_kind)
         VALUES ($1,'unit',$2,'mask_required','Seasonal infection-control precaution for the unit.',gen_random_uuid(),'manual') RETURNING id`,
          [org, unit],
        )
      ).rows[0].id as string;

      const equipment = (
        await db.query(
          `INSERT INTO ipu_equipment (organization_id,serial_number,equipment_type,manufacturer,model_number,current_unit_id)
         VALUES ($1,$2,'hospital_bed','Acme','M-100',$3) RETURNING id`,
          [org, `SN-${org}-${n}`, unit],
        )
      ).rows[0].id as string;

      const equipmentMaintenance = (
        await db.query(
          `INSERT INTO ipu_equipment_maintenance (organization_id,equipment_id,maintenance_kind,performed_by_membership_id)
         VALUES ($1,$2,'routine_service',gen_random_uuid()) RETURNING id`,
          [org, equipment],
        )
      ).rows[0].id as string;

      const equipmentInspection = (
        await db.query(
          `INSERT INTO ipu_equipment_inspection (organization_id,equipment_id,inspection_kind,inspector_membership_id,outcome,next_inspection_due_date)
         VALUES ($1,$2,'annual_biomed',gen_random_uuid(),'pass',(now() + interval '1 year')::date) RETURNING id`,
          [org, equipment],
        )
      ).rows[0].id as string;

      const bodyRelease = (
        await db.query(
          `INSERT INTO ipu_body_release (organization_id,ipu_admission_id,provider_entity_id,patient_id,death_event_id,pronouncing_physician_id,pronounced_at)
         VALUES ($1,$2,gen_random_uuid(),$3,gen_random_uuid(),gen_random_uuid(),now()) RETURNING id`,
          [org, admission, patient],
        )
      ).rows[0].id as string;

      const censusSnapshot = (
        await db.query(
          `INSERT INTO ipu_census_snapshot (organization_id,service_date,unit_id,provider_entity_id)
         VALUES ($1,current_date,$2,gen_random_uuid()) RETURNING id`,
          [org, unit],
        )
      ).rows[0].id as string;

      const admissionStateHistory = (
        await db.query(
          `INSERT INTO ipu_admission_state_history (organization_id,ipu_admission_id,to_state,by_membership_id)
         VALUES ($1,$2,'active',gen_random_uuid()) RETURNING id`,
          [org, admission],
        )
      ).rows[0].id as string;

      const bedCleaningEvent = (
        await db.query(
          `INSERT INTO ipu_bed_cleaning_event (organization_id,bed_id,to_status)
         VALUES ($1,$2,'ready') RETURNING id`,
          [org, bed],
        )
      ).rows[0].id as string;

      const visitor = (
        await db.query(
          `INSERT INTO ipu_visitor (organization_id,ipu_admission_id,visitor_name,relationship,screening_outcome,consent_evaluator_result,checked_in_by)
         VALUES ($1,$2,'Visitor One','friend','{}'::jsonb,'{}'::jsonb,gen_random_uuid()) RETURNING id`,
          [org, admission],
        )
      ).rows[0].id as string;

      const mealService = (
        await db.query(
          `INSERT INTO ipu_meal_service (organization_id,ipu_admission_id,service_date,meal_slot,recorded_by)
         VALUES ($1,$2,current_date,'breakfast',gen_random_uuid()) RETURNING id`,
          [org, admission],
        )
      ).rows[0].id as string;

      return {
        unit,
        room,
        bed,
        admission,
        admissionIrc,
        admissionArranged,
        bedAssignment,
        admissionTransition,
        gipCriteria,
        gipReassessment,
        ircEpisode,
        remoteEpisode,
        shift,
        staffAssignment,
        rnCoverageWindow,
        rnBreakGlass,
        ivSafetyOverlay,
        restraintEvent,
        restraintReassessment,
        visitorRestriction,
        equipment,
        equipmentMaintenance,
        equipmentInspection,
        bodyRelease,
        censusSnapshot,
        admissionStateHistory,
        bedCleaningEvent,
        visitor,
        mealService,
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
    // not theoretical.
    it("chartwarden_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
      const { rows } = await db.query<{ rolbypassrls: boolean }>(
        "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'chartwarden_app'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].rolbypassrls).toBe(false);
    });

    it("every M37 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
      const rls = readFileSync(join(MIGRATIONS_DIR, "0153_ipu_m37_rls_audit_triggers.sql"), "utf8");
      const policyBlocks = rls.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? [];
      expect(policyBlocks.length).toBe(26); // 0153 policies; the 27th table (0230) is covered by its own test below
      for (const block of policyBlocks) {
        const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((m) => m[1]);
        expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
        expect(block).not.toMatch(/pg_has_role/i);
        expect(block).not.toMatch(/IS NULL/i);
      }
    });

    it("COVERED lists every manifest-owned M37 table (no table escapes the cross-tenant proof)", () => {
      expect(COVERED.length).toBe(27);
      expect(new Set(COVERED.map((c) => c.table)).size).toBe(27);
    });

    it("ipu_rn_break_glass keeps its own tenant policy on app.org_id (0230)", () => {
      const bg = readFileSync(join(MIGRATIONS_DIR, "0230_m37_rn_break_glass.sql"), "utf8");
      const block =
        bg.match(/CREATE POLICY "ipu_rn_break_glass_org"[\s\S]*?WITH CHECK \([^;]*\)/)?.[0] ?? "";
      expect(block).toMatch(/current_setting\(\s*'app\.org_id'/);
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

    it("a WITH CHECK refuses an INSERT into another tenant's scope", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO inpatient_unit (organization_id,facility_id,display_name,bed_count)
           VALUES ($1,gen_random_uuid(),'Cross-tenant unit',4)`,
            [ORG_A], // B tries to write a row scoped to A
          ),
        ),
      ).rejects.toThrow();
    });

    // Ported from the superseded partial suite (apps/backend/__tests__/m37-ipu-rls-isolation.live.test.ts):
    // §3.6 (D11) requires the restraint-event free-text justification to be scrubbed out of audit_event.
    it("the restraint justification is scrubbed out of the audit log (§3.6 D11 denylist)", async () => {
      const secret = `SECRET-PHI-${"x".repeat(110)}`;
      const adm = (
        await withOrg(ORG_A, () =>
          db.query(
            `INSERT INTO ipu_admission (organization_id,provider_entity_id,patient_id,admission_id,level_of_care_period_id,unit_id,kind,created_by)
           VALUES ($1,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),$2,'gip',gen_random_uuid()) RETURNING id`,
            [ORG_A, a.unit],
          ),
        )
      ).rows[0].id;
      await withOrg(ORG_A, () =>
        db.query(
          `INSERT INTO ipu_restraint_event (organization_id,ipu_admission_id,restraint_kind,restraint_justification_text,ordering_physician_id,ordering_order_id,applied_by_membership_id,applied_step_up_assertion_id,reassessment_interval_minutes)
         VALUES ($1,$2,'soft_limb',$3,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),60)`,
          [ORG_A, adm, secret],
        ),
      );
      const after = (
        await db.query(
          "SELECT after FROM audit_event WHERE resource_kind='ipu_restraint_event' ORDER BY created_at DESC LIMIT 1",
        )
      ).rows[0]?.after;
      expect(after).toBeTruthy();
      // The column is present in the snapshot but its PHI value is replaced by the scrub sentinel.
      expect(after.restraint_justification_text).toBeDefined();
      expect(String(after.restraint_justification_text)).not.toContain("SECRET-PHI");
    });
  },
);
