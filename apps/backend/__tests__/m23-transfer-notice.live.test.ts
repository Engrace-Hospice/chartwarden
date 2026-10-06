/**
 * The receiving hospice's Medicare transfer notice (TOB 8xC), END TO END over real Postgres.
 *
 * CMS Pub. 100-04 ch. 11 §20.1.3 (Rev. 12847): "The admitting hospice submits a transfer notice after the
 * transfer has occurred ... The 8XC does not get submitted until after the other provider has finalized their
 * billing." Transfers from the same CCN are not allowed; a beneficiary changes hospices once per benefit
 * period; the receiving hospice's From date must equal the transferring hospice's Through date.
 *
 * Nothing on the path is stubbed except the two external wires (the X12 gateway and the MAC transport): the
 * REAL M6 write service records the transfer-in as the NOBYPASSRLS `wardenx_app` role → the REAL
 * catalog-validating publisher writes `m6.transfer.created` → the REAL dispatcher delivers it → M23's
 * consumer drafts through the real repository under RLS → the real transfer-notice service confirms and
 * submits → the real worker processor transmits → the real 999 / 277CA ack crons route the acks by the
 * submission's kind.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m23:transfer-notice:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  buildProviderEntityLocationLister,
  buildRequiredProviderEntityCcnResolver,
} from "../src/bootstrap/provider-entity-resolver";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import { M6_OUTBOX_EVENTS, transferInNoticeContextForOrg } from "../src/modules/06-admission/index";
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
  buildM23TransferNoticeDraftConsumer,
  buildTransferNoticeService,
} from "../src/modules/23-billing-medicare/index";
import {
  type M23WorkerDeps,
  runAckPull277ca,
  runAckPull999,
  runTransferNoticeSubmitJob,
} from "../src/modules/23-billing-medicare/jobs/m23-jobs";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/index";
import { M27_OUTBOX_EVENTS } from "../src/modules/27-cost-report/index";
import { M33_OUTBOX_EVENTS } from "../src/modules/33-reporting/index";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const ATTENDING = "77777777-7777-7777-7777-777777777777";
const MD = "66666666-6666-6666-6666-666666666666";
const CCN: Record<string, string> = { [ORG_A]: "381501", [ORG_B]: "381502" };
const SENDING_CCN = "381777";
const SENDING_NPI = "1234567893";
const TRANSFER_DATE = "2026-03-10";

describe.skipIf(!DB_URL)("M23 transfer notice (TOB 8xC) — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbAdmissionRouteService>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let notices: ReturnType<typeof buildTransferNoticeService>;
  let workerDeps: M23WorkerDeps;
  const providerOf: Record<string, string> = {};
  const membershipOf: Record<string, string> = {};
  const enqueued: { queue: string; payload: Record<string, unknown> }[] = [];
  const generated: Record<string, unknown>[] = [];
  let pending999: { rawFileUri: string }[] = [];
  let pending277: { rawFileUri: string }[] = [];
  let parsed999: unknown[] = [];
  let parsed277: unknown[] = [];

  const actor = (org: string) => ({
    organizationId: org,
    userId: USER,
    roles: ["billing_manager"],
    membershipId: membershipOf[org] as string,
    stepUpRecent: true,
    actorKind: "user",
  });

  async function applyMigrations() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  /** An admission in intake, sited on the org's provider, dated on the transfer date. */
  async function intakeAdmission(org: string): Promise<string> {
    const { admissionId } = await admitViaQualifiedReferral(svc, admin, {
      hospicePhysicianId: MD,
      organizationId: org,
      actorUserId: USER,
      patientId: randomUUID(),
      admissionAt: `${TRANSFER_DATE}T12:00:00.000Z`,
    });
    const { rows } = await admin.query("SELECT version FROM admission WHERE id=$1", [admissionId]);
    await svc.updateAdmission(
      org,
      admissionId,
      { providerEntityId: providerOf[org] } as never,
      Number(rows[0].version),
    );
    return admissionId;
  }

  async function transferIn(
    org: string,
    admissionId: string,
    over: Record<string, unknown> = {},
  ): Promise<void> {
    await svc.transferIn(
      org,
      admissionId,
      {
        effectiveDate: TRANSFER_DATE,
        otherHospiceName: "Sending Hospice of Oregon",
        otherHospiceCcn: SENDING_CCN,
        otherHospiceNpi: SENDING_NPI,
        // accept seeded period 1 on this admission, so the carried sequence is 2.
        priorBenefitPeriodSequence: 2,
        priorElectionStartDate: "2026-01-01",
        hospiceMedicalDirectorId: MD,
        attendingPhysicianId: ATTENDING,
        narrative: "Family relocated; records received from the sending hospice.",
        ...over,
      } as never,
      USER,
    );
  }

  async function noticeRowsFor(admissionId: string) {
    const { rows } = await admin.query(
      `SELECT id, organization_id, action, state, tob, statement_from_date::text AS from_date,
              admission_date::text AS admission_date, benefit_period_sequence, prior_hospice_ccn,
              prior_hospice_npi, provider_ccn, attending_physician_id, certifying_physician_id,
              payer_control_number, version
         FROM transfer_notice_record WHERE admission_id=$1 ORDER BY created_at`,
      [admissionId],
    );
    return rows;
  }

  async function draftedNoticeFor(org: string): Promise<{ admissionId: string; id: string }> {
    const admissionId = await intakeAdmission(org);
    await transferIn(org, admissionId);
    await dispatcher.tick();
    const rows = await noticeRowsFor(admissionId);
    expect(rows).toHaveLength(1);
    return { admissionId, id: rows[0].id as string };
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'tn@x.test'),($2,'tnmd@x.test'),($3,'tnat@x.test')`,
      [USER, MD, ATTENDING],
    );
    for (const org of [ORG_A, ORG_B]) {
      providerOf[org] = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'\\x00','12-31') RETURNING id`,
          [
            org,
            CCN[org],
            `Hospice ${org.slice(0, 4)}`,
            org === ORG_A ? "1245319599" : "1679576722",
          ],
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone, status)
         VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles','active')`,
        [providerOf[org]],
      );
      membershipOf[org] = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [USER, org],
        )
      ).rows[0].id as string;
    }
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    registerM5IntakeSeams(handle.db);

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
        buildM23TransferNoticeDraftConsumer({
          db: handle.db as never,
          outbox: bind("m23") as never,
          resolveTransferIn: (org, transferEventId) =>
            transferInNoticeContextForOrg(handle.db, org, transferEventId),
          resolveCcn: buildRequiredProviderEntityCcnResolver(handle.db),
        }),
      ],
      eventCatalog: catalog,
      options: { log: () => {} },
    });

    notices = buildTransferNoticeService(handle.db as never, {
      outbox: bind("m23") as never,
      jobs: {
        async enqueue(queue, dedupeKey, payload) {
          enqueued.push({ queue, payload });
          return { jobId: `outbox:${dedupeKey}` };
        },
      },
      transferInFacts: (org, transferEventId) =>
        transferInNoticeContextForOrg(handle.db, org, transferEventId),
    });

    workerDeps = {
      connection: {} as never,
      db: handle.db as never,
      outbox: bind("m23") as never,
      x12: {
        generate837i: async () => ({ x12: "", correlationId: "" }),
        generateNoe: async () => ({ x12: "", correlationId: "" }),
        generateNotr: async () => ({ x12: "", correlationId: "" }),
        async generateTransferNotice(input) {
          generated.push(input as never);
          return { x12: "ISA*...~", correlationId: `corr-${input.transferNoticeId}` };
        },
        parse999: async () => parsed999 as never,
        parse277ca: async () => parsed277 as never,
      },
      macPortal: {
        upload: async (input) => ({
          accepted: true,
          generatedFileUri: `s3://notices/${input.controlNumber}.x12`,
        }),
        pullPending999: async () => pending999,
        pullPending277ca: async () => pending277,
        probeHealth: async () => true,
      },
      jurisdictions: { listJurisdictions: async () => [{ macJurisdiction: "ngs_j6" }] },
    };
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("drafts an original 81C when M6 records a transfer-in — dated from the transfer, held for the prior hospice", async () => {
    const admissionId = await intakeAdmission(ORG_A);
    await transferIn(ORG_A, admissionId);
    expect(await noticeRowsFor(admissionId)).toHaveLength(0);

    await dispatcher.tick();

    const rows = await noticeRowsFor(admissionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organization_id: ORG_A,
      action: "original",
      state: "DRAFT",
      tob: "81C",
      from_date: TRANSFER_DATE,
      admission_date: TRANSFER_DATE,
      benefit_period_sequence: 2,
      prior_hospice_ccn: SENDING_CCN,
      prior_hospice_npi: SENDING_NPI,
      provider_ccn: CCN[ORG_A],
      attending_physician_id: ATTENDING,
      certifying_physician_id: MD,
    });
    const { rows: events } = await admin.query(
      "SELECT organization_id FROM outbox_event WHERE event_type='m23.transfer_notice.draft_created' AND payload->>'transferNoticeId'=$1",
      [rows[0].id],
    );
    expect(events).toEqual([{ organization_id: ORG_A }]);

    const view = await notices.get(actor(ORG_A), rows[0].id as string);
    expect(view.blockers.map((b) => b.code)).toEqual(["PRIOR_BILLING_NOT_CONFIRMED"]);
    expect(view.allowedActions).not.toContain("submit");
    await expect(
      notices.submit(actor(ORG_A), view.transferNoticeId, { expectedVersion: view.version }),
    ).rejects.toMatchObject({ code: "TRANSFER_NOTICE_BLOCKED", statusCode: 422 });
  });

  it("confirm → submit → worker → 999 → 277CA accepted, the whole filing", async () => {
    const { id } = await draftedNoticeFor(ORG_A);
    let view = await notices.get(actor(ORG_A), id);

    // A Through date one day short is a gap in care: Medicare would reject the transfer.
    view = await notices.confirmPriorBilling(actor(ORG_A), id, {
      expectedVersion: view.version,
      priorHospiceThroughDate: "2026-03-09",
      priorHospicePatientStatus: "50",
    });
    expect(view.blockers.map((b) => b.code)).toEqual(["CONTINUITY_GAP"]);

    view = await notices.confirmPriorBilling(actor(ORG_A), id, {
      expectedVersion: view.version,
      priorHospiceThroughDate: TRANSFER_DATE,
      priorHospicePatientStatus: "51",
    });
    expect(view.blockers).toEqual([]);
    expect(view.allowedActions).toContain("submit");

    const accepted = await notices.submit(actor(ORG_A), id, { expectedVersion: view.version });
    expect(accepted.kind).toBe("transfer_notice");
    expect(enqueued.at(-1)).toEqual({
      queue: "transfer_notice.submit",
      payload: { transferNoticeId: id, submissionId: accepted.submissionId },
    });
    const { rows: subs } = await admin.query(
      "SELECT kind::text AS kind, outcome::text AS outcome, transfer_notice_id FROM claim_submission WHERE id=$1",
      [accepted.submissionId],
    );
    expect(subs).toEqual([{ kind: "transfer_notice", outcome: "queued", transfer_notice_id: id }]);
    expect((await noticeRowsFor(view.admissionId))[0].state).toBe("READY");

    // The worker, exactly as the BullMQ processor runs it (org-scoped tx as the app role).
    await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
      runTransferNoticeSubmitJob(tx as never, workerDeps, {
        organizationId: ORG_A,
        transferNoticeId: id,
        submissionId: accepted.submissionId,
      }),
    );
    expect(generated.at(-1)).toMatchObject({
      transferNoticeId: id,
      document: {
        tob: "81C",
        frequencyCode: "C",
        statementFromDate: TRANSFER_DATE,
        admissionDate: TRANSFER_DATE,
        conditionCodes: [],
        attendingPhysicianId: ATTENDING,
        otherPhysicianId: MD,
      },
    });
    expect((await noticeRowsFor(view.admissionId))[0].state).toBe("SUBMITTED");

    pending999 = [{ rawFileUri: `999-${id}` }];
    parsed999 = [
      {
        organizationId: ORG_A,
        claimId: "",
        submissionId: accepted.submissionId,
        claimControlNumber: view.controlNumber,
        accepted: true,
        reasonCodes: [],
        ackFileUri: `s3://acks/999-${id}`,
      },
    ];
    await runAckPull999(workerDeps);
    expect((await noticeRowsFor(view.admissionId))[0].state).toBe("ACK_PENDING");

    pending277 = [{ rawFileUri: `277-${id}` }];
    parsed277 = [
      {
        organizationId: ORG_A,
        claimId: "",
        submissionId: accepted.submissionId,
        outcome: "accepted",
        payerClaimControlNumber: "PAYER-8XC-1",
        reasonCodes: [],
        ackFileUri: `s3://acks/277-${id}`,
      },
    ];
    await runAckPull277ca(workerDeps);
    const done = (await noticeRowsFor(view.admissionId))[0];
    expect(done.state).toBe("ACK_ACCEPTED");
    expect(done.payer_control_number).toBe("PAYER-8XC-1");
    const { rows: acks } = await admin.query(
      "SELECT kind::text AS kind, claim_id FROM claim_acknowledgment WHERE submission_id=$1 ORDER BY ack_received_at, kind",
      [accepted.submissionId],
    );
    expect(acks.map((a) => a.kind).sort()).toEqual(["ack_277ca", "ack_999"]);
    expect(acks.every((a) => a.claim_id === null)).toBe(true);
    const { rows: acceptedEvents } = await admin.query(
      "SELECT 1 FROM outbox_event WHERE event_type='m23.transfer_notice.accepted' AND payload->>'transferNoticeId'=$1",
      [id],
    );
    expect(acceptedEvents).toHaveLength(1);

    // §20.1.3 correction: a new 8xC whose From is the corrected date, with OC 56 (date on file) + CC D0.
    const corrected = await notices.correctDate(actor(ORG_A), id, {
      correctedTransferDate: "2026-03-11",
    });
    expect(corrected).toMatchObject({
      action: "correction",
      supersedesNoticeId: id,
      tob: "81C",
      statementFromDate: "2026-03-11",
      originalTransferDate: TRANSFER_DATE,
      conditionCodes: ["D0"],
    });
    expect(corrected.occurrenceCodes).toEqual([{ code: "56", date: TRANSFER_DATE }]);
    // The original now has a live follow-up, so it offers no second correction or void.
    expect((await notices.get(actor(ORG_A), id)).allowedActions).toEqual([]);
    await expect(notices.voidNotice(actor(ORG_A), id)).rejects.toThrow(/in progress/);
  });

  it("refuses a transfer-in from our own CCN, and records nothing", async () => {
    const admissionId = await intakeAdmission(ORG_A);
    await expect(
      transferIn(ORG_A, admissionId, { otherHospiceCcn: CCN[ORG_A] }),
    ).rejects.toMatchObject({ code: "TRANSFER_SAME_PROVIDER", statusCode: 422 });
    const { rows } = await admin.query("SELECT 1 FROM transfer_event WHERE admission_id=$1", [
      admissionId,
    ]);
    expect(rows).toHaveLength(0);
    await dispatcher.tick();
    expect(await noticeRowsFor(admissionId)).toHaveLength(0);
  });

  it("refuses a second change of hospice in the same benefit period", async () => {
    const admissionId = await intakeAdmission(ORG_A);
    await transferIn(ORG_A, admissionId);
    await expect(
      transferIn(ORG_A, admissionId, { priorBenefitPeriodSequence: 2 }),
    ).rejects.toMatchObject({ code: "TRANSFER_LIMIT_EXCEEDED", statusCode: 409 });
  });

  it("cancels a draft with a reason, then redrafts it as a fresh original", async () => {
    const { admissionId, id } = await draftedNoticeFor(ORG_A);
    const view = await notices.get(actor(ORG_A), id);
    await expect(
      notices.cancel(actor(ORG_A), id, { expectedVersion: view.version, reason: " " }),
    ).rejects.toMatchObject({ statusCode: 422 });
    const cancelled = await notices.cancel(actor(ORG_A), id, {
      expectedVersion: view.version,
      reason: "Recorded against the wrong admission.",
    });
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.allowedActions).toEqual(["redraft"]);
    const redrafted = await notices.redraft(actor(ORG_A), id);
    expect(redrafted).toMatchObject({
      action: "original",
      state: "draft",
      supersedesNoticeId: null,
    });
    expect(redrafted.controlNumber).not.toBe(cancelled.controlNumber);
    expect(await noticeRowsFor(admissionId)).toHaveLength(2);
  });

  it("keeps each tenant's notices to itself — service, list and RLS as the app role", async () => {
    const a = await draftedNoticeFor(ORG_A);
    const b = await draftedNoticeFor(ORG_B);
    expect((await noticeRowsFor(b.admissionId))[0].organization_id).toBe(ORG_B);

    await expect(notices.get(actor(ORG_B), a.id)).rejects.toMatchObject({ statusCode: 404 });
    const listB = await notices.list(actor(ORG_B), {}, undefined, 200);
    expect(listB.items.map((n) => n.transferNoticeId)).toContain(b.id);
    expect(listB.items.map((n) => n.transferNoticeId)).not.toContain(a.id);

    const seenFromB = await withOrgContext(
      handle.db,
      { organizationId: ORG_B, userId: USER },
      (tx) => tx.execute(sql`SELECT id FROM transfer_notice_record WHERE id = ${a.id}`),
    );
    expect(seenFromB.rows).toHaveLength(0);
  });
});
