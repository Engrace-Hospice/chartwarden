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
 * NOBYPASSRLS `chartwarden_app` role → the REAL catalog-validating publisher writes the outbox row → the REAL
 * dispatcher delivers it → M23's real consumer resolves the period through M6's real org-explicit reader
 * and inserts through the real `NoeRepository` under RLS.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m23:noe-draft:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  claimLateNoeSpans,
  medicareReceiptDay,
  noeTimeliness5d,
  repositories,
} from "@chartwarden/billing";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
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
  buildM23NoticeFiledLateConsumer,
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
import { buildNoticeWindowPort } from "../src/modules/23-billing-medicare/jobs/m23-worker-ports";
import { parkNoticeForExternalFiling } from "../src/modules/23-billing-medicare/jobs/notice-external-filing";
import { buildClaimValidationContextPort } from "../src/modules/23-billing-medicare/services/claim-validation-context-port";
import { withdrawExternalNoticeFiling } from "../src/modules/23-billing-medicare/services/external-notice-filing";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/index";
import { M27_OUTBOX_EVENTS } from "../src/modules/27-cost-report/index";
import { M33_OUTBOX_EVENTS } from "../src/modules/33-reporting/index";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";
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

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
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
  const lateAlerts: Record<string, unknown>[] = [];
  const lateOpsNotices: Record<string, unknown>[] = [];
  let parsed999: Parsed999[] = [];
  let parsed277: Parsed277ca[] = [];
  // The M23 write service the NOE routes call (correct / submit), as chartwarden_app with the real publisher.
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
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
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
        // Round 2, Q4: a late externally recorded filing -> the M36 alert to the tenant and a platform-ops notice.
        buildM23NoticeFiledLateConsumer({
          alerts: { dispatch: async (a) => void lateAlerts.push(a) },
          opsNotice: (n) => void lateOpsNotices.push(n),
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

  /** A drafted NOE, made READY and transmitted by the REAL `noe.submit` processor (as chartwarden_app). */
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

  /** The production ValidationContextPort's NOE read + the `noe_timeliness_5d` rule, as chartwarden_app. */
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

  /** A NOE the 277CA rejected (999 accepted the file first), as chartwarden_app through the real crons. */
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
        submissionId: queued.submissionId as string,
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
        submissionId: queued.submissionId as string,
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
        submissionId: queued.submissionId as string,
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
        submissionId: queued.submissionId as string,
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
  // ── an organization that bills outside ChartWarden files its NOE itself (owner decision D4; migration 1353) ───────
  // ChartWarden transmits NOTHING for it: submit parks the notice, the tenant records the date it filed, and the deadline
  // tracker keeps counting until then. The pure rules are unit-tested (`m23-notice-external-filing.test.ts`); this proves the
  // SQL: the CHECKs, the same-state patch under RLS as `chartwarden_app`, the audit trigger, and the two tracker scans.

  // The Eastern (CMS) calendar day, as the service judges "today" (UTC is a day ahead in the Eastern evening).
  const todayIso = () => medicareReceiptDay(new Date());

  /** A bare NOE row. The ids that point at other modules are logical FKs, so none of them has to exist. */
  async function seedNoe(
    org: string,
    over: { state?: string; effective?: string; status?: "pending" | "filed" | null } = {},
  ): Promise<string> {
    const effective = over.effective ?? addDays(todayIso(), -1);
    const filed = over.status === "filed";
    const { rows } = await admin.query(
      `INSERT INTO noe_record (organization_id, provider_entity_id, patient_id, admission_id, election_period_id, state,
              election_effective_date, window_target_at, noe_control_number, external_filing_status,
              filed_externally_on, filed_externally_recorded_at, filed_externally_by_membership_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [
        org,
        providerOf[org],
        randomUUID(),
        randomUUID(),
        randomUUID(),
        over.state ?? "READY",
        effective,
        addDays(effective, 5),
        `EXT-${randomUUID().slice(0, 12)}`,
        over.status ?? null,
        filed ? effective : null,
        filed ? new Date() : null,
        filed ? USER : null,
      ],
    );
    return rows[0].id as string;
  }
  const noeRow = async (id: string) =>
    (
      await admin.query(
        `SELECT state, version, external_filing_status, filed_externally_on::text AS filed_on,
                filed_externally_by_membership_id AS by, window_breached_at::text AS breached,
                external_filing_set_breach AS set_breach
           FROM noe_record WHERE id=$1`,
        [id],
      )
    ).rows[0] as Record<string, unknown>;

  /** The M23 write service for a deployment whose orgs all bill outside (`outside`) or none does, with a recording queue. */
  function externalFilingService(outside: boolean) {
    const enqueued: unknown[] = [];
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M23_OUTBOX_EVENTS]));
    const service = buildDrizzleM23WriteService(handle.db as never, {
      outbox: {
        publish: (tx: unknown, e: Record<string, unknown>) =>
          publisher.publish(tx as never, { ...e, callerModule: "m23" } as never),
      } as never,
      jobs: {
        enqueue: async (...args: unknown[]) => {
          enqueued.push(args);
          return { jobId: randomUUID() };
        },
      },
      providerCcn: {
        ccnForProviderEntity: async (_tx, organizationId) => ccnOf[organizationId] as string,
      },
      billsOutside: async () => outside,
    });
    return { service, enqueued };
  }

  it("migration 1353: external_filing_status is pending | filed, and the three filed_* columns move with `filed` (all set, or all NULL)", async () => {
    const id = await seedNoe(ORG_A);
    expect(await noeRow(id)).toMatchObject({ external_filing_status: null, filed_on: null });
    const set = (sql: string) => admin.query(`UPDATE noe_record SET ${sql} WHERE id=$1`, [id]);
    await expect(set("external_filing_status='done'")).rejects.toMatchObject({ code: "23514" });
    await expect(set("external_filing_status='filed'")).rejects.toMatchObject({ code: "23514" });
    await expect(
      set("external_filing_status='pending', filed_externally_on=CURRENT_DATE"),
    ).rejects.toMatchObject({
      code: "23514",
    });
    await expect(set("filed_externally_on=CURRENT_DATE")).rejects.toMatchObject({ code: "23514" });
    await set("external_filing_status='pending'");
    await set(
      `external_filing_status='filed', filed_externally_on=CURRENT_DATE, filed_externally_recorded_at=now(),
       filed_externally_by_membership_id='${USER}'`,
    );
    expect(await noeRow(id)).toMatchObject({ external_filing_status: "filed", by: USER });
    await set(
      "external_filing_status=NULL, filed_externally_on=NULL, filed_externally_recorded_at=NULL, filed_externally_by_membership_id=NULL",
    );
  });

  it("migration 1353: external_filing_set_breach is NOT NULL, false by default, and can only be true on a notice recorded as filed", async () => {
    const id = await seedNoe(ORG_A);
    expect(await noeRow(id)).toMatchObject({ set_breach: false });
    const set = (sql: string) => admin.query(`UPDATE noe_record SET ${sql} WHERE id=$1`, [id]);
    await expect(set("external_filing_set_breach=NULL")).rejects.toMatchObject({ code: "23502" });
    await expect(set("external_filing_set_breach=true")).rejects.toMatchObject({ code: "23514" });
    await set("external_filing_status='pending'");
    await expect(set("external_filing_set_breach=true")).rejects.toMatchObject({ code: "23514" });
    await set(
      `external_filing_status='filed', filed_externally_on=CURRENT_DATE, filed_externally_recorded_at=now(),
       filed_externally_by_membership_id='${USER}', external_filing_set_breach=true`,
    );
    expect(await noeRow(id)).toMatchObject({ set_breach: true });
    // leaving `filed` without clearing the flag is refused: a withdrawal resets both together
    await expect(
      set(
        "external_filing_status=NULL, filed_externally_on=NULL, filed_externally_recorded_at=NULL, filed_externally_by_membership_id=NULL",
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("the deadline tracker keeps counting for a parked or unmarked NOE of an outside org, and drops one recorded as filed", async () => {
    const effective = addDays(todayIso(), -12); // due 7 days ago: past due, not yet stamped
    const unmarked = await seedNoe(ORG_A, { effective });
    const parked = await seedNoe(ORG_A, { effective, status: "pending" });
    const filed = await seedNoe(ORG_A, { effective, status: "filed" });
    const mine = new Set([unmarked, parked, filed]);
    const scan = (
      fn: (
        r: InstanceType<typeof repositories.NoeRepository>,
      ) => Promise<readonly { id: string }[]>,
    ) =>
      withOrgContext(handle.db as never, { organizationId: ORG_A, userId: "" }, async (tx) =>
        fn(new repositories.NoeRepository(tx as never)),
      ).then((rows) =>
        rows
          .map((r) => r.id)
          .filter((id) => mine.has(id))
          .sort(),
      );

    const expected = [unmarked, parked].sort();
    expect(await scan((r) => r.listWindowWatchCandidates(ORG_A, todayIso()))).toEqual(expected);
    expect(await scan((r) => r.listDdeWatchCandidates(ORG_A, addDays(todayIso(), 7)))).toEqual(
      expected,
    );
  });

  it("an outside org: submit parks the NOE (nothing queued, sent or announced), the tenant records the date, the tracker lets go, and it is write-audited", async () => {
    const { service, enqueued } = externalFilingService(true);
    const id = await seedNoe(ORG_A, { state: "DRAFT" });

    const parkedView = await service.submitNoe(actorOf(ORG_A), id);

    expect(parkedView).toEqual({
      submissionId: null,
      jobId: null,
      kind: "noe",
      externalFiling: "pending",
    });
    expect(await noeRow(id)).toMatchObject({ state: "READY", external_filing_status: "pending" });
    expect(enqueued).toEqual([]);
    expect(
      (await admin.query("SELECT count(*)::int AS n FROM claim_submission WHERE noe_id=$1", [id]))
        .rows[0].n,
    ).toBe(0);
    expect(await eventRows("m23.noe.submit_requested", "noeId", id)).toHaveLength(0);

    // A pending NOE is still on the tracker; recording the date takes it off.
    const watch = () =>
      withOrgContext(handle.db as never, { organizationId: ORG_A, userId: "" }, (tx) =>
        new repositories.NoeRepository(tx as never).listDdeWatchCandidates(
          ORG_A,
          addDays(todayIso(), 7),
        ),
      ).then((rows) => rows.some((r) => r.id === id));
    expect(await watch()).toBe(true);

    const recorded = await service.recordNoeExternalFiling(actorOf(ORG_A), id, {
      filedOn: todayIso(),
    });
    expect(recorded.externalFiling).toMatchObject({
      status: "filed_externally",
      filedOn: todayIso(),
    });
    const row = await noeRow(id);
    expect(row).toMatchObject({
      state: "READY",
      external_filing_status: "filed",
      filed_on: todayIso(),
      by: USER,
      breached: null,
    });
    expect(await watch()).toBe(false);

    // Idempotent for the same date (nothing rewritten); another date is refused.
    await service.recordNoeExternalFiling(actorOf(ORG_A), id, { filedOn: todayIso() });
    expect((await noeRow(id)).version).toBe(row.version);
    await expect(
      service.recordNoeExternalFiling(actorOf(ORG_A), id, { filedOn: addDays(todayIso(), -1) }),
    ).rejects.toMatchObject({ code: "NOTICE_ALREADY_FILED_EXTERNALLY", statusCode: 409 });
    // A recorded filing is never submitted a second time, even once the org transmits through ChartWarden.
    await expect(
      externalFilingService(false).service.submitNoe(actorOf(ORG_A), id),
    ).rejects.toMatchObject({
      code: "NOTICE_FILED_EXTERNALLY",
    });

    // Write-audited by the table's trigger: the acting user, before and after.
    const { rows: audit } = await admin.query(
      `SELECT actor_user_id, before->>'external_filing_status' AS before_status, after->>'external_filing_status' AS after_status
         FROM audit_event WHERE resource_kind='noe_record' AND resource_id=$1 AND event_type='noe_record.update'
          AND after->>'external_filing_status'='filed'`,
      [id],
    );
    expect(audit).toEqual([
      { actor_user_id: USER, before_status: "pending", after_status: "filed" },
    ]);
  }, 60_000);

  it("a date after the due date stamps the breach on record with the filing date; a bad date writes nothing", async () => {
    const { service } = externalFilingService(true);
    const effective = addDays(todayIso(), -12);
    const late = await seedNoe(ORG_A, { effective, status: "pending" });
    const filedOn = addDays(effective, 8); // due on +5: three days late
    await service.recordNoeExternalFiling(actorOf(ORG_A), late, { filedOn });
    expect(await noeRow(late)).toMatchObject({
      external_filing_status: "filed",
      breached: filedOn,
    });

    // Round 2, Q4: the late filing is published (real catalog-validating publisher, same transaction) and reaches the alert + ops sink.
    const windowTargetAt = addDays(effective, 5);
    const lateEvents = await eventRows("m23.noe.filed_externally_late", "noeId", late);
    expect(lateEvents).toHaveLength(1);
    expect(lateEvents[0]?.organization_id).toBe(ORG_A);
    expect(lateEvents[0]?.payload).toEqual({
      noeId: late,
      admissionId: expect.any(String),
      filedOn,
      windowTargetAt,
    });
    lateAlerts.length = 0;
    lateOpsNotices.length = 0;
    await dispatcher.tick();
    expect(lateAlerts.filter((a) => (a.payload as { noeId?: string }).noeId === late)).toEqual([
      expect.objectContaining({
        alertCode: "m23.noe.filed_externally_late",
        severity: "critical",
        organizationId: ORG_A,
        payload: { noeId: late, admissionId: expect.any(String), filedOn, windowTargetAt },
      }),
    ]);
    expect(
      lateOpsNotices.filter((n) => (n.details as { noticeId?: string }).noticeId === late),
    ).toEqual([expect.objectContaining({ kind: "m23.notice_filed_late" })]);
    // An idempotent replay of the same recording publishes nothing more.
    await service.recordNoeExternalFiling(actorOf(ORG_A), late, { filedOn });
    expect(await eventRows("m23.noe.filed_externally_late", "noeId", late)).toHaveLength(1);

    const untouched = await seedNoe(ORG_A, { effective });
    for (const [bad, code] of [
      [addDays(todayIso(), 1), "FILED_ON_IN_FUTURE"],
      [addDays(effective, -1), "FILED_ON_BEFORE_EFFECTIVE_DATE"],
    ] as const) {
      await expect(
        service.recordNoeExternalFiling(actorOf(ORG_A), untouched, { filedOn: bad }),
      ).rejects.toMatchObject({
        code,
        statusCode: 422,
      });
    }
    expect(await noeRow(untouched)).toMatchObject({ external_filing_status: null, version: 0 });
  }, 60_000);

  it("a breach stamp the deadline watchdog set is NEVER cleared by a tenant's record: an on-time date over it announces the contradiction with both dates; a late one keeps its stamp", async () => {
    const { service } = externalFilingService(true);
    const effective = addDays(todayIso(), -3); // due in +5: two days left
    const onTime = await seedNoe(ORG_A, { effective, status: "pending" });
    const observed = todayIso();
    await admin.query("UPDATE noe_record SET window_breached_at=$2 WHERE id=$1", [
      onTime,
      observed,
    ]);

    await service.recordNoeExternalFiling(actorOf(ORG_A), onTime, { filedOn: todayIso() });

    // the stamp survives; the attested date is recorded beside it
    expect(await noeRow(onTime)).toMatchObject({
      external_filing_status: "filed",
      filed_on: todayIso(),
      breached: observed,
    });
    // ...and compliance and ops are told (real catalog-validating publisher, same transaction): the late-filing event, with the observed date
    const events = await eventRows("m23.noe.filed_externally_late", "noeId", onTime);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({
      noeId: onTime,
      admissionId: expect.any(String),
      filedOn: todayIso(),
      windowTargetAt: addDays(effective, 5),
      breachObservedAt: observed,
    });
    lateAlerts.length = 0;
    lateOpsNotices.length = 0;
    await dispatcher.tick();
    expect(lateAlerts.filter((a) => (a.payload as { noeId?: string }).noeId === onTime)).toEqual([
      expect.objectContaining({
        alertCode: "m23.noe.filed_externally_late",
        severity: "critical",
        organizationId: ORG_A,
        payload: expect.objectContaining({ breachObservedAt: observed, filedOn: todayIso() }),
      }),
    ]);
    expect(
      lateOpsNotices.filter((n) => (n.details as { noticeId?: string }).noticeId === onTime),
    ).toEqual([expect.objectContaining({ kind: "m23.notice_filing_contradicts_breach" })]);
    // a replay announces nothing more
    await service.recordNoeExternalFiling(actorOf(ORG_A), onTime, { filedOn: todayIso() });
    expect(await eventRows("m23.noe.filed_externally_late", "noeId", onTime)).toHaveLength(1);

    // an on-time record with NO stamp publishes nothing
    const clean = await seedNoe(ORG_A, { effective, status: "pending" });
    await service.recordNoeExternalFiling(actorOf(ORG_A), clean, { filedOn: todayIso() });
    expect(await eventRows("m23.noe.filed_externally_late", "noeId", clean)).toHaveLength(0);

    const lateEffective = addDays(todayIso(), -12); // due 7 days ago
    const late = await seedNoe(ORG_A, { effective: lateEffective, status: "pending" });
    const stamp = addDays(todayIso(), -6);
    await admin.query("UPDATE noe_record SET window_breached_at=$2 WHERE id=$1", [late, stamp]);
    await service.recordNoeExternalFiling(actorOf(ORG_A), late, { filedOn: todayIso() });
    expect(await noeRow(late)).toMatchObject({ external_filing_status: "filed", breached: stamp });
    const lateEvents = await eventRows("m23.noe.filed_externally_late", "noeId", late);
    expect(lateEvents).toHaveLength(1);
    expect(lateEvents[0]?.payload).not.toHaveProperty("breachObservedAt");
  }, 60_000);

  it("a withdrawn LATE record takes its own breach stamp with it: re-recording the true on-time date announces nothing, and the window watch scans the notice again", async () => {
    const { service } = externalFilingService(true);
    const effective = addDays(todayIso(), -12); // due 7 days ago
    const id = await seedNoe(ORG_A, { effective, status: "pending" });
    const lateOn = addDays(effective, 8); // three days late
    await service.recordNoeExternalFiling(actorOf(ORG_A), id, { filedOn: lateOn });
    // the record wrote the stamp itself, and says so (what a withdrawal reads to know the stamp is its own)
    expect(await noeRow(id)).toMatchObject({
      external_filing_status: "filed",
      breached: lateOn,
      set_breach: true,
    });
    expect(await eventRows("m23.noe.filed_externally_late", "noeId", id)).toHaveLength(1);
    await dispatcher.tick(); // the late filing's own alert goes out now

    const {
      rows: [{ recorded_at: recordedAt }],
    } = await admin.query(
      "SELECT filed_externally_recorded_at AS recorded_at FROM noe_record WHERE id=$1",
      [id],
    );
    const inOrgA = <T>(fn: (tx: never) => Promise<T>) =>
      withOrgContext<never, T>(handle.db as never, { organizationId: ORG_A, userId: USER }, fn);
    const withdrawn = await inOrgA((tx) =>
      withdrawExternalNoticeFiling(tx, {
        kind: "noe",
        organizationId: ORG_A,
        noticeId: id,
        expectedRecordedAt: (recordedAt as Date).toISOString(),
      }),
    );
    expect(await noeRow(id)).toMatchObject({
      external_filing_status: null,
      filed_on: null,
      breached: null,
      set_breach: false,
    });
    expect(withdrawn.clearedBreachStamp).toBe(lateOn);
    // the notice is overdue and un-stamped, so the window watch (which re-stamps) scans it again
    const candidates = await inOrgA((tx) =>
      new repositories.NoeRepository(tx).listWindowWatchCandidates(ORG_A, todayIso()),
    );
    expect(candidates.map((c) => c.id)).toContain(id);

    // the tenant records the TRUE date, which was on time: no stamp to contradict, so nothing is announced
    lateAlerts.length = 0;
    lateOpsNotices.length = 0;
    const onTimeOn = addDays(effective, 3);
    await service.recordNoeExternalFiling(actorOf(ORG_A), id, { filedOn: onTimeOn });
    expect(await noeRow(id)).toMatchObject({
      external_filing_status: "filed",
      filed_on: onTimeOn,
      breached: null,
    });
    expect(await eventRows("m23.noe.filed_externally_late", "noeId", id)).toHaveLength(1); // the first record's, no second
    await dispatcher.tick();
    expect(lateAlerts.filter((a) => (a.payload as { noeId?: string }).noeId === id)).toEqual([]);
    expect(
      lateOpsNotices.filter((n) => (n.details as { noticeId?: string }).noticeId === id),
    ).toEqual([]);
  }, 60_000);

  // The deadline watchdog stamps `medicareReceiptDay(now)` on its first tick after the due day: target + 1. A tenant that filed
  // exactly one day late records filedOn = target + 1, the very same date, so the dates cannot say who wrote the stamp. The record
  // says it itself (`external_filing_set_breach`): here the watchdog (the REAL stamp port) wrote first, so the record never owned it.
  it("a withdrawn record keeps the stamp the watchdog wrote first, even when a one-day-late record carries the same date: no re-stamp, no second breach, and an on-time re-record still announces the contradiction", async () => {
    const { service } = externalFilingService(true);
    const effective = addDays(todayIso(), -6); // due yesterday: today is target + 1
    const target = addDays(effective, 5);
    const id = await seedNoe(ORG_A, { effective, status: "pending" });
    const inOrgA = <T>(fn: (tx: never) => Promise<T>) =>
      withOrgContext<never, T>(handle.db as never, { organizationId: ORG_A, userId: USER }, fn);

    // the watchdog's first tick after the due day stamps the breach (the real port; today = target + 1)
    await inOrgA((tx) =>
      buildNoticeWindowPort().recordBreach({
        tx,
        kind: "noe",
        noticeId: id,
        expectedVersion: 0,
        breachedAt: new Date(),
      }),
    );
    const watchdogStamp = addDays(target, 1);
    expect(await noeRow(id)).toMatchObject({ breached: watchdogStamp, set_breach: false });

    // the tenant, exactly one day late, records the same date: it keeps the watchdog's stamp and does not claim it
    await service.recordNoeExternalFiling(actorOf(ORG_A), id, { filedOn: watchdogStamp });
    expect(await noeRow(id)).toMatchObject({
      external_filing_status: "filed",
      filed_on: watchdogStamp,
      breached: watchdogStamp,
      set_breach: false,
    });
    expect(await eventRows("m23.noe.filed_externally_late", "noeId", id)).toHaveLength(1);
    await dispatcher.tick();

    // the operator withdraws the record: the watchdog's observed breach stays, untouched
    const {
      rows: [{ recorded_at: recordedAt }],
    } = await admin.query(
      "SELECT filed_externally_recorded_at AS recorded_at FROM noe_record WHERE id=$1",
      [id],
    );
    const withdrawn = await inOrgA((tx) =>
      withdrawExternalNoticeFiling(tx, {
        kind: "noe",
        organizationId: ORG_A,
        noticeId: id,
        expectedRecordedAt: (recordedAt as Date).toISOString(),
      }),
    );
    expect(withdrawn.clearedBreachStamp).toBeNull();
    expect(await noeRow(id)).toMatchObject({
      external_filing_status: null,
      filed_on: null,
      breached: watchdogStamp,
      set_breach: false,
    });
    // so the window watch does not scan it again: no re-stamp with a moved date, no second `window_breached`, no second alert
    const candidates = await inOrgA((tx) =>
      new repositories.NoeRepository(tx).listWindowWatchCandidates(ORG_A, todayIso()),
    );
    expect(candidates.map((c) => c.id)).not.toContain(id);

    // the tenant re-records an on-time date before any further tick: the observed breach is not lost, and the contradiction is announced
    lateAlerts.length = 0;
    const onTimeOn = addDays(effective, 3);
    await service.recordNoeExternalFiling(actorOf(ORG_A), id, { filedOn: onTimeOn });
    expect(await noeRow(id)).toMatchObject({
      external_filing_status: "filed",
      filed_on: onTimeOn,
      breached: watchdogStamp,
      set_breach: false,
    });
    const events = await eventRows("m23.noe.filed_externally_late", "noeId", id);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.payload)).toContainEqual(
      expect.objectContaining({ filedOn: onTimeOn, breachObservedAt: watchdogStamp }),
    );
    await dispatcher.tick();
    expect(lateAlerts.filter((a) => (a.payload as { noeId?: string }).noeId === id)).toEqual([
      expect.objectContaining({
        alertCode: "m23.noe.filed_externally_late",
        payload: expect.objectContaining({ breachObservedAt: watchdogStamp }),
      }),
    ]);
  }, 60_000);

  it("refuses an organization ChartWarden files for; a parked NOE goes the normal way once the org transmits again, and the marker clears", async () => {
    const id = await seedNoe(ORG_A, { status: "pending" });
    const transmits = externalFilingService(false);
    await expect(
      transmits.service.recordNoeExternalFiling(actorOf(ORG_A), id, { filedOn: todayIso() }),
    ).rejects.toMatchObject({ code: "ORG_NOT_BILLING_OUTSIDE", statusCode: 409 });

    const queued = await transmits.service.submitNoe(actorOf(ORG_A), id);
    expect(queued).not.toHaveProperty("externalFiling");
    expect(queued.submissionId).toEqual(expect.any(String));
    expect(transmits.enqueued).toHaveLength(1);
    expect(await noeRow(id)).toMatchObject({ external_filing_status: null });
    expect(await eventRows("m23.noe.submit_requested", "noeId", id)).toHaveLength(1);
  }, 60_000);

  /** A notice's transmission attempts, oldest first. */
  const attemptsOf = async (noeId: string) =>
    (
      await admin.query(
        `SELECT id, attempt_index, outcome, outcome_reason, submitted_at IS NOT NULL AS sent
           FROM claim_submission WHERE noe_id=$1 ORDER BY attempt_index`,
        [noeId],
      )
    ).rows as {
      id: string;
      attempt_index: number;
      outcome: string;
      outcome_reason: string | null;
      sent: boolean;
    }[];

  it("park, switch back to a vendor, resubmit: the new transmission is recorded on a NEW attempt and the parked attempt stays closed", async () => {
    const id = await seedNoe(ORG_A, { state: "DRAFT" });
    const vendor = externalFilingService(false);

    // vendor era: submit appends attempt 0 (queued) and enqueues a job carrying it
    const first = await vendor.service.submitNoe(actorOf(ORG_A), id);
    expect(await attemptsOf(id)).toMatchObject([{ attempt_index: 0, outcome: "queued" }]);

    // the org switches to outside before the job runs: the worker pre-flight parks the notice and closes ITS attempt
    await parkNoticeForExternalFiling(
      { db: handle.db as never },
      {
        organizationId: ORG_A,
        kind: "noe",
        noticeId: id,
        submissionId: first.submissionId as string,
      },
    );
    expect(await noeRow(id)).toMatchObject({ state: "READY", external_filing_status: "pending" });
    expect(await attemptsOf(id)).toMatchObject([
      { attempt_index: 0, outcome: "failed_worker", outcome_reason: "PARKED_FOR_EXTERNAL_FILING" },
    ]);

    // the org switches back to a vendor and the tenant resubmits: a NEW attempt, never the closed row handed back
    const second = await vendor.service.submitNoe(actorOf(ORG_A), id);
    expect(second.submissionId).not.toBe(first.submissionId);
    expect(await noeRow(id)).toMatchObject({ external_filing_status: null });
    expect(await attemptsOf(id)).toMatchObject([
      { attempt_index: 0, outcome: "failed_worker" },
      { attempt_index: 1, outcome: "queued", id: second.submissionId },
    ]);

    // the worker records the transmission on THAT attempt
    await withOrgContext(handle.db as never, { organizationId: ORG_A, userId: "" }, (tx) =>
      runNoeSubmit(tx as never, workerDeps, {
        organizationId: ORG_A,
        noeId: id,
        submissionId: second.submissionId as string,
      }),
    );
    expect(await attemptsOf(id)).toMatchObject([
      { attempt_index: 0, outcome: "failed_worker", outcome_reason: "PARKED_FOR_EXTERNAL_FILING" },
      { attempt_index: 1, outcome: "submitted", id: second.submissionId, sent: true },
    ]);
    const { rows } = await admin.query(
      "SELECT state, latest_submission_id FROM noe_record WHERE id=$1",
      [id],
    );
    expect(rows[0]).toMatchObject({
      state: "SUBMITTED",
      latest_submission_id: second.submissionId,
    });
  }, 60_000);

  it("a notice recorded as filed while a vendor-era attempt is queued: the job (outside: the park; vendor again: the submit worker) ends without transmitting and closes its OWN attempt", async () => {
    const outside = externalFilingService(true);
    const vendor = externalFilingService(false);
    for (const org of ["outside", "vendor"] as const) {
      const id = await seedNoe(ORG_A, { state: "DRAFT" });
      const queued = await vendor.service.submitNoe(actorOf(ORG_A), id);
      // the org goes outside and the tenant records the filing; the queued attempt is NOT closed from the request path
      await outside.service.recordNoeExternalFiling(actorOf(ORG_A), id, { filedOn: todayIso() });
      expect(await attemptsOf(id)).toMatchObject([{ attempt_index: 0, outcome: "queued" }]);
      const submitted = (name: string) => eventRows(name, "noeId", id);

      if (org === "outside") {
        await parkNoticeForExternalFiling(
          { db: handle.db as never },
          {
            organizationId: ORG_A,
            kind: "noe",
            noticeId: id,
            submissionId: queued.submissionId as string,
          },
        );
      } else {
        await withOrgContext(handle.db as never, { organizationId: ORG_A, userId: "" }, (tx) =>
          runNoeSubmit(tx as never, workerDeps, {
            organizationId: ORG_A,
            noeId: id,
            submissionId: queued.submissionId as string,
          }),
        );
      }
      expect(await attemptsOf(id)).toMatchObject([
        {
          attempt_index: 0,
          outcome: "failed_worker",
          outcome_reason:
            org === "outside" ? "PARKED_FOR_EXTERNAL_FILING" : "NOTICE_FILED_EXTERNALLY",
          sent: false,
        },
      ]);
      // never transmitted: the notice is still the tenant's recorded filing, and nothing was announced as submitted
      expect(await noeRow(id)).toMatchObject({ state: "READY", external_filing_status: "filed" });
      expect(await submitted("m23.noe.submitted")).toHaveLength(0);
    }
  }, 60_000);

  // Round 3, L1a: the worker read the notice, checked it, then spent a network call on the upload before it wrote anything, so a
  // record / park of the same notice could commit in between and the notice would be transmitted AND recorded as filed. The worker
  // now takes the row's lock with its read and holds it to its commit: the concurrent write waits, and then loses (412).
  it.each(["record", "park"] as const)(
    "the submit worker holds the NOE row from its read to its commit: a concurrent %s waits for the upload and then loses, so the notice is never transmitted AND filed",
    async (concurrent) => {
      const vendor = externalFilingService(false);
      const outside = externalFilingService(true);
      const id = await seedNoe(ORG_A, { state: "DRAFT" });
      const queued = await vendor.service.submitNoe(actorOf(ORG_A), id);

      let reachedUpload!: () => void;
      const atUpload = new Promise<void>((resolve) => {
        reachedUpload = resolve;
      });
      let finishUpload!: () => void;
      const uploadMayFinish = new Promise<void>((resolve) => {
        finishUpload = resolve;
      });
      const portal = workerDeps.macPortal as NonNullable<M23WorkerDeps["macPortal"]>;
      const slowDeps: M23WorkerDeps = {
        ...workerDeps,
        macPortal: {
          ...portal,
          upload: async (input) => {
            reachedUpload();
            await uploadMayFinish;
            return { accepted: true, generatedFileUri: `s3://notices/${input.controlNumber}.x12` };
          },
        },
      };
      const worker = withOrgContext(
        handle.db as never,
        { organizationId: ORG_A, userId: "" },
        (tx) =>
          runNoeSubmit(tx as never, slowDeps, {
            organizationId: ORG_A,
            noeId: id,
            submissionId: queued.submissionId as string,
          }),
      );
      await atUpload; // the worker has read and checked the notice and is mid-upload

      let outcome = "pending";
      const rival =
        concurrent === "record"
          ? outside.service.recordNoeExternalFiling(actorOf(ORG_A), id, { filedOn: todayIso() })
          : outside.service.submitNoe(actorOf(ORG_A), id);
      const settledRival = rival.then(
        () => {
          outcome = "committed";
        },
        (error: { code?: string }) => {
          outcome = error.code ?? "failed";
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      const outcomeWhileUploading = outcome;
      finishUpload(); // always let the worker end, so a failing assertion cannot strand its connection
      const workerResult = await worker.then(
        () => "done",
        (error: unknown) => String(error),
      );
      await settledRival;
      expect(
        outcomeWhileUploading,
        "the concurrent write must wait behind the worker's row lock",
      ).toBe("pending");
      expect(workerResult).toBe("done");
      expect(outcome).toBe("VERSION_CONFLICT");
      expect(await noeRow(id)).toMatchObject({ state: "SUBMITTED", external_filing_status: null });
      expect(await eventRows("m23.noe.submitted", "noeId", id)).toHaveLength(1);
    },
    60_000,
  );

  it("cross-tenant: org B cannot record (or park) org A's NOE; the worker's park of a job enqueued before the org switched is org-scoped too", async () => {
    const { service } = externalFilingService(true);
    const id = await seedNoe(ORG_A);
    await expect(
      service.recordNoeExternalFiling(actorOf(ORG_B), id, { filedOn: todayIso() }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.submitNoe(actorOf(ORG_B), id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await noeRow(id)).toMatchObject({ external_filing_status: null, version: 0 });

    // The worker pre-flight (a job enqueued before the org went `outside`): parks only the job's own org's notice.
    await parkNoticeForExternalFiling(
      { db: handle.db as never },
      { organizationId: ORG_B, kind: "noe", noticeId: id },
    );
    expect(await noeRow(id)).toMatchObject({ external_filing_status: null });
    await parkNoticeForExternalFiling(
      { db: handle.db as never },
      { organizationId: ORG_A, kind: "noe", noticeId: id },
    );
    expect(await noeRow(id)).toMatchObject({ state: "READY", external_filing_status: "pending" });
  }, 60_000);
});
