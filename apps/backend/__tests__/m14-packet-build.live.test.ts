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
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { registerPlatformJob } from "@wardenx/tenancy";
import IORedis from "ioredis";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { registerSeam } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
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
import { idgMissedDosesForOrg } from "../src/modules/13-emar/index";
import type { IdgWriteOutboxPort } from "../src/modules/14-idg/idg-route-service-db";
import {
  M14_OUTBOX_EVENTS,
  M14_PLATFORM_JOB_ID,
  runPacketBuildCron,
  runScheduleMaterialiseCron,
} from "../src/modules/14-idg/index";
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
        ["er_visit", "fall", "hospitalisation", "infection", "missed_dose", "missed_dose"].sort(),
      );
      const bySev = (k: string) =>
        flagged
          .filter((f) => f.kind === k)
          .map((f) => f.severity)
          .sort();
      expect(bySev("missed_dose")).toEqual(["info", "urgent"]);
      expect(bySev("fall")).toEqual(["urgent"]);
      expect(bySev("infection")).toEqual(["attention"]);
      expect(JSON.stringify(snap)).not.toContain("free text must not cross");
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
  },
);
