/**
 * Over the 800-line soft ceiling on purpose: one ordered patient journey (plan -> visit -> note -> cosign -> IDG) shares state across steps, so it cannot be split.
 *
 * S05 (clinical workflow audit 2026-10-28, CW-CL-08) — care plan -> scheduled visit -> signed note ->
 * cosign -> IDG update, END TO END over real Postgres, as the NOBYPASSRLS `chartwarden_app` role.
 *
 * Nothing between the five hops is stubbed except what the sibling suites already stub (the LatestAssessment
 * reader): the REAL M7 care-plan service + CarePlanReader, the REAL M17 scheduler + proposal generator, the REAL
 * M8 encounter service (draft -> finalize -> sign -> cosign) with the real M5 CareTeamProvider and M6
 * AdmissionStatusReader, the REAL M8 SignedEncountersReader (the only encounter feed M14's packet has), the REAL
 * M14 meeting machine (record -> adjourn -> `idg.decision_recorded`) and the REAL outbox dispatcher feeding M7's
 * `idg.decision_recorded` consumer, whose proposal is then signed to quorum to become the authoritative plan.
 *
 * Several cases PIN current behaviour that the audit flagged as a gap; each is named `DEFECT S05-n` so a fix
 * flips exactly one assertion (and the title) rather than going unnoticed. They are not xfail: they pass today.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m14:s05-careplan-to-idg:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInMemorySessionContextStore, createSessionContextResolver } from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import { runWithRequestContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { registerSeam } from "../src/bootstrap/seams/registry";
import { registerPatientSeams } from "../src/modules/05-patient/index";
import { createCareTeamProvider } from "../src/modules/05-patient/seams/care-team-provider";
import {
  createDrizzleCareTeamStore,
  createDrizzleCaseloadStore,
} from "../src/modules/05-patient/seams/drizzle-stores";
import {
  createAdmissionStatusReader,
  createDrizzleAdmissionReaderStore,
} from "../src/modules/06-admission/index";
import {
  type CarePlanWriteOutboxPort,
  M7_OUTBOX_EVENTS,
  buildM7IdgDecisionConsumer,
  createDbCarePlanRouteService,
} from "../src/modules/07-care-plan/index";
import { createDrizzleCarePlanReaderStore } from "../src/modules/07-care-plan/seams/drizzle-store";
import { createCarePlanReader } from "../src/modules/07-care-plan/seams/reader";
import {
  type EncounterWriteOutboxPort,
  M8_OUTBOX_EVENTS,
  createDbEncounterRouteService,
  createHearthnoteCiphers,
} from "../src/modules/08-encounters/index";
import { createDrizzleEncounterReaderStore } from "../src/modules/08-encounters/seams/drizzle-store";
import { createSignedEncountersReader } from "../src/modules/08-encounters/seams/readers";
import {
  type IdgWriteOutboxPort,
  createDbIdgBackend,
} from "../src/modules/14-idg/idg-route-service-db";
import {
  M14_OUTBOX_EVENTS,
  buildM14WorkerDeps,
  createDrizzleIdgSeamStore,
  createIdgScheduleProvider,
  runReviewClockSweepCron,
} from "../src/modules/14-idg/index";
import {
  M17_OUTBOX_EVENTS,
  type SchedulingWriteOutboxPort,
  createDbSchedulingBackend,
  registerSchedulingSeams,
} from "../src/modules/17-scheduling/index";
import { createDrizzleCredentialStore } from "../src/modules/17-scheduling/seams/credentials-drizzle-store";
import { M17_SYSTEM_USER_ID } from "../src/modules/17-scheduling/system-actor";
import { requiredSectionSelections, requiredVitalsCapture } from "./_hearthnote-fixtures";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG = "11111111-1111-1111-1111-111111111111";
const USER_LPN = "33333333-3333-3333-3333-333333333333";
const USER_CM = "88888888-8888-8888-8888-888888888888";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const SESSION_LPN = "66666666-6666-6666-6666-666666666666";
const SESSION_CM = "66666666-6666-6666-6666-666666666667";
const SESSION_STALE = "77777777-7777-7777-7777-777777777777";

const DAY_MS = 86_400_000;
const NOW_MS = Date.now();
/** Yesterday, UTC: past (the future-date CHECK) yet inside the `normal` late-entry tier in any org timezone. */
const SERVICE_DATE = new Date(NOW_MS - DAY_MS).toISOString().slice(0, 10);

// M7 signers: signing is bound to the actor, so each signer slot needs its own person holding that role.
const SIGNER_ROLES = [
  "rn_case_manager",
  "hospice_physician",
  "nurse_practitioner",
  "msw",
  "chaplain",
  "medical_director",
] as const;
const signerIds = (role: string) => {
  const n = SIGNER_ROLES.indexOf(role as (typeof SIGNER_ROLES)[number]) + 1;
  const tail = String(n).padStart(12, "0");
  return {
    userId: `5555555${n}-5555-4555-8555-${tail}`,
    membershipId: `6666666${n}-6666-4666-8666-${tail}`,
  };
};
const signerFor = (role: string) => ({ ...signerIds(role), roles: [role] });

const TEST_DEK = { version: "test-v1", key: Buffer.alloc(32, 7) };
const CIPHERS = createHearthnoteCiphers({
  async dekForOrg() {
    return TEST_DEK;
  },
  async dekForOrgVersion(_org: string, version: string) {
    return { version, key: TEST_DEK.key };
  },
});

describe.skipIf(!DB_URL)(
  "S05 — care plan -> visit -> signed note -> cosign -> IDG update, LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let m7: ReturnType<typeof createDbCarePlanRouteService>;
    let m8: ReturnType<typeof createDbEncounterRouteService>;
    let m14: ReturnType<typeof createDbIdgBackend>;
    let m17: ReturnType<typeof createDbSchedulingBackend>;
    let dispatcher: ReturnType<typeof createOutboxDispatcher>;
    let m14Outbox: IdgWriteOutboxPort;
    let peId: string;
    let locationId: string;
    let lpnMembership: string;
    let cmMembership: string;
    /** A REAL membership: M7's idg_review version FKs `drafted_by_membership_id` to the decision's recorder. */
    let COORDINATOR: string;
    let LPN: { membershipId: string; sessionId: string };
    let CM: { membershipId: string; sessionId: string };

    // Shared story state, filled by the cases in order.
    let planId = "";
    let initialVersionId = "";
    let problemId = "";
    let interventionId = "";
    let proseInterventionId = "";
    let visitId = "";
    let noteId = ""; // the LPN visit note that is cosigned
    let draftNoteId = ""; // never finalized
    let pendingNoteId = ""; // signed by the LPN, awaiting cosign (stays so)
    let decisionId = "";
    let meetingId = "";

    const inCtx = <T>(fn: () => Promise<T>): Promise<T> =>
      runWithRequestContext({ organizationId: ORG, userId: USER_LPN }, fn);

    async function resetSchema() {
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const r of LIVE_DROP_ROLES)
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
        );
    }
    async function applyMigrations() {
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort())
        await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    async function eventsFor(aggregateId: string): Promise<string[]> {
      const { rows } = await admin.query(
        "SELECT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
        [aggregateId],
      );
      return rows.map((r) => r.event_type as string);
    }
    async function seedUserMembership(email: string, userId = randomUUID()): Promise<string> {
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [userId, email]);
      return (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status, default_provider_entity_id, default_location_ids)
           VALUES ($1,$2,'active',$3,$4::jsonb) RETURNING id`,
          [userId, ORG, peId, JSON.stringify([locationId])],
        )
      ).rows[0].id as string;
    }
    async function seedMeeting(status: string): Promise<string> {
      return (
        await admin.query(
          `INSERT INTO idg_meeting (organization_id, location_id, scheduled_start, scheduled_end, status,
             coordinator_membership_id, tenant_quorum_snapshot)
           VALUES ($1,$2, now(), now() + interval '2 hours', $3, $4, '{}'::jsonb) RETURNING id`,
          [ORG, locationId, status, COORDINATOR],
        )
      ).rows[0].id as string;
    }
    async function seedPacket(
      meeting: string,
      patientId: string,
      admissionId: string,
      sinceCursorIso: string,
    ): Promise<void> {
      await admin.query(
        `INSERT INTO idg_patient_packet
           (organization_id, provider_entity_id, location_id, idg_meeting_id, patient_id, admission_id,
            since_cursor_iso, built_snapshot, discipline_views, cover_summary_layer1)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,'{}'::jsonb,'seed')`,
        [ORG, peId, locationId, meeting, patientId, admissionId, sinceCursorIso],
      );
    }
    async function openLpnDraft(linkedVisitId?: string): Promise<string> {
      const d = await m8.createDraft(ORG, lpnMembership, {
        patientId: PATIENT,
        admissionId: ADMISSION,
        ...(linkedVisitId ? { visitId: linkedVisitId } : {}),
        encounterType: "routine_visit" as never,
        discipline: "lpn" as never,
        serviceDate: SERVICE_DATE as never,
      } as never);
      await m8.updateSelections(ORG, d.id, 0, requiredSectionSelections("routine_visit", "lpn"));
      const vitals = requiredVitalsCapture("routine_visit", "lpn");
      if (vitals) await m8.captureVitals(ORG, d.id, vitals);
      return d.id;
    }
    async function signLpn(id: string) {
      await m8.finalize(ORG, id, SERVICE_DATE as never);
      return m8.sign(ORG, id, LPN, { at: SERVICE_DATE as never });
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')",
        [ORG],
      );
      peId = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,'01-1234','S05 PE','1234567890','enc','12-31') RETURNING id`,
          [ORG],
        )
      ).rows[0].id as string;
      locationId = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'S05 Loc','1 Main St','Town','NY','10001','America/New_York') RETURNING id`,
          [peId],
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO admission (id, organization_id, provider_entity_id, location_id, patient_id, status, admission_at, activated_at)
         VALUES ($1,$2,$3,$4,$5,'active',$6,$6)`,
        [ADMISSION, ORG, peId, locationId, PATIENT, new Date(NOW_MS - 30 * DAY_MS).toISOString()],
      );
      await admin.query(
        `INSERT INTO patient (id, organization_id, provider_entity_id, location_id, mrn,
                              legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
         VALUES ($1,$2,$3,$4,'MRN-S05','Test','Patient','1950-01-01','F','active')`,
        [PATIENT, ORG, peId, locationId],
      );
      lpnMembership = await seedUserMembership("s05-lpn@x.test", USER_LPN);
      cmMembership = await seedUserMembership("s05-cm@x.test", USER_CM);
      COORDINATOR = await seedUserMembership("s05-idg-coordinator@x.test");
      await admin.query(
        `INSERT INTO patient_assignment (patient_id, organization_id, provider_entity_id, location_id,
                                         clinician_user_id, role, assigned_at)
         VALUES ($1,$2,$3,$4,$5,'primary_rn',CURRENT_DATE)`,
        [PATIENT, ORG, peId, locationId, USER_CM],
      );
      for (const role of SIGNER_ROLES) {
        const { userId, membershipId } = signerIds(role);
        await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [
          userId,
          `${role}@s05.test`,
        ]);
        await admin.query(
          "INSERT INTO membership (id,user_id,organization_id,status) VALUES ($1,$2,$3,'active')",
          [membershipId, userId, ORG],
        );
      }
      // The LPN: a real role + an active credential, so M17's pre-schedule gate passes for real.
      const lpnRole = (
        await admin.query(
          `INSERT INTO role (organization_id, key, name, category) VALUES ($1,'lpn','LPN','clinical_staff') RETURNING id`,
          [ORG],
        )
      ).rows[0].id as string;
      await admin.query(
        "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
        [ORG, lpnMembership, lpnRole],
      );
      await admin.query(
        `INSERT INTO membership_credential (organization_id, membership_id, credential_type, effective_at, granted_by_membership_id)
         VALUES ($1,$2,'lpn','2020-01-01',$2)`,
        [ORG, lpnMembership],
      );
      await admin.query(
        `UPDATE organization SET settings = settings || '{"allow_unassigned_pool_assignment": true}'::jsonb WHERE id=$1`,
        [ORG],
      );

      LPN = { membershipId: lpnMembership, sessionId: SESSION_LPN };
      CM = { membershipId: cmMembership, sessionId: SESSION_CM };
      const freshSession = (sessionId: string, userId: string, membershipId: string) => ({
        sessionClass: "staff" as const,
        portalAccountId: null,
        sessionPatientId: null,
        sessionId,
        userId,
        membershipId,
        organizationId: ORG,
        roles: [],
        providerEntityIds: [],
        locationIds: [],
        lastStepUpAt: new Date(),
        lastStepUpFactor: "webauthn" as const,
      });
      registerSeam(
        "SessionContextResolver",
        createSessionContextResolver(
          createInMemorySessionContextStore([
            freshSession(SESSION_LPN, USER_LPN, lpnMembership),
            freshSession(SESSION_CM, USER_CM, cmMembership),
          ]).store,
        ),
      );

      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
      registerSeam(
        "AdmissionStatusReader",
        createAdmissionStatusReader(createDrizzleAdmissionReaderStore(handle.db)),
      );
      registerPatientSeams({
        db: handle.db,
        caseload: { store: createDrizzleCaseloadStore(handle.db) },
      });
      registerSeam(
        "CareTeamProvider",
        createCareTeamProvider(createDrizzleCareTeamStore(handle.db)),
      );
      registerSchedulingSeams({ credentials: { store: createDrizzleCredentialStore(handle.db) } });
      // The REAL M7 reader: M17 proposes visits from it, M8's sign gate asks it whether review is overdue.
      registerSeam(
        "CarePlanReader",
        createCarePlanReader(createDrizzleCarePlanReaderStore(handle.db)),
      );
      // The one stub, same as the M8 write suite: no assessment scales are required for a routine visit.
      registerSeam("LatestAssessmentProvider", {
        latest: async () => null,
        latestBatch: async () => [],
      } as never);

      const catalog = buildBootOutboxCatalog([
        M7_OUTBOX_EVENTS,
        M8_OUTBOX_EVENTS,
        M14_OUTBOX_EVENTS,
        M17_OUTBOX_EVENTS,
      ]);
      const publisher = buildTxOutboxPublisher(catalog);
      const bind = (callerModule: string) => ({
        publish: (tx: unknown, e: Record<string, unknown>) =>
          publisher.publish(tx as never, { ...e, callerModule } as never),
      });
      m7 = createDbCarePlanRouteService(
        handle.db,
        bind("m7") as unknown as CarePlanWriteOutboxPort,
      );
      m8 = createDbEncounterRouteService(
        handle.db,
        bind("m8") as unknown as EncounterWriteOutboxPort,
        CIPHERS,
      );
      m17 = createDbSchedulingBackend(
        handle.db,
        bind("m17") as unknown as SchedulingWriteOutboxPort,
      );
      m14Outbox = bind("m14") as unknown as IdgWriteOutboxPort;
      m14 = createDbIdgBackend(handle.db, m14Outbox);

      const orgs: ActiveOrgEnumerator = { listActiveOrgs: async () => [{ organizationId: ORG }] };
      dispatcher = createOutboxDispatcher({
        db: handle.db,
        orgs,
        consumers: [
          buildM7IdgDecisionConsumer({
            db: handle.db,
            outbox: bind("m7") as unknown as CarePlanWriteOutboxPort,
          }),
        ],
        eventCatalog: catalog,
        options: { log: () => {} },
      });
    }, 180_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    // ── hop 1: the authoritative care plan ──────────────────────────────────────────────────────────────
    it("hop 1 — M7 plan is signed to quorum and carries an LPN visit intervention", async () => {
      const boot = (await m7.bootstrapCarePlan(ORG, PATIENT, ADMISSION)) as {
        id: string;
        initialVersionId: string;
      };
      planId = boot.id;
      initialVersionId = boot.initialVersionId;
      problemId = (
        (await m7.addProblem(ORG, planId, {
          description: "Dyspnea at rest",
          kind: "terminal",
          source: "clinical",
        })) as { id: string }
      ).id;
      // The clinician's natural prose cadence ('2x/week') vs the structured one M17's parser needs.
      proseInterventionId = (
        (await m7.addIntervention(ORG, planId, {
          problemId,
          scopeText: "Skilled LPN symptom visit (prose cadence)",
          frequencyText: "2x/week",
          frequencyValue: "2:visit:week",
          discipline: "lpn",
        })) as { id: string }
      ).id;
      interventionId = (
        (await m7.addIntervention(ORG, planId, {
          problemId,
          scopeText: "Skilled LPN symptom visit",
          frequencyText: "2:visit:week",
          frequencyValue: "2:visit:week",
          discipline: "lpn",
        })) as { id: string }
      ).id;
      await m7.finalizeVersion(ORG, planId, initialVersionId, 1, null);
      const at = new Date().toISOString();
      await m7.signVersion(
        ORG,
        planId,
        initialVersionId,
        2,
        "rn_case_manager",
        at,
        signerFor("rn_case_manager"),
      );
      await m7.signVersion(
        ORG,
        planId,
        initialVersionId,
        3,
        "hospice_physician",
        at,
        signerFor("hospice_physician"),
      );
      const { rows } = await admin.query(
        "SELECT status, active_version_id FROM care_plan WHERE id=$1",
        [planId],
      );
      expect(rows[0]).toMatchObject({ status: "active", active_version_id: initialVersionId });
      expect(await eventsFor(initialVersionId)).toContain("m7.care_plan.version_signed");
    });

    // ── hop 2: plan -> scheduled visit ──────────────────────────────────────────────────────────────────
    it("hop 2 — M17 derives pending visit proposals from the signed plan's intervention (real CarePlanReader)", async () => {
      const out = await m17.generateCarePlanVisitProposals(ORG, M17_SYSTEM_USER_ID, {
        planId,
        versionId: initialVersionId,
        patientId: PATIENT,
        admissionId: ADMISSION,
      });
      // DEFECT S05-1 (pinned): the prose-cadence intervention is dropped silently. M7 stores both
      // `frequency_text` ('2x/week') and a structured `frequency_value` ('2:visit:week'), but the reader hands M17
      // only the text, and M17's grammar (count:unit:period) rejects it: counted as "skipped", no alert, no proposal.
      expect(out.proposalsSkipped).toBeGreaterThanOrEqual(1);
      expect(out.proposalsCreated).toBeGreaterThan(0);
      const { rows } = await admin.query(
        `SELECT status, proposed_discipline, source, source_payload->>'interventionId' AS intervention_id,
                source_payload->>'planId' AS plan_id
           FROM visit_proposal WHERE patient_id=$1`,
        [PATIENT],
      );
      expect(rows.length).toBe(out.proposalsCreated);
      for (const r of rows) {
        expect(r.intervention_id).not.toBe(proseInterventionId);
        expect(r).toMatchObject({
          status: "pending",
          proposed_discipline: "lpn",
          source: "frequency_driven_m7",
          intervention_id: interventionId,
          plan_id: planId,
        });
      }
      // Idempotent: a replayed signed-version event proposes nothing new.
      const again = await m17.generateCarePlanVisitProposals(ORG, M17_SYSTEM_USER_ID, {
        planId,
        versionId: initialVersionId,
        patientId: PATIENT,
        admissionId: ADMISSION,
      });
      expect(again.proposalsCreated).toBe(0);
    });

    it("DEFECT S05-2 — plan-derived proposals name no clinician, so publishProposal can never schedule them", async () => {
      const { rows } = await admin.query(
        "SELECT id, suggested_membership_id FROM visit_proposal WHERE patient_id=$1 AND status='pending' LIMIT 1",
        [PATIENT],
      );
      expect(rows[0].suggested_membership_id).toBeNull();
      await expect(
        m17.publishProposal(ORG, lpnMembership, rows[0].id as string),
      ).rejects.toMatchObject({
        message: expect.stringContaining("no suggested membership"),
      });
      // The proposal is untouched (still pending): the plan's frequency is NOT turned into a visit.
      const after = await admin.query("SELECT status FROM visit_proposal WHERE id=$1", [
        rows[0].id,
      ]);
      expect(after.rows[0].status).toBe("pending");
    });

    it("hop 2b — the visit is scheduled to the LPN by hand (the only path that works today)", async () => {
      const start = new Date(NOW_MS + 2 * 3_600_000);
      const visit = await m17.createVisit(ORG, lpnMembership, {
        patientId: PATIENT,
        admissionId: ADMISSION,
        patientAddressId: null,
        externalFacilityId: null,
        assignedMembershipId: lpnMembership,
        visitPurpose: "routine_visit",
        visitSetting: "patient_home",
        scheduledStartedAt: start.toISOString(),
        scheduledEndedAt: new Date(start.getTime() + 3_600_000).toISOString(),
      } as never);
      visitId = visit.id;
      expect(await eventsFor(visitId)).toContain("m17.visit.assigned");
    });

    // ── hop 3: the signed note, linked back to the plan ────────────────────────────────────────────────
    it("hop 3 — the LPN note is linked to the visit and the plan's intervention, signed, and routes to the RN case manager", async () => {
      noteId = await inCtx(() => openLpnDraft(visitId));
      const link = await inCtx(() =>
        m8.addCarePlanLink(ORG, lpnMembership, noteId, { problemId, interventionId } as never),
      );
      const links = await admin.query(
        "SELECT problem_id, intervention_id FROM encounter_care_plan_link WHERE encounter_id=$1",
        [noteId],
      );
      expect(link.id).toBeTruthy();
      expect(links.rows[0]).toMatchObject({
        problem_id: problemId,
        intervention_id: interventionId,
      });
      const enc = await admin.query("SELECT visit_id FROM encounter WHERE id=$1", [noteId]);
      expect(enc.rows[0].visit_id).toBe(visitId);

      const signed = await inCtx(() => signLpn(noteId));
      expect(signed.status).toBe("cosign_pending");
      const routed = await admin.query(
        "SELECT routed_to_membership_id FROM cosignature_request WHERE id=$1",
        [signed.cosignatureRequestId],
      );
      expect(routed.rows[0].routed_to_membership_id).toBe(cmMembership);
      expect(routed.rows[0].routed_to_membership_id).not.toBe(lpnMembership);
    });

    // ── hop 4a: unsigned notes vs the IDG's only encounter feed ────────────────────────────────────────
    it("unsigned notes are detectable in M8's own queues, but the IDG's encounter feed omits all of them", async () => {
      draftNoteId = await inCtx(() => openLpnDraft()); // never finalized
      pendingNoteId = await inCtx(async () => {
        const id = await openLpnDraft();
        await signLpn(id); // LPN-signed, awaiting RN cosign — stays that way
        return id;
      });

      // M8's own surfaces see them: the cosignature queue holds both cosign-pending notes, the author's drafts hold the draft.
      const queue = await inCtx(() => m8.cosignatureQueue(ORG));
      const queued = queue.encounters.map((e) => e.id);
      expect(queued).toEqual(expect.arrayContaining([noteId, pendingNoteId]));
      const drafts = await inCtx(() => m8.myDrafts(ORG, lpnMembership));
      expect(JSON.stringify(drafts)).toContain(draftNoteId);

      // The REAL SignedEncountersReader is what M14's packet builder calls (`packet-build.ts`). Both statuses
      // that mean "this visit is not fully signed off" are absent from it; nothing else in the packet input
      // (`SinceLastIdgInput`, packages/idg) carries unsigned documentation.
      const reader = createSignedEncountersReader(createDrizzleEncounterReaderStore(handle.db));
      const since = new Date(NOW_MS - 30 * DAY_MS).toISOString();
      const seen = (await reader.signedEncountersForPatientSince(ORG, PATIENT as never, since)).map(
        (e) => e.encounterId as string,
      );
      expect(seen).not.toContain(draftNoteId);
      // DEFECT S05-3 (pinned): an LPN note awaiting cosign is invisible to the IDG, as is a draft. The
      // meeting reviews a patient whose newest visits are missing from the packet with no "unsigned" marker.
      expect(seen).not.toContain(pendingNoteId);
      expect(seen).not.toContain(noteId);
    });

    // ── hop 4b: cosign ─────────────────────────────────────────────────────────────────────────────────
    it("the author cannot acknowledge or cosign their own note; the request stays routed and no cosignature row is written", async () => {
      await expect(
        m8.cosignAcknowledge(ORG, noteId, LPN, SERVICE_DATE as never),
      ).rejects.toMatchObject({
        statusCode: 403,
      });
      await expect(
        m8.cosignSign(ORG, noteId, LPN, { isQualifiedRn: true, at: SERVICE_DATE as never }),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect((await m8.getCosignature(ORG, noteId)).status).toBe("routed");
      const sigs = await admin.query(
        "SELECT 1 FROM encounter_signature WHERE encounter_id=$1 AND kind='cosignature'",
        [noteId],
      );
      expect(sigs.rowCount).toBe(0);
    });

    it("a cosigner without a fresh step-up, or who is not a qualified RN, cannot cosign", async () => {
      await m8.cosignAcknowledge(ORG, noteId, CM, SERVICE_DATE as never);
      await expect(
        m8.cosignSign(
          ORG,
          noteId,
          { membershipId: cmMembership, sessionId: SESSION_STALE },
          {
            isQualifiedRn: true,
            at: SERVICE_DATE as never,
          },
        ),
      ).rejects.toMatchObject({ code: "STEP_UP_AUTH_REQUIRED" });
      await expect(
        m8.cosignSign(ORG, noteId, CM, { isQualifiedRn: false, at: SERVICE_DATE as never }),
      ).rejects.toMatchObject({ code: "NOT_COSIGN_ELIGIBLE" });
      const enc = await admin.query("SELECT status, cosigned_at FROM encounter WHERE id=$1", [
        noteId,
      ]);
      expect(enc.rows[0]).toMatchObject({ status: "cosign_pending", cosigned_at: null });
    });

    it("the RN case manager cosigns: linkage names the cosigner (not the author), the encounter is cosigned and reaches the IDG feed", async () => {
      const done = await m8.cosignSign(ORG, noteId, CM, {
        isQualifiedRn: true,
        at: SERVICE_DATE as never,
      });
      expect(done.status).toBe("cosigned");
      const sig = await admin.query(
        `SELECT signed_by_membership_id, signed_by_discipline, session_id
           FROM encounter_signature WHERE encounter_id=$1 AND kind='cosignature'`,
        [noteId],
      );
      expect(sig.rows).toHaveLength(1);
      expect(sig.rows[0].signed_by_membership_id).toBe(cmMembership);
      expect(sig.rows[0].signed_by_membership_id).not.toBe(lpnMembership);
      expect(sig.rows[0].signed_by_discipline).toBe("rn");
      const author = await admin.query(
        "SELECT signed_by_membership_id FROM encounter_signature WHERE encounter_id=$1 AND kind<>'cosignature'",
        [noteId],
      );
      expect(author.rows[0].signed_by_membership_id).toBe(lpnMembership);
      expect(await eventsFor(noteId)).toContain("m8.encounter.cosigned");
      const cr = await m8.getCosignature(ORG, noteId);
      expect(cr.status).toBe("signed");

      const reader = createSignedEncountersReader(createDrizzleEncounterReaderStore(handle.db));
      const seen = (
        await reader.signedEncountersForPatientSince(
          ORG,
          PATIENT as never,
          new Date(NOW_MS - 30 * DAY_MS).toISOString(),
        )
      ).map((e) => e.encounterId as string);
      expect(seen).toContain(noteId); // cosigned => visible to the IDG
      expect(seen).not.toContain(pendingNoteId); // still awaiting cosign => not
    });

    // ── hop 5: IDG ─────────────────────────────────────────────────────────────────────────────────────
    it("an IDG cannot be adjourned without the step-up signoff: meeting stays live, decision stays open, nothing is emitted or reviewed", async () => {
      meetingId = await seedMeeting("live");
      await seedPacket(meetingId, PATIENT, ADMISSION, new Date(NOW_MS - 20 * DAY_MS).toISOString());
      await m14.recordAttendance(ORG, COORDINATOR, meetingId, {
        membershipId: COORDINATOR,
        discipline: "rn",
      });
      const decision = await m14.recordDecision(ORG, COORDINATOR, meetingId, {
        patientId: PATIENT,
        decisionKind: "care_plan_update",
        payload: {
          kind: "care_plan_update",
          mutations: [
            {
              op: "problem_update",
              problemId,
              updates: { description: "Dyspnea at rest, now with orthopnea" },
            },
          ],
        },
      });
      decisionId = decision.id;

      await expect(m14.adjournMeeting(ORG, COORDINATOR, meetingId, false)).rejects.toMatchObject({
        statusCode: 412,
      });
      expect(
        (await admin.query("SELECT status FROM idg_meeting WHERE id=$1", [meetingId])).rows[0]
          .status,
      ).toBe("live");
      expect(
        (await admin.query("SELECT status FROM idg_decision WHERE id=$1", [decisionId])).rows[0]
          .status,
      ).toBe("open");
      expect(await eventsFor(decisionId)).not.toContain("idg.decision_recorded");
      const pkt = await admin.query(
        "SELECT frozen_at, last_idg_reviewed_at FROM idg_patient_packet WHERE idg_meeting_id=$1",
        [meetingId],
      );
      expect(pkt.rows[0]).toMatchObject({ frozen_at: null, last_idg_reviewed_at: null });
    });

    it("adjourning with the signoff emits the decision, finalizes the minutes and resets the patient's review floor", async () => {
      const adjourned = await m14.adjournMeeting(ORG, COORDINATOR, meetingId, true);
      expect(adjourned.status).toBe("adjourned");
      expect(await eventsFor(decisionId)).toContain("idg.decision_recorded");
      const minutes = await m14.getMinutes(ORG, meetingId);
      expect(minutes.status).toBe("final");
      expect(minutes.decisionCount).toBe(1);
      expect(minutes.attendanceCount).toBe(1);
      const pkt = await admin.query(
        "SELECT frozen_at, last_idg_reviewed_at FROM idg_patient_packet WHERE idg_meeting_id=$1",
        [meetingId],
      );
      expect(pkt.rows[0].frozen_at).not.toBeNull();
      expect(pkt.rows[0].last_idg_reviewed_at).not.toBeNull();
    });

    it("the IDG outcome becomes the authoritative plan only after the M7 idg_review version is signed to quorum", async () => {
      // Real dispatcher: M14's real adjournment event -> M7's consumer.
      await dispatcher.tick();
      await dispatcher.tick();
      const [review] = (
        await admin.query(
          "SELECT id, version, status FROM care_plan_version WHERE care_plan_id=$1 AND kind='idg_review'",
          [planId],
        )
      ).rows;
      expect(review).toBeTruthy();
      const app = await admin.query(
        "SELECT status FROM care_plan_idg_decision_application WHERE idg_decision_id=$1",
        [decisionId],
      );
      expect(app.rows.length).toBe(1);
      // Proposal only: the authoritative problem row is unchanged and the active version is still the initial one.
      const before = await admin.query("SELECT description FROM problem WHERE id=$1", [problemId]);
      expect(before.rows[0].description).toBe("Dyspnea at rest");
      expect(
        (await admin.query("SELECT active_version_id FROM care_plan WHERE id=$1", [planId])).rows[0]
          .active_version_id,
      ).toBe(initialVersionId);

      await m7.finalizeVersion(ORG, planId, review.id as string, review.version as number, null);
      let version = (review.version as number) + 1;
      const at = new Date().toISOString();
      for (const role of ["rn_case_manager", "msw", "chaplain", "medical_director"] as const) {
        await m7.signVersion(ORG, planId, review.id as string, version, role, at, signerFor(role));
        version += 1;
      }
      const after = await admin.query("SELECT description FROM problem WHERE id=$1", [problemId]);
      expect(after.rows[0].description).toBe("Dyspnea at rest, now with orthopnea");
      expect(
        (await admin.query("SELECT active_version_id FROM care_plan WHERE id=$1", [planId])).rows[0]
          .active_version_id,
      ).toBe(review.id);
      expect(
        (
          await admin.query(
            "SELECT status FROM care_plan_idg_decision_application WHERE care_plan_version_id=$1",
            [review.id],
          )
        ).rows[0].status,
      ).toBe("applied");
      expect(
        (await admin.query("SELECT status FROM care_plan_version WHERE id=$1", [initialVersionId]))
          .rows[0].status,
      ).toBe("superseded");
    });

    // ── completeness / detectability ───────────────────────────────────────────────────────────────────
    it("DEFECT S05-4 — a meeting with zero attendees and no quorum can still be adjourned and resets the review floor", async () => {
      const patientId = randomUUID();
      const admissionId = randomUUID();
      const m = await seedMeeting("live");
      await seedPacket(m, patientId, admissionId, new Date(NOW_MS - 20 * DAY_MS).toISOString());
      const decision = await m14.recordDecision(ORG, COORDINATOR, m, {
        patientId,
        decisionKind: "care_plan_update",
        payload: {
          kind: "care_plan_update",
          mutations: [
            {
              op: "problem_add",
              icd10Code: null,
              snomedCode: null,
              description: "x",
              problemKind: "terminal",
            },
          ],
        },
      });
      expect(
        (await admin.query("SELECT was_quorate FROM idg_decision WHERE id=$1", [decision.id]))
          .rows[0].was_quorate,
      ).toBe(false);
      const adjourned = await m14.adjournMeeting(ORG, COORDINATOR, m, true);
      // Pinned: nobody attended, yet the meeting completes, the minutes are final and the 15-day floor advances.
      expect(adjourned.status).toBe("adjourned");
      expect((await m14.getMinutes(ORG, m)).attendanceCount).toBe(0);
      const pkt = await admin.query(
        "SELECT last_idg_reviewed_at FROM idg_patient_packet WHERE idg_meeting_id=$1",
        [m],
      );
      expect(pkt.rows[0].last_idg_reviewed_at).not.toBeNull();
    });

    it("an overdue IDG is detectable through the cadence rollup once a prior review exists", async () => {
      const patientId = randomUUID();
      const admissionId = randomUUID();
      const m = await seedMeeting("adjourned");
      await seedPacket(m, patientId, admissionId, new Date(NOW_MS - 40 * DAY_MS).toISOString());
      await admin.query(
        "UPDATE idg_patient_packet SET frozen_at=$1, last_idg_reviewed_at=$1 WHERE idg_meeting_id=$2",
        [new Date(NOW_MS - 25 * DAY_MS), m],
      );
      const provider = createIdgScheduleProvider(createDrizzleIdgSeamStore(handle.db));
      const adherence = await inCtx(() => provider.getCadenceAdherence(ORG, admissionId));
      expect(adherence.reviewCount).toBe(1);
      expect(adherence.longestGapDays).toBeGreaterThan(15);
      expect(adherence.isCompliant).toBe(false);
    });

    it("DEFECT S05-5 — an admission that has NEVER been in an IDG reads as compliant (missing IDG is invisible to the rollup)", async () => {
      const provider = createIdgScheduleProvider(createDrizzleIdgSeamStore(handle.db));
      // ADMISSION was activated 30 days ago; its packet was built for a meeting 20 days of cursor ago — use a fresh,
      // packet-less admission to model "no IDG ever convened for this patient".
      const adherence = await inCtx(() => provider.getCadenceAdherence(ORG, randomUUID()));
      expect(adherence).toMatchObject({ reviewCount: 0, admissionDayCount: 0, isCompliant: true });
    });

    it("the review-clock sweep escalates at T-3/T-0/T+1 only: a patient 25 days past the floor raises no alert (DEFECT S05-6)", async () => {
      const deps = (admissionId: string, patientId: string, activatedDaysAgo: number) =>
        buildM14WorkerDeps({
          connection: {} as never,
          db: handle.db,
          outbox: m14Outbox,
          activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
          activeAdmissions: {
            activeAdmissionsForOrg: async (_o: string, after: string | null) =>
              after === null
                ? [
                    {
                      admissionId,
                      patientId,
                      locationId,
                      activatedAtIso: new Date(NOW_MS - activatedDaysAgo * DAY_MS).toISOString(),
                    },
                  ]
                : [],
          },
        } as never);
      const escalated = async (patientId: string) =>
        (
          await admin.query(
            "SELECT payload FROM outbox_event WHERE event_type='m14.review_clock.escalated' AND payload->>'patientId'=$1",
            [patientId],
          )
        ).rows;

      // On the floor day (activated 15 days ago, never reviewed): detected, critical.
      const dueId = randomUUID();
      await runReviewClockSweepCron(deps(randomUUID(), dueId, 15));
      const due = await escalated(dueId);
      expect(due).toHaveLength(1);
      expect(due[0].payload).toMatchObject({
        stage: "t_zero",
        severity: "critical",
        lastIdgReviewedAt: null,
      });

      // 40 days since activation, never reviewed: 25 days overdue, and the sweep is silent.
      const lateId = randomUUID();
      await runReviewClockSweepCron(deps(randomUUID(), lateId, 40));
      expect(await escalated(lateId)).toHaveLength(0);
    });
  },
);
