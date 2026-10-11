/**
 * F-106 — the Medicare Notice of Election, END TO END over real Postgres.
 *
 * The NOE tells Medicare a beneficiary has elected the hospice benefit. CMS requires it within FIVE
 * CALENDAR DAYS of the election effective date; miss the window and the hospice forfeits payment for every
 * day from the election start until the NOE is accepted (42 CFR 418.24(b), CR 8877). `noe_record.
 * window_target_at` carries that deadline and its schema comment spells the arithmetic out.
 *
 * `NoeRepository.create` had NO CALLER anywhere in the repository — not production code, not one test —
 * and `schema.noeRecord` is touched only by M23's ABAC resolver and its eraser. There is no route either:
 * `/api/v1/noe-records` is a GET list and the only POSTs are `/:id/submit` and `/:id/cancel`, both of which
 * load an existing row. So no Notice of Election has ever been created in any deployment, and the 5-day
 * watchdog cron has always scanned an empty table.
 *
 * The trigger is `m6.election.period_started`, NOT `m6.election.signed` as M23's §4.4 map said: the
 * election effective date the deadline is computed from lives only on `election_period.effective_at`,
 * written by the `setActive` transition at ADMISSION ACTIVATION, and `election_statement` carries only
 * `signed_at`. At signing the anchor is NULL and a federal filing cannot be dated from a guess.
 *
 * Nothing is stubbed: the REAL M6 write service runs the §418.24 chain to an ACTIVE admission as the
 * NOBYPASSRLS `wardenx_app` role → the REAL catalog-validating publisher writes the outbox row → the REAL
 * dispatcher delivers it → M23's real consumer resolves the period through M6's real org-explicit reader
 * and inserts through the real `NoeRepository` under RLS.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m23:noe-draft:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { claimLateNoeSpans, noeTimeliness5d, repositories } from "@wardenx/billing";
import { createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildProviderEntityLocationLister } from "../src/bootstrap/provider-entity-resolver";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import { M6_OUTBOX_EVENTS, electionPeriodContextForOrg } from "../src/modules/06-admission/index";
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
import { fixedValidationSeams } from "../src/modules/23-billing-medicare/__tests__/_validation-seams-fixture";
import {
  M23_OUTBOX_EVENTS,
  buildDrizzleM23WriteService,
  buildM23NoeDraftConsumer,
  noeWindowTargetAt,
} from "../src/modules/23-billing-medicare/index";
import {
  type M23WorkerDeps,
  type Parsed277ca,
  type Parsed999,
  runAckPull277ca,
  runAckPull999,
  runNoeSubmit,
} from "../src/modules/23-billing-medicare/jobs/m23-jobs";
import { buildClaimValidationContextPort } from "../src/modules/23-billing-medicare/services/claim-validation-context-port";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/index";
import { M27_OUTBOX_EVENTS } from "../src/modules/27-cost-report/index";
import { M33_OUTBOX_EVENTS } from "../src/modules/33-reporting/index";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";

/** Clinical content every CTI draft carries (`CtiDraftInput` requires it — CtiDraftSchema, route 22). */
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
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const ATTENDING = "77777777-7777-7777-7777-777777777777";
const MD = "66666666-6666-6666-6666-666666666666";

const SIGN = { signingPatientName: "Pat Patient", signingRole: "patient" } as const;

describe.skipIf(!DB_URL)("F-106 — M23 drafts the Notice of Election, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbAdmissionRouteService>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  const providerOf: Record<string, string> = {};
  const locationOf: Record<string, string> = {};
  const ccnOf: Record<string, string> = {};
  const skips: { reason: string; organizationId: string; electionPeriodId: string }[] = [];
  // The M23 worker bundle the ack-pull crons run over: the real catalog-validating publisher (bound to m23), the
  // two external wires faked (x12 gateway, MAC transport), alerts recorded.
  let workerDeps: M23WorkerDeps;
  const alerts: { alertCode: string; organizationId: string; payload: Record<string, unknown> }[] =
    [];
  let parsed999: Parsed999[] = [];
  let parsed277: Parsed277ca[] = [];
  // The M23 write service the NOE routes call (correct / submit), as wardenx_app with the real publisher.
  let m23: ReturnType<typeof buildDrizzleM23WriteService>;

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

  async function noesFor(admissionId: string) {
    const { rows } = await admin.query(
      `SELECT id, organization_id, provider_entity_id, patient_id, election_period_id, state,
              election_effective_date::text AS election_effective_date,
              window_target_at::text AS window_target_at, window_breached_at,
              noe_control_number, version
         FROM noe_record WHERE admission_id=$1`,
      [admissionId],
    );
    return rows;
  }
  async function eventRows(eventType: string, key: string, value: string) {
    const { rows } = await admin.query(
      `SELECT organization_id, payload, status FROM outbox_event
        WHERE event_type=$1 AND payload->>$2=$3`,
      [eventType, key, value],
    );
    return rows as { organization_id: string; payload: Record<string, unknown>; status: string }[];
  }
  async function firstPeriodId(admissionId: string): Promise<string> {
    const { rows } = await admin.query(
      "SELECT id FROM election_period WHERE admission_id=$1 ORDER BY sequence_number LIMIT 1",
      [admissionId],
    );
    return rows[0].id as string;
  }

  /** The §418.24 chain through the REAL write service, to an ACTIVE admission. */
  async function activeAdmission(org: string, patientId: string): Promise<string> {
    // Main's intake: triage → qualify → accept (+ admission details) — see _m6-admit.ts.
    const { admissionId } = await admitViaQualifiedReferral(svc, admin, {
      hospicePhysicianId: MD,
      organizationId: org,
      actorUserId: USER,
      patientId,
    });
    const periods = await svc.listElectionPeriods(org, admissionId);
    const periodId = periods?.[0]?.id as string;
    const nor = await svc.acknowledgeNor(
      org,
      admissionId,
      { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
      USER,
    );
    const es = await svc.draftElectionStatement(org, admissionId, periodId, {
      electedProviderEntityId: providerOf[org],
      electedAttendingPhysicianId: ATTENDING,
      waiverAcknowledged: true,
    });
    await svc.signElection(org, es.id, es.version, USER, SIGN);
    const cti = await svc.draftCti(
      org,
      {
        electionPeriodId: periodId,
        hospiceMedicalDirectorId: MD,
        attendingPhysicianId: ATTENDING,
        ...CTI_CLINICAL,
        isRecert: false,
      },
      USER,
    );
    await svc.signCtiHospiceMd(org, cti.id, cti.version, USER);
    await svc.activateAdmission(org, admissionId, nor.version);
    return admissionId;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'f106a@x.test'),($2,'f106md@x.test'),($3,'f106at@x.test')`,
      [USER, MD, ATTENDING],
    );
    for (const org of [ORG_A, ORG_B]) {
      ccnOf[org] = `H${org.slice(0, 5)}`;
      providerOf[org] = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,$2,$3,$4,'\\x00','12-31') RETURNING id`,
          [org, ccnOf[org], `Hospice ${org.slice(0, 4)}`, `NPI-${org.slice(0, 4)}`],
        )
      ).rows[0].id as string;
      locationOf[org] = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone, status)
             VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles','active') RETURNING id`,
          [providerOf[org]],
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
        [USER, org],
      );
    }
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    registerM5IntakeSeams(handle.db); // M5 intake seams M6 conversion + readiness consult

    const catalog = buildBootOutboxCatalog([
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

    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [
        buildM23NoeDraftConsumer({
          db: handle.db as never,
          outbox: bind("m23") as never,
          // M6's ORG-EXPLICIT reader. The §4.7 seam pins the tenant from the ambient request scope and a
          // relay tick is not a request.
          resolveElectionPeriod: async (organizationId, electionPeriodId) =>
            electionPeriodContextForOrg(handle.db, organizationId, electionPeriodId),
          resolveCcn: async (organizationId, providerEntityId) => {
            const { rows } = await admin.query(
              "SELECT ccn FROM provider_entity WHERE id=$1 AND organization_id=$2",
              [providerEntityId, organizationId],
            );
            if (!rows[0]) throw new Error("provider CCN unavailable");
            return rows[0].ccn as string;
          },
          onSkipped: (info) => skips.push(info),
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
        generateNoe: async (input) => ({ x12: "ISA*...~", correlationId: `corr-${input.noeId}` }),
        generateNotr: async () => ({ x12: "", correlationId: "" }),
        parse999: async () => parsed999,
        parse277ca: async () => parsed277,
      },
      macPortal: {
        upload: async (input) => ({
          accepted: true,
          generatedFileUri: `s3://notices/${input.controlNumber}.x12`,
        }),
        pullPending999: async () => [{ rawFileUri: "s3://acks/999.x12" }],
        pullPending277ca: async () => [{ rawFileUri: "s3://acks/277.x12" }],
        probeHealth: async () => true,
      },
      jurisdictions: { listJurisdictions: async () => [{ macJurisdiction: "ngs_j6" }] },
    };
    m23 = buildDrizzleM23WriteService(handle.db as never, {
      outbox: bind("m23") as never,
      jobs: { enqueue: async () => ({ jobId: randomUUID() }) },
      providerCcn: {
        ccnForProviderEntity: async (_tx, organizationId) => ccnOf[organizationId] as string,
      },
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("drafts the NOE — `noe_record`'s first row in any database", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(ORG_A, patientId);
    // Activation alone creates nothing: the request is a real `pending` outbox row, which is the state
    // every hospice election on the platform has left behind for the life of the deployment.
    expect(await noesFor(admissionId)).toHaveLength(0);

    await dispatcher.tick();

    const noes = await noesFor(admissionId);
    expect(noes).toHaveLength(1);
    expect(noes[0].organization_id).toBe(ORG_A);
    expect(noes[0].patient_id).toBe(patientId);
    expect(noes[0].provider_entity_id).toBe(providerOf[ORG_A]);
    // Created DRAFT: `submitNoe` is the human step that assembles and queues it.
    expect(noes[0].state).toBe("DRAFT");
  });

  it("computes the CMS 5-day filing window from the election effective date", async () => {
    const admissionId = await activeAdmission(ORG_A, randomUUID());
    await dispatcher.tick();

    const noes = await noesFor(admissionId);
    expect(noes).toHaveLength(1);
    // 42 CFR 418.24(b) — five CALENDAR days from the election effective date, which is the column
    // `election_period.effective_at` and NOT the statement's `signed_at`.
    const effective = noes[0].election_effective_date as string;
    expect(effective).not.toBeNull();
    expect(noes[0].window_target_at).toBe(noeWindowTargetAt(effective));
    expect(Date.parse(noes[0].window_target_at as string) - Date.parse(effective)).toBe(
      5 * 86_400_000,
    );
    // Nothing has breached yet — the watchdog stamps this, and until now it scanned an empty table.
    expect(noes[0].window_breached_at).toBeNull();
  });

  it("anchors on the period's effective date, which only exists after ACTIVATION", async () => {
    const admissionId = await activeAdmission(ORG_A, randomUUID());
    await dispatcher.tick();

    const periodId = await firstPeriodId(admissionId);
    const { rows } = await admin.query(
      "SELECT effective_at::text AS effective_at FROM election_period WHERE id=$1",
      [periodId],
    );
    const noes = await noesFor(admissionId);
    expect(noes).toHaveLength(1);
    expect(noes[0].election_period_id).toBe(periodId);
    // The whole reason this consumer subscribes to `period_started` rather than `election.signed`: at
    // signing this column is NULL, and both NOE date columns are NOT NULL.
    expect(rows[0].effective_at).not.toBeNull();
    expect(noes[0].election_effective_date).toBe(rows[0].effective_at);
  });

  it("derives a deterministic D4 control number under the provider's CCN", async () => {
    const admissionId = await activeAdmission(ORG_A, randomUUID());
    await dispatcher.tick();

    const noes = await noesFor(admissionId);
    expect(noes).toHaveLength(1);
    // `noe_control_number` is NOT NULL under a UNIQUE (provider_entity_id, noe_control_number).
    const cn = noes[0].noe_control_number as string;
    expect(cn.startsWith(`${ccnOf[ORG_A]}-`)).toBe(true);
    expect(cn).toMatch(/^[A-Za-z0-9]{6}-\d{6}-[0-9a-z]{5}-\d{2}$/);
  });

  it("is idempotent — a redelivery does not file a second notice", async () => {
    const admissionId = await activeAdmission(ORG_A, randomUUID());
    await dispatcher.tick();
    expect(await noesFor(admissionId)).toHaveLength(1);

    // Re-drive the same event, which is what a redelivery after a partial failure looks like.
    // `noe_record_admission_uq` is the structural backstop behind the pre-read.
    await admin.query("DELETE FROM outbox_consumer_receipt");
    await admin.query(
      "UPDATE outbox_event SET status='pending', attempt_count=0 WHERE event_type='m6.election.period_started'",
    );
    await dispatcher.tick();
    expect(await noesFor(admissionId)).toHaveLength(1);
  });

  it("does not leak across tenants — org B's election drafts org B's NOE only", async () => {
    const a = await activeAdmission(ORG_A, randomUUID());
    const b = await activeAdmission(ORG_B, randomUUID());
    await dispatcher.tick();

    const noesA = await noesFor(a);
    const noesB = await noesFor(b);
    expect(noesA).toHaveLength(1);
    expect(noesB).toHaveLength(1);
    expect(noesA[0].organization_id).toBe(ORG_A);
    expect(noesB[0].organization_id).toBe(ORG_B);
    expect(noesA[0].provider_entity_id).toBe(providerOf[ORG_A]);
    expect(noesB[0].provider_entity_id).toBe(providerOf[ORG_B]);
  });

  it("announces the draft, and the event it consumes now dispatches", async () => {
    const admissionId = await activeAdmission(ORG_A, randomUUID());
    await dispatcher.tick();

    const noes = await noesFor(admissionId);
    const drafted = await eventRows("m23.noe.draft_created", "noeId", noes[0].id as string);
    expect(drafted).toHaveLength(1);
    expect(drafted[0].organization_id).toBe(ORG_A);
    expect(drafted[0].payload.windowTargetAt).toBe(noes[0].window_target_at);

    // The point of the binding: `m6.election.period_started` declares m23, m26 and m27, so it stays
    // DEFERRED — a pending row re-claimed every thirty minutes — until all three bind. This asserts the
    // NOE row exists, not that the upstream event settled; m26/m27 are still unbound and registered.
    const periodId = await firstPeriodId(admissionId);
    const started = await eventRows("m6.election.period_started", "electionPeriodId", periodId);
    expect(started).toHaveLength(1);
  });

  it("files nothing for a recertification — an NOE is once per election, not per period", async () => {
    const admissionId = await activeAdmission(ORG_A, randomUUID());
    await dispatcher.tick();
    expect(await noesFor(admissionId)).toHaveLength(1);
    skips.length = 0;

    // Re-drive the started event with a SECOND-period id: sequence 2 is a recert continuing the same
    // election, which files no new notice. The control that pins the sequence gate rather than relying on
    // the unique index, since the index would also refuse it and the two are different reasons.
    const { rows: seq2 } = await admin.query(
      `INSERT INTO election_period (organization_id, admission_id, sequence_number, period_kind, status, effective_at)
         VALUES ($1,$2,2,'ninety_day','active',CURRENT_DATE) RETURNING id`,
      [ORG_A, admissionId],
    );
    await admin.query(
      `INSERT INTO outbox_event (organization_id, event_type, aggregate_kind, aggregate_id, payload)
         VALUES ($1,'m6.election.period_started','election_period',$2,$3::jsonb)`,
      [ORG_A, seq2[0].id, JSON.stringify({ electionPeriodId: seq2[0].id, sequence: 2 })],
    );
    await dispatcher.tick();

    expect(await noesFor(admissionId)).toHaveLength(1);
    expect(skips.map((s) => s.reason)).toContain("not_first_period");
  });
  it("an ACCEPTED NOE is the admission's effective NOE (claim validation read it as missing before)", async () => {
    const admissionId = await activeAdmission(ORG_A, randomUUID());
    await dispatcher.tick();
    const [drafted] = await noesFor(admissionId);
    const read = () =>
      withOrgContext(handle.db as never, { organizationId: ORG_A, userId: "" }, async (tx) => {
        const repo = new repositories.NoeRepository(tx as never);
        return {
          active: await repo.findActiveByAdmission(admissionId),
          effective: await repo.findEffectiveByAdmission(admissionId),
        };
      });
    // In flight: both reads agree.
    expect((await read()).effective?.id).toBe(drafted.id);
    expect((await read()).active?.id).toBe(drafted.id);

    // Medicare accepted it: no longer "in flight", but it IS the admission's NOE.
    await admin.query("UPDATE noe_record SET state='ACK_ACCEPTED' WHERE id=$1", [drafted.id]);
    const accepted = await read();
    expect(accepted.active).toBeNull();
    expect(accepted.effective?.id).toBe(drafted.id);
    expect(accepted.effective?.state).toBe("ack_accepted");

    // A withdrawn / rejected filing never establishes the election.
    await admin.query("UPDATE noe_record SET state='ACK_REJECTED' WHERE id=$1", [drafted.id]);
    expect((await read()).effective).toBeNull();
    await admin.query("UPDATE noe_record SET state='CANCELLED' WHERE id=$1", [drafted.id]);
    expect((await read()).effective).toBeNull();
  });

  // ── the MAC's answer: the 999 / 277CA crons route a NOE's acknowledgment to the NOE ────────────────────────

  /** A drafted NOE, made READY and transmitted by the REAL `noe.submit` processor (as wardenx_app). */
  async function submittedNoe(org: string): Promise<{
    admissionId: string;
    noeId: string;
    submissionId: string;
    controlNumber: string;
  }> {
    const admissionId = await activeAdmission(org, randomUUID());
    await dispatcher.tick();
    const [drafted] = await noesFor(admissionId);
    await withOrgContext(handle.db as never, { organizationId: org, userId: "" }, async (tx) => {
      const noes = new repositories.NoeRepository(tx as never);
      const noe = await noes.findById(drafted.id);
      await noes.transitionToState(drafted.id, noe?.version ?? 0, "ready");
      await runNoeSubmit(tx as never, workerDeps, { organizationId: org, noeId: drafted.id });
    });
    const { rows } = await admin.query(
      "SELECT id FROM claim_submission WHERE noe_id=$1 AND kind='noe' AND outcome='submitted'",
      [drafted.id],
    );
    expect(rows).toHaveLength(1);
    return {
      admissionId,
      noeId: drafted.id as string,
      submissionId: rows[0].id as string,
      controlNumber: drafted.noe_control_number as string,
    };
  }

  async function noeAckState(noeId: string) {
    const { rows } = await admin.query(
      `SELECT state, accepted_at, rejected_at, rejection_stage, rejection_codes, payer_noe_control_number,
              latest_acknowledgment_id
         FROM noe_record WHERE id=$1`,
      [noeId],
    );
    return rows[0];
  }

  /** The production ValidationContextPort's NOE read + the `noe_timeliness_5d` rule, as wardenx_app. */
  async function noeRuleFor(org: string, admissionId: string, opts: { serviceTo?: string } = {}) {
    const { rows } = await admin.query(
      `SELECT n.patient_id, n.provider_entity_id,
              (COALESCE(a.admission_at, now()) AT TIME ZONE 'UTC')::date::text AS day
         FROM noe_record n JOIN admission a ON a.id = n.admission_id
        WHERE n.admission_id=$1 ORDER BY n.created_at DESC LIMIT 1`,
      [admissionId],
    );
    const day = rows[0].day as string;
    const now = new Date(`${day}T12:00:00.000Z`);
    const port = buildClaimValidationContextPort({
      seams: fixedValidationSeams({ admissionId, hospiceAdmissionDate: day }, now),
      eligibilityBound: false,
      now: () => now,
    });
    const { context } = await withOrgContext(
      handle.db as never,
      { organizationId: org, userId: USER },
      (tx) =>
        port.build(
          tx as never,
          { organizationId: org, userId: USER, membershipId: "m", actorKind: "user" } as never,
          {
            id: randomUUID(),
            providerEntityId: rows[0].provider_entity_id,
            patientId: rows[0].patient_id,
            admissionId,
            tob: "812",
            serviceFrom: day,
            serviceTo: opts.serviceTo ?? day,
            replacesClaimId: null,
            totalChargeCents: 0,
          } as never,
        ),
    );
    return {
      context,
      result: noeTimeliness5d.check(context, noeTimeliness5d.defaultParameters ?? {}),
    };
  }

  it("a 999-REJECTED NOE is recorded as rejected, alerts the billers, and blocks claim validation as 'no NOE'", async () => {
    const { admissionId, noeId, submissionId, controlNumber } = await submittedNoe(ORG_A);
    alerts.length = 0;
    // Before the MAC answers, the in-flight NOE is the admission's NOE.
    expect((await noeRuleFor(ORG_A, admissionId)).context.noe?.state).toBe("submitted");

    parsed999 = [
      {
        // Tenant B naming tenant A's submission: under B's RLS context the submission does not exist → no-op.
        organizationId: ORG_B,
        claimId: "",
        submissionId,
        claimControlNumber: controlNumber,
        accepted: true,
        reasonCodes: [],
        ackFileUri: `s3://acks/999/${noeId}-cross-tenant.json`,
      },
      {
        organizationId: ORG_A,
        claimId: "",
        submissionId,
        claimControlNumber: controlNumber,
        accepted: false,
        reasonCodes: ["IK5:R", "IK3:8"],
        ackFileUri: `s3://acks/999/${noeId}.json`,
      },
    ];
    await runAckPull999(workerDeps);

    const noe = await noeAckState(noeId);
    expect(noe).toMatchObject({
      state: "ACK_REJECTED",
      rejection_stage: "999",
      rejection_codes: ["IK5:R", "IK3:8"],
      accepted_at: null,
    });
    expect(noe.rejected_at).toBeInstanceOf(Date);
    const { rows: acks } = await admin.query(
      "SELECT id, organization_id, claim_id, kind, outcome_status FROM claim_acknowledgment WHERE submission_id=$1",
      [submissionId],
    );
    expect(acks).toEqual([
      {
        id: noe.latest_acknowledgment_id,
        organization_id: ORG_A,
        claim_id: null,
        kind: "ack_999",
        outcome_status: "rejected",
      },
    ]);
    const rejected = await eventRows("m23.noe.rejected", "noeId", noeId);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.payload).toMatchObject({
      rejectionStage: "999",
      rejectionCodes: ["IK5:R", "IK3:8"],
    });
    expect(alerts).toEqual([
      expect.objectContaining({
        alertCode: "m23.noe.rejected",
        organizationId: ORG_A,
        payload: expect.objectContaining({
          noeId,
          providerEntityId: providerOf[ORG_A],
          admissionId,
        }),
      }),
    ]);

    // Re-pulling the same file changes nothing.
    await runAckPull999(workerDeps);
    expect(
      (
        await admin.query("SELECT 1 FROM claim_acknowledgment WHERE submission_id=$1", [
          submissionId,
        ])
      ).rows,
    ).toHaveLength(1);
    expect(await eventRows("m23.noe.rejected", "noeId", noeId)).toHaveLength(1);
    expect(alerts).toHaveLength(1);
    expect(await noeAckState(noeId)).toEqual(noe);

    // A rejected NOE never established the election: the claim validates as having no NOE (blocking).
    const { context, result } = await noeRuleFor(ORG_A, admissionId);
    expect(context.noe).toBeNull();
    expect(result.passed).toBe(false);
    expect(result.message).toBe("No Notice of Election exists for the admission.");
  });

  it("a 999- then 277CA-ACCEPTED NOE records the acceptance date and payer control number, and validates", async () => {
    const { admissionId, noeId, submissionId, controlNumber } = await submittedNoe(ORG_A);
    alerts.length = 0;
    const acceptedAt = new Date("2026-10-06T15:30:00.000Z");
    const deps = { ...workerDeps, now: () => acceptedAt };

    parsed999 = [
      {
        organizationId: ORG_A,
        claimId: "",
        submissionId,
        claimControlNumber: controlNumber,
        accepted: true,
        reasonCodes: [],
        ackFileUri: `s3://acks/999/${noeId}-ok.json`,
      },
    ];
    await runAckPull999(deps);
    expect((await noeAckState(noeId)).state).toBe("ACK_PENDING");

    parsed277 = [
      {
        organizationId: ORG_A,
        claimId: "",
        submissionId,
        outcome: "accepted",
        payerClaimControlNumber: "PAYER-778",
        reasonCodes: [],
        ackFileUri: `s3://acks/277/${noeId}-ok.json`,
      },
    ];
    await runAckPull277ca(deps);

    expect(await noeAckState(noeId)).toMatchObject({
      state: "ACK_ACCEPTED",
      accepted_at: acceptedAt,
      rejected_at: null,
      rejection_stage: null,
      payer_noe_control_number: "PAYER-778",
    });
    const accepted = await eventRows("m23.noe.accepted", "noeId", noeId);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.payload).toMatchObject({ acceptedAt: acceptedAt.toISOString() });
    expect(alerts).toEqual([]);

    const { context, result } = await noeRuleFor(ORG_A, admissionId);
    expect(context.noe?.state).toBe("ack_accepted");
    expect(result.passed).toBe(true);
  });

  // ── ack stage split (ADR-0053 D2, migration 1063): a clearinghouse answers before the payer ─────────────────
  it("a clearinghouse-stage accept stays ACK_PENDING (clearinghouse_accepted_at, no accepted_at); the payer 277CA then reaches ACK_ACCEPTED", async () => {
    const { noeId, submissionId, controlNumber } = await submittedNoe(ORG_A);
    alerts.length = 0;
    const at = new Date("2026-10-06T15:30:00.000Z");
    const deps = { ...workerDeps, now: () => at };

    parsed999 = [
      {
        organizationId: ORG_A,
        claimId: "",
        submissionId,
        claimControlNumber: controlNumber,
        accepted: true,
        reasonCodes: [],
        stage: "clearinghouse",
        ackFileUri: `s3://acks/ch/${noeId}-ok.json`,
      },
    ];
    await runAckPull999(deps);

    const pending = await admin.query(
      "SELECT state, accepted_at, clearinghouse_accepted_at, payer_status_date FROM noe_record WHERE id=$1",
      [noeId],
    );
    expect(pending.rows[0]).toMatchObject({
      state: "ACK_PENDING",
      accepted_at: null,
      clearinghouse_accepted_at: at,
      payer_status_date: null,
    });
    const stages = await admin.query(
      "SELECT stage FROM claim_acknowledgment WHERE submission_id=$1",
      [submissionId],
    );
    expect(stages.rows).toEqual([{ stage: "clearinghouse" }]);
    expect(await eventRows("m23.noe.accepted", "noeId", noeId)).toHaveLength(0);

    parsed277 = [
      {
        organizationId: ORG_A,
        claimId: "",
        submissionId,
        outcome: "accepted",
        payerClaimControlNumber: "PAYER-901",
        reasonCodes: [],
        ackFileUri: `s3://acks/277/${noeId}-payer.json`,
      },
    ];
    await runAckPull277ca(deps);
    expect(await noeAckState(noeId)).toMatchObject({ state: "ACK_ACCEPTED", accepted_at: at });
    expect(await eventRows("m23.noe.accepted", "noeId", noeId)).toHaveLength(1);
  });

  it("a clearinghouse-stage rejection is ACK_REJECTED with rejection_stage 'clearinghouse', through the real catalog", async () => {
    const { noeId, submissionId, controlNumber } = await submittedNoe(ORG_A);
    alerts.length = 0;
    parsed999 = [
      {
        organizationId: ORG_A,
        claimId: "",
        submissionId,
        claimControlNumber: controlNumber,
        accepted: false,
        reasonCodes: ["CL103"],
        stage: "clearinghouse",
        ackFileUri: `s3://acks/ch/${noeId}-rej.json`,
      },
    ];
    await runAckPull999(workerDeps);

    expect(await noeAckState(noeId)).toMatchObject({
      state: "ACK_REJECTED",
      rejection_stage: "clearinghouse",
      rejection_codes: ["CL103"],
    });
    const rejected = await eventRows("m23.noe.rejected", "noeId", noeId);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.payload).toMatchObject({ rejectionStage: "clearinghouse" });
  });

  // ── a corrected NOE after a rejection (ch. 11 §20.1.1; M23 §2.2 "corrected NOE is its own row") ───────────────

  const REASON = "The 277CA rejected the NOE (A7:21): MBI updated from HETS, refiling the notice.";
  const actorOf = (org: string) =>
    ({
      organizationId: org,
      userId: USER,
      membershipId: USER,
      roles: ["billing_specialist"],
      actorKind: "user",
      stepUpRecent: true,
    }) as never;
  const addDays = (iso: string, n: number) =>
    new Date(Date.parse(`${iso}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

  /** A NOE the 277CA rejected (999 accepted the file first), as wardenx_app through the real crons. */
  async function rejectedNoe(org: string) {
    const sub = await submittedNoe(org);
    parsed999 = [
      {
        organizationId: org,
        claimId: "",
        submissionId: sub.submissionId,
        claimControlNumber: sub.controlNumber,
        accepted: true,
        reasonCodes: [],
        ackFileUri: `s3://acks/999/${sub.noeId}-accept.json`,
      },
    ];
    await runAckPull999(workerDeps);
    parsed277 = [
      {
        organizationId: org,
        claimId: "",
        submissionId: sub.submissionId,
        outcome: "rejected",
        payerClaimControlNumber: "",
        reasonCodes: ["A7:21"],
        ackFileUri: `s3://acks/277/${sub.noeId}-reject.json`,
      },
    ];
    await runAckPull277ca(workerDeps);
    expect((await noeAckState(sub.noeId)).state).toBe("ACK_REJECTED");
    return sub;
  }

  it("a rejected NOE → corrected NOE → accepted late: the correction is the effective NOE, judged on Medicare's date, with OSC 77", async () => {
    const { admissionId, noeId } = await rejectedNoe(ORG_A);
    const [original] = (await noesFor(admissionId)).filter((n) => n.id === noeId);
    const admission = original.election_effective_date as string;

    const filed = await m23.correctNoe(actorOf(ORG_A), noeId, { reason: REASON });
    expect(filed.created).toBe(true);
    const correctedId = filed.notice.noeId;
    expect(filed.notice).toMatchObject({
      state: "draft",
      admissionId,
      electionEffectiveDate: admission,
      // The CMS clock still runs from admission.
      windowTargetAt: original.window_target_at,
      correctsNoticeId: noeId,
    });
    // Both directions of the link, as the read routes serve them.
    const { rows: chain } = await admin.query(
      "SELECT id, state, corrects_notice_id, noe_control_number FROM noe_record WHERE admission_id=$1 ORDER BY created_at",
      [admissionId],
    );
    expect(chain.map((r) => [r.id, r.state, r.corrects_notice_id])).toEqual([
      [noeId, "ACK_REJECTED", null],
      [correctedId, "DRAFT", noeId],
    ]);
    expect(chain[1].noe_control_number).not.toBe(chain[0].noe_control_number);
    // Announced on the same transaction, through the catalog-validating publisher; the reason never leaves the row.
    const announced = await eventRows("m23.noe.correction_created", "noeId", correctedId);
    expect(announced).toHaveLength(1);
    expect(announced[0]?.payload).toMatchObject({ correctsNoeId: noeId, rejectionStage: "277ca" });
    expect(JSON.stringify(announced[0]?.payload)).not.toContain("MBI updated");
    // Write-audited like every notice write (the table's audit trigger).
    const { rows: audit } = await admin.query(
      `SELECT actor_user_id, after->>'corrects_notice_id' AS corrects FROM audit_event
        WHERE resource_kind='noe_record' AND resource_id=$1 AND event_type='noe_record.insert'`,
      [correctedId],
    );
    expect(audit).toEqual([{ actor_user_id: USER, corrects: noeId }]);

    // Through the ordinary submit queue, the worker and the ack routing.
    const queued = await m23.submitNoe(actorOf(ORG_A), correctedId);
    await withOrgContext(handle.db as never, { organizationId: ORG_A, userId: "" }, (tx) =>
      runNoeSubmit(tx as never, workerDeps, { organizationId: ORG_A, noeId: correctedId }),
    );
    // Medicare accepts it on day +7 (two days late); we pull the 277CA a day later.
    const payerDate = addDays(admission, 7);
    const late = { ...workerDeps, now: () => new Date(`${addDays(admission, 8)}T14:00:00.000Z`) };
    parsed999 = [
      {
        organizationId: ORG_A,
        claimId: "",
        submissionId: queued.submissionId,
        claimControlNumber: chain[1].noe_control_number,
        accepted: true,
        reasonCodes: [],
        ackFileUri: `s3://acks/999/${correctedId}.json`,
        functionalGroupDate: payerDate,
      },
    ];
    await runAckPull999(late);
    parsed277 = [
      {
        organizationId: ORG_A,
        claimId: "",
        submissionId: queued.submissionId,
        outcome: "accepted",
        payerClaimControlNumber: "ICN-CORRECTED",
        reasonCodes: [],
        ackFileUri: `s3://acks/277/${correctedId}.json`,
        statusEffectiveDate: payerDate,
      },
    ];
    await runAckPull277ca(late);
    const { rows: accepted } = await admin.query(
      "SELECT state, payer_status_date::text AS payer_date, payer_status_date_source AS source, accepted_at FROM noe_record WHERE id=$1",
      [correctedId],
    );
    expect(accepted[0]).toMatchObject({
      state: "ACK_ACCEPTED",
      payer_date: payerDate,
      source: "277ca_stc02",
    });
    // accepted_at stays our receipt time — a day after Medicare's date.
    expect((accepted[0].accepted_at as Date).toISOString().slice(0, 10)).toBe(
      addDays(admission, 8),
    );
    expect((await eventRows("m23.noe.accepted", "noeId", correctedId))[0]?.payload).toMatchObject({
      payerStatusDate: payerDate,
      payerStatusDateSource: "277ca_stc02",
    });

    // Claim validation reads the corrected NOE and passes (late is not blocking), reporting OSC 77 from
    // admission through the day before Medicare's acceptance date.
    const serviceTo = addDays(admission, 20);
    const { context, result } = await noeRuleFor(ORG_A, admissionId, { serviceTo });
    expect(context.noe).toMatchObject({
      state: "ack_accepted",
      electionEffectiveDate: admission,
      acceptedDate: payerDate,
      acceptedDateSource: "277ca_stc02",
    });
    expect(result.severity).toBe("info");
    expect(result.annotations?.observed).toMatchObject({
      daysLate: 2,
      occurrenceSpanCode: "77",
      occurrenceSpanFrom: admission,
      occurrenceSpanThrough: addDays(admission, 6),
    });
    expect(
      claimLateNoeSpans(context.noe, { serviceFrom: context.claim.serviceFrom, serviceTo }),
    ).toEqual([{ code: "77", from: admission, through: addDays(admission, 6) }]);

    // An accepted correction cannot be corrected again, and the rejected one replays the accepted correction.
    await expect(
      m23.correctNoe(actorOf(ORG_A), correctedId, { reason: REASON }),
    ).rejects.toMatchObject({
      code: "NOTICE_NOT_REJECTED",
      statusCode: 409,
    });
    expect(await m23.correctNoe(actorOf(ORG_A), noeId, { reason: REASON })).toMatchObject({
      created: false,
      notice: { noeId: correctedId },
    });
  }, 120_000);

  it("a NOE corrected and accepted on time validates with no OSC 77", async () => {
    const { admissionId, noeId } = await rejectedNoe(ORG_A);
    const [original] = await noesFor(admissionId);
    const admission = original.election_effective_date as string;
    const filed = await m23.correctNoe(actorOf(ORG_A), noeId, { reason: REASON });
    const correctedId = filed.notice.noeId;
    const queued = await m23.submitNoe(actorOf(ORG_A), correctedId);
    await withOrgContext(handle.db as never, { organizationId: ORG_A, userId: "" }, (tx) =>
      runNoeSubmit(tx as never, workerDeps, { organizationId: ORG_A, noeId: correctedId }),
    );
    const onTime = { ...workerDeps, now: () => new Date(`${addDays(admission, 4)}T14:00:00.000Z`) };
    parsed999 = [
      {
        organizationId: ORG_A,
        claimId: "",
        submissionId: queued.submissionId,
        claimControlNumber: "x",
        accepted: true,
        reasonCodes: [],
        ackFileUri: `s3://acks/999/${correctedId}-ontime.json`,
      },
    ];
    await runAckPull999(onTime);
    parsed277 = [
      {
        organizationId: ORG_A,
        claimId: "",
        submissionId: queued.submissionId,
        outcome: "accepted",
        payerClaimControlNumber: "ICN-ONTIME",
        reasonCodes: [],
        ackFileUri: `s3://acks/277/${correctedId}-ontime.json`,
        statusEffectiveDate: addDays(admission, 4),
      },
    ];
    await runAckPull277ca(onTime);
    const { context, result } = await noeRuleFor(ORG_A, admissionId, {
      serviceTo: addDays(admission, 20),
    });
    expect(context.noe?.acceptedDate).toBe(addDays(admission, 4));
    expect(result.passed).toBe(true);
    expect(claimLateNoeSpans(context.noe, context.claim)).toEqual([]);
  }, 120_000);

  it("one correction at a time: concurrent requests file exactly one corrected NOE", async () => {
    const { admissionId, noeId } = await rejectedNoe(ORG_A);
    const results = await Promise.all([
      m23.correctNoe(actorOf(ORG_A), noeId, { reason: REASON }),
      m23.correctNoe(actorOf(ORG_A), noeId, { reason: REASON }),
    ]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.notice.noeId)).size).toBe(1);
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM noe_record WHERE corrects_notice_id=$1",
      [noeId],
    );
    expect(rows[0].n).toBe(1);
    expect((await noesFor(admissionId)).length).toBe(2);
  }, 120_000);

  it("cross-tenant: org B cannot refile org A's rejected NOE (RLS hides it; nothing is written)", async () => {
    const { admissionId, noeId } = await rejectedNoe(ORG_A);
    await expect(m23.correctNoe(actorOf(ORG_B), noeId, { reason: REASON })).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(await noesFor(admissionId)).toHaveLength(1);
    expect(await eventRows("m23.noe.correction_created", "correctsNoeId", noeId)).toHaveLength(0);
  }, 120_000);
});
