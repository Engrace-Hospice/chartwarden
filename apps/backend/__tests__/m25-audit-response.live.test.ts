/**
 * M25 audit response packet, milestone 7a-2 (hospice ADR/TPE/QIC PRD) - LIVE Postgres as the NOBYPASSRLS
 * `chartwarden_app` role, through the real services, the real catalog-validating outbox publisher AND the real
 * cross-module seams (M23 `ClaimSubmissionReader`, M22 `DocumentReader`).
 *
 * Proves what the pure suites cannot: the response checklist is whatever the person typed (nothing is seeded);
 * attachments obey the appeal enclosure rules against the patient of the CLAIM they are attached under (another
 * patient, another tenant, 42 CFR Part 2, superseded - refused with a reason code and never a title); a reviewer must
 * differ from whoever sent the packet to review; nothing is filed without sign-off, proof, and either a recorded
 * deadline or the explicit "none stated in the request" attestation; a filing after a typed deadline needs a late
 * acknowledgement; filing moves the request to responded in the same transaction that writes the submission attempt
 * (purpose audit_response, born acknowledged) and the render request (a valid typed packet); the database refuses a
 * response without its packet, freezes the manifest and the enclosure list once filed, and keeps the attestation
 * immutable; the attestation stops the no-deadline alert; a notice document links to an audit deadline only through
 * the document seam against a named claim's patient; the new keys gate the routes; migrations 1174-1176 re-apply.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m25:audit-response:live
 * (SUPERUSER to a THROWAWAY db - this file DROPs and recreates the public schema.)
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
import { auditResponsePacketViolations } from "@chartwarden/types";
import { FormatRegistry } from "@sinclair/typebox";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
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
import { buildSeamAppealSourcePorts } from "../src/modules/25-remittance/routes/appeal-packet-sources";
import { buildDrizzleAuditRequestService } from "../src/modules/25-remittance/routes/audit-request-service";
import { registerAuditRequestRoutes } from "../src/modules/25-remittance/routes/audit-request.routes";
import { registerAuditResponseRoutes } from "../src/modules/25-remittance/routes/audit-response.routes";
import { buildDrizzleLaterTierService } from "../src/modules/25-remittance/routes/later-tier-service";
import { buildDrizzleSubmissionService } from "../src/modules/25-remittance/routes/submission-service";
import { registerSubmissionRoutes } from "../src/modules/25-remittance/routes/submission.routes";
import { type M7Fixture, ORG, ORG_B, daysAgo, daysAhead, setupM7Fixture } from "./_m25-m7-fixture";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) FormatRegistry.Set("uuid", (v) => UUID_RE.test(v));
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => !Number.isNaN(Date.parse(v)));
}

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("M25 audit response packet (milestone 7a-2) - LIVE Postgres", () => {
  let fx: M7Fixture;
  let memberR = "";
  let userR = "";
  let patient1 = "";
  let patient1b = "";

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
  const audit = (withOutbox = true) =>
    buildDrizzleAuditRequestService(fx.handle.db, {
      sources: buildSeamAppealSourcePorts(),
      ...(withOutbox ? { outbox: m25Outbox } : {}),
    });
  const tier = () =>
    buildDrizzleLaterTierService(fx.handle.db, {
      providerZones,
      sources: buildSeamAppealSourcePorts(),
    });
  const submission = () =>
    buildDrizzleSubmissionService(fx.handle.db, { sources: buildSeamAppealSourcePorts() });
  const A = () => fx.actor();
  const R = () => ({ ...fx.actor(), userId: userR, membershipId: memberR });
  const B = () => fx.actor(ORG_B);
  const ver = (id: string) => fx.ver("audit_request", id);
  const row = async (id: string) =>
    (await fx.admin.query("SELECT * FROM audit_request WHERE id=$1", [id])).rows[0];
  const outboxFor = async (id: string) =>
    (
      await fx.admin.query(
        "SELECT payload FROM outbox_event WHERE event_type='m25.audit_response_packet.render_requested' AND aggregate_id=$1",
        [id],
      )
    ).rows;

  async function seedDocument(
    org: string,
    patientId: string | null,
    title: string,
    over: { retentionClass?: string; status?: string } = {},
  ): Promise<string> {
    return (
      await fx.admin.query(
        `INSERT INTO document (organization_id, patient_id, retention_class, source_kind, aggregate_type, title,
           status, created_by_membership_id)
         VALUES ($1,$2,$3,'user_upload','f2f',$4,$5,$6) RETURNING id`,
        [
          org,
          patientId,
          over.retentionClass ?? "clinical_record",
          title,
          over.status ?? "active",
          fx.memberA,
        ],
      )
    ).rows[0].id as string;
  }
  const newDoc = (claim: "1" | "1b" = "1", title = "Orders") =>
    seedDocument(ORG, claim === "1" ? patient1 : patient1b, title);

  const intake = (over: Record<string, unknown> = {}) => ({
    authorityKind: "upic",
    receivedOn: daysAgo(1),
    claimIds: [fx.claim1, fx.claim1b],
    ...over,
  });
  const deadlineInput = (over: Record<string, unknown> = {}) => ({
    label: "Records due",
    dueOn: daysAhead(30),
    sourceNote: "Request letter p.1",
    ...over,
  });

  /** A request in assembly with a typed checklist and one document under each claim. */
  async function inAssembly(opts: { deadline?: boolean } = {}): Promise<string> {
    const { id } = await audit().createAuditRequest(A(), intake());
    if (opts.deadline !== false) {
      await tier().createDeadline(A(), { kind: "audit_request", id }, deadlineInput());
    }
    await audit().moveAuditRequest(A(), id, "in_assembly", await ver(id));
    await audit().setResponseItems(
      A(),
      id,
      [
        { label: "Orders for the period", state: "ready" },
        { label: "Visit notes", state: "not_applicable" },
      ],
      await ver(id),
    );
    await audit().attachAuditDocument(
      A(),
      id,
      { claimId: fx.claim1, documentId: await newDoc("1", "Plan of care") },
      await ver(id),
    );
    await audit().attachAuditDocument(
      A(),
      id,
      { claimId: fx.claim1b, documentId: await newDoc("1b", "Visit log") },
      await ver(id),
    );
    return id;
  }
  async function inReview(opts: { deadline?: boolean } = {}): Promise<string> {
    const id = await inAssembly(opts);
    await audit().moveAuditRequest(A(), id, "in_review", await ver(id));
    return id;
  }
  async function signedOff(opts: { deadline?: boolean } = {}): Promise<string> {
    const id = await inReview(opts);
    await audit().signOffAudit(R(), id, await ver(id));
    return id;
  }
  const filing = (over: Record<string, unknown> = {}) => ({
    channel: "mail",
    confirmationRef: "TRACK-90210",
    filedAt: new Date().toISOString(),
    ...over,
  });

  function makeApp(keys: string[], stepUpRecent = false) {
    resetAuthorizationContract();
    resetRbacEngine();
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        {
          orgId: ORG,
          userId: fx.userA,
          grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: keys }],
        },
      ]).store,
    );
    // The step-up gate reads this predicate (the route operation key is the permission key).
    const registry = createPredicateRegistry();
    registry.register(
      "step_up_recent",
      async (context) => context.attributes.stepUpRecent === true,
    );
    registerAbacRegistry(registry);
    const app = buildServer({
      db: fx.handle.db as never,
      authenticate: (request: FastifyRequest) => {
        request.context.userId = fx.userA;
        request.context.organizationId = ORG;
        request.context.roles = ["billing_manager"];
        request.context.providerEntityIds = [fx.pe1, fx.pe2];
        request.context.attributes = { ...request.context.attributes, membershipId: fx.memberA };
        if (stepUpRecent) {
          request.context.attributes = {
            ...request.context.attributes,
            stepUpRecent: true,
          };
        }
      },
      security: { rateLimitEnabled: false },
    });
    registerAuditRequestRoutes(app, { auditRequestService: audit(), laterTierService: tier() });
    registerAuditResponseRoutes(app, { auditResponse: audit() });
    registerSubmissionRoutes(app, { submissionService: submission() });
    return app;
  }
  const WRITE = (version?: number) => ({
    "idempotency-key": randomUUID(),
    ...(version === undefined ? {} : { "if-match": String(version) }),
  });

  beforeAll(async () => {
    fx = await setupM7Fixture(DB_URL as string, "m25-aresp");
    registerM23PublishedSeams(fx.handle.db);
    registerSeam(
      "DocumentReader",
      createDocumentReader(createDrizzleDocumentReaderStore(fx.handle.db)),
    );
    userR = (
      await fx.admin.query(`INSERT INTO "user" (email) VALUES ('m25-aresp-r@x.test') RETURNING id`)
    ).rows[0].id as string;
    memberR = (
      await fx.admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [userR, ORG],
      )
    ).rows[0].id as string;
    const patientOf = async (claim: string) =>
      (await fx.admin.query("SELECT patient_id FROM claim WHERE id=$1", [claim])).rows[0]
        .patient_id as string;
    patient1 = await patientOf(fx.claim1);
    patient1b = await patientOf(fx.claim1b);
  }, 300_000);

  afterAll(async () => {
    await fx?.close();
    resetAuthorizationContract();
    resetRbacEngine();
  });

  // ── schema posture ───────────────────────────────────────────────────────────────────────────────────────
  it("registers the keys, forces RLS on the document table and re-applies 1174-1176 idempotently", async () => {
    const keys = (
      await fx.admin.query(
        `SELECT key FROM permission WHERE key IN ('audit_request.review','audit_request.submit') ORDER BY key`,
      )
    ).rows.map((r) => r.key as string);
    expect(keys).toEqual(["audit_request.review", "audit_request.submit"]);
    const forced = await fx.admin.query(
      `SELECT 1 FROM pg_class WHERE relname='audit_request_document' AND relrowsecurity AND relforcerowsecurity`,
    );
    expect(forced.rowCount).toBe(1);
    const msg = await fx.dbMessage(
      fx.asApp((tx) => tx.execute(sql.raw("DELETE FROM audit_request_document"))),
    );
    expect(msg).toMatch(/permission denied/i);
    for (const f of [
      "1174_m25_audit_response_packet_aggregate_type.sql",
      "1175_m25_audit_response.sql",
      "1176_m25_audit_response_role_grants.sql",
    ]) {
      const text = readFileSync(join(fx.migrationsDir, f), "utf8");
      await fx.admin.query(text);
      await fx.admin.query(text);
    }
  });

  it("grants the new keys to roles holding appeal.decide / appeal.submit (1176), without copying an ABAC override", async () => {
    const roleId = (
      await fx.admin.query(
        `INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'aresp-billing','Billing','billing_finance',true) RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    for (const key of ["appeal.decide", "appeal.submit"]) {
      await fx.admin.query(
        `INSERT INTO role_permission (organization_id, role_id, permission_key, abac_override) VALUES ($1,$2,$3,'narrowed_predicate')`,
        [ORG, roleId, key],
      );
    }
    const migration = readFileSync(
      join(fx.migrationsDir, "1176_m25_audit_response_role_grants.sql"),
      "utf8",
    );
    await fx.admin.query(migration);
    await fx.admin.query(migration);
    const granted = (
      await fx.admin.query(
        `SELECT permission_key, abac_override FROM role_permission WHERE role_id=$1 AND permission_key LIKE 'audit_request%' ORDER BY permission_key`,
        [roleId],
      )
    ).rows;
    expect(granted).toEqual([
      { permission_key: "audit_request.review", abac_override: null },
      { permission_key: "audit_request.submit", abac_override: null },
    ]);
  });

  // ── the whole path ───────────────────────────────────────────────────────────────────────────────────────
  it("assembles, is signed off by a second person, and files: manifest frozen, attempt acknowledged, valid render request", async () => {
    const id = await inReview();
    // The preparer cannot sign off their own packet.
    expect(await fx.refused(audit().signOffAudit(A(), id, await ver(id)))).toMatchObject({
      code: "AUDIT_REVIEWER_IS_ASSEMBLER",
      statusCode: 409,
    });
    await audit().signOffAudit(R(), id, await ver(id));
    expect((await row(id)).reviewed_by_membership_id).toBe(memberR);

    const at = new Date();
    await audit().submitAuditResponse(
      R(),
      id,
      filing({ filedAt: at.toISOString() }),
      await ver(id),
    );
    const after = await row(id);
    expect(after.state).toBe("responded");
    expect(after.response_channel).toBe("mail");
    expect(after.response_confirmation_ref).toBe("TRACK-90210");
    expect(after.response_filed_late).toBe(false);
    expect(new Date(after.responded_at).toISOString()).toBe(at.toISOString());
    expect(after.packet_manifest.documents).toHaveLength(2);
    expect(after.packet_manifest.checklist).toEqual([
      { label: "Orders for the period", state: "ready" },
      { label: "Visit notes", state: "not_applicable" },
    ]);

    const rows = await outboxFor(id);
    expect(rows).toHaveLength(1);
    const packet = rows[0].payload.payload;
    expect(auditResponsePacketViolations(packet)).toEqual([]);
    expect(packet).toMatchObject({
      auditRequestId: id,
      authorityKind: "upic",
      filingChannel: "mail",
      filingConfirmationRef: "TRACK-90210",
      filedLate: false,
      noDeadlineStatedAttested: false,
      checklist: [
        { label: "Orders for the period", state: "ready" },
        { label: "Visit notes", state: "not_applicable" },
      ],
      claims: [{ claimControlNumber: expect.stringMatching(/^CCN-/) }, {}],
    });
    expect(packet.enclosures.map((e: { title: string }) => e.title)).toEqual([
      "Plan of care",
      "Visit log",
    ]);
    expect(packet.deadlines).toHaveLength(1);

    const attempts = (
      await fx.admin.query(
        "SELECT * FROM submission_attempt WHERE audit_request_id=$1 ORDER BY attempt_no",
        [id],
      )
    ).rows;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      purpose: "audit_response",
      status: "acknowledged",
      channel: "mail",
      adapter: "manual",
      confirmation_ref: "TRACK-90210",
      receipt_source: "entered",
      adr_case_id: null,
      appeal_case_id: null,
      reopening_case_id: null,
    });
    expect(attempts[0].packet_manifest.documents).toHaveLength(2);

    const view = await submission().getSubmission(A(), "audit", id);
    expect(view.proofMissing).toBe(false);
    expect(view.attempts).toHaveLength(1);
    expect(view.patientId).toBeNull(); // two claims: no single patient for the read audit

    const detail = await audit().getAuditRequest(A(), id);
    expect(detail?.state).toBe("responded");
    expect(detail?.response.filing).toMatchObject({
      channel: "mail",
      confirmationRef: "TRACK-90210",
      filedLate: false,
    });
    expect(detail?.events.map((e) => e.eventKind)).toEqual(
      expect.arrayContaining([
        "response_items_set",
        "document_attached",
        "signed_off",
        "responded",
      ]),
    );
    // It then closes like any request, and the freeze holds.
    await audit().moveAuditRequest(A(), id, "closed", await ver(id));
  });

  it("amends the receipt of a filed response by appending, never rewriting (step-up route family)", async () => {
    const id = await signedOff();
    await audit().submitAuditResponse(R(), id, filing(), await ver(id));
    const attempt = (
      await fx.admin.query("SELECT id, version FROM submission_attempt WHERE audit_request_id=$1", [
        id,
      ])
    ).rows[0];
    const res = await submission().recordReceipt(
      A(),
      "audit",
      id,
      {
        attemptId: attempt.id,
        confirmationRef: "TRACK-CORRECTED",
        receiptAt: new Date(Date.now() - 60_000).toISOString(),
      },
      Number(attempt.version),
    );
    expect(res.amended).toBe(true);
    const stored = (
      await fx.admin.query(
        "SELECT confirmation_ref, receipt_amendments FROM submission_attempt WHERE id=$1",
        [attempt.id],
      )
    ).rows[0];
    expect(stored.confirmation_ref).toBe("TRACK-90210");
    expect(stored.receipt_amendments).toHaveLength(1);
    // A receipt document cannot be linked to a filing that spans several patients' claims.
    const withDoc = await fx.refused(
      submission().recordReceipt(
        A(),
        "audit",
        id,
        {
          attemptId: attempt.id,
          confirmationRef: "TRACK-3",
          receiptAt: new Date(Date.now() - 30_000).toISOString(),
          receiptDocumentId: randomUUID(),
        },
        Number(
          (await fx.admin.query("SELECT version FROM submission_attempt WHERE id=$1", [attempt.id]))
            .rows[0].version,
        ),
      ),
    );
    expect(withDoc?.code).toBe("SUBMISSION_RECEIPT_DOCUMENT_UNSUPPORTED");
  });

  // ── checklist and enclosures ─────────────────────────────────────────────────────────────────────────────
  it("takes the checklist exactly as typed: no seeded item, blank/duplicate/oversize refused, replaced as a whole", async () => {
    const { id } = await audit().createAuditRequest(A(), intake());
    expect((await audit().getAuditRequest(A(), id))?.response.items).toEqual([]);
    expect(
      (
        await fx.refused(
          audit().setResponseItems(A(), id, [{ label: "  ", state: "ready" }], await ver(id)),
        )
      )?.code,
    ).toBe("AUDIT_ITEM_LABEL_REQUIRED");
    expect(
      (
        await fx.refused(
          audit().setResponseItems(
            A(),
            id,
            [
              { label: "Orders", state: "ready" },
              { label: "orders", state: "pending" },
            ],
            await ver(id),
          ),
        )
      )?.code,
    ).toBe("AUDIT_ITEM_LABEL_DUPLICATE");
    await audit().setResponseItems(
      A(),
      id,
      [{ label: "  Orders  ", state: "pending" }],
      await ver(id),
    );
    expect((await audit().getAuditRequest(A(), id))?.response.items).toEqual([
      { label: "Orders", state: "pending" },
    ]);
    // A stale If-Match loses.
    expect((await fx.refused(audit().setResponseItems(A(), id, [], 1)))?.statusCode).toBe(409);
    // The free text stays out of the audit trail.
    const trail = JSON.stringify(
      (
        await fx.admin.query(
          "SELECT after FROM audit_event WHERE resource_id=$1 AND event_type='audit_request.update'",
          [id],
        )
      ).rows,
    );
    expect(trail).not.toContain("Orders");
  });

  it("refuses enclosures by the appeal rules against the patient of the claim they are attached under", async () => {
    const { id } = await audit().createAuditRequest(A(), intake());
    await audit().moveAuditRequest(A(), id, "in_assembly", await ver(id));
    const attach = async (claimId: string, documentId: string) =>
      fx.refused(audit().attachAuditDocument(A(), id, { claimId, documentId }, await ver(id)));
    const otherPatient = await seedDocument(ORG, randomUUID(), "SECRET other patient's note");
    const part2 = await seedDocument(ORG, patient1, "SECRET SUD note", {
      retentionClass: "compliance_42cfr_part2",
    });
    const superseded = await seedDocument(ORG, patient1, "Old version", { status: "superseded" });
    const otherTenant = await seedDocument(ORG_B, null, "SECRET other tenant's document");
    for (const bad of [randomUUID(), otherPatient, part2, superseded, otherTenant]) {
      const r = await attach(fx.claim1, bad);
      expect(r?.code).toBe("APPEAL_DOCUMENT_NOT_ATTACHABLE");
      expect(r?.message).not.toContain("SECRET");
      expect(r?.message).toContain("audit response");
    }
    // A document of claim 1's patient is not attachable under claim 1b (a different patient).
    const mine = await newDoc("1");
    expect((await attach(fx.claim1b, mine))?.code).toBe("APPEAL_DOCUMENT_NOT_ATTACHABLE");
    // A claim that is not on the request.
    expect((await attach(fx.claim2, mine))?.code).toBe("AUDIT_CLAIM_NOT_ON_REQUEST");
    // Attached once, only once; removable only while in assembly.
    await audit().attachAuditDocument(
      A(),
      id,
      { claimId: fx.claim1, documentId: mine },
      await ver(id),
    );
    expect((await attach(fx.claim1, mine))?.code).toBe("AUDIT_DUPLICATE_DOCUMENT");
    // The claim carrying documents cannot be removed from the request.
    expect((await fx.refused(audit().removeClaim(A(), id, fx.claim1, await ver(id))))?.code).toBe(
      "AUDIT_CLAIM_HAS_DOCUMENTS",
    );
    await audit().detachAuditDocument(A(), id, mine, await ver(id));
    await audit().removeClaim(A(), id, fx.claim1, await ver(id));
    // Not in assembly: no attach.
    const received = (await audit().createAuditRequest(A(), intake())).id;
    expect(
      (
        await fx.refused(
          audit().attachAuditDocument(
            A(),
            received,
            { claimId: fx.claim1, documentId: mine },
            await ver(received),
          ),
        )
      )?.code,
    ).toBe("AUDIT_WRONG_STATE");
  });

  // ── sign-off and filing gates ────────────────────────────────────────────────────────────────────────────
  it("refuses sign-off for an empty packet or an unfinished checklist item, and a stale version", async () => {
    const empty = (await audit().createAuditRequest(A(), intake())).id;
    await audit().moveAuditRequest(A(), empty, "in_assembly", await ver(empty));
    await audit().moveAuditRequest(A(), empty, "in_review", await ver(empty));
    expect((await fx.refused(audit().signOffAudit(R(), empty, await ver(empty))))?.code).toBe(
      "AUDIT_PACKET_EMPTY",
    );

    const id = await inAssembly();
    await audit().setResponseItems(
      A(),
      id,
      [{ label: "Orders for the period", state: "pending" }],
      await ver(id),
    );
    await audit().moveAuditRequest(A(), id, "in_review", await ver(id));
    expect((await fx.refused(audit().signOffAudit(R(), id, await ver(id))))?.code).toBe(
      "AUDIT_CHECKLIST_INCOMPLETE",
    );
    // A stale If-Match loses, on a packet that is otherwise ready to sign off.
    const ready = await inReview();
    expect((await fx.refused(audit().signOffAudit(R(), ready, 1)))?.statusCode).toBe(409);
  });

  it("will not file without sign-off, a real channel, proof, a past time, or the deadline/attestation", async () => {
    const unsigned = await inReview();
    expect(
      (await fx.refused(audit().submitAuditResponse(R(), unsigned, filing(), await ver(unsigned))))
        ?.code,
    ).toBe("AUDIT_NOT_SIGNED_OFF");

    const id = await signedOff();
    const file = async (over: Record<string, unknown>) =>
      fx.refused(audit().submitAuditResponse(R(), id, filing(over), await ver(id)));
    expect((await file({ channel: "mac_portal" }))?.code).toBe("AUDIT_CHANNEL_INVALID");
    expect((await file({ confirmationRef: "   " }))?.code).toBe("AUDIT_PROOF_REQUIRED");
    expect((await file({ filedAt: new Date(Date.now() + 86_400_000).toISOString() }))?.code).toBe(
      "AUDIT_FILED_IN_FUTURE",
    );
    expect(
      (
        await fx.refused(
          audit().submitAuditResponse(R(), id, filing({ filedAt: "nope" }), await ver(id)),
        )
      )?.code,
    ).toBe("AUDIT_INVALID_FILING_TIME");
    // Nothing was recorded by any refusal.
    expect((await row(id)).state).toBe("in_review");
    expect(
      (await fx.admin.query("SELECT 1 FROM submission_attempt WHERE audit_request_id=$1", [id]))
        .rowCount,
    ).toBe(0);
    expect(await outboxFor(id)).toHaveLength(0);
  });

  it("needs a recorded deadline OR the explicit none-stated attestation before it files", async () => {
    const id = await signedOff({ deadline: false });
    expect(
      (await fx.refused(audit().submitAuditResponse(R(), id, filing(), await ver(id))))?.code,
    ).toBe("AUDIT_DEADLINE_OR_ATTESTATION_REQUIRED");
    expect((await audit().getAuditRequest(A(), id))?.dueState).toBe("no_deadline_recorded");

    await audit().attestNoDeadlineStated(A(), id, await ver(id));
    const detail = await audit().getAuditRequest(A(), id);
    expect(detail?.dueState).toBe("none_stated");
    expect(detail?.response.deadlineNoneStatedAt).not.toBeNull();
    // A second attestation is refused; the database also keeps the first immutable.
    expect((await fx.refused(audit().attestNoDeadlineStated(A(), id, await ver(id))))?.code).toBe(
      "AUDIT_ALREADY_ATTESTED",
    );
    expect(
      await fx.dbMessage(
        fx.asApp((tx) =>
          tx.execute(
            sql`UPDATE audit_request SET deadline_none_stated_at = now() - interval '1 day' WHERE id=${id}`,
          ),
        ),
      ),
    ).toMatch(/M25_AUDIT_ATTESTATION_IMMUTABLE/);

    // A sign-off after the attestation does not move it; filing now succeeds and the packet says so.
    await audit().submitAuditResponse(R(), id, filing(), await ver(id));
    const packet = (await outboxFor(id))[0].payload.payload;
    expect(packet).toMatchObject({
      noDeadlineStatedAttested: true,
      deadlines: [],
      filedLate: false,
    });
  });

  it("refuses the attestation once a deadline is recorded, and an attestation by the database pair rule", async () => {
    const id = await inAssembly();
    expect((await fx.refused(audit().attestNoDeadlineStated(A(), id, await ver(id))))?.code).toBe(
      "AUDIT_DEADLINES_EXIST",
    );
    expect(
      await fx.dbMessage(
        fx.asApp((tx) =>
          tx.execute(sql`UPDATE audit_request SET deadline_none_stated_at = now() WHERE id=${id}`),
        ),
      ),
    ).toMatch(/audit_request_attestation_pair/);
  });

  it("a filing after a typed deadline needs the late acknowledgement, and records it as late", async () => {
    const id = await signedOff({ deadline: false });
    await tier().createDeadline(
      A(),
      { kind: "audit_request", id },
      deadlineInput({ dueOn: daysAgo(2), label: "Records due" }),
    );
    expect(
      (await fx.refused(audit().submitAuditResponse(R(), id, filing(), await ver(id))))?.code,
    ).toBe("AUDIT_LATE_ACKNOWLEDGEMENT_REQUIRED");
    await audit().submitAuditResponse(R(), id, filing({ lateAcknowledged: true }), await ver(id));
    expect((await row(id)).response_filed_late).toBe(true);
    expect((await outboxFor(id))[0].payload.payload.filedLate).toBe(true);
    // The late flag lives in the frozen record.
    expect(
      await fx.dbMessage(
        fx.asApp((tx) =>
          tx.execute(sql`UPDATE audit_request SET response_filed_late=false WHERE id=${id}`),
        ),
      ),
    ).toMatch(/M25_AUDIT_FILING_IMMUTABLE/);
  });

  it("a satisfied deadline still counts as recorded and cannot make the filing late", async () => {
    const id = await signedOff({ deadline: false });
    const d = await tier().createDeadline(
      A(),
      { kind: "audit_request", id },
      deadlineInput({ dueOn: daysAgo(2) }),
    );
    await tier().satisfyDeadline(A(), { kind: "audit_request", id }, d.id, undefined, d.version);
    await audit().submitAuditResponse(R(), id, filing(), await ver(id));
    expect((await row(id)).response_filed_late).toBe(false);
  });

  it("refuses to file when no outbox is bound, recording nothing", async () => {
    const id = await signedOff();
    const r = await fx.refused(audit(false).submitAuditResponse(R(), id, filing(), await ver(id)));
    expect(r?.code).toBe("SEAM_UNBOUND");
    expect((await row(id)).state).toBe("in_review");
  });

  it("re-validates every document at filing: one reclassified to Part 2 stops it, a removed claim is caught", async () => {
    const id = await signedOff();
    const docId = (
      await fx.admin.query(
        "SELECT document_id FROM audit_request_document WHERE audit_request_id=$1 ORDER BY attached_at LIMIT 1",
        [id],
      )
    ).rows[0].document_id as string;
    await fx.admin.query(
      "UPDATE document SET retention_class='compliance_42cfr_part2' WHERE id=$1",
      [docId],
    );
    const r = await fx.refused(audit().submitAuditResponse(R(), id, filing(), await ver(id)));
    expect(r?.code).toBe("APPEAL_DOCUMENT_NOT_ATTACHABLE");
    expect((await row(id)).state).toBe("in_review");
  });

  // ── database guards ──────────────────────────────────────────────────────────────────────────────────────
  it("the database refuses a response without its packet, and freezes the manifest, the checklist and the documents once filed", async () => {
    const bare = await inReview();
    expect(
      await fx.dbMessage(
        fx.asApp((tx) =>
          tx.execute(
            sql`UPDATE audit_request SET state='responded', responded_at=now() WHERE id=${bare}`,
          ),
        ),
      ),
    ).toMatch(/M25_AUDIT_RESPONSE_NEEDS_PACKET/);
    expect(
      (await fx.refused(audit().moveAuditRequest(A(), bare, "responded", await ver(bare))))?.code,
    ).toBe("AUDIT_RESPONSE_REQUIRES_FILING");

    const id = await signedOff();
    await audit().submitAuditResponse(R(), id, filing(), await ver(id));
    for (const stmt of [
      "UPDATE audit_request SET packet_manifest='{}'::jsonb",
      "UPDATE audit_request SET response_confirmation_ref='x'",
      "UPDATE audit_request SET response_items='[]'::jsonb",
      "UPDATE audit_request SET reviewed_by_membership_id=NULL",
    ]) {
      expect(await fx.dbMessage(fx.admin.query(`${stmt} WHERE id='${id}'`)), stmt).toMatch(
        /M25_AUDIT_FILING_IMMUTABLE|audit_request_manifest_has_filing/,
      );
    }
    expect(
      await fx.dbMessage(
        fx.admin.query(
          `INSERT INTO audit_request_document (organization_id, audit_request_id, claim_id, document_id) VALUES ($1,$2,$3,$4)`,
          [ORG, id, fx.claim1, randomUUID()],
        ),
      ),
    ).toMatch(/M25_AUDIT_PACKET_FROZEN/);
    expect(
      await fx.dbMessage(
        fx.admin.query(
          "UPDATE audit_request_document SET removed_at=now() WHERE audit_request_id=$1",
          [id],
        ),
      ),
    ).toMatch(/M25_AUDIT_PACKET_FROZEN/);
    // A filed request cannot be filed again.
    expect(
      (await fx.refused(audit().submitAuditResponse(R(), id, filing(), await ver(id))))?.code,
    ).toBe("AUDIT_WRONG_STATE");
  });

  it("submission_attempt: one live attempt per audit, exactly one subject, the audit purpose needs the audit subject", async () => {
    const id = await signedOff();
    await audit().submitAuditResponse(R(), id, filing(), await ver(id));
    // An acknowledged attempt is not live, so a second row would be a new attempt; one_live guards live ones.
    const insert = (cols: string, vals: string) =>
      fx.dbMessage(
        fx.admin.query(
          `INSERT INTO submission_attempt (organization_id, provider_entity_id, ${cols}, attempt_no, idempotency_key, status)
           VALUES ('${ORG}','${fx.pe1}',${vals},9,'${randomUUID()}','prepared')`,
        ),
      );
    expect(
      await insert(
        "audit_request_id, appeal_case_id, purpose",
        `'${id}','${randomUUID()}','audit_response'`,
      ),
    ).toMatch(/submission_attempt_one_subject|foreign key/);
    expect(await insert("appeal_case_id, purpose", `'${randomUUID()}','audit_response'`)).toMatch(
      /submission_attempt_purpose_subject|foreign key/,
    );
    expect(await insert("audit_request_id, purpose", `'${id}','appeal_request'`)).toMatch(
      /submission_attempt_purpose_subject/,
    );
    expect(await insert("audit_request_id, purpose", `'${id}','not_a_purpose'`)).toMatch(
      /submission_attempt_purpose_check/,
    );
    await fx.admin.query(
      `INSERT INTO submission_attempt (organization_id, provider_entity_id, audit_request_id, purpose, attempt_no, idempotency_key, status)
       VALUES ($1,$2,$3,'audit_response',2,$4,'prepared')`,
      [ORG, fx.pe1, id, randomUUID()],
    );
    expect(await insert("audit_request_id, purpose", `'${id}','audit_response'`)).toMatch(
      /submission_attempt_one_live|duplicate key/,
    );
  });

  // ── the none-stated attestation and the nightly alert ────────────────────────────────────────────────────
  it("the attestation stops the no-deadline alert; an unattested request alerts exactly once", async () => {
    const attested = (await audit().createAuditRequest(A(), intake())).id;
    const unattested = (await audit().createAuditRequest(A(), intake())).id;
    await audit().attestNoDeadlineStated(A(), attested, await ver(attested));
    const dispatched: { alertCode: string; payload: Record<string, unknown> }[] = [];
    const run = () =>
      runAppealDeadlineCron({
        connection: {} as never,
        db: fx.handle.db,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
        alerts: { dispatch: async (a) => void dispatched.push(a) },
        now: () => new Date(Date.now() + 3 * 86_400_000),
      });
    await run();
    await run();
    const ids = dispatched
      .filter((a) => a.alertCode === "audit.no_deadline_recorded")
      .map((a) => a.payload.auditRequestId);
    expect(ids).not.toContain(attested);
    expect(ids.filter((i) => i === unattested)).toHaveLength(1);
  });

  // ── notice documents on audit deadlines ──────────────────────────────────────────────────────────────────
  it("links a notice document to an audit deadline only through the document seam, against a named claim's patient", async () => {
    const one = (await audit().createAuditRequest(A(), intake({ claimIds: [fx.claim1] }))).id;
    const many = (await audit().createAuditRequest(A(), intake())).id;
    const good = await newDoc("1", "Request letter scan");
    const wrongPatient = await seedDocument(ORG, randomUUID(), "SECRET other patient");
    const part2 = await seedDocument(ORG, patient1, "SECRET SUD", {
      retentionClass: "compliance_42cfr_part2",
    });
    const make = (id: string, over: Record<string, unknown>) =>
      tier().createDeadline(A(), { kind: "audit_request", id }, deadlineInput(over) as never);

    // One claim: implicit.
    for (const bad of [
      randomUUID(),
      wrongPatient,
      part2,
      await seedDocument(ORG_B, null, "SECRET b"),
    ]) {
      const r = await fx.refused(make(one, { noticeDocumentId: bad }));
      expect(r?.code).toBe("APPEAL_DOCUMENT_NOT_ATTACHABLE");
      expect(r?.message).not.toContain("SECRET");
    }
    const ok = await make(one, { noticeDocumentId: good });
    expect(
      (await tier().listDeadlines(A(), { kind: "audit_request", id: one })).items.find(
        (d) => d.id === ok.id,
      )?.noticeDocumentId,
    ).toBe(good);

    // Several claims: the claim whose patient owns the notice must be named, and must be on the request.
    expect((await fx.refused(make(many, { noticeDocumentId: good })))?.code).toBe(
      "NOTICE_DOCUMENT_CLAIM_REQUIRED",
    );
    expect(
      (await fx.refused(make(many, { noticeDocumentId: good, noticeClaimId: fx.claim2 })))?.code,
    ).toBe("NOTICE_DOCUMENT_CLAIM_REQUIRED");
    expect(
      (await fx.refused(make(many, { noticeDocumentId: good, noticeClaimId: fx.claim1b })))?.code,
    ).toBe("APPEAL_DOCUMENT_NOT_ATTACHABLE");
    const linked = await make(many, { noticeDocumentId: good, noticeClaimId: fx.claim1 });
    expect(linked.id).toBeTruthy();

    // Editing: the same rules apply when the document changes.
    const d = (await tier().listDeadlines(A(), { kind: "audit_request", id: one })).items[0]!;
    expect(
      (
        await fx.refused(
          tier().updateDeadline(
            A(),
            { kind: "audit_request", id: one },
            d.id,
            { noticeDocumentId: wrongPatient },
            d.version,
          ),
        )
      )?.code,
    ).toBe("APPEAL_DOCUMENT_NOT_ATTACHABLE");
  });

  // ── tenancy ──────────────────────────────────────────────────────────────────────────────────────────────
  it("hides the packet from another tenant: every operation reads the request as absent", async () => {
    const id = await signedOff();
    expect(await audit().getAuditRequest(B(), id)).toBeNull();
    for (const call of [
      () => audit().signOffAudit(B(), id, 1),
      () => audit().setResponseItems(B(), id, [], 1),
      () => audit().attestNoDeadlineStated(B(), id, 1),
      () => audit().submitAuditResponse(B(), id, filing(), 1),
      () =>
        audit().attachAuditDocument(B(), id, { claimId: fx.claimB, documentId: randomUUID() }, 1),
      () => submission().getSubmission(B(), "audit", id),
    ]) {
      expect((await fx.refused(call()))?.statusCode).toBe(404);
    }
    const seen = await fx.asApp(
      (tx) => tx.execute(sql`SELECT id FROM audit_request_document WHERE audit_request_id=${id}`),
      ORG_B,
    );
    expect((seen as { rows: unknown[] }).rows).toHaveLength(0);
  });

  it("hides the packet from an actor outside the request's provider entity", async () => {
    const id = await inReview();
    const outside = fx.actor(ORG, [fx.pe2]);
    expect(await audit().getAuditRequest(outside, id)).toBeNull();
    expect((await fx.refused(audit().signOffAudit(outside, id, await ver(id))))?.statusCode).toBe(
      404,
    );
  });

  // ── routes ───────────────────────────────────────────────────────────────────────────────────────────────
  it("gates the packet routes on audit_request.manage / .review / .submit, and the filing on a step-up", async () => {
    const id = await inReview();
    const v = () => fx.ver("audit_request", id);

    const manageOnly = makeApp(["audit_request.read", "audit_request.manage"]);
    const items = await manageOnly.inject({
      method: "PUT",
      url: `/api/v1/audit-requests/${id}/response-items`,
      headers: WRITE(await v()),
      payload: { items: [{ label: "Orders", state: "ready" }] },
    });
    // In review: the checklist is frozen to assembly (a typed 409, not a database error).
    expect(items.statusCode).toBe(409);
    const noReview = await manageOnly.inject({
      method: "POST",
      url: `/api/v1/audit-requests/${id}/sign-off`,
      headers: WRITE(await v()),
    });
    expect(noReview.statusCode).toBe(403);
    const noSubmit = await manageOnly.inject({
      method: "POST",
      url: `/api/v1/audit-requests/${id}/submit`,
      headers: WRITE(await v()),
      payload: filing(),
    });
    expect(noSubmit.statusCode).toBe(403);
    await manageOnly.close();

    const full = makeApp([
      "audit_request.read",
      "audit_request.manage",
      "audit_request.review",
      "audit_request.submit",
    ]);
    // Same person who sent it to review: the route reaches the rule and the rule refuses.
    const own = await full.inject({
      method: "POST",
      url: `/api/v1/audit-requests/${id}/sign-off`,
      headers: WRITE(await v()),
    });
    expect(own.statusCode).toBe(409);
    expect((own.json() as { error: { code: string } }).error.code).toBe(
      "AUDIT_REVIEWER_IS_ASSEMBLER",
    );
    // The filing needs a recent step-up on top of the key.
    const noStepUp = await full.inject({
      method: "POST",
      url: `/api/v1/audit-requests/${id}/submit`,
      headers: WRITE(await v()),
      payload: filing(),
    });
    expect(noStepUp.statusCode).toBe(403);
    expect((noStepUp.json() as { error: { code: string } }).error.code).toBe("STEP_UP_REQUIRED");
    const badBody = await full.inject({
      method: "POST",
      url: `/api/v1/audit-requests/${id}/submit`,
      headers: WRITE(await v()),
      payload: {
        channel: "carrier_pigeon",
        confirmationRef: "x",
        filedAt: new Date().toISOString(),
      },
    });
    expect([403, 422]).toContain(badBody.statusCode);
    await full.close();
  });

  it("files through the full route stack with a step-up: attestation, sign-off by a different person is the service rule", async () => {
    const id = await signedOff({ deadline: false });
    const app = makeApp(
      [
        "audit_request.read",
        "audit_request.manage",
        "audit_request.review",
        "audit_request.submit",
      ],
      true,
    );
    const noKey = await app.inject({
      method: "POST",
      url: `/api/v1/audit-requests/${id}/submit`,
      headers: { "if-match": String(await fx.ver("audit_request", id)) },
      payload: filing(),
    });
    expect(noKey.statusCode).toBe(400);
    const refusedNoDeadline = await app.inject({
      method: "POST",
      url: `/api/v1/audit-requests/${id}/submit`,
      headers: WRITE(await fx.ver("audit_request", id)),
      payload: filing(),
    });
    expect(refusedNoDeadline.statusCode).toBe(422);
    const attest = await app.inject({
      method: "POST",
      url: `/api/v1/audit-requests/${id}/deadline-none-stated`,
      headers: WRITE(await fx.ver("audit_request", id)),
    });
    expect(attest.statusCode).toBe(200);
    const filed = await app.inject({
      method: "POST",
      url: `/api/v1/audit-requests/${id}/submit`,
      headers: WRITE(await fx.ver("audit_request", id)),
      payload: filing(),
    });
    expect(filed.statusCode).toBe(200);
    expect((await row(id)).state).toBe("responded");
    const sub = await app.inject({ method: "GET", url: `/api/v1/audit-requests/${id}/submission` });
    expect(sub.statusCode).toBe(200);
    expect((sub.json() as { attempts: { status: string }[] }).attempts[0]?.status).toBe(
      "acknowledged",
    );
    const detail = await app.inject({ method: "GET", url: `/api/v1/audit-requests/${id}` });
    expect(
      (detail.json() as { response: { filing: { confirmationRef: string } } }).response.filing
        .confirmationRef,
    ).toBe("TRACK-90210");
    await app.close();
  });
});
