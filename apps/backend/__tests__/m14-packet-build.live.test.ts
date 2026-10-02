/**
 * F-171 (#248) — LIVE Postgres proof of the M14 §2.2/§2.4/§7.1/§7.2 T-24h packet-build worker, built for
 * real in this pass (`apps/backend/src/modules/14-idg/jobs/{schedule-materialise,packet-build}.ts`).
 * Every prior investigation of the m14 `handlers-unbound` group (F-129/F-164/F-167/F-169) concluded this
 * worker had never been written in production — `jobs/index.ts` shipped exactly ONE cron
 * (`idg.review-clock-sweep`) and `buildPackets` only flipped meeting status, never inserted an
 * `idg_patient_packet` row. This proves both new crons end to end against a real, RLS-enforced database:
 *
 *   - `runScheduleMaterialiseCron` (§7.1 W-SCH-01): a fresh `idg_recurring_policy` gets real future
 *     `idg_meeting` rows, and a re-run is idempotent (no duplicate rows).
 *   - `runPacketBuildCron` (§7.2 W-PKT-01 / §4.9.1 `tminus-24h-build`): a meeting due within the T-24h
 *     window gets a REAL `idg_patient_packet` row for its included patient, built from real M5 (patient
 *     identity) / M6 (inclusion + current LOC, the new `idgPacketInclusionForOrg`/
 *     `idgCurrentLevelOfCareForOrg` org-explicit seams) / M7 (care-plan summary + terminal diagnosis + SUD
 *     flag, the new `idgPacketCarePlanContextForOrg` org-explicit seam) facts — never fabricated — and the
 *     meeting transitions `scheduled → packets_building → packets_ready`, emitting
 *     `m14.packets.build_started` / `m14.packet.render_requested` / `m14.packets.ready`.
 *   - §2.3 D9 inclusion: an ACTIVE admission at the meeting's location is included; a patient discharged
 *     within the 7-day post-discharge wrap-up window is included; a patient discharged 10 days ago is NOT.
 *   - Per-patient FAILURE ISOLATION (never fabricated data): a patient with no signed care-plan version is
 *     skipped with `m14.packets.build_failed_for_patient` while a sibling patient's packet still builds.
 *   - Cross-tenant isolation: org B's admission never appears in org A's meeting build.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… WARDENX_TEST_REDIS_URL=redis://localhost:PORT \
 *     bun run test:m14:packet-build:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { registerPlatformJob, withOrgContext } from "@wardenx/tenancy";
import { sql } from "drizzle-orm";
import IORedis from "ioredis";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { registerSeam } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { siteDisplayForOrg } from "../src/bootstrap/site-display-for-org";
import { membershipDisplayForOrg } from "../src/modules/02-identity/index";
import {
  createDrizzlePatientReaderStore,
  registerPatientSeams,
} from "../src/modules/05-patient/index";
import {
  idgCurrentLevelOfCareForOrg,
  idgHospitalEventsForOrg,
  idgPacketInclusionForOrg,
  idgRecertWindowsForOrg,
} from "../src/modules/06-admission/index";
import { idgPacketCarePlanContextForOrg } from "../src/modules/07-care-plan/index";
import {
  createDrizzleEncounterReaderStore,
  registerEncounterSeams,
} from "../src/modules/08-encounters/index";
import { idgHopeContextForOrg } from "../src/modules/10-hope/index";
import {
  M12_OUTBOX_EVENTS,
  idgMedicationHistoryForOrg,
  ingestMedicationHistoryPull,
} from "../src/modules/12-dosespot/index";
import { idgMissedDosesForOrg } from "../src/modules/13-emar/index";
import type { IdgWriteOutboxPort } from "../src/modules/14-idg/idg-route-service-db";
import {
  M14_OUTBOX_EVENTS,
  M14_PLATFORM_JOB_ID,
  runCarryForwardCron,
  runPacketBuildCron,
  runScheduleMaterialiseCron,
} from "../src/modules/14-idg/index";
import { recomputeCarryForwardCountsForMeeting } from "../src/modules/14-idg/jobs/carry-forward-count";
import { idgTriageCarePlanChangesForOrg } from "../src/modules/19-oncall/index";
import { idgQualityFlaggedEventsForOrg } from "../src/modules/30-quality/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const REDIS_URL = process.env.WARDENX_TEST_REDIS_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "wardenx_platform_live_test",
];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const ORG_C = "44444444-4444-4444-4444-444444444444"; // carry-forward tests: isolated so sibling tests' meetings/items never interfere
const MEMBER = "33333333-3333-3333-3333-33333333aaaa"; // idg tables carry no membership FK — literal is fine

function parseRedisUrl(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 6379) };
}

describe.skipIf(!DB_URL || !REDIS_URL)(
  "F-171 — M14's §2.2/§2.4/§7.1/§7.2 T-24h packet-build worker — LIVE Postgres + Valkey",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let redis: IORedis;
    let outbox: IdgWriteOutboxPort;
    const peOf: Record<string, string> = {};
    const locationOf: Record<string, string> = {};

    async function resetSchema() {
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const r of ROLES)
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
        );
    }
    async function applyMigrations() {
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort()) {
        await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
      }
    }

    async function seedOrgProviderLocation(orgId: string, slug: string): Promise<void> {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$3)",
        [orgId, slug, slug],
      );
      const pe = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [orgId, `CCN-${slug}`, `PE ${slug}`, `NPI-${slug}`],
        )
      ).rows[0].id as string;
      peOf[orgId] = pe;
      locationOf[orgId] = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [pe],
        )
      ).rows[0].id as string;
    }

    async function seedPatient(
      orgId: string,
      firstName = "Jane",
      lastName = "Doe",
    ): Promise<string> {
      const { rows } = await admin.query(
        `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
         VALUES ($1,$2,$3,$4,'1950-01-01','female','active') RETURNING id`,
        [orgId, `mrn-${Math.random().toString(36).slice(2)}`, firstName, lastName],
      );
      return rows[0].id as string;
    }

    /** A sited, ACTIVE-or-discharged admission with a real activatedAt. */
    async function seedAdmission(
      orgId: string,
      patientId: string,
      status: "active" | "discharged",
      activatedDaysAgo: number,
      dischargedDaysAgo?: number,
    ): Promise<string> {
      const { rows } = await admin.query(
        `INSERT INTO admission (organization_id, patient_id, provider_entity_id, location_id, status,
            admission_at, activated_at, discharged_at)
         VALUES ($1,$2,$3,$4,$5, now() - ($6 || ' days')::interval, now() - ($6 || ' days')::interval,
                 CASE WHEN $7::int IS NULL THEN NULL ELSE now() - ($7 || ' days')::interval END)
         RETURNING id`,
        [
          orgId,
          patientId,
          peOf[orgId],
          locationOf[orgId],
          status,
          activatedDaysAgo,
          dischargedDaysAgo ?? null,
        ],
      );
      return rows[0].id as string;
    }

    /** An `active` benefit period (sequence 2) ending in `endsInDays`: the NEXT period (3) needs a F2F whose
     *  CMS prior-to window is already open, and no attested F2F exists ⇒ cover `window_open`. */
    async function seedActiveBenefitPeriod(
      orgId: string,
      admissionId: string,
      endsInDays: number,
    ): Promise<void> {
      await admin.query(
        `INSERT INTO election_period (organization_id, admission_id, sequence_number, period_kind, effective_at,
            scheduled_end_at, status)
         VALUES ($1,$2,2,'sixty_day', current_date - 50, current_date + $3::int, 'active')`,
        [orgId, admissionId, endsInDays],
      );
    }

    async function seedLocPeriod(orgId: string, admissionId: string): Promise<void> {
      await admin.query(
        `INSERT INTO level_of_care_period (organization_id, admission_id, level_of_care, effective_at)
         VALUES ($1,$2,'routine_home_care', now() - interval '30 days')`,
        [orgId, admissionId],
      );
    }

    /** A fully signed, terminal-diagnosis-bearing care plan — the minimum a packet build needs to
     *  succeed for a patient. */
    async function seedSignedCarePlan(
      orgId: string,
      patientId: string,
      admissionId: string,
    ): Promise<void> {
      const { rows: planRows } = await admin.query(
        `INSERT INTO care_plan (organization_id, provider_entity_id, location_id, patient_id, admission_id,
            status, initial_due_at, initial_signed_at, next_review_due_at)
         VALUES ($1,$2,$3,$4,$5,'active', now() - interval '20 days', now() - interval '19 days',
                 now() + interval '10 days')
         RETURNING id`,
        [orgId, peOf[orgId], locationOf[orgId], patientId, admissionId],
      );
      const planId = planRows[0].id as string;
      await admin.query(
        `INSERT INTO care_plan_version (organization_id, provider_entity_id, location_id, care_plan_id,
            sequence, status, kind, required_signer_set, signed_at)
         VALUES ($1,$2,$3,$4,1,'signed','initial','[]'::jsonb, now() - interval '19 days')`,
        [orgId, peOf[orgId], locationOf[orgId], planId],
      );
      await admin.query(
        `INSERT INTO problem (organization_id, provider_entity_id, location_id, care_plan_id, icd10_code,
            description, kind, status, sud_related)
         VALUES ($1,$2,$3,$4,'C34.90','Malignant neoplasm of lung','terminal','active', false)`,
        [orgId, peOf[orgId], locationOf[orgId], planId],
      );
      await admin.query(
        `INSERT INTO goal (organization_id, provider_entity_id, location_id, care_plan_id, problem_id,
            original_text, source, measurable_outcome, status)
         SELECT $1,$2,$3,$4, p.id, 'Manage dyspnea', 'clinical', 'Patient reports comfort', 'in_progress'
         FROM problem p WHERE p.care_plan_id = $4 LIMIT 1`,
        [orgId, peOf[orgId], locationOf[orgId], planId],
      );
      await admin.query(
        `INSERT INTO intervention (organization_id, provider_entity_id, location_id, care_plan_id, problem_id,
            discipline, scope_text, frequency_text, frequency_value, status)
         SELECT $1,$2,$3,$4, p.id, 'rn', 'Symptom management visit', 'weekly', '1x/week', 'active'
         FROM problem p WHERE p.care_plan_id = $4 LIMIT 1`,
        [orgId, peOf[orgId], locationOf[orgId], planId],
      );
    }

    async function seedRecurringPolicy(orgId: string): Promise<string> {
      const { rows } = await admin.query(
        `INSERT INTO idg_recurring_policy (organization_id, location_id, cadence_days, day_of_week_anchor,
            start_time_local, duration_minutes, post_discharge_wrap_up_days, default_coordinator_membership_id, active)
         VALUES ($1,$2,14,'wednesday','09:00',120,7,$3,true) RETURNING id`,
        [orgId, locationOf[orgId], MEMBER],
      );
      return rows[0].id as string;
    }

    async function seedMeeting(
      orgId: string,
      status: string,
      hoursFromNow: number,
      recurringPolicyId?: string,
    ): Promise<string> {
      const { rows } = await admin.query(
        `INSERT INTO idg_meeting (organization_id, location_id, recurring_policy_id, scheduled_start,
            scheduled_end, status, coordinator_membership_id, tenant_quorum_snapshot)
         VALUES ($1,$2,$3, now() + ($4 || ' hours')::interval, now() + ($4 || ' hours')::interval + interval '2 hours',
                 $5,$6,'[]'::jsonb)
         RETURNING id`,
        [orgId, locationOf[orgId], recurringPolicyId ?? null, hoursFromNow, status, MEMBER],
      );
      return rows[0].id as string;
    }

    async function meetingStatus(id: string): Promise<string> {
      const { rows } = await admin.query("SELECT status FROM idg_meeting WHERE id=$1", [id]);
      return rows[0]?.status as string;
    }
    async function meetingCount(orgId: string, recurringPolicyId: string): Promise<number> {
      const { rows } = await admin.query(
        "SELECT count(*)::int AS n FROM idg_meeting WHERE organization_id=$1 AND recurring_policy_id=$2",
        [orgId, recurringPolicyId],
      );
      return rows[0].n as number;
    }
    async function eventsFor(aggregateId: string): Promise<string[]> {
      const { rows } = await admin.query(
        "SELECT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
        [aggregateId],
      );
      return rows.map((r) => r.event_type as string);
    }
    async function packetFor(meetingId: string, patientId: string) {
      const { rows } = await admin.query(
        `SELECT built_snapshot, discipline_views, cover_summary_layer1
           FROM idg_patient_packet WHERE idg_meeting_id=$1 AND patient_id=$2`,
        [meetingId, patientId],
      );
      return rows[0] ?? null;
    }

    function m6m7Ports() {
      return {
        m6: {
          inclusionForOrg: (
            organizationId: string,
            locationId: string,
            asOfIso: string,
            wrapUpDays: number,
          ) => idgPacketInclusionForOrg(handle.db, organizationId, locationId, asOfIso, wrapUpDays),
          currentLevelOfCareForOrg: (
            organizationId: string,
            admissionId: string,
            asOfIso: string,
          ) => idgCurrentLevelOfCareForOrg(handle.db, organizationId, admissionId, asOfIso),
        },
        m7: {
          carePlanContextForOrg: (organizationId: string, patientId: string, asOfIso: string) =>
            idgPacketCarePlanContextForOrg(handle.db, organizationId, patientId, asOfIso),
        },
        // §2.4 cover recert/F2F facts — the REAL M6 seam over the real wardenx_app connection.
        recertWindows: {
          recertWindowsForOrg: (
            organizationId: string,
            patientIds: readonly string[],
            asOfIso: string,
          ) => idgRecertWindowsForOrg(handle.db, organizationId, patientIds, new Date(asOfIso)),
        },
      };
    }

    /** §2.4 flagged-event sources + HOPE context — the REAL org-explicit seams over the wardenx_app connection. */
    function sectionPorts() {
      return {
        flaggedEventSources: [
          {
            source: "m6.hospital",
            flaggedEventsForOrg: (o: string, ids: readonly string[], since: string) =>
              idgHospitalEventsForOrg(handle.db, o, ids, since),
          },
          {
            source: "m13.missed_dose",
            flaggedEventsForOrg: (o: string, ids: readonly string[], since: string) =>
              idgMissedDosesForOrg(handle.db, o, ids, since),
          },
          {
            source: "m30.fall_infection",
            flaggedEventsForOrg: (o: string, ids: readonly string[], since: string) =>
              idgQualityFlaggedEventsForOrg(handle.db, o, ids, since),
          },
          // F-218 — M19's after-hours triage GIP proposals (`care_plan_change_indicated`), a seam pull.
          {
            source: "m19.triage_care_plan_change",
            flaggedEventsForOrg: (o: string, ids: readonly string[], since: string) =>
              idgTriageCarePlanChangesForOrg(handle.db, o, ids, since),
          },
        ],
        hope: {
          hopeContextForOrg: (o: string, ids: readonly string[]) =>
            idgHopeContextForOrg(handle.db, o, ids),
        },
      };
    }

    /** Seed every source the three §2.4 sections read, for one patient/admission (superuser inserts). */
    async function seedSectionSources(
      orgId: string,
      patientId: string,
      admissionId: string,
      otherMeetingId: string,
      thisMeetingId: string,
    ): Promise<void> {
      const pe = peOf[orgId];
      const loc = locationOf[orgId];
      // M6 — ADT-derived concurrent-hospital-admission windows: inpatient (open), ER (closed), outpatient (dropped).
      await admin.query(
        `INSERT INTO compliance_window (organization_id, admission_id, window_kind, severity, payload, starts_at,
            must_complete_by, status)
         VALUES ($1,$2,'concurrent_hospital_admission','info',
                 jsonb_build_object('patientClass','I','eventTimestamp',(now() - interval '5 days')::text),
                 now() - interval '4 days', now() + interval '3 days','open')`,
        [orgId, admissionId],
      );
      await admin.query(
        `INSERT INTO compliance_window (organization_id, admission_id, window_kind, severity, payload, starts_at,
            must_complete_by, status, closed_at, close_reason)
         VALUES ($1,$2,'concurrent_hospital_admission','info',
                 jsonb_build_object('patientClass','E','eventTimestamp',(now() - interval '8 days')::text),
                 now() - interval '8 days', now() - interval '5 days','closed', now() - interval '6 days','triaged'),
                ($1,$2,'concurrent_hospital_admission','info',
                 jsonb_build_object('patientClass','O','eventTimestamp',(now() - interval '9 days')::text),
                 now() - interval '9 days', now() - interval '5 days','closed', now() - interval '6 days','triaged')`,
        [orgId, admissionId],
      );
      // M13 — a sweep-detected controlled-substance miss (urgent) and a held dose (info); one BEFORE admission.
      await admin.query(
        `INSERT INTO missed_dose (organization_id, provider_entity_id, location_id, scheduled_dose_id, patient_id,
            admission_id, medication_order_id, detected_at, missed_kind, is_controlled_substance)
         VALUES ($1,$2,$3,gen_random_uuid(),$4,$5,gen_random_uuid(), now() - interval '2 days','detected_by_sweep',true),
                ($1,$2,$3,gen_random_uuid(),$4,$5,gen_random_uuid(), now() - interval '3 days','intentionally_held',false),
                ($1,$2,$3,gen_random_uuid(),$4,$5,gen_random_uuid(), now() - interval '120 days','detected_by_sweep',false)`,
        [orgId, pe, loc, patientId, admissionId],
      );
      // M30 — a severe fall, a fall from before the admission (cursor-excluded), a non-fall incident, an infection.
      await admin.query(
        `INSERT INTO incident_report (organization_id, provider_entity_id, location_id, kind, kind_data, patient_id,
            occurred_at, reported_by_membership_id, severity)
         VALUES ($1,$2,$3,'fall','{"narrativeText":"free text must not cross"}'::jsonb,$4, now() - interval '6 days',$5,'severe'),
                ($1,$2,$3,'fall','{}'::jsonb,$4, now() - interval '100 days',$5,'minor'),
                ($1,$2,$3,'complaint','{}'::jsonb,$4, now() - interval '6 days',$5,'minor')`,
        [orgId, pe, loc, patientId, MEMBER],
      );
      await admin.query(
        `INSERT INTO infection_surveillance_event (organization_id, provider_entity_id, location_id, patient_id,
            observed_at, pathogen, body_site, transmission_context, filed_by_membership_id)
         VALUES ($1,$2,$3,$4, now() - interval '7 days','MRSA','wound','community',$5)`,
        [orgId, pe, loc, patientId, MEMBER],
      );
      // M19 (F-218) — an after-hours triage call that proposed a GIP admission 3 days ago (counts), one from
      // before the admission cursor (does not), and a non-GIP disposition (does not). The free-text criteria
      // summary must never reach the snapshot.
      const tUser = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `m19-${randomUUID()}@x.test`,
        ])
      ).rows[0].id as string;
      const tMember = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [tUser, orgId],
        )
      ).rows[0].id as string;
      const tShift = (
        await admin.query(
          `INSERT INTO on_call_shift (organization_id, provider_entity_id, shift_starts_at, shift_ends_at,
             discipline, primary_on_call_membership_id, policy_snapshot, status, opened_at)
           VALUES ($1,$2, now() - interval '200 days', now() - interval '199 days','clinical_rn',$3,'{}'::jsonb,'active', now() - interval '200 days')
           RETURNING id`,
          [orgId, pe, tMember],
        )
      ).rows[0].id as string;
      const gipData = JSON.stringify({
        disposition: "gip_admission_proposed",
        gipCriteriaSummary: "triage free text must not cross",
        preferredFacility: null,
      });
      for (const [agoDays, disposition, data] of [
        [3, "gip_admission_proposed", gipData],
        [100, "gip_admission_proposed", gipData],
        [3, "visit_dispatched_now", null],
      ] as const) {
        const call = (
          await admin.query(
            `INSERT INTO triage_call (organization_id, provider_entity_id, on_call_shift_id, patient_id, caller_kind,
               inbound_channel, source, state, disposition, disposition_data, opened_at)
             VALUES ($1,$2,$3,$4,'caregiver','phone','manual','documented_pending_encounter',$5,$6, now() - ($7 || ' days')::interval)
             RETURNING id`,
            [orgId, pe, tShift, patientId, disposition, data, String(agoDays)],
          )
        ).rows[0].id as string;
        await admin.query(
          `INSERT INTO triage_call_state_history (organization_id, provider_entity_id, triage_call_id, from_state,
             to_state, transitioned_at, system_actor)
           VALUES ($1,$2,$3,'disposition_pending','documented_pending_encounter', now() - ($4 || ' days')::interval, true)`,
          [orgId, pe, call, String(agoDays)],
        );
      }
      // M10 — two open windows (HUV1 due in 10d, HUV2 in 40d), a completed admission RFA, and three SFVs.
      await admin.query(
        `INSERT INTO hope_timepoint_schedule (organization_id, provider_entity_id, location_id, patient_id,
            admission_id, rfa_kind, window_opens_at, window_closes_at, late_deadline_at, alert_cadence, status,
            generated_by)
         VALUES ($1,$2,$3,$4,$5,'03_huv2', now()+interval '30 days', now()+interval '40 days', now()+interval '45 days','{}'::jsonb,'open','auto_admission'),
                ($1,$2,$3,$4,$5,'02_huv1', now()+interval '1 day',  now()+interval '10 days', now()+interval '15 days','{}'::jsonb,'open','auto_admission'),
                ($1,$2,$3,$4,$5,'01_admission', now()-interval '39 days', now()-interval '35 days', now()-interval '30 days','{}'::jsonb,'completed','auto_admission')`,
        [orgId, pe, loc, patientId, admissionId],
      );
      await admin.query(
        `INSERT INTO symptom_follow_up_visit (organization_id, provider_entity_id, location_id, patient_id,
            admission_id, triggering_assessment_id, triggered_at, due_at, status, alert_cadence)
         VALUES ($1,$2,$3,$4,$5,gen_random_uuid(), now()-interval '1 day', now()+interval '1 day','open','{}'::jsonb),
                ($1,$2,$3,$4,$5,gen_random_uuid(), now()-interval '6 days', now()-interval '4 days','overdue','{}'::jsonb),
                ($1,$2,$3,$4,$5,gen_random_uuid(), now()-interval '20 days', now()-interval '18 days','completed','{}'::jsonb)`,
        [orgId, pe, loc, patientId, admissionId],
      );
      // M14 — action items: overdue+open (carried 2x), overdue+in_progress, overdue+completed, not yet due, no due
      // date, and an overdue one belonging to THIS meeting (never "carried" into its own packet).
      await admin.query(
        `INSERT INTO idg_action_item (organization_id, provider_entity_id, location_id, idg_meeting_id, patient_id,
            assigned_to_membership_id, title, due_date, status, meeting_carry_forward_count)
         VALUES ($1,$2,$3,$4,$5,$6,'overdue open', now()-interval '10 days','open',2),
                ($1,$2,$3,$4,$5,$6,'overdue in progress', now()-interval '3 days','in_progress',0),
                ($1,$2,$3,$4,$5,$6,'done', now()-interval '10 days','completed',0),
                ($1,$2,$3,$4,$5,$6,'future', now()+interval '5 days','open',0),
                ($1,$2,$3,$4,$5,$6,'undated', NULL,'open',0),
                ($1,$2,$3,$7,$5,$6,'same meeting', now()-interval '10 days','open',0)`,
        [orgId, pe, loc, otherMeetingId, patientId, MEMBER, thisMeetingId],
      );
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await seedOrgProviderLocation(ORG_A, "org-a");
      await seedOrgProviderLocation(ORG_B, "org-b");
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
      const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M14_OUTBOX_EVENTS]));
      outbox = {
        publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m14" }),
      };
      registerPatientSeams({ readerStore: createDrizzlePatientReaderStore(handle.db) });
      registerEncounterSeams({ store: createDrizzleEncounterReaderStore(handle.db) });
      const { host, port } = parseRedisUrl(REDIS_URL as string);
      redis = new IORedis({ host, port, maxRetriesPerRequest: null });
      await redis.flushdb();
    }, 120_000);

    afterAll(async () => {
      await redis?.quit();
      await handle?.close();
      if (admin) await admin.end();
    });

    it("idg.schedule-materialise creates real future meetings from a policy, idempotent on re-run", async () => {
      const policyId = await seedRecurringPolicy(ORG_A);
      const deps = {
        db: handle.db,
        outbox,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        locationTimezone: {
          locationTimezone: async () => "America/Los_Angeles",
        },
      };
      await runScheduleMaterialiseCron(deps);
      const first = await meetingCount(ORG_A, policyId);
      expect(first).toBeGreaterThan(0);
      expect(await eventsFor(policyId)).toContain("m14.schedule.materialised");

      // Re-run: the window is already full — no duplicate rows.
      await runScheduleMaterialiseCron(deps);
      const second = await meetingCount(ORG_A, policyId);
      expect(second).toBe(first);
    });

    it("idg.packets-cron builds a REAL packet for an included active-caseload patient from real M5/M6/M7 " +
      "facts, transitions the meeting, and emits the §4.4 events", async () => {
      const patientId = await seedPatient(ORG_A, "Ann", "Smith");
      const admissionId = await seedAdmission(ORG_A, patientId, "active", 40);
      await seedLocPeriod(ORG_A, admissionId);
      await seedActiveBenefitPeriod(ORG_A, admissionId, 10);
      await seedSignedCarePlan(ORG_A, patientId, admissionId);
      const meetingId = await seedMeeting(ORG_A, "scheduled", 12); // 12h from now — inside the 24h window

      const deps = {
        db: handle.db,
        outbox,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        redis,
        ...m6m7Ports(),
      };
      await runPacketBuildCron(deps);

      expect(await meetingStatus(meetingId)).toBe("packets_ready");
      expect(await eventsFor(meetingId)).toEqual(
        expect.arrayContaining(["m14.packets.build_started", "m14.packets.ready"]),
      );

      const pkt = await packetFor(meetingId, patientId);
      expect(pkt).not.toBeNull();
      const snapshot = pkt.built_snapshot as Record<string, unknown>;
      expect(snapshot.schemaVersion).toBe("2026-01-v1");
      const meta = snapshot.meta as Record<string, unknown>;
      expect(meta.sinceContext).toBe("first_idg"); // no prior IDG for this patient
      const cover = snapshot.patientCover as Record<string, unknown>;
      expect(cover.fullNameRedacted).toBe("Ann S.");
      expect(cover.primaryDiagnosisIcd10).toBe("C34.90");
      expect(cover.levelOfCare).toBe("routine");
      expect(cover.activeSudFlag).toBe(false);
      // §2.4 recert/F2F cover facts, snapshotted at freeze from M6's own window math via the real seam:
      // period 2 ends in 10 days ⇒ next period (3) starts in 11 days, F2F required, window already open.
      expect(cover.f2fWindowState).toBe("window_open");
      expect(cover.nextRecertDueAt).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
      const carePlanSummary = snapshot.carePlanSummary as Record<string, unknown>;
      expect(carePlanSummary.activeProblemCount).toBe(1);
      expect(carePlanSummary.activeGoalCount).toBe(1);
      expect(carePlanSummary.activeInterventionCount).toBe(1);
      expect(carePlanSummary.isReviewOverdue).toBe(false);
      expect(pkt.cover_summary_layer1).toEqual(expect.any(String));
      expect((pkt.cover_summary_layer1 as string).length).toBeGreaterThan(0);

      // The M22 render handshake carries the built content, not an empty shell.
      const { rows: renderRows } = await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type='m14.packet.render_requested' AND payload->>'patientId'=$1 AND payload->>'meetingId'=$2",
        [patientId, meetingId],
      );
      expect(renderRows).toHaveLength(1);
      expect(renderRows[0].payload.renderPayload.snapshot.meta.patientId).toBe(patientId);
    });

    it("F-230: the packet's `medicationHistory` slot carries M12's REAL ingest state — " +
      "available / none_available / not_pulled — and is `null` (not captured) when the seam is unbound", async () => {
      const withHistory = await seedPatient(ORG_A, "Hist", "Available");
      const zeroEntries = await seedPatient(ORG_A, "Zero", "Entries");
      const neverPulled = await seedPatient(ORG_A, "Never", "Pulled");
      for (const p of [withHistory, zeroEntries, neverPulled]) {
        const adm = await seedAdmission(ORG_A, p, "active", 40);
        await seedLocPeriod(ORG_A, adm);
        await seedActiveBenefitPeriod(ORG_A, adm, 10);
        await seedSignedCarePlan(ORG_A, p, adm);
      }
      // Real M12 ingests (the vendor-side result is the only input; persistence + publisher are real).
      const m12Publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M12_OUTBOX_EVENTS]));
      const m12Outbox = {
        publish: (tx: unknown, e: Record<string, unknown>) =>
          m12Publisher.publish(tx as never, { ...(e as object), callerModule: "m12" } as never),
      } as never;
      const ingest = (patientId: string, n: number) =>
        withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
          ingestMedicationHistoryPull(tx as never, m12Outbox, {
            organizationId: ORG_A,
            patientId,
            dosespotPatientId: "ds-x",
            sourceJobId: randomUUID(),
            result: {
              pulledAt: "2026-09-29T12:00:00.000Z",
              items: Array.from({ length: n }, (_, i) => ({
                rxnormRxcui: String(i),
                drugName: `Drug ${i}`,
                lastFillDate: null,
                sourcePharmacy: null,
              })),
            },
          }),
        );
      await ingest(withHistory, 3);
      await ingest(zeroEntries, 0);

      const meetingId = await seedMeeting(ORG_A, "scheduled", 12);
      await runPacketBuildCron({
        db: handle.db,
        outbox,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        redis,
        ...m6m7Ports(),
        // exactly how apps/backend/src/index.ts binds it
        medicationHistory: {
          medicationHistoryForOrg: (organizationId, patientIds) =>
            idgMedicationHistoryForOrg(handle.db, organizationId, patientIds),
        },
      });
      const slot = async (pid: string) =>
        ((await packetFor(meetingId, pid))?.built_snapshot as Record<string, unknown>)
          ?.medicationHistory;
      expect(await slot(withHistory)).toEqual({
        state: "available",
        recordCount: 3,
        lastPulledAt: "2026-09-29T12:00:00.000Z",
      });
      expect(await slot(zeroEntries)).toEqual({
        state: "none_available",
        recordCount: 0,
        lastPulledAt: "2026-09-29T12:00:00.000Z",
      });
      // never pulled is NOT "no external history" — that claim needs a pull that actually returned zero.
      expect(await slot(neverPulled)).toEqual({
        state: "not_pulled",
        recordCount: 0,
        lastPulledAt: null,
      });

      // A second meeting built WITHOUT the port: the slot is `null` (not captured), never a fabricated state.
      const meeting2 = await seedMeeting(ORG_A, "scheduled", 13);
      await runPacketBuildCron({
        db: handle.db,
        outbox,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        redis,
        ...m6m7Ports(),
      });
      const pkt2 = await packetFor(meeting2, withHistory);
      expect(pkt2).not.toBeNull();
      expect((pkt2.built_snapshot as Record<string, unknown>).medicationHistory).toBeNull();
    });

    it("§2.3 D9: a patient discharged within the 7-day wrap-up is included; one discharged 10 days ago is not", async () => {
      const wrappedPatient = await seedPatient(ORG_A, "Wrap", "Included");
      const wrappedAdmission = await seedAdmission(ORG_A, wrappedPatient, "discharged", 60, 3);
      await seedLocPeriod(ORG_A, wrappedAdmission);
      await seedSignedCarePlan(ORG_A, wrappedPatient, wrappedAdmission);

      const staleePatient = await seedPatient(ORG_A, "Stale", "Excluded");
      const staleAdmission = await seedAdmission(ORG_A, staleePatient, "discharged", 60, 10);
      await seedLocPeriod(ORG_A, staleAdmission);
      await seedSignedCarePlan(ORG_A, staleePatient, staleAdmission);

      const meetingId = await seedMeeting(ORG_A, "scheduled", 6);
      const deps = {
        db: handle.db,
        outbox,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        redis,
        ...m6m7Ports(),
      };
      await runPacketBuildCron(deps);

      expect(await packetFor(meetingId, wrappedPatient)).not.toBeNull();
      expect(await packetFor(meetingId, staleePatient)).toBeNull();
    });

    it("per-patient failure isolation: a patient with no signed care plan is skipped with " +
      "build_failed_for_patient while a sibling patient's packet still builds", async () => {
      const goodPatient = await seedPatient(ORG_A, "Good", "Plan");
      const goodAdmission = await seedAdmission(ORG_A, goodPatient, "active", 20);
      await seedLocPeriod(ORG_A, goodAdmission);
      await seedSignedCarePlan(ORG_A, goodPatient, goodAdmission);

      const badPatient = await seedPatient(ORG_A, "No", "Plan");
      await seedAdmission(ORG_A, badPatient, "active", 20); // no care plan at all

      const meetingId = await seedMeeting(ORG_A, "scheduled", 3);
      const deps = {
        db: handle.db,
        outbox,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        redis,
        ...m6m7Ports(),
      };
      await runPacketBuildCron(deps);

      expect(await packetFor(meetingId, goodPatient)).not.toBeNull();
      expect(await packetFor(meetingId, badPatient)).toBeNull();
      expect(await meetingStatus(meetingId)).toBe("packets_ready");

      const { rows } = await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type='m14.packets.build_failed_for_patient' AND payload->>'patientId'=$1",
        [badPatient],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toMatchObject({
        meetingId,
        patientId: badPatient,
        reason: "no_care_plan",
        // The meeting flips to packets_ready anyway, so the next tick does NOT retry — recovery is the coordinator's
        // on-demand rebuild. `willRetry: true` here was a false claim (it fed M36/M33 a promise nobody keeps).
        willRetry: false,
      });

      // Not asserted as exactly 1: ORG_A's shared location accumulates other active/wrap-up-included
      // admissions from EARLIER `it` blocks in this suite (real §2.3 D9 behavior, not a fixture bug —
      // each prior test's patient genuinely is still "active" at this location) — the meaningful,
      // isolated proof is the presence/absence assertions above (bad patient excluded, good included)
      // plus the failure event itself.
      const { rows: readyRows } = await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type='m14.packets.ready' AND aggregate_id=$1",
        [meetingId],
      );
      expect(readyRows[0].payload.builtPacketCount).toBeGreaterThanOrEqual(1);
      // the M36 T-24h reminder consumer's inputs (it derives the expected attendees from the location itself)
      expect(readyRows[0].payload.locationId).toEqual(expect.any(String));
      expect(readyRows[0].payload.scheduledStart).toEqual(expect.any(String));
      expect(readyRows[0].payload.coordinatorMembershipId).toEqual(expect.any(String));
    });

    it("active-org enumeration: the TENANT pool (wardenx_app) sees ZERO orgs under `organization` RLS; the PLATFORM pool " +
      "sees them — and the cron fed by the platform-bound enumerator actually builds", async () => {
      // A BYPASSRLS login with SELECT on `organization` only — the shape of `wardenx_platform_login` (the real role
      // is created out-of-band by ops, so the suite stands up its own stand-in of the same privilege class).
      await admin.query(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wardenx_platform_live_test') THEN
           CREATE ROLE wardenx_platform_live_test LOGIN BYPASSRLS PASSWORD 'platform_live_test'; END IF; END $$;`,
      );
      await admin.query("GRANT USAGE ON SCHEMA public TO wardenx_platform_live_test");
      await admin.query("GRANT SELECT ON organization TO wardenx_platform_live_test");
      await admin.query("UPDATE organization SET status='active' WHERE id IN ($1,$2)", [
        ORG_A,
        ORG_B,
      ]);
      const platformUrl = new URL(DB_URL as string);
      platformUrl.username = "wardenx_platform_live_test";
      platformUrl.password = "platform_live_test";
      const platformHandle = createDbClient({ connectionString: platformUrl.toString() });
      try {
        registerPlatformJob(M14_PLATFORM_JOB_ID);
        const enumeratorOn = (db: typeof handle.db | undefined) =>
          buildActiveOrgEnumerator({
            platformDb: db,
            auditBypass: async () => {}, // audit_event write is covered by platform-bypass-auditor.test.ts
            jobId: M14_PLATFORM_JOB_ID,
            reason: "live: m14 enumerator pool proof",
          });

        // The defect: bound to the tenant pool, `organization` RLS hides every row -> zero orgs, cron builds nothing.
        expect(await enumeratorOn(handle.db).listActiveOrgs()).toEqual([]);
        // The fix: the platform pool enumerates both seeded active orgs.
        const ids = (await enumeratorOn(platformHandle.db).listActiveOrgs()).map(
          (o) => o.organizationId,
        );
        expect(ids).toEqual(expect.arrayContaining([ORG_A, ORG_B]));
        // Not bound at all -> loud, never a silent empty list.
        await expect(enumeratorOn(undefined).listActiveOrgs()).rejects.toThrow(
          /DATABASE_PLATFORM_URL/,
        );

        // End-to-end: the cron with the REAL platform-bound enumerator (tenant pool for the org-scoped work).
        const patient = await seedPatient(ORG_A, "Enum", "Proof");
        const admission = await seedAdmission(ORG_A, patient, "active", 10);
        await seedLocPeriod(ORG_A, admission);
        await seedSignedCarePlan(ORG_A, patient, admission);
        const meetingId = await seedMeeting(ORG_A, "scheduled", 1);
        await runPacketBuildCron({
          db: handle.db,
          outbox,
          activeOrgs: enumeratorOn(platformHandle.db),
          redis,
          ...m6m7Ports(),
        });
        expect(await packetFor(meetingId, patient)).not.toBeNull();
        expect(await meetingStatus(meetingId)).toBe("packets_ready");
      } finally {
        await platformHandle.close();
      }
    });

    it("builds flaggedEvents (M6/M13/M30), hopeContext (M10) and carryForwardActionItems (M14) from REAL rows, " +
      "under RLS, with the cursor + status filters applied", async () => {
      const patientId = await seedPatient(ORG_A, "Sec", "Tions");
      const admissionId = await seedAdmission(ORG_A, patientId, "active", 40);
      await seedLocPeriod(ORG_A, admissionId);
      await seedSignedCarePlan(ORG_A, patientId, admissionId);
      const otherMeetingId = await seedMeeting(ORG_A, "scheduled", 900); // outside the 24h lookahead: never built here
      const meetingId = await seedMeeting(ORG_A, "scheduled", 2);
      await seedSectionSources(ORG_A, patientId, admissionId, otherMeetingId, meetingId);

      await runPacketBuildCron({
        db: handle.db,
        outbox,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        redis,
        ...m6m7Ports(),
        ...sectionPorts(),
      });

      const pkt = await packetFor(meetingId, patientId);
      expect(pkt).not.toBeNull();
      const snap = pkt.built_snapshot as {
        sinceLastIdg: { flaggedEvents: { kind: string; severity: string; sourceId: string }[] };
        hopeContext: {
          upcomingTimepoints: { timepoint: string; dueAt: string }[];
          openSfvCount: number;
        } | null;
        carryForwardActionItems: {
          actionItemId: string;
          carryForwardCount: number;
          assignedToMembershipId: string;
        }[];
        flagsForDiscussion: { kind: string }[];
      };

      // flaggedEvents: hospitalisation (I), er_visit (E, closed window still counts), 2 missed doses (the 120-day-old
      // one predates the admission cursor), the severe fall (the 100-day-old one and the complaint are out), infection.
      // The outpatient (`O`) window is not a hospitalisation.
      const flagged = snap.sinceLastIdg.flaggedEvents;
      expect(flagged.map((f) => f.kind).sort()).toEqual(
        [
          "er_visit",
          "fall",
          "hospitalisation",
          "infection",
          "missed_dose",
          "missed_dose",
          "triage_care_plan_change",
        ].sort(),
      );
      const bySev = (k: string) =>
        flagged
          .filter((f) => f.kind === k)
          .map((f) => f.severity)
          .sort();
      expect(bySev("missed_dose")).toEqual(["info", "urgent"]);
      expect(bySev("fall")).toEqual(["urgent"]);
      expect(bySev("infection")).toEqual(["attention"]);
      expect(bySev("triage_care_plan_change")).toEqual(["attention"]); // only the in-window GIP proposal
      expect(JSON.stringify(snap)).not.toContain("free text must not cross");
      expect(JSON.stringify(snap)).not.toContain("triage free text must not cross");
      // The hospital event derives the §2.4 level-of-care-candidate discussion flag.
      expect(snap.flagsForDiscussion.map((f) => f.kind)).toContain("level_of_care_candidate");

      // hopeContext: open windows only (sorted by due), the completed RFA absent; SFV count = open + overdue.
      expect(snap.hopeContext?.upcomingTimepoints.map((t) => t.timepoint)).toEqual([
        "02_huv1",
        "03_huv2",
      ]);
      expect(snap.hopeContext?.openSfvCount).toBe(2);

      // carry-forward: only the two overdue, open/in_progress items from the OTHER meeting; stored counts.
      expect(snap.carryForwardActionItems.map((c) => c.carryForwardCount).sort()).toEqual([0, 2]);
      expect(snap.carryForwardActionItems.every((c) => c.assignedToMembershipId === MEMBER)).toBe(
        true,
      );
      expect(pkt.cover_summary_layer1).toContain("2 carried-forward action item(s)");
    });

    it("render payload NAMES: org/location header + named carry-forward assignees come from the REAL org-explicit " +
      "seams (as wardenx_app), ride the render payload ONLY (never built_snapshot), are tenant-scoped, and degrade", async () => {
      const assignee = "5a5a5a5a-0000-4000-8000-0000000000a1";
      const assigneeB = "5a5a5a5a-0000-4000-8000-0000000000b1";
      await admin.query(
        `INSERT INTO "user" (id,email,name) VALUES ($1,'dana@x.test','Dana Reyes'),($2,'bee@x.test','Bee Tenant')`,
        ["6b6b6b6b-0000-4000-8000-0000000000a1", "6b6b6b6b-0000-4000-8000-0000000000b1"],
      );
      await admin.query(
        `INSERT INTO membership (id,user_id,organization_id,status) VALUES ($1,$2,$3,'active'),($4,$5,$6,'active')`,
        [
          assignee,
          "6b6b6b6b-0000-4000-8000-0000000000a1",
          ORG_A,
          assigneeB,
          "6b6b6b6b-0000-4000-8000-0000000000b1",
          ORG_B,
        ],
      );
      const patientId = await seedPatient(ORG_A, "Nam", "Ed");
      const admissionId = await seedAdmission(ORG_A, patientId, "active", 40);
      await seedLocPeriod(ORG_A, admissionId);
      await seedSignedCarePlan(ORG_A, patientId, admissionId);
      const otherMeetingId = await seedMeeting(ORG_A, "scheduled", 902);
      const meetingId = await seedMeeting(ORG_A, "scheduled", 2);
      await seedSectionSources(ORG_A, patientId, admissionId, otherMeetingId, meetingId);
      await admin.query(
        "UPDATE idg_action_item SET assigned_to_membership_id=$1 WHERE idg_meeting_id=$2",
        [assignee, otherMeetingId],
      );

      const namePorts = {
        siteDisplay: {
          displayForSite: (o: string, ids: readonly string[]) =>
            siteDisplayForOrg(handle.db, o, ids),
        },
        membershipDisplay: {
          displayForMemberships: (o: string, ids: readonly string[]) =>
            membershipDisplayForOrg(handle.db, o, ids),
        },
      };
      await runPacketBuildCron({
        db: handle.db,
        outbox,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        redis,
        ...m6m7Ports(),
        ...sectionPorts(),
        ...namePorts,
      });
      const { rows } = await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type='m14.packet.render_requested' AND payload->>'patientId'=$1 AND payload->>'meetingId'=$2",
        [patientId, meetingId],
      );
      expect(rows).toHaveLength(1);
      const rp = rows[0].payload.renderPayload;
      expect(rp.meeting).toEqual({
        meetingId,
        locationId: locationOf[ORG_A],
        organizationName: "org-a",
        locationName: "Loc",
      });
      expect(rp.memberNames).toEqual({ [assignee]: "Dana Reyes" });
      expect(rp.snapshot.carryForwardActionItems).toHaveLength(2);
      // names are render-context only: the frozen built_snapshot never carries them.
      const pkt = await packetFor(meetingId, patientId);
      expect(JSON.stringify(pkt.built_snapshot)).not.toContain("Dana Reyes");
      expect(JSON.stringify(pkt.built_snapshot)).not.toContain("org-a");

      // names ONLY, tenant-scoped, batched: org A cannot resolve org B's membership or location.
      const site = await siteDisplayForOrg(handle.db, ORG_A, [
        locationOf[ORG_A],
        locationOf[ORG_B],
      ]);
      expect(site.organizationName).toBe("org-a");
      expect([...site.locationNames]).toEqual([[locationOf[ORG_A], "Loc"]]);
      const who = await membershipDisplayForOrg(handle.db, ORG_A, [assignee, assigneeB]);
      expect([...who.keys()]).toEqual([assignee]);
      expect(Object.keys(who.get(assignee) ?? {}).sort()).toEqual(["displayName", "membershipId"]);

      // degrade: throwing ports still build + emit the packet, just without names.
      const meeting2 = await seedMeeting(ORG_A, "scheduled", 3);
      await runPacketBuildCron({
        db: handle.db,
        outbox,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        redis,
        ...m6m7Ports(),
        ...sectionPorts(),
        siteDisplay: {
          displayForSite: async () => {
            throw new Error("site port down");
          },
        },
        membershipDisplay: {
          displayForMemberships: async () => {
            throw new Error("member port down");
          },
        },
        warn: () => undefined,
      });
      const { rows: rows2 } = await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type='m14.packet.render_requested' AND payload->>'meetingId'=$1",
        [meeting2],
      );
      expect(rows2.length).toBeGreaterThanOrEqual(1);
      expect(rows2[0].payload.renderPayload.memberNames).toEqual({});
      expect(rows2[0].payload.renderPayload.meeting.organizationName).toBeUndefined();
    });

    it("the section seams are tenant-scoped under the real NOBYPASSRLS role: org A cannot read org B's rows", async () => {
      const bPatient = await seedPatient(ORG_B, "Bee", "Tenant");
      const bAdmission = await seedAdmission(ORG_B, bPatient, "active", 40);
      const bMeeting = await seedMeeting(ORG_B, "scheduled", 900);
      await seedSectionSources(ORG_B, bPatient, bAdmission, bMeeting, bMeeting);
      const since = new Date(Date.now() - 200 * 86_400_000).toISOString();
      // Sanity: the owning tenant DOES see them (so the empty results below are RLS, not missing data).
      expect(
        (await idgMissedDosesForOrg(handle.db, ORG_B, [bPatient], since)).get(bPatient),
      ).toHaveLength(3);
      expect(
        (await idgHopeContextForOrg(handle.db, ORG_B, [bPatient])).get(bPatient)?.openSfvCount,
      ).toBe(2);
      // Org A asking for org B's patient id gets nothing from any source.
      expect((await idgHospitalEventsForOrg(handle.db, ORG_A, [bPatient], since)).size).toBe(0);
      expect((await idgMissedDosesForOrg(handle.db, ORG_A, [bPatient], since)).size).toBe(0);
      expect((await idgQualityFlaggedEventsForOrg(handle.db, ORG_A, [bPatient], since)).size).toBe(
        0,
      );
      // F-218 — the M19 triage source: the owning tenant sees its 2 GIP proposals (3d and 100d old, both after
      // `since` = 200d ago; the non-GIP disposition is excluded), the other tenant sees nothing.
      expect(
        (await idgTriageCarePlanChangesForOrg(handle.db, ORG_B, [bPatient], since)).get(bPatient),
      ).toHaveLength(2);
      expect((await idgTriageCarePlanChangesForOrg(handle.db, ORG_A, [bPatient], since)).size).toBe(
        0,
      );
      expect((await idgHopeContextForOrg(handle.db, ORG_A, [bPatient])).get(bPatient)).toEqual({
        upcomingTimepoints: [],
        openSfvCount: 0,
      });
    });

    it("fail-honest: with the section ports UNBOUND flaggedEvents is [] and hopeContext is null (never a guess), " +
      "while carry-forward (M14's own table) still populates", async () => {
      const patientId = await seedPatient(ORG_A, "Un", "Bound");
      const admissionId = await seedAdmission(ORG_A, patientId, "active", 40);
      await seedLocPeriod(ORG_A, admissionId);
      await seedSignedCarePlan(ORG_A, patientId, admissionId);
      const otherMeetingId = await seedMeeting(ORG_A, "scheduled", 901);
      const meetingId = await seedMeeting(ORG_A, "scheduled", 2);
      await seedSectionSources(ORG_A, patientId, admissionId, otherMeetingId, meetingId);

      await runPacketBuildCron({
        db: handle.db,
        outbox,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        redis,
        ...m6m7Ports(),
      });
      const snap = (await packetFor(meetingId, patientId)).built_snapshot as {
        sinceLastIdg: { flaggedEvents: unknown[] };
        hopeContext: unknown;
        carryForwardActionItems: unknown[];
      };
      expect(snap.sinceLastIdg.flaggedEvents).toEqual([]);
      expect(snap.hopeContext).toBeNull();
      expect(snap.carryForwardActionItems).toHaveLength(2);
    });

    it("cross-tenant: org B's admission never appears in org A's meeting build", async () => {
      const orgBPatient = await seedPatient(ORG_B, "Other", "Tenant");
      const orgBAdmission = await seedAdmission(ORG_B, orgBPatient, "active", 10);
      await seedLocPeriod(ORG_B, orgBAdmission);
      await seedSignedCarePlan(ORG_B, orgBPatient, orgBAdmission);

      const orgAPatient = await seedPatient(ORG_A, "Own", "Tenant");
      const orgAAdmission = await seedAdmission(ORG_A, orgAPatient, "active", 10);
      await seedLocPeriod(ORG_A, orgAAdmission);
      await seedSignedCarePlan(ORG_A, orgAPatient, orgAAdmission);

      const meetingId = await seedMeeting(ORG_A, "scheduled", 1);
      const deps = {
        db: handle.db,
        outbox,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        redis,
        ...m6m7Ports(),
      };
      await runPacketBuildCron(deps);

      expect(await packetFor(meetingId, orgAPatient)).not.toBeNull();
      expect(await packetFor(meetingId, orgBPatient)).toBeNull();
    });

    // ── §2.7 / D8 / §7.6 `idg.carry-forward` (`compute-carry-forward`) ──────────────────────────────────────
    describe("idg.carry-forward — agenda carry + once-per-(item,meeting) count + compliance alert", () => {
      const carryDeps = (orgs: readonly string[]) => ({
        db: handle.db,
        outbox,
        activeOrgs: {
          listActiveOrgs: async () => orgs.map((organizationId) => ({ organizationId })),
        },
      });
      async function seedItem(
        orgId: string,
        meetingId: string,
        patientId: string,
        title: string,
        dueSql: string,
        status: string,
        count: number,
      ): Promise<string> {
        const { rows } = await admin.query(
          `INSERT INTO idg_action_item (organization_id, provider_entity_id, location_id, idg_meeting_id, patient_id,
              assigned_to_membership_id, title, due_date, status, meeting_carry_forward_count)
           VALUES ($1,$2,$3,$4,$5,$6,$7, ${dueSql}, $8, $9) RETURNING id`,
          [
            orgId,
            peOf[orgId],
            locationOf[orgId],
            meetingId,
            patientId,
            MEMBER,
            title,
            status,
            count,
          ],
        );
        const id = rows[0].id as string;
        // The count is DERIVED (distinct non-cancelled meetings carried into), so a seeded prior count is backed by
        // that many real carry-forward agenda rows on distinct past, adjourned meetings.
        for (let i = 0; i < count; i += 1) {
          await carryInto(orgId, id, await seedMeeting(orgId, "adjourned", -24 * (40 + i)));
        }
        return id;
      }
      /** Retire every upcoming (carry-eligible) meeting of the org so the NEXT seeded one is the sole target. */
      async function quiesceUpcoming(orgId: string): Promise<void> {
        await admin.query(
          "UPDATE idg_meeting SET status='adjourned', scheduled_start = now() - interval '1 hour' " +
            "WHERE organization_id=$1 AND status IN ('scheduled','packets_building','packets_ready') " +
            "AND scheduled_start < now() + interval '36 hours'",
          [orgId],
        );
      }
      async function carryInto(orgId: string, itemId: string, meetingId: string): Promise<void> {
        await admin.query(
          `INSERT INTO idg_agenda_item (organization_id, location_id, idg_meeting_id, title, kind,
              carried_from_action_item_id, added_by_membership_id)
           VALUES ($1,$2,$3,'Carried-forward action item','carry_forward',$4,$5)`,
          [orgId, locationOf[orgId], meetingId, itemId, MEMBER],
        );
      }
      async function countOf(id: string): Promise<number> {
        const { rows } = await admin.query(
          "SELECT meeting_carry_forward_count AS n FROM idg_action_item WHERE id=$1",
          [id],
        );
        return rows[0].n as number;
      }
      async function carryRows(meetingId: string) {
        const { rows } = await admin.query(
          `SELECT carried_from_action_item_id AS item, location_id, patient_id, kind, added_by_membership_id
             FROM idg_agenda_item WHERE idg_meeting_id=$1 AND kind='carry_forward' ORDER BY carried_from_action_item_id`,
          [meetingId],
        );
        return rows as {
          item: string;
          location_id: string;
          patient_id: string;
          kind: string;
          added_by_membership_id: string;
        }[];
      }
      async function carryEvents(itemId: string) {
        const { rows } = await admin.query(
          `SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m14.action_item.carry_forward'
            ORDER BY created_at`,
          [itemId],
        );
        return rows.map((r) => r.payload as Record<string, unknown>);
      }

      it("carries overdue open/in_progress items onto the next meeting ONCE, is idempotent under re-runs, " +
        "concurrent ticks and packet rebuilds, and the packet shows the real count", async () => {
        await seedOrgProviderLocation(ORG_C, "org-c");
        const patientId = await seedPatient(ORG_C, "Carry", "Fwd");
        const admissionId = await seedAdmission(ORG_C, patientId, "active", 60);
        await seedLocPeriod(ORG_C, admissionId);
        await seedSignedCarePlan(ORG_C, patientId, admissionId);
        const oldMeeting = await seedMeeting(ORG_C, "adjourned", -24 * 14);
        await seedMeeting(ORG_C, "cancelled", 10); // ignored: cancelled
        const target = await seedMeeting(ORG_C, "scheduled", 20); // inside BOTH the 36h carry and 24h build windows
        const later = await seedMeeting(ORG_C, "scheduled", 20 + 24 * 14); // beyond lookahead
        const open = await seedItem(
          ORG_C,
          oldMeeting,
          patientId,
          "call family",
          "now() - interval '8 days'",
          "open",
          0,
        );
        const inProg = await seedItem(
          ORG_C,
          oldMeeting,
          patientId,
          "get order",
          "now() - interval '2 days'",
          "in_progress",
          1,
        );
        const done = await seedItem(
          ORG_C,
          oldMeeting,
          patientId,
          "done",
          "now() - interval '8 days'",
          "completed",
          0,
        );
        const notDue = await seedItem(
          ORG_C,
          oldMeeting,
          patientId,
          "future",
          "now() + interval '5 days'",
          "open",
          0,
        );
        const undated = await seedItem(ORG_C, oldMeeting, patientId, "undated", "NULL", "open", 0);

        // Cross-tenant: an overdue item in ORG_A is untouched by a tick for ORG_C only.
        const aBefore = (
          await admin.query(
            "SELECT coalesce(sum(meeting_carry_forward_count),0)::int AS n FROM idg_action_item WHERE organization_id=$1",
            [ORG_A],
          )
        ).rows[0].n as number;

        await runCarryForwardCron(carryDeps([ORG_C]));

        const rows = await carryRows(target);
        expect(rows.map((r) => r.item).sort()).toEqual([open, inProg].sort());
        // three-column rule: location from the meeting; patient from the item; kind carry_forward
        expect(
          rows.every((r) => r.location_id === locationOf[ORG_C] && r.patient_id === patientId),
        ).toBe(true);
        expect(await carryRows(later)).toEqual([]);
        expect(await countOf(open)).toBe(1);
        expect(await countOf(inProg)).toBe(2);
        for (const untouched of [done, notDue, undated]) expect(await countOf(untouched)).toBe(0);
        const ev = await carryEvents(open);
        expect(ev).toHaveLength(1);
        expect(ev[0]).toMatchObject({
          priorActionItemId: open,
          carryForwardCount: 1,
          isComplianceAlert: false,
        });
        expect(Object.keys(ev[0] as object).sort()).toEqual([
          "carryForwardCount",
          "coordinatorMembershipId",
          "isComplianceAlert",
          "newAgendaItemId",
          "priorActionItemId",
        ]); // id-only, PHI-free

        // Re-run + two CONCURRENT ticks: nothing changes.
        await runCarryForwardCron(carryDeps([ORG_C]));
        await Promise.all([
          runCarryForwardCron(carryDeps([ORG_C])),
          runCarryForwardCron(carryDeps([ORG_C])),
        ]);
        expect(await countOf(open)).toBe(1);
        expect(await countOf(inProg)).toBe(2);
        expect((await carryRows(target)).length).toBe(2);
        expect(await carryEvents(open)).toHaveLength(1);

        // The packet build (the on-demand/T-24h path) READS the count and never increments it.
        await runPacketBuildCron({
          db: handle.db,
          outbox,
          activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_C }] },
          redis,
          ...m6m7Ports(),
        });
        const snap = (await packetFor(target, patientId)).built_snapshot as {
          carryForwardActionItems: { actionItemId: string; carryForwardCount: number }[];
        };
        const byId = new Map(
          snap.carryForwardActionItems.map((c) => [c.actionItemId, c.carryForwardCount]),
        );
        expect(byId.get(open)).toBe(1);
        expect(byId.get(inProg)).toBe(2);
        await runCarryForwardCron(carryDeps([ORG_C]));
        expect(await countOf(open)).toBe(1);

        // Tenant isolation.
        const aAfter = (
          await admin.query(
            "SELECT coalesce(sum(meeting_carry_forward_count),0)::int AS n FROM idg_action_item WHERE organization_id=$1",
            [ORG_A],
          )
        ).rows[0].n as number;
        expect(aAfter).toBe(aBefore);
      });

      it("fires the compliance flag ONLY on the crossing to 3 — the 4th carry does not re-alert", async () => {
        const patientId = await seedPatient(ORG_C, "Third", "Carry");
        const oldMeeting = await seedMeeting(ORG_C, "adjourned", -24 * 30);
        const item3 = await seedItem(
          ORG_C,
          oldMeeting,
          patientId,
          "stale",
          "now() - interval '20 days'",
          "open",
          2,
        );
        // The earlier tests' 20h meeting is already `scheduled` and will be the target; carry into it.
        await runCarryForwardCron(carryDeps([ORG_C]));
        expect(await countOf(item3)).toBe(3);
        const ev = await carryEvents(item3);
        expect(ev).toHaveLength(1);
        expect(ev[0]).toMatchObject({
          carryForwardCount: 3,
          isComplianceAlert: true,
          coordinatorMembershipId: MEMBER,
        });
        await runCarryForwardCron(carryDeps([ORG_C])); // re-run: no second alert
        expect(await carryEvents(item3)).toHaveLength(1);
        expect(await countOf(item3)).toBe(3);

        // That meeting is adjourned; the next upcoming one carries it a 4th time — NOT a crossing, no flag.
        await admin.query(
          "UPDATE idg_meeting SET status='adjourned', scheduled_start = now() - interval '1 hour' " +
            "WHERE organization_id=$1 AND status='scheduled' AND scheduled_start < now() + interval '36 hours'",
          [ORG_C],
        );
        const next = await seedMeeting(ORG_C, "packets_ready", 5);
        await runCarryForwardCron(carryDeps([ORG_C]));
        expect((await carryRows(next)).map((r) => r.item)).toContain(item3);
        expect(await countOf(item3)).toBe(4);
        expect(
          (await carryEvents(item3)).map((e) => [e.carryForwardCount, e.isComplianceAlert]),
        ).toEqual([
          [3, true],
          [4, false],
        ]);
      });

      it("a CANCELLED / RESCHEDULED meeting is not counted: the cron derives the count, and cancel recomputes at cancel time", async () => {
        const patientId = await seedPatient(ORG_C, "Cancel", "Count");
        const origin = await seedMeeting(ORG_C, "adjourned", -24 * 60);
        // Item has been carried into 2 earlier meetings: one adjourned (counts), one later CANCELLED (must not).
        const it2 = await seedItem(
          ORG_C,
          origin,
          patientId,
          "cc",
          "now() - interval '30 days'",
          "open",
          1,
        );
        const cancelledAfterCarry = await seedMeeting(ORG_C, "packets_ready", 90 * 24);
        await carryInto(ORG_C, it2, cancelledAfterCarry);
        await admin.query(
          "UPDATE idg_action_item SET meeting_carry_forward_count = 2 WHERE id=$1",
          [it2],
        );
        expect(await countOf(it2)).toBe(2);

        // Cancel through the REAL app-role recompute (the same helper the cancel/reschedule service calls, in-tx).
        await withOrgContext(handle.db, { organizationId: ORG_C, userId: "" }, async (tx) => {
          await tx.execute(
            sql`UPDATE idg_meeting SET status='cancelled' WHERE id=${cancelledAfterCarry}`,
          );
          await recomputeCarryForwardCountsForMeeting(
            tx as never,
            ORG_C,
            cancelledAfterCarry,
            new Date(),
          );
        });
        expect(await countOf(it2)).toBe(1); // dropped the cancelled meeting; the adjourned one remains

        // A rescheduled-away meeting behaves the same, and recompute is idempotent.
        const moved = await seedMeeting(ORG_C, "rescheduled", 91 * 24);
        await carryInto(ORG_C, it2, moved);
        await withOrgContext(handle.db, { organizationId: ORG_C, userId: "" }, async (tx) => {
          await recomputeCarryForwardCountsForMeeting(tx as never, ORG_C, moved, new Date());
          await recomputeCarryForwardCountsForMeeting(tx as never, ORG_C, moved, new Date());
        });
        expect(await countOf(it2)).toBe(1);

        // The cron then carries it into the next live meeting: 1 (adjourned) + 1 (new) = 2 — NOT 3 (old blind +1
        // would have double-counted the cancelled meeting), so there is no crossing and no compliance flag.
        await quiesceUpcoming(ORG_C);
        const nextLive = await seedMeeting(ORG_C, "scheduled", 30);
        await runCarryForwardCron(carryDeps([ORG_C]));
        expect((await carryRows(nextLive)).map((r) => r.item)).toContain(it2);
        expect(await countOf(it2)).toBe(2);
        const ev = await carryEvents(it2);
        expect(ev).toHaveLength(1);
        expect(ev[0]).toMatchObject({ carryForwardCount: 2, isComplianceAlert: false });
        // The packet builder's stored-count reader sees the derived number (2), never the cancelled meeting's.
        const { rows } = await admin.query(
          "SELECT meeting_carry_forward_count AS n FROM idg_action_item WHERE id=$1",
          [it2],
        );
        expect(rows[0].n).toBe(2);
      });

      it("a cancelled meeting that had carried an item in a cron tick (stale stored count) is corrected by the next carry", async () => {
        const patientId = await seedPatient(ORG_C, "Stale", "Count");
        const origin = await seedMeeting(ORG_C, "adjourned", -24 * 70);
        const it3 = await seedItem(
          ORG_C,
          origin,
          patientId,
          "sc",
          "now() - interval '30 days'",
          "open",
          2,
        );
        // a third carry row into a meeting that is then cancelled OUT OF BAND (admin write, no recompute): stored 2
        const ghost = await seedMeeting(ORG_C, "cancelled", 95 * 24);
        await carryInto(ORG_C, it3, ghost);
        expect(await countOf(it3)).toBe(2);
        await quiesceUpcoming(ORG_C);
        const live = await seedMeeting(ORG_C, "packets_ready", 8);
        await runCarryForwardCron(carryDeps([ORG_C]));
        // 2 real + 1 new = 3 (ghost excluded) -> this IS the crossing (prior stored 2 -> 3), flagged once.
        expect(await countOf(it3)).toBe(3);
        expect((await carryRows(live)).map((r) => r.item)).toContain(it3);
        expect(
          (await carryEvents(it3)).map((e) => [e.carryForwardCount, e.isComplianceAlert]),
        ).toEqual([[3, true]]);
      });

      it("the DB unique index itself refuses a duplicate (item, meeting) carry row", async () => {
        const { rows } = await admin.query(
          `SELECT carried_from_action_item_id AS item, idg_meeting_id AS meeting FROM idg_agenda_item
            WHERE kind='carry_forward' AND organization_id=$1 LIMIT 1`,
          [ORG_C],
        );
        await expect(
          admin.query(
            `INSERT INTO idg_agenda_item (organization_id, idg_meeting_id, title, kind, carried_from_action_item_id,
                added_by_membership_id) VALUES ($1,$2,'dup','carry_forward',$3,$4)`,
            [ORG_C, rows[0].meeting, rows[0].item, MEMBER],
          ),
        ).rejects.toThrow(/idg_agenda_item_carry_forward_uq/);
      });
    });
  },
);
