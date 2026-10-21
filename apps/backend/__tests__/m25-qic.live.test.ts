/**
 * M25 QIC reconsideration and escalation (hospice ADR/TPE/QIC PRD, milestone 4) - LIVE Postgres as the NOBYPASSRLS
 * `chartwarden_app` role, through the real services, the real M22 / M23 seams and the real catalog-validating publisher.
 *
 * Proves what the pure suites cannot: a reconsideration cannot be submitted (normal or late good cause) unless every
 * cited item is enclosed, or explained with the preclusion acknowledged, and the redetermination notice copy is
 * enclosed - with nothing published when it is refused; the cited evidence is frozen once filed (service and
 * trigger); the QIC clock is derived from the recorded receipt date plus append-only extensions, and without a
 * receipt date no escalation is offered; escalation is refused before the QIC is late, needs a step-up at the
 * route, is recorded once and frozen, and its confirmation moves the case to `escalated` and opens a linked ALJ case
 * that raises no deadline alert; a QIC decision recorded instead still works; the QIC columns exist on no other
 * tier; free text is scrubbed from the audit trail; the overdue cron alerts; another tenant sees nothing; and a
 * redetermination behaves exactly as before.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m25:qic:live
 * (SUPERUSER to a THROWAWAY db - this file DROPs and recreates the public schema.)
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
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
import { appealPacketViolations } from "@chartwarden/types";
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
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/index";
import { runAppealDeadlineCron } from "../src/modules/25-remittance/jobs/cron-workers";
import { runAppealDeadlineWatch } from "../src/modules/25-remittance/jobs/m25-jobs";
import { buildSeamAppealSourcePorts } from "../src/modules/25-remittance/routes/appeal-packet-sources";
import { buildDrizzleQicService } from "../src/modules/25-remittance/routes/qic-service";
import { QicViewSchema, registerQicRoutes } from "../src/modules/25-remittance/routes/qic.routes";
import { buildDrizzleM25WriteService } from "../src/modules/25-remittance/routes/write-service-drizzle";
import { appRoleConnectionString } from "./_live-app-role";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) FormatRegistry.Set("uuid", (v) => UUID_RE.test(v));
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => !Number.isNaN(Date.parse(v)));
}

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const NARRATIVE =
  "The redetermination overlooked the timely face-to-face note, which is enclosed with this request.";
const ROUTE_PERMISSIONS = [
  "appeal.read",
  "appeal.submit",
  "appeal.attach_document",
  "appeal.decide",
];

describe.skipIf(!DB_URL)("M25 QIC reconsideration and escalation - LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let app: FastifyInstance;
  let providerEntityId = "";
  let claimId = "";
  let userA = "";
  let memberA = "";
  let userB = "";
  let memberB = "";
  let docNotice = "";
  let docNote = "";
  let docOther = "";
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
  const actorOf = (membershipId: string, organizationId = ORG, userId = userA) => ({
    organizationId,
    userId,
    membershipId,
    roles: ["billing_manager"],
    stepUpRecent: true,
  });
  const A = () => actorOf(memberA);
  const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const refused = async (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string; message?: string; statusCode?: number }) => e,
    );
  const ver = async (id: string) =>
    Number(
      (await admin.query("SELECT version FROM appeal_case WHERE id=$1", [id])).rows[0].version,
    );
  const row = async (id: string) =>
    (await admin.query("SELECT * FROM appeal_case WHERE id=$1", [id])).rows[0];
  const outboxCount = async () =>
    Number((await admin.query("SELECT count(*)::int AS n FROM outbox_event")).rows[0].n);
  const renderRequested = async (appealId: string) =>
    (
      await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type='m25.appeal_packet.render_requested' AND aggregate_id=$1",
        [appealId],
      )
    ).rows;

  async function seedDocument(org: string, patientId: string | null, title: string, kind = "f2f") {
    return (
      await admin.query(
        `INSERT INTO document (organization_id, patient_id, retention_class, source_kind, aggregate_type, title,
           status, created_by_membership_id)
         VALUES ($1,$2,'clinical_record','user_upload',$3,$4,'active',$5) RETURNING id`,
        [org, patientId, kind, title, memberA],
      )
    ).rows[0].id as string;
  }

  /** A denial plus one appeal_case on it, inserted directly (the tier machinery is milestone 1's, not under test). */
  async function seedAppeal(
    over: { tier?: string; state?: string; deadline?: string; noticeDatedOn?: string | null } = {},
  ): Promise<{ id: string; denialId: string }> {
    const denialId = (
      await admin.query(
        `INSERT INTO denial_case (organization_id, provider_entity_id, claim_id, source_evv_aggregator_submission_id,
           carc_code, category, source, state, dollar_value, taxonomy_status)
         VALUES ($1,$2,$3,$4,'50','denial','evv_aggregator_rejection','appealed',10,'mapped') RETURNING id`,
        [ORG, providerEntityId, claimId, randomUUID()],
      )
    ).rows[0].id as string;
    const id = (
      await admin.query(
        `INSERT INTO appeal_case (organization_id, provider_entity_id, denial_case_id, claim_id, tier, state,
           tier_deadline_at, notice_dated_on)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          ORG,
          providerEntityId,
          denialId,
          claimId,
          over.tier ?? "reconsideration",
          over.state ?? "draft",
          over.deadline ?? "2099-01-01T00:00:00Z",
          over.noticeDatedOn === undefined ? "2026-02-01" : over.noticeDatedOn,
        ],
      )
    ).rows[0].id as string;
    return { id, denialId };
  }

  const submitFields = (over: Record<string, unknown> = {}) => ({
    appealNarrative: NARRATIVE,
    attachedDocumentIds: [docNotice, docNote],
    reconsideration: {
      redeterminationMacName: "Example MAC",
      redeterminationNoticeDocumentId: docNotice,
      evidencePreclusionAcknowledged: false,
    },
    ...over,
  });
  const citeNote = async (id: string) =>
    qic().setCitedEvidence(
      A(),
      id,
      {
        items: [{ label: "Face-to-face note", documentId: docNote, notAvailableReason: null }],
        none: false,
      },
      await ver(id),
    );

  /** A reconsideration submitted and acknowledged (state under_review), with the QIC receipt date recorded. */
  async function underReview(receivedDaysAgo: number | null): Promise<string> {
    const { id } = await seedAppeal();
    await qic().setCitedEvidence(A(), id, { items: [], none: true }, await ver(id));
    await write().submitAppeal(A(), id, submitFields(), await ver(id));
    // Filed long ago, so a receipt date in the past is a legitimate one (the service refuses a receipt before filing).
    await admin.query(
      "UPDATE appeal_case SET submitted_at = now() - interval '200 days' WHERE id = $1",
      [id],
    );
    await write().ackAppeal(A(), id, await ver(id));
    if (receivedDaysAgo !== null) {
      await qic().recordQicClock(A(), id, { receivedOn: daysAgo(receivedDaysAgo) }, await ver(id));
    }
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
      [ORG, "m25-qic"],
      [ORG_B, "m25-qic-b"],
    ])
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,'A','A')",
        [org, slug],
      );
    userA = (await admin.query(`INSERT INTO "user" (email) VALUES ('qic-a@x.test') RETURNING id`))
      .rows[0].id as string;
    userB = (await admin.query(`INSERT INTO "user" (email) VALUES ('qic-b@x.test') RETURNING id`))
      .rows[0].id as string;
    const member = async (user: string, org: string) =>
      (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [user, org],
        )
      ).rows[0].id as string;
    memberA = await member(userA, ORG);
    memberB = await member(userB, ORG_B);
    providerEntityId = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN-QIC','QIC','NPI-QIC','enc','12-31') RETURNING id`,
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
          claimControlNumber: "CCN-QIC-0001",
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
    docNotice = await seedDocument(ORG, patient, "Redetermination notice", "encounter");
    docNote = await seedDocument(ORG, patient, "Face-to-face note 2026-02-20");
    docOther = await seedDocument(ORG_B, null, "SECRET other tenant document");
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
    registerQicRoutes(app, { qicService: qic() });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    resetAuthorizationContract();
    resetRbacEngine();
    await handle?.close?.();
    await admin?.end();
  });

  // ── the evidence guard, on both submit paths ───────────────────────────────────────────────────────────────
  describe("evidence guard", () => {
    it("refuses a submit with no cited-evidence list (neither items nor the attestation), publishing nothing", async () => {
      const { id } = await seedAppeal();
      const before = await outboxCount();
      const err = await refused(write().submitAppeal(A(), id, submitFields(), await ver(id)));
      expect(err).toMatchObject({ code: "EVIDENCE_LIST_REQUIRED", statusCode: 422 });
      expect((await row(id)).state).toBe("draft");
      expect(await outboxCount()).toBe(before);
    });

    it("refuses a submit that does not enclose the redetermination notice copy", async () => {
      const { id } = await seedAppeal();
      await citeNote(id);
      const err = await refused(
        write().submitAppeal(
          A(),
          id,
          submitFields({
            attachedDocumentIds: [docNote],
            reconsideration: {
              redeterminationMacName: "Example MAC",
              redeterminationNoticeDocumentId: docNotice,
            },
          }),
          await ver(id),
        ),
      );
      expect(err).toMatchObject({ code: "NOTICE_COPY_REQUIRED", statusCode: 422 });
      expect((await row(id)).state).toBe("draft");
    });

    it("refuses a cited item whose document is not among the attachments, and an unnamed MAC", async () => {
      const { id } = await seedAppeal();
      await citeNote(id);
      expect(
        await refused(
          write().submitAppeal(
            A(),
            id,
            submitFields({ attachedDocumentIds: [docNotice] }),
            await ver(id),
          ),
        ),
      ).toMatchObject({ code: "EVIDENCE_NOT_ENCLOSED", statusCode: 422 });
      expect(
        await refused(
          write().submitAppeal(
            A(),
            id,
            submitFields({
              reconsideration: { redeterminationNoticeDocumentId: docNotice },
            }),
            await ver(id),
          ),
        ),
      ).toMatchObject({ code: "REDETERMINATION_MAC_REQUIRED", statusCode: 422 });
    });

    it("lets an item go unenclosed only with a reason AND the acknowledged preclusion warning", async () => {
      const { id } = await seedAppeal();
      await qic().setCitedEvidence(
        A(),
        id,
        {
          items: [
            {
              label: "Visit notes",
              documentId: null,
              notAvailableReason: "The facility has not released the notes yet.",
            },
          ],
          none: false,
        },
        await ver(id),
      );
      expect(
        await refused(write().submitAppeal(A(), id, submitFields(), await ver(id))),
      ).toMatchObject({ code: "PRECLUSION_ACK_REQUIRED", statusCode: 422 });
      await write().submitAppeal(
        A(),
        id,
        submitFields({
          reconsideration: {
            redeterminationMacName: "Example MAC",
            redeterminationNoticeDocumentId: docNotice,
            evidencePreclusionAcknowledged: true,
          },
        }),
        await ver(id),
      );
      const [{ payload }] = await renderRequested(id);
      expect(payload.payload.reconsideration).toMatchObject({
        evidencePreclusionAcknowledged: true,
        citedEvidence: [{ label: "Visit notes", documentId: null }],
      });
    });

    it("publishes a valid typed packet carrying the request elements when the evidence is complete", async () => {
      const { id } = await seedAppeal();
      await citeNote(id);
      await write().submitAppeal(A(), id, submitFields(), await ver(id));
      const [{ payload }] = await renderRequested(id);
      expect(appealPacketViolations(payload.payload)).toEqual([]);
      expect(payload.payload).toMatchObject({
        tier: "reconsideration",
        reconsideration: {
          redeterminationMacName: "Example MAC",
          redeterminationNoticeDate: "2026-02-01",
          redeterminationNoticeDocumentId: docNotice,
          citedEvidence: [{ label: "Face-to-face note", documentId: docNote }],
          citedEvidenceNone: false,
        },
      });
    });

    it("applies the same guard to a late good-cause submit", async () => {
      const { id } = await seedAppeal({ deadline: "2025-01-01T00:00:00Z" });
      const late = (over: Record<string, unknown> = {}) =>
        write().submitAppealLateGoodCause(
          A(),
          id,
          {
            ...submitFields(),
            goodCauseJustification:
              "The redetermination notice was misdelivered to a prior address on file.",
            ...over,
          },
          1,
        );
      expect(await refused(late())).toMatchObject({ code: "EVIDENCE_LIST_REQUIRED" });
      await qic().setCitedEvidence(A(), id, { items: [], none: true }, 1);
      const before = await outboxCount();
      expect(
        await refused(
          write().submitAppealLateGoodCause(
            A(),
            id,
            {
              ...submitFields({ attachedDocumentIds: [docNote] }),
              goodCauseJustification:
                "The redetermination notice was misdelivered to a prior address on file.",
            },
            await ver(id),
          ),
        ),
      ).toMatchObject({ code: "NOTICE_COPY_REQUIRED" });
      expect(await outboxCount()).toBe(before);
      await write().submitAppealLateGoodCause(
        A(),
        id,
        {
          ...submitFields(),
          goodCauseJustification:
            "The redetermination notice was misdelivered to a prior address on file.",
        },
        await ver(id),
      );
      expect((await row(id)).state).toBe("submitted");
    });

    it("refuses an evidence list on a tier that is not a reconsideration", async () => {
      const { id } = await seedAppeal({ tier: "redetermination" });
      expect(
        await refused(qic().setCitedEvidence(A(), id, { items: [], none: true }, 1)),
      ).toMatchObject({ code: "NOT_RECONSIDERATION", statusCode: 409 });
    });
  });

  // ── freezing ───────────────────────────────────────────────────────────────────────────────────────────────
  describe("what was filed is frozen", () => {
    it("refuses an evidence edit once submitted, in the service and in the trigger", async () => {
      const id = await underReview(null);
      expect(
        await refused(qic().setCitedEvidence(A(), id, { items: [], none: true }, await ver(id))),
      ).toMatchObject({ code: "EVIDENCE_FROZEN", statusCode: 409 });
      await expect(
        admin.query("UPDATE appeal_case SET cited_evidence_none = false WHERE id = $1", [id]),
      ).rejects.toThrow(/M25_QIC_EVIDENCE_FROZEN/);
    });

    it("does not let the QIC columns exist on any other tier", async () => {
      const { id } = await seedAppeal({ tier: "redetermination" });
      await expect(
        admin.query("UPDATE appeal_case SET qic_received_on = '2026-01-01' WHERE id = $1", [id]),
      ).rejects.toThrow(/appeal_case_qic_reconsideration_only/);
      await expect(
        admin.query("UPDATE appeal_case SET cited_evidence_none = true WHERE id = $1", [id]),
      ).rejects.toThrow(/appeal_case_qic_reconsideration_only/);
    });

    it("refuses `escalated` without a recorded request and forwarding date", async () => {
      const id = await underReview(70);
      await expect(
        admin.query("UPDATE appeal_case SET state = 'escalated' WHERE id = $1", [id]),
      ).rejects.toThrow(/appeal_case_escalated_has_facts/);
      const { id: draft } = await seedAppeal();
      await expect(
        admin.query("UPDATE appeal_case SET state = 'escalated' WHERE id = $1", [draft]),
      ).rejects.toThrow(/M25_QIC_ILLEGAL_ESCALATION/);
    });
  });

  // ── the QIC clock ──────────────────────────────────────────────────────────────────────────────────────────
  describe("QIC decision clock", () => {
    it("computes nothing, and offers no escalation, without a recorded receipt date", async () => {
      const id = await underReview(null);
      const view = await qic().getQic(A(), id);
      expect(view).toMatchObject({
        kind: "reconsideration",
        state: "under_review",
        clock: null,
        escalationEligible: false,
      });
      expect(view?.escalationBlockedReason).toMatch(/received the request/);
      expect(
        await refused(
          qic().requestEscalation(
            A(),
            id,
            { channel: "fax", confirmationRef: "F-1", requestedAt: new Date().toISOString() },
            await ver(id),
          ),
        ),
      ).toMatchObject({ code: "QIC_RECEIPT_NOT_RECORDED", statusCode: 409 });
    });

    it("refuses a clock on a draft, a future receipt date, a bad extension, and an extension before a receipt date", async () => {
      const { id: draft } = await seedAppeal();
      expect(
        await refused(qic().recordQicClock(A(), draft, { receivedOn: daysAgo(1) }, 1)),
      ).toMatchObject({ code: "INVALID_STATE", statusCode: 409 });
      const id = await underReview(null);
      expect(
        await refused(qic().recordQicClock(A(), id, { receivedOn: daysAgo(-10) }, await ver(id))),
      ).toMatchObject({ code: "DATE_IN_FUTURE", statusCode: 422 });
      expect(
        await refused(qic().recordQicClock(A(), id, { extensionDays: 5 }, await ver(id))),
      ).toMatchObject({ code: "QIC_RECEIPT_NOT_RECORDED" });
      await qic().recordQicClock(A(), id, { receivedOn: daysAgo(10) }, await ver(id));
      expect(
        await refused(qic().recordQicClock(A(), id, { extensionDays: 15 }, await ver(id))),
      ).toMatchObject({ code: "EXTENSION_OUT_OF_RANGE", statusCode: 422 });
    });

    it("derives receipt + 60 + extensions, shows how, and appends extensions only", async () => {
      const id = await underReview(10);
      await qic().recordQicClock(A(), id, { extensionDays: 14 }, await ver(id));
      await qic().recordQicClock(A(), id, { extensionDays: 3 }, await ver(id));
      const view = await qic().getQic(A(), id);
      expect(view?.clock).toMatchObject({
        receivedOn: daysAgo(10),
        baseDays: 60,
        extensionDays: 17,
        overdue: false,
        daysOverdue: 0,
      });
      expect(view?.clock?.extensions.map((e) => e.days)).toEqual([14, 3]);
      expect(view?.escalationEligible).toBe(false);
      expect(view?.escalationBlockedReason).toMatch(/has not passed yet/);
      await expect(
        admin.query(
          `UPDATE appeal_case SET qic_clock_extensions = '[{"days":1,"recordedAt":"x"}]'::jsonb WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow(/M25_QIC_EXTENSIONS_APPEND_ONLY/);
    });

    it("a redetermination has no QIC surface", async () => {
      const { id } = await seedAppeal({ tier: "redetermination" });
      expect(await qic().getQic(A(), id)).toMatchObject({ kind: "none", clock: null });
    });
  });

  // ── escalation ─────────────────────────────────────────────────────────────────────────────────────────────
  describe("OMHA escalation", () => {
    const request = (over: Record<string, unknown> = {}) => ({
      channel: "fax",
      confirmationRef: "FAX-CONF-77",
      requestedAt: new Date().toISOString(),
      ...over,
    });

    it("is refused before the QIC is late, then offered once the recorded date passes", async () => {
      const early = await underReview(10);
      expect(
        await refused(qic().requestEscalation(A(), early, request(), await ver(early))),
      ).toMatchObject({ code: "QIC_NOT_YET_DUE", statusCode: 409 });
      const late = await underReview(70);
      const view = await qic().getQic(A(), late);
      expect(view).toMatchObject({ escalationEligible: true, escalationBlockedReason: null });
      expect(view?.clock).toMatchObject({ overdue: true });
      // 70 days after receipt is 10 days past the 60-day date; the exact count moves with the time of day
      expect(view?.clock?.daysOverdue).toBeGreaterThanOrEqual(9);
      expect(view?.clock?.daysOverdue).toBeLessThanOrEqual(10);
    });

    it("needs a known channel, a confirmation reference and a time that is not in the future", async () => {
      const id = await underReview(70);
      const v = await ver(id);
      expect(
        await refused(qic().requestEscalation(A(), id, request({ channel: "pigeon" }), v)),
      ).toMatchObject({ code: "CHANNEL_INVALID", statusCode: 422 });
      expect(
        await refused(qic().requestEscalation(A(), id, request({ confirmationRef: " " }), v)),
      ).toMatchObject({ code: "PROOF_REQUIRED" });
      expect(
        await refused(
          qic().requestEscalation(
            A(),
            id,
            request({ requestedAt: new Date(Date.now() + 864e5).toISOString() }),
            v,
          ),
        ),
      ).toMatchObject({ code: "REQUESTED_IN_FUTURE" });
    });

    it("records the request once (state unchanged), freezes it and the clock, and refuses a stale version", async () => {
      const id = await underReview(70);
      const v = await ver(id);
      await qic().requestEscalation(A(), id, request(), v);
      const after = await row(id);
      expect(after.state).toBe("under_review");
      expect(after.escalation_channel).toBe("fax");
      expect(
        await refused(qic().requestEscalation(A(), id, request(), await ver(id))),
      ).toMatchObject({ code: "ALREADY_REQUESTED", statusCode: 409 });
      expect(
        await refused(qic().recordQicClock(A(), id, { extensionDays: 1 }, await ver(id))),
      ).toMatchObject({ code: "CLOCK_FROZEN", statusCode: 409 });
      await expect(
        admin.query("UPDATE appeal_case SET escalation_channel = 'mail' WHERE id = $1", [id]),
      ).rejects.toThrow(/M25_QIC_ESCALATION_FROZEN/);
      await expect(
        admin.query("UPDATE appeal_case SET qic_received_on = '2026-01-01' WHERE id = $1", [id]),
      ).rejects.toThrow(/M25_QIC_CLOCK_FROZEN/);
      expect(
        await refused(qic().confirmEscalation(A(), id, { forwardedOn: daysAgo(0) }, v)),
      ).toMatchObject({ code: "VERSION_CONFLICT", statusCode: 409 });
    });

    it("confirming moves the case to escalated and opens a linked ALJ case with no deadline alert", async () => {
      const id = await underReview(70);
      await qic().requestEscalation(A(), id, request(), await ver(id));
      const result = await qic().confirmEscalation(
        A(),
        id,
        { forwardedOn: daysAgo(0) },
        await ver(id),
      );
      const reconsideration = await row(id);
      expect(reconsideration.state).toBe("escalated");
      expect(String(reconsideration.escalation_confirmed_on)).toContain(daysAgo(0).slice(0, 4));
      const alj = await row(result.nextAppealCaseId);
      expect(alj).toMatchObject({
        tier: "alj",
        state: "submitted",
        prior_tier_appeal_case_id: id,
        denial_case_id: reconsideration.denial_case_id,
      });
      expect(alj.tier_deadline_at.getTime()).toBe(
        reconsideration.escalation_requested_at.getTime(),
      );
      expect(alj.cited_evidence).toBeNull();
      const kinds = (
        await admin.query(
          "SELECT appeal_case_id, event_kind FROM appeal_case_event WHERE appeal_case_id = ANY($1)",
          [[id, result.nextAppealCaseId]],
        )
      ).rows.map((r) => `${r.appeal_case_id === id ? "qic" : "alj"}:${r.event_kind}`);
      expect(kinds).toEqual(
        expect.arrayContaining([
          "qic:escalation_requested",
          "qic:escalated_to_next_tier",
          "alj:created",
        ]),
      );
      // the QIC view now points forward, the ALJ view points back and says it has no filing deadline
      expect(await qic().getQic(A(), id)).toMatchObject({
        kind: "reconsideration",
        state: "escalated",
        nextAppealCaseId: result.nextAppealCaseId,
        escalationEligible: false,
      });
      expect(await qic().getQic(A(), result.nextAppealCaseId)).toMatchObject({
        kind: "escalated_alj",
        escalatedFromAppealCaseId: id,
      });
      // the deadline watch raises nothing for the ALJ row (its stored instant is already past)
      const alerts = await runAppealDeadlineWatch(
        {
          async watchableAppeals() {
            return [
              {
                id: result.nextAppealCaseId,
                tierDeadlineAt: alj.tier_deadline_at.toISOString(),
                state: "submitted",
              },
            ];
          },
        },
        new Date(),
      );
      expect(alerts.alerts).toEqual([]);
      // once escalated the case only closes; a second confirmation is refused
      expect(
        await refused(qic().confirmEscalation(A(), id, { forwardedOn: daysAgo(0) }, await ver(id))),
      ).toMatchObject({ code: "INVALID_TRANSITION", statusCode: 409 });
      await write().closeAppeal(A(), id, await ver(id));
      expect((await row(id)).state).toBe("closed");
    });

    it("refuses to confirm before a request is recorded", async () => {
      const id = await underReview(70);
      expect(
        await refused(qic().confirmEscalation(A(), id, { forwardedOn: daysAgo(0) }, await ver(id))),
      ).toMatchObject({ code: "ESCALATION_NOT_REQUESTED", statusCode: 409 });
    });

    it("lets the QIC's decision be recorded instead of escalating", async () => {
      const id = await underReview(70);
      await write().decideAppeal(
        A(),
        id,
        {
          outcome: "favorable",
          decidedAt: new Date().toISOString(),
          reason: "The QIC reversed the denial and the payment is expected shortly.",
        },
        await ver(id),
      );
      expect((await row(id)).state).toBe("decided");
    });
  });

  // ── routes: step-up, permissions, tenancy ──────────────────────────────────────────────────────────────────
  describe("routes", () => {
    const post = (
      url: string,
      body: unknown,
      headers: Record<string, string>,
      ifMatch: number,
      method: "POST" | "PATCH" = "POST",
    ) =>
      app.inject({
        method,
        url,
        headers: { ...headers, "idempotency-key": randomUUID(), "if-match": String(ifMatch) },
        payload: body as never,
      });

    it("request-escalation without a fresh step-up is a 403 STEP_UP_REQUIRED and writes nothing", async () => {
      const id = await underReview(70);
      const v = await ver(id);
      const body = {
        channel: "fax",
        confirmationRef: "FAX-1",
        requestedAt: new Date().toISOString(),
      };
      const denied = await post(
        `/api/v1/appeals/${id}/request-escalation`,
        body,
        as(ORG, userA, memberA, false),
        v,
      );
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe("STEP_UP_REQUIRED");
      expect((await row(id)).escalation_requested_at).toBeNull();
      const ok = await post(
        `/api/v1/appeals/${id}/request-escalation`,
        body,
        as(ORG, userA, memberA, true),
        v,
      );
      expect(ok.statusCode).toBe(200);
      expect(ok.json().version).toBe(v + 1);
    });

    it("request-escalation before the QIC is late is a 409 over the wire", async () => {
      const id = await underReview(10);
      const res = await post(
        `/api/v1/appeals/${id}/request-escalation`,
        { channel: "fax", confirmationRef: "FAX-1", requestedAt: new Date().toISOString() },
        as(ORG, userA, memberA, true),
        await ver(id),
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("QIC_NOT_YET_DUE");
    });

    it("the clock route takes exactly one of receivedOn / extensionDays and an If-Match", async () => {
      const id = await underReview(null);
      const headers = as(ORG, userA, memberA, false);
      const both = await post(
        `/api/v1/appeals/${id}/qic-clock`,
        { receivedOn: daysAgo(3), extensionDays: 2 },
        headers,
        await ver(id),
        "PATCH",
      );
      expect(both.statusCode).toBe(422);
      const none = await post(
        `/api/v1/appeals/${id}/qic-clock`,
        {},
        headers,
        await ver(id),
        "PATCH",
      );
      expect(none.statusCode).toBe(422);
      const good = await post(
        `/api/v1/appeals/${id}/qic-clock`,
        { receivedOn: daysAgo(3) },
        headers,
        await ver(id),
        "PATCH",
      );
      expect(good.statusCode).toBe(200);
      const stale = await post(
        `/api/v1/appeals/${id}/qic-clock`,
        { receivedOn: daysAgo(2) },
        headers,
        1,
        "PATCH",
      );
      expect(stale.statusCode).toBe(409);
    });

    it("GET /qic is schema-valid, and another tenant's appeal is a 404", async () => {
      const id = await underReview(10);
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/appeals/${id}/qic`,
        headers: as(ORG, userA, memberA),
      });
      expect(res.statusCode).toBe(200);
      expect(Value.Check(QicViewSchema, res.json())).toBe(true);
      const other = await app.inject({
        method: "GET",
        url: `/api/v1/appeals/${id}/qic`,
        headers: as(ORG_B, userB, memberB),
      });
      expect(other.statusCode).toBe(404);
      expect(await qic().getQic(actorOf(memberB, ORG_B, userB), id)).toBeNull();
      expect(
        await refused(
          qic().setCitedEvidence(actorOf(memberB, ORG_B, userB), id, { items: [], none: true }, 1),
        ),
      ).toMatchObject({ statusCode: 404 });
      expect(docOther).toBeTruthy();
    });
  });

  // ── trail, cron ────────────────────────────────────────────────────────────────────────────────────────────
  describe("audit trail and the overdue cron", () => {
    it("keeps the cited evidence and the escalation confirmation out of the audit trail", async () => {
      const { id } = await seedAppeal();
      await qic().setCitedEvidence(
        A(),
        id,
        {
          items: [{ label: "UNIQUE-LABEL-9137", documentId: docNote, notAvailableReason: null }],
          none: false,
        },
        await ver(id),
      );
      const leaked = await admin.query(
        `SELECT count(*)::int AS n FROM audit_event
          WHERE resource_kind = 'appeal_case' AND resource_id = $1 AND (before::text LIKE '%UNIQUE-LABEL-9137%' OR after::text LIKE '%UNIQUE-LABEL-9137%')`,
        [id],
      );
      expect(leaked.rows[0].n).toBe(0);
      // not vacuous: the update itself was audited, with the column scrubbed
      const audited = await admin.query(
        `SELECT count(*)::int AS n FROM audit_event
          WHERE resource_kind = 'appeal_case' AND resource_id = $1 AND event_type = 'appeal_case.update'`,
        [id],
      );
      expect(audited.rows[0].n).toBeGreaterThan(0);
      const escalated = await underReview(70);
      await qic().requestEscalation(
        A(),
        escalated,
        {
          channel: "mail",
          confirmationRef: "SECRET-REF-5521",
          requestedAt: new Date().toISOString(),
        },
        await ver(escalated),
      );
      const leakedRef = await admin.query(
        `SELECT count(*)::int AS n FROM audit_event
          WHERE resource_kind = 'appeal_case' AND resource_id = $1 AND after::text LIKE '%SECRET-REF-5521%'`,
        [escalated],
      );
      expect(leakedRef.rows[0].n).toBe(0);
    });

    it("alerts for an overdue reconsideration with no escalation request, and not for the others", async () => {
      const overdue = await underReview(80);
      const requested = await underReview(80);
      await qic().requestEscalation(
        A(),
        requested,
        { channel: "fax", confirmationRef: "FAX-9", requestedAt: new Date().toISOString() },
        await ver(requested),
      );
      const notYet = await underReview(5);
      const noReceipt = await underReview(null);
      const dispatched: { alertCode: string; payload: Record<string, unknown> }[] = [];
      await runAppealDeadlineCron({
        connection: {} as never,
        db: handle.db,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
        alerts: { dispatch: async (a) => void dispatched.push(a) },
        now: () => new Date(),
      });
      const qicAlerts = dispatched.filter((d) => d.alertCode === "appeal.qic_decision_overdue");
      const ids = qicAlerts.map((d) => d.payload.appealCaseId);
      expect(ids).toContain(overdue);
      expect(ids).not.toContain(requested);
      expect(ids).not.toContain(notYet);
      expect(ids).not.toContain(noReceipt);
    });
  });

  // ── review hardening ──────────────────────────────────────────────────────────────────────────────────────
  describe("review hardening", () => {
    const fax = (over: Record<string, unknown> = {}) => ({
      channel: "fax",
      confirmationRef: "FAX-CONF-77",
      requestedAt: new Date().toISOString(),
      ...over,
    });

    it("refuses a receipt date before the request was filed, and keeps the previous value in the event", async () => {
      const { id } = await seedAppeal();
      await qic().setCitedEvidence(A(), id, { items: [], none: true }, await ver(id));
      await write().submitAppeal(A(), id, submitFields(), await ver(id));
      await write().ackAppeal(A(), id, await ver(id));
      expect(
        await refused(qic().recordQicClock(A(), id, { receivedOn: daysAgo(5) }, await ver(id))),
      ).toMatchObject({ code: "RECEIPT_BEFORE_FILING", statusCode: 422 });
      await qic().recordQicClock(A(), id, { receivedOn: daysAgo(0) }, await ver(id));
      await qic().recordQicClock(A(), id, { receivedOn: daysAgo(0) }, await ver(id));
      const payloads = (
        await admin.query(
          "SELECT event_payload FROM appeal_case_event WHERE appeal_case_id=$1 AND event_kind='qic_clock_recorded' ORDER BY occurred_at",
          [id],
        )
      ).rows.map((r) => r.event_payload);
      expect(payloads[0]).toMatchObject({ receivedOn: daysAgo(0), previousReceivedOn: null });
      expect(payloads[1].previousReceivedOn).toBeTruthy();
    });

    it("refuses an escalation request that pre-dates the QIC decision date", async () => {
      const id = await underReview(70);
      expect(
        await refused(
          qic().requestEscalation(
            A(),
            id,
            fax({ requestedAt: new Date(Date.now() - 20 * 864e5).toISOString() }),
            await ver(id),
          ),
        ),
      ).toMatchObject({ code: "REQUESTED_BEFORE_DUE", statusCode: 422 });
      await qic().requestEscalation(A(), id, fax(), await ver(id));
    });

    it("refuses a Medicare-number-shaped string in evidence text and the confirmation reference", async () => {
      const { id } = await seedAppeal();
      expect(
        await refused(
          qic().setCitedEvidence(
            A(),
            id,
            {
              items: [
                { label: "Notes for 1EG4-TE5-MK73", documentId: docNote, notAvailableReason: null },
              ],
              none: false,
            },
            await ver(id),
          ),
        ),
      ).toMatchObject({ code: "MBI_NOT_ALLOWED", statusCode: 422 });
      expect(
        await refused(
          qic().setCitedEvidence(
            A(),
            id,
            {
              items: [
                {
                  label: "Visit notes",
                  documentId: null,
                  notAvailableReason: "1EG4TE5MK73 not released",
                },
              ],
              none: false,
            },
            await ver(id),
          ),
        ),
      ).toMatchObject({ code: "MBI_NOT_ALLOWED" });
      const late = await underReview(70);
      expect(
        await refused(
          qic().requestEscalation(
            A(),
            late,
            fax({ confirmationRef: "1EG4TE5MK73" }),
            await ver(late),
          ),
        ),
      ).toMatchObject({ code: "MBI_NOT_ALLOWED", statusCode: 422 });
    });

    it("takes an extension only while the QIC is reviewing, in the service and in the trigger", async () => {
      const { id } = await seedAppeal();
      await qic().setCitedEvidence(A(), id, { items: [], none: true }, await ver(id));
      await write().submitAppeal(A(), id, submitFields(), await ver(id));
      await qic().recordQicClock(A(), id, { receivedOn: daysAgo(0) }, await ver(id));
      expect(
        await refused(qic().recordQicClock(A(), id, { extensionDays: 3 }, await ver(id))),
      ).toMatchObject({ code: "INVALID_STATE", statusCode: 409 });
      await expect(
        admin.query(
          `UPDATE appeal_case SET qic_clock_extensions = '[{"days":3,"recordedAt":"x"}]'::jsonb WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow(/M25_QIC_EXTENSIONS_STATE/);
    });

    it("sets the forwarding date only by moving the case to escalated", async () => {
      const id = await underReview(70);
      await qic().requestEscalation(A(), id, fax(), await ver(id));
      await expect(
        admin.query("UPDATE appeal_case SET escalation_confirmed_on = CURRENT_DATE WHERE id = $1", [
          id,
        ]),
      ).rejects.toThrow(/M25_QIC_CONFIRM_STATE/);
    });

    it("confirm-escalation needs a fresh step-up over the wire", async () => {
      const id = await underReview(70);
      await qic().requestEscalation(A(), id, fax(), await ver(id));
      const send = (stepUp: boolean) =>
        app.inject({
          method: "POST",
          url: `/api/v1/appeals/${id}/confirm-escalation`,
          headers: {
            ...as(ORG, userA, memberA, stepUp),
            "idempotency-key": randomUUID(),
            "if-match": String(1_000),
          },
          payload: { forwardedOn: daysAgo(0) } as never,
        });
      const denied = await send(false);
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe("STEP_UP_REQUIRED");
      expect((await row(id)).state).toBe("under_review");
      // with the step-up it reaches the service (the deliberately stale version is then a 409, nothing written)
      expect((await send(true)).statusCode).toBe(409);
    });
  });
});
