/**
 * M25 electronic submission, milestone 6a (hospice ADR/TPE/QIC PRD) - LIVE Postgres as the NOBYPASSRLS `chartwarden_app`
 * role, through the real services, the real M22 / M23 seams and the real catalog-validating publisher.
 *
 * Proves what the pure suites cannot: every ADR response, appeal, reopening request and QIC escalation request leaves
 * exactly one submission attempt that mirrors the case's own filing columns; an appeal submit (normal and late good
 * cause), which records no proof, leaves a `needs_manual` attempt and still moves the case to `submitted` as before;
 * the receipt route needs the subject's submit key AND a fresh step-up, refuses a receipt document of another patient,
 * another tenant or 42 CFR Part 2, moves the attempt to `acknowledged`, and freezes it (a correction appends, never
 * rewrites); one live attempt per (subject, purpose); the CHECKs make a send without an approval or an electronic
 * adapter, and an acknowledgement without proof, unrepresentable; another tenant sees nothing; the confirmation
 * reference stays out of the audit trail; the esMD and fax shells are unbound and nothing is transmitted; and the
 * nightly proof-missing cron alerts.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m25:submission:live
 * (SUPERUSER to a THROWAWAY db - this file DROPs and recreates the public schema.)
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { repositories } from "@chartwarden/billing";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFoundationSiteReader } from "../src/bootstrap/foundation-site-reader";
import { buildServer, registerSeam } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  createDocumentReader,
  createDrizzleDocumentReaderStore,
} from "../src/modules/22-documents/index";
import { registerM23PublishedSeams } from "../src/modules/23-billing-medicare/cost-report-seams";
import { ADR_CHECKLIST_KEYS } from "../src/modules/25-remittance/domain";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/index";
import { runAppealDeadlineCron } from "../src/modules/25-remittance/jobs/cron-workers";
import { buildDrizzleAdrService } from "../src/modules/25-remittance/routes/adr-service";
import { buildSeamAppealSourcePorts } from "../src/modules/25-remittance/routes/appeal-packet-sources";
import { buildDrizzleQicService } from "../src/modules/25-remittance/routes/qic-service";
import { buildDrizzleReopeningService } from "../src/modules/25-remittance/routes/reopening-service";
import {
  buildDrizzleSubmissionService,
  recordFilingAttempt,
} from "../src/modules/25-remittance/routes/submission-service";
import {
  SubmissionViewSchema,
  registerSubmissionRoutes,
} from "../src/modules/25-remittance/routes/submission.routes";
import { buildDrizzleM25WriteService } from "../src/modules/25-remittance/routes/write-service-drizzle";
import { LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) FormatRegistry.Set("uuid", (v) => UUID_RE.test(v));
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => !Number.isNaN(Date.parse(v)));
}

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const ORG = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const NARRATIVE = "The redetermination overlooked the timely face-to-face note enclosed here.";
const ROUTE_PERMISSIONS = [
  "adr.read",
  "adr.submit",
  "appeal.read",
  "appeal.submit",
  "reopening.read",
  "reopening.submit",
];

describe.skipIf(!DB_URL)("M25 submission attempts (milestone 6a) - LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let app: FastifyInstance;
  let providerEntityId = "";
  let claimId = "";
  let userA = "";
  let memberA = "";
  let userB = "";
  let userC = "";
  let memberB = "";
  let docF2f = "";
  let docCti = "";
  let docReceipt = "";
  let docOtherPatient = "";
  let docPart2 = "";
  let docOtherTenant = "";
  const patient = randomUUID();

  const outbox = buildTxOutboxPublisher(buildBootOutboxCatalog([M25_OUTBOX_EVENTS]));
  const m25Outbox = {
    publish: (
      tx: unknown,
      input: Parameters<typeof outbox.publish>[1] extends infer I ? Omit<I, "callerModule"> : never,
    ) =>
      outbox.publish(tx as Parameters<typeof outbox.publish>[0], { ...input, callerModule: "m25" }),
  };
  const providerZones = (tx: DbClient, pe: string) =>
    buildFoundationSiteReader().providerEntityTimezones(tx, pe);
  const write = () =>
    buildDrizzleM25WriteService(handle.db, m25Outbox, {
      appealSources: buildSeamAppealSourcePorts(),
      providerZones,
    });
  const qic = () => buildDrizzleQicService(handle.db, { providerZones });
  const adrSvc = () =>
    buildDrizzleAdrService(handle.db, { outbox: m25Outbox, sources: buildSeamAppealSourcePorts() });
  const reopenSvc = () => buildDrizzleReopeningService(handle.db);
  const sub = () =>
    buildDrizzleSubmissionService(handle.db, { sources: buildSeamAppealSourcePorts() });
  const actorOf = (membershipId: string, organizationId = ORG, userId = userA) => ({
    organizationId,
    userId,
    membershipId,
    roles: ["billing_manager"],
    stepUpRecent: true,
  });
  const A = () => actorOf(memberA);
  const B = () => actorOf(memberB, ORG, userC);
  const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const refused = async (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string; message?: string; statusCode?: number }) => e,
    );
  const ver = async (table: string, id: string) =>
    Number((await admin.query(`SELECT version FROM ${table} WHERE id=$1`, [id])).rows[0].version);
  const attempts = async (col: string, id: string) =>
    (
      await admin.query(
        `SELECT * FROM submission_attempt WHERE ${col}=$1 ORDER BY attempt_no, created_at`,
        [id],
      )
    ).rows;

  async function seedDocument(
    org: string,
    patientId: string | null,
    title: string,
    over: { retentionClass?: string; aggregateType?: string } = {},
  ): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO document (organization_id, patient_id, retention_class, source_kind, aggregate_type, title,
           status, created_by_membership_id)
         VALUES ($1,$2,$3,'user_upload',$4,$5,'active',$6) RETURNING id`,
        [
          org,
          patientId,
          over.retentionClass ?? "clinical_record",
          over.aggregateType ?? "f2f",
          title,
          memberA,
        ],
      )
    ).rows[0].id as string;
  }

  async function mkDenial(): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO denial_case (organization_id, provider_entity_id, claim_id, source_evv_aggregator_submission_id,
           carc_code, category, source, state, dollar_value, taxonomy_status)
         VALUES ($1,$2,$3,$4,'50','denial','evv_aggregator_rejection','appealed',10,'mapped') RETURNING id`,
        [ORG, providerEntityId, claimId, randomUUID()],
      )
    ).rows[0].id as string;
  }

  async function seedAppeal(over: { tier?: string; deadline?: string } = {}): Promise<string> {
    const denialId = await mkDenial();
    return (
      await admin.query(
        `INSERT INTO appeal_case (organization_id, provider_entity_id, denial_case_id, claim_id, tier, state,
           tier_deadline_at, notice_dated_on)
         VALUES ($1,$2,$3,$4,$5,'draft',$6,'2026-02-01') RETURNING id`,
        [
          ORG,
          providerEntityId,
          denialId,
          claimId,
          over.tier ?? "redetermination",
          over.deadline ?? "2099-01-01T00:00:00Z",
        ],
      )
    ).rows[0].id as string;
  }
  const appealFields = (over: Record<string, unknown> = {}) => ({
    appealNarrative: NARRATIVE,
    attachedDocumentIds: [docF2f],
    ...over,
  });
  const submittedAppeal = async (): Promise<string> => {
    const id = await seedAppeal();
    await write().submitAppeal(A(), id, appealFields(), await ver("appeal_case", id));
    return id;
  };

  async function adrInReview(): Promise<string> {
    const { id } = await adrSvc().createAdr(A(), {
      claimId,
      macName: "CGS",
      reviewType: "adr",
      requestedOn: daysAgo(5),
      adrReference: "ADR-REF-1",
    });
    const v = () => ver("adr_case", id);
    await adrSvc().transitionAdr(A(), id, "in_assembly", await v());
    await adrSvc().attachAdrDocument(
      A(),
      id,
      { documentId: docF2f, checklistKey: "plan_of_care" },
      await v(),
    );
    for (const key of ADR_CHECKLIST_KEYS) {
      await adrSvc().setAdrChecklistItem(A(), id, key, "ready", await v());
    }
    await adrSvc().transitionAdr(A(), id, "in_review", await v());
    await adrSvc().signOffAdr(B(), id, await v());
    return id;
  }
  async function reopeningDraft(): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO reopening_case (organization_id, provider_entity_id, claim_id, denial_case_id, mac_name)
         VALUES ($1,$2,$3,$4,'CGS') RETURNING id`,
        [ORG, providerEntityId, claimId, await mkDenial()],
      )
    ).rows[0].id as string;
  }
  /** A reconsideration submitted, acknowledged and 70 days past the QIC's receipt, so escalation is available. */
  async function lateReconsideration(): Promise<string> {
    const id = await seedAppeal({ tier: "reconsideration" });
    await qic().setCitedEvidence(A(), id, { items: [], none: true }, await ver("appeal_case", id));
    await write().submitAppeal(
      A(),
      id,
      appealFields({
        reconsideration: {
          redeterminationMacName: "Example MAC",
          redeterminationNoticeDocumentId: docCti,
          evidencePreclusionAcknowledged: false,
        },
        attachedDocumentIds: [docF2f, docCti],
      }),
      await ver("appeal_case", id),
    );
    await admin.query(
      "UPDATE appeal_case SET submitted_at = now() - interval '200 days' WHERE id = $1",
      [id],
    );
    await write().ackAppeal(A(), id, await ver("appeal_case", id));
    await qic().recordQicClock(A(), id, { receivedOn: daysAgo(70) }, await ver("appeal_case", id));
    return id;
  }

  // ── route-level scaffolding (permissions, the step-up predicate, header auth) ──────────────────────────────
  function headerAuth(request: FastifyRequest): void {
    const u = request.headers["x-test-user"];
    if (typeof u !== "string" || u.length === 0) return;
    request.context.userId = u;
    const org = request.headers["x-test-org"];
    request.context.organizationId = typeof org === "string" ? org : "";
    request.context.roles = ["billing_manager"];
    const m = request.headers["x-test-membership"];
    request.context.attributes.membershipId = typeof m === "string" ? m : u;
    if (request.headers["x-test-step-up"] === "1") request.context.attributes.stepUpRecent = true;
  }
  const as = (org: string, user: string, membership: string, stepUp = false) => ({
    "x-test-user": user,
    "x-test-org": org,
    "x-test-membership": membership,
    ...(stepUp ? { "x-test-step-up": "1" } : {}),
  });
  const receiptCall = (
    segment: string,
    id: string,
    body: Record<string, unknown>,
    ifMatch: number,
    stepUp = true,
    who: [string, string, string] = [ORG, userA, memberA],
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/${segment}/${id}/submission-receipt`,
      headers: {
        ...as(who[0], who[1], who[2], stepUp),
        "idempotency-key": randomUUID(),
        "if-match": String(ifMatch),
      },
      payload: body as never,
    });
  const receipt = (attemptId: string, over: Record<string, unknown> = {}) => ({
    attemptId,
    confirmationRef: "CONF-RECEIPT-7731",
    receiptAt: new Date(Date.now() - 3_600_000).toISOString(),
    ...over,
  });

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
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
    for (const [org, slug] of [
      [ORG, "m25-sub"],
      [ORG_B, "m25-sub-b"],
    ])
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,'A','A')",
        [org, slug],
      );
    userA = (await admin.query(`INSERT INTO "user" (email) VALUES ('sub-a@x.test') RETURNING id`))
      .rows[0].id as string;
    userB = (await admin.query(`INSERT INTO "user" (email) VALUES ('sub-b@x.test') RETURNING id`))
      .rows[0].id as string;
    const member = async (user: string, org: string) =>
      (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [user, org],
        )
      ).rows[0].id as string;
    memberA = await member(userA, ORG);
    userC = (await admin.query(`INSERT INTO "user" (email) VALUES ('sub-c@x.test') RETURNING id`))
      .rows[0].id as string;
    memberB = await member(userC, ORG);
    const memberOrgB = await member(userB, ORG_B);
    providerEntityId = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN-SUB','SUB','NPI-SUB','enc','12-31') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    claimId = (
      await withOrgContext(handle.db, { organizationId: ORG, userId: "" }, (tx) =>
        new repositories.ClaimRepository(tx).create({
          organizationId: ORG,
          providerEntityId,
          patientId: patient,
          admissionId: randomUUID(),
          electionPeriodIdFrom: randomUUID(),
          electionPeriodIdTo: randomUUID(),
          patientPayerId: randomUUID(),
          tob: "811",
          serviceFrom: "2026-03-01",
          serviceTo: "2026-03-31",
          claimControlNumber: "CCN-SUB-0001",
          payerClaimControlNumber: null,
          macJurisdiction: "ngs_j6",
          sequestrationAppliedPct: "2.00",
          sequestrationPolicyId: randomUUID(),
          createdByMembershipId: randomUUID(),
          totalChargeCents: 1_234_500,
        }),
      )
    ).id;
    await admin.query("UPDATE claim SET state = 'DENIED' WHERE id = $1", [claimId]);
    await admin.query(
      `INSERT INTO claim_line (organization_id, claim_id, line_number, revenue_code, q_code, level_of_care,
         service_date_from, service_date_to, unit_count, unit_rate_cents, line_charge_cents, level_of_care_period_id)
       VALUES ($1,$2,1,'0651','Q5001','RHC','2026-03-01','2026-03-31',30,41150,1234500,$1)`,
      [ORG, claimId],
    );
    docF2f = await seedDocument(ORG, patient, "Face-to-face note");
    docCti = await seedDocument(ORG, patient, "Certification of terminal illness", {
      aggregateType: "encounter",
    });
    docReceipt = await seedDocument(ORG, patient, "Portal confirmation page", {
      aggregateType: "encounter",
    });
    docOtherPatient = await seedDocument(ORG, randomUUID(), "Someone else's record");
    docPart2 = await seedDocument(ORG, patient, "Part 2 record", {
      retentionClass: "compliance_42cfr_part2",
    });
    docOtherTenant = await seedDocument(ORG_B, null, "SECRET other tenant document");
    registerM23PublishedSeams(handle.db);
    registerSeam(
      "DocumentReader",
      createDocumentReader(createDrizzleDocumentReaderStore(handle.db)),
    );

    resetAuthorizationContract();
    resetRbacEngine();
    const { store } = createInMemoryEffectivePermissionStore(
      [
        [ORG, userA],
        [ORG_B, userB],
      ].map(([orgId, userId]) => ({
        orgId: orgId as string,
        userId: userId as string,
        grants: [
          { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ROUTE_PERMISSIONS },
        ],
      })),
    );
    registerEffectivePermissionResolver(store);
    const registry = createPredicateRegistry();
    registry.register(
      "step_up_recent",
      async (context) => context.attributes.stepUpRecent === true,
    );
    registerAbacRegistry(registry);
    app = buildServer({
      db: handle.db as never,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
    });
    registerSubmissionRoutes(app, { submissionService: sub() });
    expect(memberOrgB).toBeTruthy();
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    resetAuthorizationContract();
    resetRbacEngine();
    await handle?.close?.();
    await admin?.end();
  });

  // ── the four existing submit paths leave one attempt each ──────────────────────────────────────────────────
  describe("the existing submit routes record an attempt", () => {
    it("an ADR response leaves one acknowledged manual attempt that mirrors the case", async () => {
      const id = await adrInReview();
      const filedAt = new Date(Date.now() - 60_000).toISOString();
      await adrSvc().submitAdr(
        B(),
        id,
        {
          channel: "esmd",
          confirmationRef: "ESMD-CONF-1",
          filedAt,
          receiptDocumentId: docReceipt,
        },
        await ver("adr_case", id),
      );
      const caseRow = (await admin.query("SELECT * FROM adr_case WHERE id=$1", [id])).rows[0];
      expect(caseRow.state).toBe("submitted");
      const rows = await attempts("adr_case_id", id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        purpose: "adr_response",
        attempt_no: 1,
        adapter: "manual",
        status: "acknowledged",
        receipt_source: "entered",
        channel: caseRow.filing_channel,
        confirmation_ref: caseRow.filing_confirmation_ref,
        receipt_document_id: docReceipt,
        idempotency_key: `adr_response:${id}:1`,
        provider_entity_id: providerEntityId,
        prepared_by_membership_id: memberB,
      });
      expect(rows[0].receipt_at.getTime()).toBe(caseRow.filed_at.getTime());
      expect(rows[0].packet_manifest.documents).toHaveLength(1);
      expect(rows[0].approved_at).toBeNull();
    });

    it("a reopening request leaves one acknowledged attempt that mirrors the case", async () => {
      const id = await reopeningDraft();
      await reopenSvc().submitReopening(
        A(),
        id,
        {
          formName: "CGS 56900 reopening request",
          channel: "mac_portal",
          confirmationRef: "PRT-90210",
          filedAt: new Date(Date.now() - 60_000).toISOString(),
        },
        await ver("reopening_case", id),
      );
      const caseRow = (await admin.query("SELECT * FROM reopening_case WHERE id=$1", [id])).rows[0];
      const rows = await attempts("reopening_case_id", id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        purpose: "reopening_request",
        status: "acknowledged",
        channel: caseRow.filing_channel,
        confirmation_ref: caseRow.filing_confirmation_ref,
      });
      expect(rows[0].receipt_at.getTime()).toBe(caseRow.filed_at.getTime());
    });

    it("a QIC escalation request leaves its own attempt beside the reconsideration's appeal attempt", async () => {
      const id = await lateReconsideration();
      const requestedAt = new Date(Date.now() - 60_000).toISOString();
      await qic().requestEscalation(
        A(),
        id,
        { channel: "fax", confirmationRef: "FAX-CONF-77", requestedAt },
        await ver("appeal_case", id),
      );
      const caseRow = (await admin.query("SELECT * FROM appeal_case WHERE id=$1", [id])).rows[0];
      const rows = await attempts("appeal_case_id", id);
      expect(rows.map((r) => [r.purpose, r.status])).toEqual([
        ["appeal_request", "needs_manual"],
        ["qic_escalation_request", "acknowledged"],
      ]);
      const esc = rows[1];
      expect(esc).toMatchObject({
        channel: caseRow.escalation_channel,
        confirmation_ref: caseRow.escalation_confirmation_ref,
        receipt_source: "entered",
      });
      expect(esc.receipt_at.getTime()).toBe(caseRow.escalation_requested_at.getTime());
    });

    it("an appeal submit still moves the case to submitted and leaves a needs_manual attempt (proof missing)", async () => {
      const id = await submittedAppeal();
      expect(
        (await admin.query("SELECT state FROM appeal_case WHERE id=$1", [id])).rows[0].state,
      ).toBe("submitted");
      const rows = await attempts("appeal_case_id", id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        purpose: "appeal_request",
        status: "needs_manual",
        adapter: "manual",
        channel: null,
        confirmation_ref: null,
        receipt_at: null,
      });
      expect(rows[0].needs_manual_reason).toMatch(/record the receipt/i);
    });

    it("a late good-cause appeal submit also leaves a needs_manual attempt", async () => {
      const id = await seedAppeal({ deadline: "2026-01-01T00:00:00Z" });
      await write().submitAppealLateGoodCause(
        A(),
        id,
        {
          ...appealFields(),
          goodCauseJustification: "The notice was misdelivered to a prior address.",
        },
        await ver("appeal_case", id),
      );
      const rows = await attempts("appeal_case_id", id);
      expect(rows.map((r) => [r.purpose, r.status])).toEqual([["appeal_request", "needs_manual"]]);
    });

    it("a refused submit leaves no attempt behind (same transaction)", async () => {
      const id = await seedAppeal();
      const err = await refused(
        write().submitAppeal(
          A(),
          id,
          appealFields({ attachedDocumentIds: [docOtherTenant] }),
          await ver("appeal_case", id),
        ),
      );
      expect(err).toMatchObject({ statusCode: 422 });
      expect(await attempts("appeal_case_id", id)).toHaveLength(0);
    });
  });

  // ── the receipt ───────────────────────────────────────────────────────────────────────────────────────────
  describe("recording the receipt", () => {
    it("needs a fresh step-up, then acknowledges the attempt and freezes it", async () => {
      const id = await submittedAppeal();
      const [att] = await attempts("appeal_case_id", id);
      const noStepUp = await receiptCall("appeals", id, receipt(att.id), att.version, false);
      expect(noStepUp.statusCode).toBe(403);
      expect((await attempts("appeal_case_id", id))[0].status).toBe("needs_manual");

      const ok = await receiptCall(
        "appeals",
        id,
        receipt(att.id, { receiptDocumentId: docReceipt }),
        att.version,
      );
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ id: att.id, amended: false });
      const after = (await attempts("appeal_case_id", id))[0];
      expect(after).toMatchObject({
        status: "acknowledged",
        confirmation_ref: "CONF-RECEIPT-7731",
        receipt_source: "entered",
        receipt_document_id: docReceipt,
        needs_manual_reason: null,
      });

      // the receipt is frozen at the database
      await expect(
        admin.query("UPDATE submission_attempt SET confirmation_ref='CHANGED' WHERE id=$1", [
          att.id,
        ]),
      ).rejects.toThrow(/M25_SUBMISSION_RECEIPT_FROZEN/);
      await expect(
        admin.query("UPDATE submission_attempt SET status='cancelled' WHERE id=$1", [att.id]),
      ).rejects.toThrow(/M25_SUBMISSION_RECEIPT_FROZEN|M25_SUBMISSION_ILLEGAL_TRANSITION/);
    });

    it("appends a correction instead of rewriting, and the amendment list only grows", async () => {
      const id = await submittedAppeal();
      const [att] = await attempts("appeal_case_id", id);
      await receiptCall("appeals", id, receipt(att.id), att.version);
      const acked = (await attempts("appeal_case_id", id))[0];
      const amend = await receiptCall(
        "appeals",
        id,
        receipt(att.id, { confirmationRef: "CONF-CORRECTED-9" }),
        acked.version,
      );
      expect(amend.json()).toMatchObject({ amended: true });
      const after = (await attempts("appeal_case_id", id))[0];
      expect(after.confirmation_ref).toBe("CONF-RECEIPT-7731");
      expect(after.receipt_amendments).toHaveLength(1);
      expect(after.receipt_amendments[0]).toMatchObject({ confirmationRef: "CONF-CORRECTED-9" });
      await expect(
        admin.query("UPDATE submission_attempt SET receipt_amendments='[]'::jsonb WHERE id=$1", [
          att.id,
        ]),
      ).rejects.toThrow(/M25_SUBMISSION_AMENDMENTS_APPEND_ONLY/);
      await expect(
        admin.query(
          `UPDATE submission_attempt SET receipt_amendments='[{"x":1},{"y":2}]'::jsonb WHERE id=$1`,
          [att.id],
        ),
      ).rejects.toThrow(/M25_SUBMISSION_AMENDMENTS_APPEND_ONLY/);
    });

    it("refuses a bad reference, a future time, and a stale version", async () => {
      const id = await submittedAppeal();
      const [att] = await attempts("appeal_case_id", id);
      const bad = async (over: Record<string, unknown>, ifMatch = att.version) =>
        (await receiptCall("appeals", id, receipt(att.id, over), ifMatch)).json().error;
      expect(await bad({ confirmationRef: "1EG4-TE5-MK73" })).toMatchObject({
        code: "MBI_NOT_ALLOWED",
      });
      expect(await bad({ receiptAt: new Date(Date.now() + 864e5).toISOString() })).toMatchObject({
        code: "RECEIPT_IN_FUTURE",
      });
      expect(await bad({}, att.version + 5)).toMatchObject({ code: "VERSION_CONFLICT" });
      expect((await attempts("appeal_case_id", id))[0].status).toBe("needs_manual");
    });

    it("refuses a receipt document of another patient, another tenant or 42 CFR Part 2", async () => {
      const id = await submittedAppeal();
      const [att] = await attempts("appeal_case_id", id);
      for (const doc of [docOtherPatient, docOtherTenant, docPart2]) {
        const res = await receiptCall(
          "appeals",
          id,
          receipt(att.id, { receiptDocumentId: doc }),
          att.version,
        );
        expect(res.statusCode).toBe(422);
        expect(res.json().error).toMatchObject({ code: "APPEAL_DOCUMENT_NOT_ATTACHABLE" });
      }
      expect((await attempts("appeal_case_id", id))[0].status).toBe("needs_manual");
    });

    it("works the same for ADR and reopening subjects, and not across subjects", async () => {
      const adr = await adrInReview();
      await adrSvc().submitAdr(
        B(),
        adr,
        {
          channel: "mail",
          confirmationRef: "M-1",
          filedAt: new Date(Date.now() - 1000).toISOString(),
        },
        await ver("adr_case", adr),
      );
      const [adrAtt] = await attempts("adr_case_id", adr);
      // an acknowledged attempt takes an amendment through the ADR route ...
      const amended = await receiptCall("adrs", adr, receipt(adrAtt.id), adrAtt.version);
      expect(amended.json()).toMatchObject({ amended: true });
      // ... but another subject's route cannot reach it
      const appealId = await submittedAppeal();
      const cross = await receiptCall("appeals", appealId, receipt(adrAtt.id), adrAtt.version);
      expect(cross.statusCode).toBe(404);
      const reopen = await reopeningDraft();
      const crossReopen = await receiptCall("reopenings", reopen, receipt(adrAtt.id), 1);
      expect(crossReopen.statusCode).toBe(404);
    });
  });

  // ── cancel, one live attempt, the CHECKs ───────────────────────────────────────────────────────────────────
  describe("lifecycle guards", () => {
    const cancelCall = (
      segment: string,
      id: string,
      attemptId: string,
      version: number,
      over: { stepUp?: boolean; reason?: string; who?: [string, string, string] } = {},
    ) => {
      const who = over.who ?? [ORG, userA, memberA];
      return app.inject({
        method: "POST",
        url: `/api/v1/${segment}/${id}/submission-cancel`,
        headers: {
          ...as(who[0], who[1], who[2], over.stepUp ?? true),
          "idempotency-key": randomUUID(),
          "if-match": String(version),
        },
        payload: { attemptId, reason: over.reason ?? "Entered against the wrong claim" },
      });
    };
    /** A `prepared` electronic-shaped attempt (the 6b shape), inserted directly: 6a never creates one. */
    const preparedAttempt = async (id: string): Promise<{ id: string; version: number }> =>
      (
        await admin.query(
          `INSERT INTO submission_attempt (organization_id, provider_entity_id, appeal_case_id, purpose, attempt_no,
             idempotency_key, adapter, status)
           VALUES ($1,$2,$3,'qic_escalation_request',7,$4,'manual','prepared') RETURNING id, version`,
          [ORG, providerEntityId, id, randomUUID()],
        )
      ).rows[0];

    it("never cancels the only path to proof: a needs_manual attempt on a filed case is a 409 PROOF_ONLY_PATH", async () => {
      const id = await submittedAppeal();
      const [att] = await attempts("appeal_case_id", id);
      const res = await cancelCall("appeals", id, att.id, att.version);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("PROOF_ONLY_PATH");
      expect((await attempts("appeal_case_id", id))[0].status).toBe("needs_manual");
      // the receipt is still recordable afterwards: the appeal is not stranded
      const ok = await receiptCall("appeals", id, receipt(att.id), att.version);
      expect(ok.statusCode).toBe(200);
    });

    it("requires a step-up and a reason to cancel, and a cancelled attempt is frozen", async () => {
      const id = await submittedAppeal();
      const prep = await preparedAttempt(id);
      expect(
        (await cancelCall("appeals", id, prep.id, prep.version, { stepUp: false })).statusCode,
      ).toBe(403);
      expect(
        await refused(sub().cancelAttempt(A(), "appeal", id, prep.id, "short", prep.version)),
      ).toMatchObject({ code: "REASON_REQUIRED", statusCode: 409 });
      const res = await cancelCall("appeals", id, prep.id, prep.version);
      expect(res.statusCode).toBe(200);
      const row = (await admin.query("SELECT * FROM submission_attempt WHERE id=$1", [prep.id]))
        .rows[0];
      expect(row.status).toBe("cancelled");
      expect(row.failure_reason).toBe("Cancelled: Entered against the wrong claim");
      await expect(
        admin.query("UPDATE submission_attempt SET version = version + 1 WHERE id=$1", [prep.id]),
      ).rejects.toThrow(/M25_SUBMISSION_FROZEN/);
      expect((await cancelCall("appeals", id, prep.id, row.version)).statusCode).toBe(409);
    });

    it("never cancels an acknowledged attempt", async () => {
      const adr = await adrInReview();
      await adrSvc().submitAdr(
        B(),
        adr,
        {
          channel: "mail",
          confirmationRef: "M-2",
          filedAt: new Date(Date.now() - 1000).toISOString(),
        },
        await ver("adr_case", adr),
      );
      const [ack] = await attempts("adr_case_id", adr);
      const res = await cancelCall("adrs", adr, ack.id, ack.version);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("SUBMISSION_NOT_CANCELLABLE");
    });

    it("refuses to cancel through another tenant's or an out-of-scope actor's route", async () => {
      const id = await submittedAppeal();
      const prep = await preparedAttempt(id);
      const other = await cancelCall("appeals", id, prep.id, prep.version, {
        who: [ORG_B, userB, memberB],
      });
      expect(other.statusCode).toBe(404);
      const noScope = { ...A(), providerEntityScope: [] as string[] };
      const elsewhere = { ...A(), providerEntityScope: [randomUUID()] };
      for (const actor of [noScope, elsewhere]) {
        expect(
          await refused(
            sub().cancelAttempt(actor, "appeal", id, prep.id, "a long enough reason", prep.version),
          ),
        ).toMatchObject({ statusCode: 404 });
        expect(
          await refused(sub().recordReceipt(actor, "appeal", id, receipt(prep.id), prep.version)),
        ).toMatchObject({ statusCode: 404 });
        expect(await refused(sub().getSubmission(actor, "appeal", id))).toMatchObject({
          statusCode: 404,
        });
      }
      expect((await attempts("appeal_case_id", id)).find((r) => r.id === prep.id)?.status).toBe(
        "prepared",
      );
      const inScope = { ...A(), providerEntityScope: [providerEntityId] };
      expect((await sub().getSubmission(inScope, "appeal", id)).attempts.length).toBeGreaterThan(0);
    });

    it("caps the amendment count, rejects an identical correction, and the trigger holds the cap too", async () => {
      const id = await submittedAppeal();
      const [att] = await attempts("appeal_case_id", id);
      await receiptCall("appeals", id, receipt(att.id), att.version);
      const stamp = new Date(Date.now() - 3_600_000).toISOString();
      const amend = async (ref: string) => {
        const cur = (await attempts("appeal_case_id", id))[0];
        return receiptCall(
          "appeals",
          id,
          { attemptId: att.id, confirmationRef: ref, receiptAt: stamp },
          cur.version,
        );
      };
      expect((await amend("CORR-0")).statusCode).toBe(200);
      const dup = await amend("CORR-0");
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.code).toBe("AMENDMENT_DUPLICATE");
      for (let i = 1; i < 20; i++) expect((await amend(`CORR-${i}`)).statusCode).toBe(200);
      const over = await amend("CORR-20");
      expect(over.statusCode).toBe(409);
      expect(over.json().error.code).toBe("AMENDMENT_LIMIT");
      const list = (await attempts("appeal_case_id", id))[0].receipt_amendments as unknown[];
      expect(list).toHaveLength(20);
      await expect(
        admin.query("UPDATE submission_attempt SET receipt_amendments = $2::jsonb WHERE id=$1", [
          att.id,
          JSON.stringify([...list, { x: 1 }]),
        ]),
      ).rejects.toThrow(/M25_SUBMISSION_AMENDMENT_LIMIT/);
    });

    it("leaves the case's own filing columns untouched when a receipt is amended (the case is authoritative)", async () => {
      const adr = await adrInReview();
      await adrSvc().submitAdr(
        B(),
        adr,
        {
          channel: "mail",
          confirmationRef: "ORIGINAL-REF",
          filedAt: new Date(Date.now() - 1000).toISOString(),
        },
        await ver("adr_case", adr),
      );
      const [ack] = await attempts("adr_case_id", adr);
      expect((await receiptCall("adrs", adr, receipt(ack.id), ack.version)).statusCode).toBe(200);
      const caseRow = (await admin.query("SELECT * FROM adr_case WHERE id=$1", [adr])).rows[0];
      expect(caseRow.filing_confirmation_ref).toBe("ORIGINAL-REF");
    });

    it("refuses an electronic adapter or a send without an approver other than the preparer, at insert", async () => {
      const id = await submittedAppeal();
      const insert = (cols: Record<string, unknown>) => {
        const all = {
          organization_id: ORG,
          provider_entity_id: providerEntityId,
          appeal_case_id: id,
          purpose: "qic_escalation_request",
          attempt_no: 8,
          idempotency_key: randomUUID(),
          prepared_by_membership_id: memberA,
          ...cols,
        };
        const keys = Object.keys(all);
        return admin.query(
          `INSERT INTO submission_attempt (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
          Object.values(all),
        );
      };
      const rule =
        /submission_attempt_electronic_needs_other_approver|submission_attempt_send_is_approved/;
      await expect(insert({ adapter: "esmd", status: "prepared" })).rejects.toThrow(rule);
      await expect(
        insert({
          adapter: "esmd",
          status: "queued",
          approved_by_membership_id: memberA,
          approved_at: new Date(),
        }),
      ).rejects.toThrow(/submission_attempt_electronic_needs_other_approver/);
      await expect(
        insert({
          adapter: "manual",
          status: "queued",
          approved_by_membership_id: memberB,
          approved_at: new Date(),
        }),
      ).resolves.toBeTruthy();
    });

    it("allows one live attempt per (subject, purpose): the service and the unique index both refuse a second", async () => {
      const id = await submittedAppeal();
      const err = await refused(
        withOrgContext(handle.db, { organizationId: ORG, userId: "" }, (tx) =>
          recordFilingAttempt(tx as never, {
            organizationId: ORG,
            providerEntityId,
            purpose: "appeal_request",
            subjectId: id,
            channel: null,
            confirmationRef: null,
            receiptAt: null,
            actorMembershipId: memberA,
          }),
        ),
      );
      expect(err).toMatchObject({ code: "SUBMISSION_ATTEMPT_LIVE", statusCode: 409 });
      await expect(
        admin.query(
          `INSERT INTO submission_attempt (organization_id, provider_entity_id, appeal_case_id, purpose, attempt_no,
             idempotency_key, adapter, status, needs_manual_reason)
           VALUES ($1,$2,$3,'appeal_request',2,'other-key','manual','needs_manual','x')`,
          [ORG, providerEntityId, id],
        ),
      ).rejects.toThrow(/submission_attempt_one_live/);
      // a retry after a cancel is a NEW row (attempt 2), never a rewind
      const [att] = await attempts("appeal_case_id", id);
      await admin.query("UPDATE submission_attempt SET status='cancelled' WHERE id=$1", [att.id]);
      await withOrgContext(handle.db, { organizationId: ORG, userId: "" }, (tx) =>
        recordFilingAttempt(tx as never, {
          organizationId: ORG,
          providerEntityId,
          purpose: "appeal_request",
          subjectId: id,
          channel: null,
          confirmationRef: null,
          receiptAt: null,
          actorMembershipId: memberA,
        }),
      );
      expect((await attempts("appeal_case_id", id)).map((r) => [r.attempt_no, r.status])).toEqual([
        [1, "cancelled"],
        [2, "needs_manual"],
      ]);
    });

    it("makes an unproven acknowledgement, an unapproved send and a manual send unrepresentable", async () => {
      const id = await submittedAppeal();
      const insert = (cols: Record<string, unknown>) => {
        const all = {
          organization_id: ORG,
          provider_entity_id: providerEntityId,
          appeal_case_id: id,
          purpose: "qic_escalation_request",
          attempt_no: 9,
          idempotency_key: randomUUID(),
          adapter: "manual",
          ...cols,
        };
        const keys = Object.keys(all);
        return admin.query(
          `INSERT INTO submission_attempt (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
          Object.values(all),
        );
      };
      await expect(insert({ status: "acknowledged" })).rejects.toThrow(
        /submission_attempt_ack_has_proof/,
      );
      await expect(insert({ status: "needs_manual" })).rejects.toThrow(
        /submission_attempt_needs_manual_reason/,
      );
      await expect(
        insert({ status: "needs_manual", needs_manual_reason: "x", confirmation_ref: "R" }),
      ).rejects.toThrow(/submission_attempt_no_proof_before_ack/);
      await expect(insert({ status: "queued", adapter: "esmd" })).rejects.toThrow(
        /submission_attempt_send_is_approved|submission_attempt_electronic_needs_other_approver/,
      );
      await expect(
        insert({
          status: "sent",
          adapter: "manual",
          approved_by_membership_id: memberA,
          approved_at: new Date(),
        }),
      ).rejects.toThrow(
        /submission_attempt_send_is_electronic|submission_attempt_electronic_needs_other_approver/,
      );
      // a subject must match the purpose
      await expect(
        admin.query(
          `INSERT INTO submission_attempt (organization_id, provider_entity_id, appeal_case_id, purpose, attempt_no,
             idempotency_key, status, needs_manual_reason)
           VALUES ($1,$2,$3,'adr_response',1,$4,'needs_manual','x')`,
          [ORG, providerEntityId, id, randomUUID()],
        ),
      ).rejects.toThrow(/submission_attempt_purpose_subject/);
    });

    it("refuses an illegal edge and a rewound status at the database", async () => {
      const id = await submittedAppeal();
      const [att] = await attempts("appeal_case_id", id);
      await expect(
        admin.query("UPDATE submission_attempt SET status='sent' WHERE id=$1", [att.id]),
      ).rejects.toThrow(/M25_SUBMISSION_ILLEGAL_TRANSITION|submission_attempt_send_is/);
      await expect(
        admin.query("UPDATE submission_attempt SET status='sending' WHERE id=$1", [att.id]),
      ).rejects.toThrow(/M25_SUBMISSION_ILLEGAL_TRANSITION|submission_attempt_send_is/);
    });
  });

  // ── read model, tenancy, audit ─────────────────────────────────────────────────────────────────────────────
  describe("read model, tenancy and audit", () => {
    it("GET is schema-valid, shows proof missing, the guided checklist and the unbound adapters", async () => {
      const id = await submittedAppeal();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/appeals/${id}/submission`,
        headers: as(ORG, userA, memberA),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Value.Check(SubmissionViewSchema, body)).toBe(true);
      expect(body).toMatchObject({ proofMissing: true, noAttemptRecord: false });
      expect(body.attempts[0]).toMatchObject({ status: "needs_manual", proofMissing: true });
      expect(body.checklist.map((s: { key: string }) => s.key)).toContain("record_confirmation");
      expect(body.adapters.map((a: { kind: string; bound: boolean }) => [a.kind, a.bound])).toEqual(
        [
          ["manual", true],
          ["esmd", false],
          ["fax", false],
        ],
      );
      // reading is audited with a resource id (the read-audit config needs resourceIdParam)
      const reads = await admin.query(
        `SELECT count(*)::int AS n FROM audit_event WHERE resource_id = $1 AND event_type LIKE '%.viewed'`,
        [id],
      );
      expect(reads.rows[0].n).toBeGreaterThan(0);
      // the read is attributed to the claim's patient (the §164.528 accounting joins on context.patientId)
      const attributed = await admin.query(
        `SELECT count(*)::int AS n FROM audit_event
          WHERE resource_id = $1 AND event_type LIKE '%.viewed' AND context->>'patientId' = $2`,
        [id, patient],
      );
      expect(attributed.rows[0].n).toBeGreaterThan(0);
      expect(body.patientId).toBe(patient);
    });

    it("loses patient attribution only for a missing claim: a real source failure surfaces", async () => {
      const id = await submittedAppeal();
      await admin.query("UPDATE appeal_case SET claim_id=$2 WHERE id=$1", [id, randomUUID()]);
      expect((await sub().getSubmission(A(), "appeal", id)).patientId).toBeNull();
      const unbound = buildDrizzleSubmissionService(handle.db);
      expect(await refused(unbound.getSubmission(A(), "appeal", id))).toMatchObject({
        code: "SEAM_UNBOUND",
        statusCode: 503,
      });
    });

    it("reports a case filed before milestone 6 as having no attempt record", async () => {
      const id = await seedAppeal();
      await admin.query(
        "UPDATE appeal_case SET state='submitted', submitted_at=now() WHERE id=$1",
        [id],
      );
      const view = await sub().getSubmission(A(), "appeal", id);
      expect(view).toMatchObject({ noAttemptRecord: true, proofMissing: false, attempts: [] });
    });

    it("hides another tenant's attempts and refuses its writes (RLS, as chartwarden_app)", async () => {
      const id = await submittedAppeal();
      const [att] = await attempts("appeal_case_id", id);
      const other = actorOf(memberB, ORG_B, userB);
      const get = await app.inject({
        method: "GET",
        url: `/api/v1/appeals/${id}/submission`,
        headers: as(ORG_B, userB, memberB),
      });
      expect(get.statusCode).toBe(404);
      expect(await refused(sub().getSubmission(other, "appeal", id))).toMatchObject({
        statusCode: 404,
      });
      const write = await receiptCall("appeals", id, receipt(att.id), att.version, true, [
        ORG_B,
        userB,
        memberB,
      ]);
      expect(write.statusCode).toBe(404);
      const visible = await withOrgContext(
        handle.db,
        { organizationId: ORG_B, userId: "" },
        async (tx) =>
          (
            await (tx as never as { execute: (q: string) => Promise<{ rows: unknown[] }> }).execute(
              "SELECT id FROM submission_attempt",
            )
          ).rows.length,
      );
      expect(visible).toBe(0);
      expect((await attempts("appeal_case_id", id))[0].status).toBe("needs_manual");
    });

    it("keeps the confirmation reference and amendments out of the audit trail", async () => {
      const id = await submittedAppeal();
      const [att] = await attempts("appeal_case_id", id);
      await receiptCall(
        "appeals",
        id,
        receipt(att.id, { confirmationRef: "SECRET-REF-5521" }),
        att.version,
      );
      const acked = (await attempts("appeal_case_id", id))[0];
      await receiptCall(
        "appeals",
        id,
        receipt(att.id, { confirmationRef: "SECRET-AMEND-8842" }),
        acked.version,
      );
      const leaked = await admin.query(
        `SELECT count(*)::int AS n FROM audit_event
          WHERE resource_kind = 'submission_attempt' AND resource_id = $1
            AND (before::text LIKE '%SECRET-%' OR after::text LIKE '%SECRET-%')`,
        [att.id],
      );
      expect(leaked.rows[0].n).toBe(0);
      const audited = await admin.query(
        `SELECT count(*)::int AS n FROM audit_event
          WHERE resource_kind = 'submission_attempt' AND resource_id = $1 AND event_type = 'submission_attempt.update'`,
        [att.id],
      );
      expect(audited.rows[0].n).toBeGreaterThanOrEqual(2);
    });

    it("emits no outbox event of its own", async () => {
      const id = await submittedAppeal();
      const [att] = await attempts("appeal_case_id", id);
      const before = Number(
        (await admin.query("SELECT count(*)::int AS n FROM outbox_event")).rows[0].n,
      );
      await receiptCall("appeals", id, receipt(att.id), att.version);
      const after = Number(
        (await admin.query("SELECT count(*)::int AS n FROM outbox_event")).rows[0].n,
      );
      expect(after).toBe(before);
      const names = await admin.query(
        "SELECT DISTINCT event_type FROM outbox_event WHERE event_type LIKE 'm25.submission%'",
      );
      expect(names.rows).toEqual([]);
    });
  });

  // ── the nightly proof-missing watch ────────────────────────────────────────────────────────────────────────
  describe("proof-missing cron", () => {
    it("alerts for a needs_manual attempt past the threshold, not for a young or acknowledged one", async () => {
      const old = await submittedAppeal();
      const young = await submittedAppeal();
      const proven = await submittedAppeal();
      await admin.query(
        "UPDATE submission_attempt SET created_at = now() - interval '10 days' WHERE appeal_case_id IN ($1,$2)",
        [old, proven],
      );
      const [provenAtt] = await attempts("appeal_case_id", proven);
      await receiptCall("appeals", proven, receipt(provenAtt.id), provenAtt.version);
      const dispatched: { alertCode: string; payload: Record<string, unknown> }[] = [];
      await runAppealDeadlineCron({
        connection: {} as never,
        db: handle.db,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
        alerts: { dispatch: async (a) => void dispatched.push(a) },
        now: () => new Date(),
      });
      const ids = dispatched
        .filter((d) => d.alertCode === "submission.proof_missing")
        .map((d) => d.payload.subjectId);
      expect(ids).toContain(old);
      expect(ids).not.toContain(young);
      expect(ids).not.toContain(proven);
      const sample = dispatched.find(
        (d) => d.alertCode === "submission.proof_missing" && d.payload.subjectId === old,
      );
      expect(Object.keys(sample?.payload ?? {}).sort()).toEqual([
        "daysOpen",
        "subjectId",
        "subjectKind",
      ]);
    });

    it("stops alerting once the case is withdrawn or closed", async () => {
      const withdrawn = await submittedAppeal();
      const closed = await submittedAppeal();
      const live = await submittedAppeal();
      await admin.query(
        "UPDATE submission_attempt SET created_at = now() - interval '10 days' WHERE appeal_case_id IN ($1,$2,$3)",
        [withdrawn, closed, live],
      );
      await write().withdrawAppeal(
        A(),
        withdrawn,
        { reason: "Withdrawn: the claim was paid on review, nothing left to appeal." },
        await ver("appeal_case", withdrawn),
      );
      await admin.query("UPDATE appeal_case SET state='closed', closed_at=now() WHERE id=$1", [
        closed,
      ]);
      const dispatched: { alertCode: string; payload: Record<string, unknown> }[] = [];
      await runAppealDeadlineCron({
        connection: {} as never,
        db: handle.db,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
        alerts: { dispatch: async (a) => void dispatched.push(a) },
        now: () => new Date(),
      });
      const ids = dispatched
        .filter((d) => d.alertCode === "submission.proof_missing")
        .map((d) => d.payload.subjectId);
      expect(ids).toContain(live);
      expect(ids).not.toContain(withdrawn);
      expect(ids).not.toContain(closed);
    });
  });
});
