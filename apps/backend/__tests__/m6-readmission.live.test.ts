/**
 * Readmission workflow, END TO END over real Postgres (the NOBYPASSRLS `wardenx_app` role, the real catalog-validating
 * outbox publisher and dispatcher):
 *
 *   discharge (live) → the patient's chart moves to discharged → readmission context suggests period 2 and reports
 *   the prior election open → readmit into period 2 (HETS-confirmed) → activation → M23 drafts the readmission's NOE
 *   (a re-election starts a new election whatever its sequence) → submitting it is REFUSED until the prior stay's
 *   NOTR is filed (Claims Processing Manual ch. 11 §20.1.6) → filed → accepted → the chart is active again.
 *
 * Plus: a period-3 readmission needs a face-to-face before activation unless exceptional circumstances are documented
 * (MBPM ch. 9 §20.1(5)(d)); a transfer-out keeps the period; the "recently discharged" worklist; a readmission must
 * name an earlier stay of the SAME patient.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m6:readmission:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type AbacContext, INTAKE_DEFAULT_GRANTS } from "@wardenx/auth";
import { createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildProviderEntityLocationLister } from "../src/bootstrap/provider-entity-resolver";
import { M5_OUTBOX_EVENTS } from "../src/modules/05-patient/events-by-m5";
import { buildM5AdmissionSitingConsumer } from "../src/modules/05-patient/outbox-consumers/m6-admission-activated";
import { buildM5AdmissionDischargedConsumer } from "../src/modules/05-patient/outbox-consumers/m6-admission-discharged";
import { buildAdmissionAbacPredicates } from "../src/modules/06-admission/abac-predicates";
import {
  createDbAdmissionAbacResolver,
  createDbAdmissionRouteService,
} from "../src/modules/06-admission/admission-route-service-db";
import { createDbDischargeWorklistService } from "../src/modules/06-admission/discharge-worklist-service-db";
import {
  M6_OUTBOX_EVENTS,
  admissionSchedulingContextForOrg,
  claimAssemblyRangeContextForOrg,
  createDbReadmissionService,
  createDrizzleAdmissionReaderStore,
  electionPeriodContextForOrg,
  latestLiveEndedEpisode,
  priorEpisodesForOrg,
  registerAdmissionSeams,
} from "../src/modules/06-admission/index";
import { loadPriorEpisodes } from "../src/modules/06-admission/seams/prior-episodes";
import { M10_OUTBOX_EVENTS } from "../src/modules/10-hope/index";
import { M11_OUTBOX_EVENTS } from "../src/modules/11-orders/index";
import { M12_OUTBOX_EVENTS } from "../src/modules/12-dosespot/index";
import { M13_OUTBOX_EVENTS } from "../src/modules/13-emar/index";
import { M14_OUTBOX_EVENTS } from "../src/modules/14-idg/index";
import { M15_OUTBOX_EVENTS } from "../src/modules/15-discipline-care-plans/index";
import { M16_OUTBOX_EVENTS } from "../src/modules/16-bereavement/index";
import { M20_OUTBOX_EVENTS } from "../src/modules/20-field-safety/index";
import { M21_OUTBOX_EVENTS } from "../src/modules/21-supplies/index";
import { M22_OUTBOX_EVENTS } from "../src/modules/22-documents/index";
import {
  M23_OUTBOX_EVENTS,
  buildDrizzleM23WriteService,
  buildM23NoeDraftConsumer,
  buildM23NotrDraftConsumer,
  priorElectionClosureForOrg,
} from "../src/modules/23-billing-medicare/index";
import {
  type M23WorkerDeps,
  type Parsed999,
  runAckPull999,
  runNotrSubmit,
} from "../src/modules/23-billing-medicare/jobs/m23-jobs";
import { readClaimRhcCarryOver } from "../src/modules/23-billing-medicare/services/rhc-carry-over";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/index";
import { M27_OUTBOX_EVENTS } from "../src/modules/27-cost-report/index";
import { M33_OUTBOX_EVENTS } from "../src/modules/33-reporting/index";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { registerM5IntakeSeams, seedM5Patient } from "./_m6-admit";

const CTI_CLINICAL = {
  terminalDiagnosisIcd10: "C34.90",
  prognosisStatement:
    "Life expectancy of 6 months or less if the terminal illness runs its normal course.",
  narrative:
    "Metastatic non-small-cell lung cancer with progressive functional decline despite treatment; patient has elected comfort-focused care.",
  clinicalFindings: { ppsScore: 40, weightLossPercent6mo: 12, dyspneaAtRest: true },
};

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const ATTENDING = "77777777-7777-7777-7777-777777777777";
const MD = "66666666-6666-6666-6666-666666666666";
const SIGN = { signingPatientName: "Pat Patient", signingRole: "patient" } as const;
const WRITE_ACTOR = {
  organizationId: ORG,
  userId: USER,
  roles: ["billing_specialist"],
  membershipId: USER,
  stepUpRecent: true,
  actorKind: "user",
};

const today = () => new Date().toISOString().slice(0, 10);
const never = (): never => {
  throw new Error("expected a claim-range admission");
};
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!DB_URL)("Readmission workflow — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbAdmissionRouteService>;
  let readmission: ReturnType<typeof createDbReadmissionService>;
  let m23: ReturnType<typeof buildDrizzleM23WriteService>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let m5Siting: ReturnType<typeof buildM5AdmissionSitingConsumer>;
  let m5Discharged: ReturnType<typeof buildM5AdmissionDischargedConsumer>;
  let providerId = "";
  const noeSkips: { reason: string; electionPeriodId: string }[] = [];
  // The M23 ack-pull cron's bundle: the real catalog-validating publisher, the x12 / MAC wires faked.
  let workerDeps: M23WorkerDeps;
  const alerts: { alertCode: string; payload: Record<string, unknown> }[] = [];
  let parsed999: Parsed999[] = [];

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
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }
  async function one<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T> {
    const { rows } = await admin.query(sql, params);
    return rows[0] as T;
  }
  async function periodsOf(admissionId: string) {
    const { rows } = await admin.query(
      `SELECT id, sequence_number, period_kind, status, benefit_period_source, benefit_period_suggested,
              benefit_period_confirmed_by, benefit_period_confirmed_on::text AS confirmed_on, f2f_exception_reason
         FROM election_period WHERE admission_id=$1 ORDER BY sequence_number`,
      [admissionId],
    );
    return rows;
  }
  async function patientStatus(patientId: string): Promise<string> {
    return (await one<{ status: string }>("SELECT status FROM patient WHERE id=$1", [patientId]))
      .status;
  }
  /** Hand the latest `eventType` row M6 wrote for `aggregateId` to an M5 consumer. */
  async function deliver(
    consumer: { handle(e: { organizationId: string; payload: unknown }): Promise<unknown> },
    eventType: string,
    aggregateId: string,
  ) {
    const row = await one<{ organization_id: string; payload: unknown }>(
      `SELECT organization_id, payload FROM outbox_event WHERE event_type=$1 AND aggregate_id=$2
        ORDER BY created_at DESC LIMIT 1`,
      [eventType, aggregateId],
    );
    return consumer.handle({ organizationId: row.organization_id, payload: row.payload });
  }

  /** Referral → qualify → convert (with an optional first benefit period) → admission details. */
  async function admit(
    patientId: string,
    first: Record<string, unknown> = {},
    admissionAt = `${daysAgo(1)}T00:00:00.000Z`,
  ): Promise<string> {
    await seedM5Patient(admin, ORG, patientId);
    const ref = await svc.createReferral(
      ORG,
      {
        source: "phone",
        receivedAt: new Date().toISOString(),
        receivingUserId: USER,
        patientNameAtReceipt: "P",
        patientId,
        referrerName: "Dr. Referrer",
        referringDxText: "Metastatic NSCLC",
      } as never,
      USER,
    );
    await svc.triageReferral(ORG, ref.id, "eligible", 0);
    await svc.qualifyReferral(ORG, ref.id, 1, USER);
    const { admissionId } = await svc.acceptReferral(
      ORG,
      ref.id,
      { primaryDiagnosisIcd10: "C34.90", patientId, ...first } as never,
      2,
      USER,
    );
    const { version } = await one<{ version: string }>(
      "SELECT version FROM admission WHERE id=$1",
      [admissionId],
    );
    await svc.updateAdmission(
      ORG,
      admissionId,
      { admissionAt, hospicePhysicianId: MD },
      Number(version),
    );
    return admissionId;
  }

  /** NOR + signed election + signed CTI (the §418.24 bundle), then activation. */
  async function completeAndActivate(admissionId: string): Promise<void> {
    const periods = await periodsOf(admissionId);
    const periodId = periods[0].id as string;
    const nor = await svc.acknowledgeNor(
      ORG,
      admissionId,
      { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
      USER,
    );
    const es = await svc.draftElectionStatement(ORG, admissionId, periodId, {
      electedProviderEntityId: providerId,
      electedAttendingPhysicianId: ATTENDING,
      waiverAcknowledged: true,
    });
    await svc.signElection(ORG, es.id, es.version, USER, SIGN);
    const cti = await svc.draftCti(
      ORG,
      {
        electionPeriodId: periodId,
        hospiceMedicalDirectorId: MD,
        attendingPhysicianId: ATTENDING,
        ...CTI_CLINICAL,
        isRecert: false,
      },
      USER,
    );
    await svc.signCtiHospiceMd(ORG, cti.id, cti.version, USER);
    await svc.activateAdmission(ORG, admissionId, nor.version);
  }

  async function dischargeLive(admissionId: string, dischargeDate = daysAgo(1)): Promise<void> {
    const adm = await svc.getAdmission(ORG, admissionId);
    await svc.discharge(
      ORG,
      admissionId,
      {
        reason: "no_longer_terminal",
        dischargeDate,
        narrative:
          "The patient's condition stabilized; no longer terminally ill per the IDG review.",
        ifVersion: adm?.version,
      } as never,
      USER,
    );
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG, ORG_B],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'rd@x.test'),($2,'rdmd@x.test'),($3,'rdat@x.test')`,
      [USER, MD, ATTENDING],
    );
    providerId = (
      await one<{ id: string }>(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,'H11111','Hospice A','NPI-1111','\\x00','12-31') RETURNING id`,
        [ORG],
      )
    ).id;
    await admin.query(
      `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone, status)
         VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles','active')`,
      [providerId],
    );
    for (const org of [ORG, ORG_B])
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
        [USER, org],
      );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    registerM5IntakeSeams(handle.db);
    registerAdmissionSeams({ store: createDrizzleAdmissionReaderStore(handle.db) });

    const catalog = buildBootOutboxCatalog([
      M5_OUTBOX_EVENTS,
      M6_OUTBOX_EVENTS,
      M10_OUTBOX_EVENTS,
      M11_OUTBOX_EVENTS,
      M12_OUTBOX_EVENTS,
      M13_OUTBOX_EVENTS,
      M14_OUTBOX_EVENTS,
      M15_OUTBOX_EVENTS,
      M16_OUTBOX_EVENTS,
      M20_OUTBOX_EVENTS,
      M21_OUTBOX_EVENTS,
      M22_OUTBOX_EVENTS,
      M23_OUTBOX_EVENTS,
      M25_OUTBOX_EVENTS,
      M27_OUTBOX_EVENTS,
      M33_OUTBOX_EVENTS,
      M37_OUTBOX_EVENTS,
    ]);
    const publisher = buildTxOutboxPublisher(catalog);
    const bind = (module: string) => ({
      publish: (tx: unknown, e: Record<string, unknown>) =>
        publisher.publish(tx as never, { ...e, callerModule: module } as never),
    });

    svc = createDbAdmissionRouteService(
      handle.db,
      bind("m6") as never,
      undefined,
      {
        async belongsToOrg(organizationId: string, providerEntityId: string) {
          const { rows } = await admin.query(
            "SELECT 1 FROM provider_entity WHERE id=$1 AND organization_id=$2",
            [providerEntityId, organizationId],
          );
          return rows.length > 0;
        },
      },
      { activeLocationsFor: buildProviderEntityLocationLister(handle.db) },
    );
    // The PRODUCTION bindings of the two cross-module facts (apps/backend/src/index.ts).
    readmission = createDbReadmissionService(handle.db, {
      closureFor: (organizationId, q) =>
        priorElectionClosureForOrg(handle.db as never, organizationId, q),
    });
    m23 = buildDrizzleM23WriteService(handle.db as never, {
      outbox: bind("m23") as never,
      jobs: { enqueue: async () => ({ jobId: randomUUID() }) },
      priorLiveEndedStay: {
        async latestPriorLiveEndedAdmission(organizationId, q) {
          const prior = latestLiveEndedEpisode(
            await priorEpisodesForOrg(handle.db, organizationId, q.patientId, q.currentAdmissionId),
          );
          return prior ? { admissionId: prior.admissionId } : null;
        },
      },
    });

    const orgs: ActiveOrgEnumerator = { listActiveOrgs: async () => [{ organizationId: ORG }] };
    const resolveCcn = async () => "H11111";
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [
        buildM23NoeDraftConsumer({
          db: handle.db as never,
          outbox: bind("m23") as never,
          resolveElectionPeriod: async (organizationId, electionPeriodId) =>
            electionPeriodContextForOrg(handle.db, organizationId, electionPeriodId),
          resolveCcn,
          onSkipped: (info) => noeSkips.push(info),
        }),
        buildM23NotrDraftConsumer({
          db: handle.db as never,
          outbox: bind("m23") as never,
          resolveAdmission: async (organizationId, admissionId) =>
            admissionSchedulingContextForOrg(handle.db, organizationId, admissionId),
          resolveCcn,
        }),
      ],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
    workerDeps = {
      connection: {} as never,
      db: handle.db as never,
      outbox: bind("m23") as never,
      alerts: { dispatch: async (a) => void alerts.push(a) },
      x12: {
        generate837i: async () => ({ x12: "", correlationId: "" }),
        generateNoe: async () => ({ x12: "", correlationId: "" }),
        generateNotr: async (input) => ({ x12: "ISA*...~", correlationId: `corr-${input.notrId}` }),
        parse999: async () => parsed999,
        parse277ca: async () => [],
      },
      macPortal: {
        upload: async (input) => ({
          accepted: true,
          generatedFileUri: `s3://notices/${input.controlNumber}.x12`,
        }),
        pullPending999: async () => [{ rawFileUri: "s3://acks/999.x12" }],
        pullPending277ca: async () => [],
        probeHealth: async () => true,
      },
      jurisdictions: { listJurisdictions: async () => [{ macJurisdiction: "ngs_j6" }] },
    };
    const m5Publisher = { publish: (tx: never, input: never) => bind("m5").publish(tx, input) };
    m5Siting = buildM5AdmissionSitingConsumer({ db: handle.db, outbox: m5Publisher as never });
    m5Discharged = buildM5AdmissionDischargedConsumer({
      db: handle.db,
      outbox: m5Publisher as never,
    });
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("discharge → readmit in period 2 → activation → NOE blocked until the prior NOTR → patient active", async () => {
    const patientId = randomUUID();
    // ── first election: period 1, live discharge ──
    const first = await admit(patientId, {}, `${daysAgo(30)}T00:00:00.000Z`);
    expect((await periodsOf(first))[0]).toMatchObject({
      sequence_number: 1,
      benefit_period_source: "internal_history",
    });
    await completeAndActivate(first);
    await deliver(m5Siting, "m6.admission.activated", first);
    await dischargeLive(first, daysAgo(5));
    await deliver(m5Discharged, "m6.admission.discharged", first);
    expect(await patientStatus(patientId)).toBe("discharged");
    await dispatcher.tick(); // M23 drafts the first NOE and the discharge NOTR

    // ── the readmission context ──
    const ctx = await readmission.getReadmissionContext(ORG, first, {});
    expect(ctx?.readmission).toEqual({ eligible: true, blockers: [] });
    expect(ctx?.previous).toMatchObject({ endKind: "live_discharge", lastSequence: 1 });
    expect(ctx?.suggestion).toMatchObject({
      suggestedSequence: 2,
      basis: "next_after_live_discharge",
    });
    expect(ctx?.requirements).toMatchObject({ sequence: 2, periodKind: "ninety_day" });
    expect(ctx?.requirements.certification.attendingIfDesignated).toBe(false);
    expect(ctx?.rhc.applies).toBe(true);
    expect(ctx?.priorElectionClosure).toMatchObject({ admissionId: first, status: "not_filed" });
    expect(ctx?.noeBlocked).toBe(true);

    // ── readmit into period 2, HETS-confirmed ──
    const second = await admit(patientId, {
      benefitPeriod: { sequence: 2, source: "hets_confirmed", confirmedOn: today() },
    });
    const [p2] = await periodsOf(second);
    expect(p2).toMatchObject({
      sequence_number: 2,
      period_kind: "ninety_day",
      benefit_period_source: "hets_confirmed",
      benefit_period_suggested: 2,
      benefit_period_confirmed_by: USER,
      confirmed_on: today(),
    });
    await completeAndActivate(second);
    const after = await periodsOf(second);
    expect(after[0].status).toBe("active");

    // M23 drafts the readmission's NOE although its sequence is 2: a re-election starts a new election.
    await dispatcher.tick();
    const noe = await one<{ id: string; state: string }>(
      "SELECT id, state FROM noe_record WHERE admission_id=$1",
      [second],
    );
    expect(noe?.state).toBe("DRAFT");
    expect(noeSkips.filter((s) => s.electionPeriodId === p2.id)).toHaveLength(0);

    // ── the NOE waits for the prior election's close-out ──
    await expect(m23.submitNoe(WRITE_ACTOR as never, noe.id)).rejects.toMatchObject({
      code: "PRIOR_ELECTION_NOT_CLOSED",
      statusCode: 409,
    });
    const notr = await one<{ id: string }>("SELECT id FROM notr_record WHERE admission_id=$1", [
      first,
    ]);
    expect(notr).toBeDefined();
    await admin.query("UPDATE notr_record SET state='SUBMITTED' WHERE id=$1", [notr.id]);
    expect((await readmission.getReadmissionContext(ORG, first, {}))?.noeBlocked).toBe(false);
    const accepted = await m23.submitNoe(WRITE_ACTOR as never, noe.id);
    expect(accepted.kind).toBe("noe");

    // ── two-tier RHC: the 26-day first stay (both ends inclusive, ch. 11 §30.2) carries into the readmission's
    //    day count (claim assembly read) ──
    const range = await claimAssemblyRangeContextForOrg(handle.db, ORG, patientId, {
      from: today(),
      to: today(),
    });
    expect(range?.admission.admissionId).toBe(second);
    expect(range?.admission.rhcPriorHospiceDays).toBe(26);
    expect(range?.admission.rhcPriorStays).toEqual([
      { admissionId: first, startedOn: daysAgo(30), endedOn: daysAgo(5) },
    ]);

    // ── …merged with another hospice's period from HETS (CWF is beneficiary-level): 10 days that ended 20 days
    //    before our first stay. The claim assembly's carry-over read (M23's own eligibility_check, as wardenx_app).
    const hetsPayload = {
      hospicePeriods: [
        {
          kind: "benefit_period",
          periodNumber: null,
          startDate: daysAgo(59),
          endDate: daysAgo(50),
          hospiceNpi: "1649726464",
          revocationOrDischargeDate: daysAgo(50),
          revocationCode: "1",
          daysUsed: 10,
        },
      ],
      hospiceHistoryTruncated: false,
      transport: "sandbox",
    };
    await admin.query(
      `INSERT INTO eligibility_check (organization_id, provider_entity_id, patient_id, as_of_service_date, outcome,
                                      parsed_payload, checked_at, stale_at)
         VALUES ($1, $2, $3, $4, 'active_part_a', $5, now(), now() + interval '30 days')`,
      [ORG, providerId, patientId, today(), JSON.stringify(hetsPayload)],
    );
    const carry = await withOrgContext(handle.db, { organizationId: ORG, userId: USER }, (tx) =>
      readClaimRhcCarryOver(tx as never, ORG, patientId, range?.admission ?? never(), new Date()),
    );
    expect(carry).toMatchObject({ priorDays: 36, basis: "hets_merged" });
    expect(carry.chain.map((c) => [c.source, c.countedDays])).toEqual([
      ["hets", 10],
      ["internal", 26],
    ]);

    // ── the chart is under care again ──
    await deliver(m5Siting, "m6.admission.activated", second);
    expect(await patientStatus(patientId)).toBe("active");
  }, 120_000);

  it("a NOTR the MAC REJECTS stops closing the prior election: the readmission's NOE is blocked again", async () => {
    const patientId = randomUUID();
    const first = await admit(patientId, {}, `${daysAgo(30)}T00:00:00.000Z`);
    await completeAndActivate(first);
    await deliver(m5Siting, "m6.admission.activated", first);
    await dischargeLive(first, daysAgo(5));
    await deliver(m5Discharged, "m6.admission.discharged", first);
    await dispatcher.tick(); // the first NOE and the discharge NOTR
    const second = await admit(patientId, {
      benefitPeriod: { sequence: 2, source: "hets_confirmed", confirmedOn: today() },
    });
    await completeAndActivate(second);
    await dispatcher.tick(); // the readmission's NOE
    const noe = await one<{ id: string }>("SELECT id FROM noe_record WHERE admission_id=$1", [
      second,
    ]);
    const notr = await one<{ id: string; notr_control_number: string }>(
      "SELECT id, notr_control_number FROM notr_record WHERE admission_id=$1",
      [first],
    );

    // File the prior stay's NOTR for real: the route queues it, the `notr.submit` processor transmits it.
    const queued = await m23.submitNotr(WRITE_ACTOR as never, notr.id);
    expect(queued.kind).toBe("notr");
    await withOrgContext(handle.db, { organizationId: ORG, userId: "" }, (tx) =>
      runNotrSubmit(tx as never, workerDeps, { organizationId: ORG, notrId: notr.id }),
    );
    const submission = await one<{ id: string }>(
      "SELECT id FROM claim_submission WHERE notr_id=$1 AND kind='notr' AND outcome='submitted'",
      [notr.id],
    );
    // The route's QUEUED attempt is the one the worker transmitted (terminalized, not left queued).
    expect(submission?.id).toBe(queued.submissionId);
    expect((await readmission.getReadmissionContext(ORG, first, {}))?.noeBlocked).toBe(false);

    // The MAC's 999 rejects the NOTR file.
    alerts.length = 0;
    parsed999 = [
      {
        organizationId: ORG,
        claimId: "",
        submissionId: submission.id,
        claimControlNumber: notr.notr_control_number,
        accepted: false,
        reasonCodes: ["IK5:R"],
        ackFileUri: `s3://acks/999/${notr.id}.json`,
      },
    ];
    await runAckPull999(workerDeps);

    expect(
      await one(
        "SELECT state, rejection_stage, rejection_codes, rejected_at IS NOT NULL AS stamped FROM notr_record WHERE id=$1",
        [notr.id],
      ),
    ).toEqual({
      state: "ACK_REJECTED",
      rejection_stage: "999",
      rejection_codes: ["IK5:R"],
      stamped: true,
    });
    expect(
      (
        await admin.query(
          "SELECT 1 FROM outbox_event WHERE event_type='m23.notr.rejected' AND payload->>'notrId'=$1",
          [notr.id],
        )
      ).rows,
    ).toHaveLength(1);
    expect(alerts.map((a) => [a.alertCode, a.payload.notrId])).toEqual([
      ["m23.notr.rejected", notr.id],
    ]);

    // The prior election is open again: Medicare would reject the readmission's NOE.
    const ctx = await readmission.getReadmissionContext(ORG, first, {});
    expect(ctx?.priorElectionClosure).toMatchObject({ admissionId: first, status: "not_filed" });
    expect(ctx?.noeBlocked).toBe(true);
    await expect(m23.submitNoe(WRITE_ACTOR as never, noe.id)).rejects.toMatchObject({
      code: "PRIOR_ELECTION_NOT_CLOSED",
      statusCode: 409,
    });
  }, 120_000);

  it("a period-3 readmission needs a face-to-face before activation, unless exceptional circumstances are documented", async () => {
    const patientId = randomUUID();
    const first = await admit(patientId, {}, `${daysAgo(20)}T00:00:00.000Z`);
    await completeAndActivate(first);
    await dischargeLive(first, daysAgo(3));

    const blocked = await admit(patientId, {
      benefitPeriod: { sequence: 3, source: "staff_entered_unverified" },
    });
    expect((await periodsOf(blocked))[0]).toMatchObject({
      sequence_number: 3,
      period_kind: "sixty_day",
      benefit_period_suggested: 2,
    });
    const readiness = await svc.getAdmissionReadiness(ORG, blocked);
    expect(readiness?.requirements.find((r) => r.code === "f2f")).toMatchObject({
      blocking: true,
      status: "action_required",
    });
    // Activation is refused by the R-AC-01 readiness gate (412), and the CTI signature did NOT activate the
    // period as if it were a recertification.
    await expect(completeAndActivate(blocked)).rejects.toMatchObject({
      code: "ADMISSION_NOT_READY",
      statusCode: 412,
    });
    expect((await periodsOf(blocked))[0].status).not.toBe("active");

    // The exception path, on another patient (the blocked admission above stays open for this one).
    const other = randomUUID();
    const prior = await admit(other, {}, `${daysAgo(20)}T00:00:00.000Z`);
    await completeAndActivate(prior);
    await dischargeLive(prior, daysAgo(3));
    const excepted = await admit(other, {
      benefitPeriod: { sequence: 3, source: "staff_entered_unverified" },
      f2fException: { reason: "Weekend emergency admission; no hospice physician available" },
    });
    expect((await periodsOf(excepted))[0].f2f_exception_reason).toContain("Weekend");
    const r2 = await svc.getAdmissionReadiness(ORG, excepted);
    expect(r2?.requirements.find((r) => r.code === "f2f")).toMatchObject({
      blocking: false,
      status: "pending",
    });
    await completeAndActivate(excepted);
    expect((await periodsOf(excepted))[0].status).toBe("active");

    // The M6→M23 claim-range seam carries the documented exception, so M23's `f2f_attested_for_recert` can
    // deem the F2F complete on a death within 2 days (MBPM ch. 9 §20.1(5)(d)) — no cross-module table read.
    const range = await claimAssemblyRangeContextForOrg(handle.db, ORG, other, {
      from: today(),
      to: today(),
    });
    expect(range?.admission.admissionId).toBe(excepted);
    expect(range?.electionPeriods).toEqual([
      expect.objectContaining({ sequence: 3, f2fExceptionDocumented: true }),
    ]);
    const plain = await claimAssemblyRangeContextForOrg(handle.db, ORG, other, {
      from: daysAgo(15),
      to: daysAgo(15),
    });
    expect(plain?.electionPeriods.every((p) => p.f2fExceptionDocumented === false)).toBe(true);
  }, 120_000);

  it("a transfer out keeps the benefit period; the recently-discharged worklist lists the live ending", async () => {
    const patientId = randomUUID();
    const admissionId = await admit(patientId, {}, `${daysAgo(10)}T00:00:00.000Z`);
    await completeAndActivate(admissionId);
    await svc.transferOut(
      ORG,
      admissionId,
      {
        effectiveDate: daysAgo(1),
        otherHospiceName: "Sunrise Hospice",
        receivingCareSetting: "home",
        otherHospiceCcn: "391234",
        narrative: "patient relocated closer to family; care transferred by mutual agreement",
      } as never,
      USER,
    );
    const plan = await readmission.getPatientBenefitPeriodPlan(ORG, patientId, {});
    expect(plan.suggestion).toMatchObject({ suggestedSequence: 1, basis: "same_after_transfer" });
    expect(plan.previous?.transfer).toBe(true);

    const worklist = createDbDischargeWorklistService(handle.db);
    const page = await worklist.list(
      ORG,
      { bucket: "recently_discharged", limit: 200 },
      { patientIds: null },
    );
    const row = page.items.find((i) => i.admissionId === admissionId);
    expect(row).toMatchObject({ dischargeType: "transfer_out", effectiveDate: daysAgo(1) });

    // Once readmitted, the stay is no longer a readmission candidate.
    await admit(patientId);
    const again = await worklist.list(
      ORG,
      { bucket: "recently_discharged", limit: 200 },
      { patientIds: null },
    );
    expect(again.items.find((i) => i.admissionId === admissionId)).toBeUndefined();
  }, 120_000);

  it("a readmission must name an earlier, live-ended stay of the SAME patient", async () => {
    const a = randomUUID();
    const b = randomUUID();
    const stayOfA = await admit(a, {}, `${daysAgo(10)}T00:00:00.000Z`);
    await completeAndActivate(stayOfA);
    await dischargeLive(stayOfA);
    await seedM5Patient(admin, ORG, b);
    await expect(
      svc.createAdmission(
        ORG,
        {
          patientId: b,
          intakeMethod: "in_person",
          hospiceMedicalDirectorId: MD,
          readmittedFromAdmissionId: stayOfA,
        },
        USER,
      ),
    ).rejects.toMatchObject({ code: "READMISSION_SOURCE_INVALID", statusCode: 409 });

    // The direct-intake path records the link, the period and how it was established.
    const direct = await svc.createAdmission(
      ORG,
      {
        patientId: a,
        intakeMethod: "in_person",
        hospiceMedicalDirectorId: MD,
        readmittedFromAdmissionId: stayOfA,
        admissionDate: today(),
      },
      USER,
    );
    const adm = await one<{ readmitted_from_admission_id: string; admission_at: Date }>(
      "SELECT readmitted_from_admission_id, admission_at FROM admission WHERE id=$1",
      [direct.id],
    );
    expect(adm.readmitted_from_admission_id).toBe(stayOfA);
    expect((await periodsOf(direct.id))[0]).toMatchObject({
      sequence_number: 2,
      benefit_period_source: "internal_history",
    });
  }, 120_000);

  it("cross-tenant: another org can neither read, suggest from, nor readmit from this org's stays", async () => {
    // Arrange: a live-ended stay in ORG (A); a patient of ORG_B.
    const patientA = randomUUID();
    const stayOfA = await admit(patientA, {}, `${daysAgo(10)}T00:00:00.000Z`);
    await completeAndActivate(stayOfA);
    await dischargeLive(stayOfA);
    const patientB = randomUUID();
    await seedM5Patient(admin, ORG_B, patientB);

    // The readmission context of A's stay is invisible from ORG_B (RLS as wardenx_app + explicit org predicate).
    expect(await readmission.getReadmissionContext(ORG_B, stayOfA, {})).toBeNull();
    // ORG_B's plan for A's patient knows nothing of A's history.
    const plan = await readmission.getPatientBenefitPeriodPlan(ORG_B, patientA, {});
    expect(plan.previous).toBeNull();
    expect(plan.suggestion.suggestedSequence).toBe(1);
    // ORG_B cannot name A's stay as a readmission source, for its own patient or for A's patient id.
    for (const patientId of [patientB, patientA]) {
      await expect(
        svc.createAdmission(
          ORG_B,
          {
            patientId,
            intakeMethod: "in_person",
            hospiceMedicalDirectorId: MD,
            readmittedFromAdmissionId: stayOfA,
          },
          USER,
        ),
      ).rejects.toMatchObject({
        code: patientId === patientB ? "READMISSION_SOURCE_INVALID" : "PATIENT_NOT_FOUND",
      });
    }
    // A direct intake in ORG for ORG_B's patient is refused (the body's patient must belong to the caller's org).
    await expect(
      svc.createAdmission(
        ORG,
        { patientId: patientB, intakeMethod: "in_person", hospiceMedicalDirectorId: MD },
        USER,
      ),
    ).rejects.toMatchObject({ code: "PATIENT_NOT_FOUND" });
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM admission WHERE readmitted_from_admission_id=$1",
      [stayOfA],
    );
    expect(rows[0].n).toBe(0);

    // The explicit org predicate holds even on a connection that BYPASSES RLS (superuser = system paths).
    const superuser = createDbClient({ connectionString: DB_URL as string });
    try {
      expect(await loadPriorEpisodes(superuser.db, ORG_B, patientA)).toHaveLength(0);
      expect(await loadPriorEpisodes(superuser.db, ORG, patientA)).toHaveLength(1);
    } finally {
      await superuser.close();
    }
  }, 120_000);
  it("admission_intake_scope as wardenx_app: intake reaches its own org's readmission candidate only", async () => {
    // Arrange: ORG has a live-discharged stay (patientFree) and an ACTIVE stay (patientActive); ORG_B has a patient.
    const patientFree = randomUUID();
    const stayFree = await admit(patientFree, {}, `${daysAgo(10)}T00:00:00.000Z`);
    await completeAndActivate(stayFree);
    await dischargeLive(stayFree);
    const patientActive = randomUUID();
    const stayActive = await admit(patientActive);
    await completeAndActivate(stayActive);
    const patientB = randomUUID();
    await seedM5Patient(admin, ORG_B, patientB);

    // The predicate over the REAL Drizzle resolver on the NOBYPASSRLS app-role connection (`handle`).
    const predicate = buildAdmissionAbacPredicates({
      resolver: createDbAdmissionAbacResolver(handle.db),
      isInCaseload: async () => false,
    }).admission_intake_scope as (c: AbacContext, t: Record<string, unknown>) => Promise<boolean>;
    const ctx = (organizationId: string, roles: string[]) =>
      ({
        organizationId,
        userId: USER,
        roles,
        providerEntityIds: [],
        locationIds: [],
        attributes: {},
      }) as unknown as AbacContext;

    // intake + own org + no active admission → allow (by patient, and by the earlier stay)
    expect(await predicate(ctx(ORG, ["intake_coordinator"]), { patientId: patientFree })).toBe(
      true,
    );
    expect(await predicate(ctx(ORG, ["intake_supervisor"]), { admissionId: stayFree })).toBe(true);
    // an active admission → deny
    expect(await predicate(ctx(ORG, ["intake_coordinator"]), { patientId: patientActive })).toBe(
      false,
    );
    // cross-tenant, both directions → deny (M5's org-scoped read + RLS on admission)
    expect(await predicate(ctx(ORG_B, ["intake_coordinator"]), { patientId: patientFree })).toBe(
      false,
    );
    expect(await predicate(ctx(ORG_B, ["intake_coordinator"]), { admissionId: stayFree })).toBe(
      false,
    );
    expect(await predicate(ctx(ORG, ["intake_coordinator"]), { patientId: patientB })).toBe(false);
    // ORG_B's intake user reaches ORG_B's own patient
    expect(await predicate(ctx(ORG_B, ["intake_coordinator"]), { patientId: patientB })).toBe(true);
    // no intake role → deny
    expect(await predicate(ctx(ORG, ["rn"]), { patientId: patientFree })).toBe(false);
  }, 120_000);

  it("MIGRATION 0374: grants the intake roles their readmission-flow keys ONLY where the role exists, idempotently — pinned to INTAKE_DEFAULT_GRANTS", async () => {
    const sqlText = readFileSync(
      join(MIGRATIONS_DIR, "0374_m6_intake_default_role_grants.sql"),
      "utf8",
    );
    // The migration's VALUES table IS the constant (a drift here is a silent permission change).
    const fromSql: Record<string, string[]> = {};
    for (const m of sqlText.matchAll(/\('([a-z_]+)',\s*'([a-z_.]+)'\)/g)) {
      const role = m[1] as string;
      fromSql[role] ??= [];
      fromSql[role].push(m[2] as string);
    }
    const sorted = (o: Record<string, readonly string[]>) =>
      Object.fromEntries(Object.entries(o).map(([r, k]) => [r, [...k].sort()]));
    expect(sorted(fromSql)).toEqual(sorted(INTAKE_DEFAULT_GRANTS));
    // Read-only eligibility: the check (a live HETS round-trip) is never granted.
    expect(Object.values(fromSql).flat()).not.toContain("billing.eligibility.check");

    const role = async (org: string, key: string) =>
      (
        await one<{ id: string }>(
          `INSERT INTO role (organization_id, key, name, category) VALUES ($1,$2,$2,'operations')
           ON CONFLICT DO NOTHING RETURNING id`,
          [org, key],
        )
      )?.id ??
      (
        await one<{ id: string }>("SELECT id FROM role WHERE organization_id=$1 AND key=$2", [
          org,
          key,
        ])
      ).id;
    const coordA = await role(ORG, "intake_coordinator");
    const supA = await role(ORG, "intake_supervisor");
    const rnA = await role(ORG, "rn_intake_test");
    const coordB = await role(ORG_B, "intake_coordinator");
    // ORG_B never created `intake_supervisor` — it must get nothing for it.

    await admin.query(sqlText);
    await admin.query(sqlText); // idempotent

    const keysOf = async (roleId: string) =>
      (
        await admin.query(
          "SELECT permission_key FROM role_permission WHERE role_id=$1 ORDER BY permission_key",
          [roleId],
        )
      ).rows.map((r) => r.permission_key as string);
    expect(await keysOf(coordA)).toEqual([...INTAKE_DEFAULT_GRANTS.intake_coordinator].sort());
    expect(await keysOf(supA)).toEqual([...INTAKE_DEFAULT_GRANTS.intake_supervisor].sort());
    expect(await keysOf(coordB)).toEqual([...INTAKE_DEFAULT_GRANTS.intake_coordinator].sort());
    expect(await keysOf(rnA)).toEqual([]);
    const supB = await admin.query(
      "SELECT 1 FROM role WHERE organization_id=$1 AND key='intake_supervisor'",
      [ORG_B],
    );
    expect(supB.rowCount).toBe(0);
    // every grant row carries its role's own org (the three-column tenancy rule)
    const mismatched = await admin.query(
      `SELECT count(*)::int AS n FROM role_permission rp JOIN role r ON r.id = rp.role_id
        WHERE r.key IN ('intake_coordinator','intake_supervisor') AND rp.organization_id <> r.organization_id`,
    );
    expect(mismatched.rows[0].n).toBe(0);
  });
});
