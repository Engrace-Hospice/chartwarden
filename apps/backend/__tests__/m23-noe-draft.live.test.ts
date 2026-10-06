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
import { repositories } from "@wardenx/billing";
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
import {
  M23_OUTBOX_EVENTS,
  buildM23NoeDraftConsumer,
  noeWindowTargetAt,
} from "../src/modules/23-billing-medicare/index";
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
});
