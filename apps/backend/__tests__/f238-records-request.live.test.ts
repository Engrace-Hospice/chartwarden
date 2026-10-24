/**
 * F-238 step 4 — LIVE Postgres proof of the records-request workflow, as the NOBYPASSRLS `chartwarden_app` role,
 * with the REAL M6 ReferralReader and M5 PatientReader behind the identity ports.
 *
 * 1. Outbound: a request for a referral gets a valid, per-org-unique code; its audit row scrubs the
 *    recipient and free text; another tenant sees nothing (FORCEd RLS) and cannot write into this one.
 * 2. Inbound by FAX: an UNFILED batch whose first page carries the cover sheet's code (as OCR misread it)
 *    is filed under the request's referral, linked, the request moves to `received` — and the identity
 *    check then runs against that referral's prospect (it ran AFTER the link: not `no_target`).
 * 3. Inbound by E-MAIL: the code in the subject (source metadata) does the same.
 * 4. A batch already filed under ANOTHER referral is NOT re-filed: the job summary carries the warning and
 *    neither the batch nor the request changes.
 * 5. Another tenant's code, and a cancelled request's code, file nothing.
 * 6. Manual link at upload (the route's service): the batch is linked and the request received.
 * 7. Outbound FAX (migration 0315): the cover-sheet PDF goes through the outbound-fax port (stub); the
 *    attempt is recorded and settled under RLS, its audit rows scrub the number, the send is idempotent per
 *    request (replay / 409 on another number / one dial for two concurrent clicks), a stale `sending` row is
 *    settled `failed` so a retry can send, and another tenant sees no send.
 * 9. Expiry (migration 0314): the hourly sweep's per-org write (app role, org-explicit) expires only
 *    unanswered requests past `expires_on`; an expired request's code STILL files a returned fax
 *    (received, flagged after expiry, `expired_at` kept); extending re-opens one.
 * 10. (0314) A code naming another referral is PERSISTED on the batch and surfaces through the referral's
 *    batch list, the review queue and the workspace; relinking the batch to that request's referral links
 *    it, receives the request and clears the conflict.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:f238:records-request:live
 */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { isValidRecordsRequestCode } from "@chartwarden/intake-extraction";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { siteDisplayForOrg } from "../src/bootstrap/site-display-for-org";
import {
  createDrizzlePatientReaderStore,
  createPatientReader,
} from "../src/modules/05-patient/index";
import { createReferralReader } from "../src/modules/06-admission/seams/drizzle-store";
import {
  type DocLensClassifierPort,
  type DocLensExtractorPort,
  type IdentityTargetPorts,
  type OutboundFaxTransport,
  createCandidateValueCipher,
  createDbDocumentBackend,
  createDbRecordsRequestFaxStore,
  createDbRecordsRequestService,
  createReviewWorkspaceService,
  createStubOutboundFaxTransport,
  expireRecordsRequestsForOrg,
  renderRecordsRequestCoverSheetPdf,
  runDocLensIntake,
  sendRecordsRequestFax,
} from "../src/modules/22-documents/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";

const block = (text: string, y: number) => ({
  text,
  bbox: [40, y, 400, y + 14] as [number, number, number, number],
  label: "text",
});
/** A returned fax: our cover sheet on top (code as `codeOnPage`), then the prospect's transfer record. */
const faxPages = (codeOnPage: string | null) => [
  {
    page: 1,
    width: 612,
    height: 792,
    blocks: [
      { ...block("REQUEST FOR MEDICAL RECORDS", 50), label: "section_header" },
      block(codeOnPage ? `Request code ${codeOnPage}` : "Fax from Riverbend Family Medicine", 90),
      block("Please include this cover sheet on top of your fax", 110),
    ],
  },
  {
    page: 2,
    width: 612,
    height: 792,
    blocks: [
      { ...block("TRANSFER RECORD", 50), label: "section_header" },
      block("Patient: DOCLENS, ARTHUR", 90),
      block("DOB: 03/02/1941", 110),
    ],
  },
];

const classifier: DocLensClassifierPort = {
  classify: async (i) => ({
    available: true,
    invocationId: `cls-${i.pageNumber}`,
    documentType: (i.pageNumber === 2 ? "transfer_record" : "unknown") as never,
    confidence: 0.95,
  }),
};
const f = (page: number, value: string, quote: string) => ({
  value,
  confidence: 0.95,
  sourceQuote: { page, text: quote },
});
const extractor: DocLensExtractorPort = {
  extract: async (i) => {
    const page = i.pages?.[0]?.page ?? 0;
    const fields =
      page === 2
        ? {
            "patient.legalLastName": f(2, "DOCLENS", "Patient: DOCLENS, ARTHUR"),
            "patient.legalFirstName": f(2, "ARTHUR", "Patient: DOCLENS, ARTHUR"),
            "patient.dateOfBirth": f(2, "03/02/1941", "DOB: 03/02/1941"),
          }
        : {};
    return { available: true, invocationId: `ext-${page}`, fields: fields as never };
  },
};

/** What a degraded fax OCR reads: every D as 0 and every T as 1 (both outside the code alphabet). */
const ocrMangle = (code: string) =>
  `rr ${code.slice(3).replace(/D/g, "0").replace(/T/g, "1").toLowerCase()}`;

describe.skipIf(!DB_URL)("F-238 — records request: outbound code, inbound matching — LIVE", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let rr: ReturnType<typeof createDbRecordsRequestService>;
  let docs: ReturnType<typeof createDbDocumentBackend>["service"];
  let ports: IdentityTargetPorts;
  let membership: string;
  let actor: { userId: string; membershipId: string };
  let referral: string;
  let otherReferral: string;
  let otherOrgReferral: string;
  const dek = randomBytes(32);
  const cipher = createCandidateValueCipher({
    dekForOrg: async () => ({ version: "v1", key: dek }),
    dekForOrgVersion: async (_o: string, version: string) => ({ version, key: dek }),
  });

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
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }
  async function seedBatch(to: { referralId: string | null; sourceMetadata?: string }) {
    const doc = (
      await admin.query(
        `INSERT INTO document (organization_id, patient_id, retention_class, source_kind, aggregate_type,
           title, created_by_membership_id)
         VALUES ($1,NULL,'intake_artifact','fax_ingest','other','Returned records',$2) RETURNING id`,
        [ORG, membership],
      )
    ).rows[0].id as string;
    const v = (
      await admin.query(
        `INSERT INTO document_version (organization_id, document_id, version_number, minio_object_key,
           mime_type, byte_size, sha256_hex, uploaded_by_kind)
         VALUES ($1,$2,'1',$3,'application/pdf','1','abc','system') RETURNING id`,
        [ORG, doc, `uploads/${doc}/v1`],
      )
    ).rows[0].id as string;
    await admin.query("UPDATE document SET active_version_id=$1 WHERE id=$2", [v, doc]);
    return (
      await admin.query(
        `INSERT INTO intake_upload_batch (organization_id, referral_id, initial_document_id, source_channel,
           source_metadata, uploaded_by_membership_id, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,gen_random_uuid()) RETURNING id`,
        [
          ORG,
          to.referralId,
          doc,
          to.sourceMetadata ? "email_ingest" : "fax",
          to.sourceMetadata ?? null,
          membership,
        ],
      )
    ).rows[0].id as string;
  }
  const run = (batchId: string, codeOnPage: string | null) =>
    runDocLensIntake(
      {
        db: handle.db,
        docling: {
          parse: async () => ({ doclingVersion: "2.133.0", pages: faxPages(codeOnPage) as never }),
          render: async () => {
            throw new Error("no render in this suite");
          },
        },
        presignSource: async () => "https://minio.invalid/x?sig",
        cipher,
        classifier: () => classifier,
        extractor: () => extractor,
        identityTargets: ports,
      },
      { organizationId: ORG, batchId, actorUserId: USER, correlationId: "f238-rr" },
    );
  const batchRow = async (id: string) =>
    (
      await admin.query(
        "SELECT referral_id, records_request_id, identity_status FROM intake_upload_batch WHERE id=$1",
        [id],
      )
    ).rows[0] as {
      referral_id: string | null;
      records_request_id: string | null;
      identity_status: string | null;
    };
  const requestStatus = async (id: string) =>
    (await admin.query("SELECT status, received_at FROM intake_records_request WHERE id=$1", [id]))
      .rows[0] as { status: string; received_at: Date | null };
  const newRequest = (
    referralId: string,
    org = ORG,
    who = actor,
    dates: { dueDate?: string; expiresOn?: string } = { dueDate: "2026-10-11" },
  ) =>
    rr.create(
      org,
      who,
      { referralId, patientId: null },
      {
        recipientName: "Dr. Pell",
        recipientOrganization: "Riverbend Family Medicine",
        recipientFax: "(503) 555-0100",
        recordsRequested: ["history_and_physical", "labs"],
        recordsRequestedNote: "Oncology notes for Arthur since 2025",
        ...dates,
      },
    );

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    for (const [id, slug] of [
      [ORG, "org-a"],
      [OTHER_ORG, "org-b"],
    ])
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [id, slug],
      );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f238rr@x.test')`, [USER]);
    membership = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG],
      )
    ).rows[0].id as string;
    actor = { userId: USER, membershipId: membership };
    const mkReferral = async (org: string, name: string, dob: string) =>
      (
        await admin.query(
          `INSERT INTO referral (organization_id, patient_name_at_receipt, patient_dob_at_receipt, source_channel)
           VALUES ($1,$2,$3,'fax') RETURNING id`,
          [org, name, dob],
        )
      ).rows[0].id as string;
    referral = await mkReferral(ORG, "DOCLENS, ARTHUR", "1941-03-02");
    otherReferral = await mkReferral(ORG, "VANCE, ADA", "1950-11-19");
    otherOrgReferral = await mkReferral(OTHER_ORG, "SOMEONE, ELSE", "1950-01-01");

    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    rr = createDbRecordsRequestService(handle.db);
    docs = createDbDocumentBackend(handle.db, { cipher }).service;
    const patients = createPatientReader(createDrizzlePatientReaderStore(handle.db));
    const referrals = createReferralReader(handle.db);
    ports = {
      async patient(organizationId, patientId) {
        const p = await patients.findById({ organizationId, id: patientId });
        return p
          ? { lastName: p.lastName, firstName: p.firstName, dateOfBirth: p.dateOfBirth }
          : null;
      },
      async referral(organizationId, referralId) {
        const r = await referrals.getReferralSubject({
          organizationId,
          referralId: referralId as never,
        });
        return r
          ? {
              patientId: r.patientId,
              patientNameAtReceipt: r.patientNameAtReceipt,
              patientDobAtReceipt: r.patientDobAtReceipt,
            }
          : null;
      },
    };
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("creates a request with a valid code; the audit row scrubs recipient + free text", async () => {
    const req = await newRequest(referral);
    expect(isValidRecordsRequestCode(req.requestCode)).toBe(true);
    expect(req).toMatchObject({ referralId: referral, status: "requested", batches: 0 });
    const audit = (
      await admin.query(
        "SELECT actor_user_id, after FROM audit_event WHERE resource_kind='intake_records_request' AND resource_id=$1",
        [req.id],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_user_id).toBe(USER);
    const after = JSON.stringify(audit[0].after);
    for (const leaked of ["Pell", "Riverbend", "555-0100", "Oncology", "Arthur"])
      expect(after).not.toContain(leaked);
    // Structural fields stay readable for the audit trail.
    expect(audit[0].after.request_code).toBe(req.requestCode);
    expect(audit[0].after.status).toBe("requested");
  });

  it("is invisible to another tenant and cannot be written into this one (FORCEd RLS, app role)", async () => {
    const req = await newRequest(referral);
    const app = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await app.connect();
    try {
      await app.query("SELECT set_config('app.org_id', $1, false)", [OTHER_ORG]);
      expect(
        (await app.query("SELECT id FROM intake_records_request WHERE id=$1", [req.id])).rows,
      ).toHaveLength(0);
      await expect(
        app.query(
          `INSERT INTO intake_records_request (organization_id, referral_id, request_code, recipient_name,
             recipient_fax, records_requested, requested_by_membership_id, correlation_id)
           VALUES ($1,$2,'RR-AAAAAAA','x','5550100','[]',$3,'c')`,
          [ORG, referral, membership],
        ),
      ).rejects.toThrow(/row-level security/);
      await app.query("SELECT set_config('app.org_id', $1, false)", [ORG]);
      expect(
        (await app.query("SELECT id FROM intake_records_request WHERE id=$1", [req.id])).rows,
      ).toHaveLength(1);
      // No DELETE grant: a request is cancelled, never erased.
      await expect(
        app.query("DELETE FROM intake_records_request WHERE id=$1", [req.id]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
    expect((await rr.listForReferral(OTHER_ORG, referral)).length).toBe(0);
  });

  it("a returned FAX with the (OCR-mangled) code files an unfiled batch under the referral, BEFORE the identity check", async () => {
    // A code containing D and T so the mangling really substitutes characters outside the alphabet.
    let req = await newRequest(referral);
    for (let i = 0; i < 200 && !/[DT]/.test(req.requestCode.slice(3)); i++)
      req = await newRequest(referral);
    expect(req.requestCode.slice(3)).toMatch(/[DT]/);
    const batch = await seedBatch({ referralId: null });
    const summary = await run(batch, ocrMangle(req.requestCode));
    expect(summary).toMatchObject({
      outcome: "extracted",
      recordsRequest: {
        outcome: "linked",
        code: req.requestCode,
        recordsRequestId: req.id,
        referralId: referral,
        filed: true,
      },
    });
    // The identity check ran against the referral's prospect — it would be `no_target` had it run first.
    expect((summary as { identity: string }).identity).not.toBe("no_target");
    expect(await batchRow(batch)).toMatchObject({
      referral_id: referral,
      records_request_id: req.id,
    });
    expect((await batchRow(batch)).identity_status).not.toBe("no_target");
    const transfer = (
      await admin.query(
        "SELECT identity_status FROM classified_page WHERE intake_upload_batch_id=$1 AND page_range_start=2",
        [batch],
      )
    ).rows[0] as { identity_status: string };
    expect(transfer.identity_status).toBe("match");
    const st = await requestStatus(req.id);
    expect(st.status).toBe("received");
    expect(st.received_at).not.toBeNull();
    expect((await rr.get(ORG, referral, req.id)).batches).toBe(1);
  });

  it("an e-mail whose SUBJECT carries the code is filed the same way", async () => {
    const req = await newRequest(referral);
    const batch = await seedBatch({
      referralId: null,
      sourceMetadata: JSON.stringify({ subject: `Re: Records request ${req.requestCode}` }),
    });
    const summary = await run(batch, null);
    expect(summary).toMatchObject({
      recordsRequest: { outcome: "linked", recordsRequestId: req.id, filed: true },
    });
    expect(await batchRow(batch)).toMatchObject({
      referral_id: referral,
      records_request_id: req.id,
    });
    expect((await requestStatus(req.id)).status).toBe("received");
  });

  it("a batch already filed under ANOTHER referral is never re-filed: a warning, nothing moves", async () => {
    const req = await newRequest(referral);
    const batch = await seedBatch({ referralId: otherReferral });
    const summary = await run(batch, req.requestCode);
    expect(summary).toMatchObject({
      recordsRequest: {
        outcome: "conflict",
        warning: "code_names_another_referral",
        recordsRequestId: req.id,
      },
    });
    expect(await batchRow(batch)).toMatchObject({
      referral_id: otherReferral,
      records_request_id: null,
    });
    expect((await requestStatus(req.id)).status).toBe("requested");
  });

  it("another tenant's code, and a cancelled request's code, file nothing", async () => {
    // The other org's request (seeded as admin — the app role cannot write another org's row).
    const otherMembership = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, OTHER_ORG],
      )
    ).rows[0].id as string;
    const foreign = await newRequest(otherOrgReferral, OTHER_ORG, {
      userId: USER,
      membershipId: otherMembership,
    });
    const b1 = await seedBatch({ referralId: null });
    expect(await run(b1, foreign.requestCode)).toMatchObject({
      recordsRequest: { outcome: "unknown_code" },
    });
    expect(await batchRow(b1)).toMatchObject({ referral_id: null, records_request_id: null });

    const cancelled = await newRequest(referral);
    await rr.cancel(ORG, actor, referral, cancelled.id, "duplicate request");
    const b2 = await seedBatch({ referralId: null });
    expect(await run(b2, cancelled.requestCode)).toMatchObject({
      recordsRequest: { outcome: "cancelled_request" },
    });
    expect(await batchRow(b2)).toMatchObject({ referral_id: null, records_request_id: null });
    // The cancel reason is audit-denylisted.
    const audit = (
      await admin.query(
        "SELECT after FROM audit_event WHERE resource_kind='intake_records_request' AND resource_id=$1 AND event_type='intake_records_request.update'",
        [cancelled.id],
      )
    ).rows[0]?.after as Record<string, unknown>;
    expect(audit.status).toBe("cancelled");
    expect(JSON.stringify(audit)).not.toContain("duplicate request");
  });

  it("a manual link at upload files the batch and receives the request in one transaction", async () => {
    const req = await newRequest(referral);
    const view = await docs.uploadBatch(ORG, actor, {
      patientId: null,
      referralId: referral,
      recordsRequestId: req.id,
      sourceChannel: "fax",
    });
    expect(view).toMatchObject({ referralId: referral, recordsRequestId: req.id });
    expect(await batchRow(view.id)).toMatchObject({ records_request_id: req.id });
    expect((await requestStatus(req.id)).status).toBe("received");
    // A later run of the job does not link twice.
    expect((await rr.listForReferral(ORG, referral)).find((r) => r.id === req.id)?.batches).toBe(1);
  });

  describe("outbound fax (0315)", () => {
    const render = async (req: Awaited<ReturnType<typeof newRequest>>, faxTo?: string) =>
      renderRecordsRequestCoverSheetPdf(
        req,
        { displayName: "DOCLENS, ARTHUR", dateOfBirth: "1941-03-02" },
        {
          fromOrganization: (await siteDisplayForOrg(handle.db, ORG, [])).organizationName,
          faxTo,
        },
      );
    const faxDeps = (transport: OutboundFaxTransport) => ({
      store: createDbRecordsRequestFaxStore(handle.db),
      transport,
    });
    const faxRows = async (requestId: string) =>
      (
        await admin.query(
          `SELECT id, status, fax_number, provider, provider_message_id, page_count, document_sha256,
                  failure_reason, sent_by_membership_id, sent_at, failed_at
             FROM intake_records_request_fax WHERE records_request_id=$1 ORDER BY attempted_at`,
          [requestId],
        )
      ).rows;

    it("sends the cover-sheet PDF, records the attempt, and its audit rows scrub the number", async () => {
      const req = await newRequest(referral);
      const transport = createStubOutboundFaxTransport({ log: () => {} });
      const doc = await render(req, "(503) 555-0100");
      const res = await sendRecordsRequestFax(faxDeps(transport), ORG, actor, {
        request: req,
        faxNumber: "+15035550100",
        document: doc,
      });
      expect(res.replayed).toBe(false);
      expect(res.fax).toMatchObject({ status: "sent", provider: "stub", pageCount: 2 });
      const rows = await faxRows(req.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: "sent",
        fax_number: "+15035550100",
        provider: "stub",
        provider_message_id: res.fax.providerMessageId,
        page_count: 2,
        document_sha256: doc.sha256,
        sent_by_membership_id: membership,
      });
      expect(
        Buffer.from(transport.sent[0]?.documents[0]?.bytes ?? []).toString("latin1"),
      ).toContain(`(${req.requestCode}) Tj`);
      // The org's display name is the "From" line.
      expect(Buffer.from(doc.bytes).toString("latin1")).toContain("(org-a) Tj");
      const audit = (
        await admin.query(
          "SELECT event_type, actor_user_id, after FROM audit_event WHERE resource_kind='intake_records_request_fax' AND resource_id=$1 ORDER BY created_at, event_type",
          [rows[0].id],
        )
      ).rows;
      expect(audit.map((a) => a.event_type).sort()).toEqual([
        "intake_records_request_fax.insert",
        "intake_records_request_fax.update",
      ]);
      for (const a of audit) {
        expect(a.actor_user_id).toBe(USER);
        expect(JSON.stringify(a.after)).not.toContain("5035550100");
      }
      expect(audit.find((a) => a.event_type.endsWith("update"))?.after.status).toBe("sent");
    });

    it("is idempotent per request: a replay, a 409 for another number, ONE dial for two concurrent sends", async () => {
      const req = await newRequest(referral);
      const transport = createStubOutboundFaxTransport({ log: () => {} });
      const doc = await render(req);
      const go = (faxNumber: string, t: OutboundFaxTransport = transport) =>
        sendRecordsRequestFax(faxDeps(t), ORG, actor, { request: req, faxNumber, document: doc });
      const first = await go("+15035550100");
      const again = await go("+15035550100");
      expect(again).toMatchObject({ replayed: true, fax: { id: first.fax.id } });
      await expect(go("+15035550199")).rejects.toMatchObject({
        code: "RECORDS_REQUEST_FAX_ALREADY_SENT",
      });
      expect(transport.sent).toHaveLength(1);

      // Two clicks at once on a fresh request: the partial unique index lets exactly one dial.
      const req2 = await newRequest(referral);
      const doc2 = await render(req2);
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const slow = createStubOutboundFaxTransport({ log: () => {} });
      const slowSend: OutboundFaxTransport = {
        ...slow,
        async send(r) {
          await gate;
          return slow.send(r);
        },
      };
      const both = Promise.allSettled([
        sendRecordsRequestFax(faxDeps(slowSend), ORG, actor, {
          request: req2,
          faxNumber: "+15035550100",
          document: doc2,
        }),
        new Promise((r) => setTimeout(r, 150)).then(() =>
          sendRecordsRequestFax(faxDeps(slowSend), ORG, actor, {
            request: req2,
            faxNumber: "+15035550100",
            document: doc2,
          }),
        ),
      ]);
      setTimeout(() => release(), 400);
      const [a, b] = await both;
      expect(a.status).toBe("fulfilled");
      expect(b).toMatchObject({
        status: "rejected",
        reason: { code: "RECORDS_REQUEST_FAX_IN_PROGRESS" },
      });
      expect(slow.sent).toHaveLength(1);
      expect(await faxRows(req2.id)).toHaveLength(1);
    });

    it("a refusal is recorded failed; a stale `sending` row is settled failed so a retry can send", async () => {
      const req = await newRequest(referral);
      const doc = await render(req);
      const refusing = createStubOutboundFaxTransport({ log: () => {}, fail: () => "no answer" });
      const failed = await sendRecordsRequestFax(faxDeps(refusing), ORG, actor, {
        request: req,
        faxNumber: "+15035550100",
        document: doc,
      });
      expect(failed.fax).toMatchObject({ status: "failed", failureReason: "no answer" });
      // A crashed attempt: `sending` an hour ago, never settled.
      await admin.query(
        `INSERT INTO intake_records_request_fax (organization_id, records_request_id, referral_id, fax_number,
           status, provider, page_count, document_sha256, sent_by_membership_id, attempted_at, correlation_id)
         VALUES ($1,$2,$3,'+15035550100','sending','stub',2,$4,$5, now() - interval '1 hour', 'crashed')`,
        [ORG, req.id, referral, doc.sha256, membership],
      );
      const ok = createStubOutboundFaxTransport({ log: () => {} });
      const retried = await sendRecordsRequestFax(faxDeps(ok), ORG, actor, {
        request: req,
        faxNumber: "+15035550100",
        document: doc,
      });
      expect(retried).toMatchObject({ replayed: false, fax: { status: "sent" } });
      const rows = await faxRows(req.id);
      // By attempt time: the crashed attempt (an hour ago), the refusal, the retry.
      expect(rows.map((r) => r.status)).toEqual(["failed", "failed", "sent"]);
      expect(rows[0].failure_reason).toMatch(/^interrupted/);
      expect(rows[1].failure_reason).toBe("no answer");
      // The refusal text is audit-denylisted too.
      const audit = (
        await admin.query(
          "SELECT after FROM audit_event WHERE resource_kind='intake_records_request_fax' AND resource_id=$1 AND event_type='intake_records_request_fax.update'",
          [rows[1].id],
        )
      ).rows[0]?.after as Record<string, unknown>;
      expect(audit.status).toBe("failed");
      expect(JSON.stringify(audit)).not.toContain("no answer");
    });

    it("another tenant sees no send and cannot record one against this tenant's request (FORCEd RLS)", async () => {
      const req = await newRequest(referral);
      await sendRecordsRequestFax(
        faxDeps(createStubOutboundFaxTransport({ log: () => {} })),
        ORG,
        actor,
        { request: req, faxNumber: "+15035550100", document: await render(req) },
      );
      const store = createDbRecordsRequestFaxStore(handle.db);
      expect((await store.latestForRequests(OTHER_ORG, [req.id])).size).toBe(0);
      expect((await store.latestForRequests(ORG, [req.id])).get(req.id)?.status).toBe("sent");
      const app = new Client({ connectionString: appRoleUrl(DB_URL as string) });
      await app.connect();
      try {
        await app.query("BEGIN");
        await app.query("SELECT set_config('app.org_id', $1, true)", [OTHER_ORG]);
        const seen = await app.query(
          "SELECT count(*)::int AS n FROM intake_records_request_fax WHERE records_request_id=$1",
          [req.id],
        );
        expect(seen.rows[0].n).toBe(0);
        await expect(
          app.query(
            `INSERT INTO intake_records_request_fax (organization_id, records_request_id, referral_id,
               fax_number, provider, page_count, document_sha256, sent_by_membership_id, correlation_id)
             VALUES ($1,$2,$3,'+15035550100','stub',1,$4,$5,'x')`,
            [ORG, req.id, referral, "0".repeat(64), membership],
          ),
        ).rejects.toThrow(/row-level security/);
        await app.query("ROLLBACK");
      } finally {
        await app.end();
      }
    });
  });

  // ── 9. expiry (0314) ──────────────────────────────────────────────────────────────────────────────
  it("the sweep's per-org write expires only unanswered requests past expires_on (app role, audited)", async () => {
    const stale = await newRequest(referral, ORG, actor, { expiresOn: "2020-01-02" });
    const fresh = await newRequest(referral);
    // Default: 30 days after the due date (or after today once that has passed) — in the future.
    expect((fresh.expiresOn ?? "") > new Date().toISOString().slice(0, 10)).toBe(true);
    const partial = await newRequest(referral, ORG, actor, { expiresOn: "2020-01-02" });
    await rr.mark(ORG, actor, referral, partial.id, "partially_received");
    // Another org's sweep touches nothing here.
    expect(await expireRecordsRequestsForOrg(handle.db, OTHER_ORG)).toBe(0);
    expect((await requestStatus(stale.id)).status).toBe("requested");

    expect(await expireRecordsRequestsForOrg(handle.db, ORG)).toBeGreaterThanOrEqual(1);
    const view = await rr.get(ORG, referral, stale.id);
    expect(view).toMatchObject({ status: "expired", expiresOn: "2020-01-02" });
    expect(view.expiredAt).toBeTruthy();
    expect((await rr.get(ORG, referral, fresh.id)).status).toBe("requested");
    expect((await rr.get(ORG, referral, partial.id)).status).toBe("partially_received");
    // A second tick leaves an already-expired row alone.
    await expireRecordsRequestsForOrg(handle.db, ORG);
    expect((await rr.get(ORG, referral, stale.id)).expiredAt).toBe(view.expiredAt);
    // Audited as a system write (no acting user).
    const audit = (
      await admin.query(
        `SELECT actor_user_id, after FROM audit_event WHERE resource_kind='intake_records_request'
           AND resource_id=$1 AND event_type='intake_records_request.update'`,
        [stale.id],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_user_id).toBeNull();
    expect(audit[0].after.status).toBe("expired");
    // The CHECK keeps an expired row stamped.
    await expect(
      admin.query("UPDATE intake_records_request SET expired_at=NULL WHERE id=$1", [stale.id]),
    ).rejects.toThrow(/intake_records_request_expired_shape/);
  });

  it("an EXPIRED request's code still files a returned fax — received, flagged after expiry", async () => {
    const req = await newRequest(referral, ORG, actor, { expiresOn: "2020-01-02" });
    await expireRecordsRequestsForOrg(handle.db, ORG);
    expect((await requestStatus(req.id)).status).toBe("expired");
    const batch = await seedBatch({ referralId: null });
    const summary = await run(batch, req.requestCode);
    expect(summary).toMatchObject({
      recordsRequest: {
        outcome: "linked",
        recordsRequestId: req.id,
        filed: true,
        afterExpiry: true,
      },
    });
    expect(await batchRow(batch)).toMatchObject({
      referral_id: referral,
      records_request_id: req.id,
    });
    const view = await rr.get(ORG, referral, req.id);
    expect(view).toMatchObject({ status: "received", receivedAfterExpiry: true, batches: 1 });
    expect(view.expiredAt).toBeTruthy();
  });

  it("extending an expired request re-opens it (same code); a received one cannot be extended", async () => {
    const req = await newRequest(referral, ORG, actor, { expiresOn: "2020-01-02" });
    await expireRecordsRequestsForOrg(handle.db, ORG);
    const reopened = await rr.extend(ORG, actor, referral, req.id, { expiresOn: "2099-12-31" });
    expect(reopened).toMatchObject({
      status: "requested",
      expiresOn: "2099-12-31",
      expiredAt: null,
      requestCode: req.requestCode,
    });
    await rr.mark(ORG, actor, referral, req.id, "received");
    await expect(
      rr.extend(ORG, actor, referral, req.id, { expiresOn: "2099-12-31" }),
    ).rejects.toMatchObject({ code: "RECORDS_REQUEST_NOT_EXTENDABLE" });
  });

  // ── 10. conflict persisted (0314) ─────────────────────────────────────────────────────────────────
  it("a code naming another referral is persisted on the batch and surfaces on every screen; relinking there resolves it", async () => {
    const req = await newRequest(referral);
    const batch = await seedBatch({ referralId: otherReferral });
    expect(await run(batch, req.requestCode)).toMatchObject({
      recordsRequest: { outcome: "conflict", warning: "code_names_another_referral" },
    });
    const conflictRow = async () =>
      (
        await admin.query(
          `SELECT referral_id, records_request_id, records_request_conflict_id, records_request_conflict_kind
             FROM intake_upload_batch WHERE id=$1`,
          [batch],
        )
      ).rows[0];
    expect(await conflictRow()).toEqual({
      referral_id: otherReferral,
      records_request_id: null,
      records_request_conflict_id: req.id,
      records_request_conflict_kind: "code_names_another_referral",
    });
    const expected = { code: req.requestCode, kind: "code_names_another_referral" };

    // The referral the batch IS filed under shows the warning on the batch row …
    const page = await docs.listReferralBatches(ORG, otherReferral, undefined, 50);
    expect(page.items.find((b) => b.id === batch)?.recordsRequestConflict).toEqual(expected);
    // … and the review queue + workspace carry it (code + kind only), as the app role.
    const ws = createReviewWorkspaceService({
      db: handle.db,
      cipher,
      identity: { ports, canAccessReferral: async () => true },
    });
    const queue = await ws.listQueue(ORG, { view: "open", limit: 200 });
    expect(queue.items.find((q) => q.id === batch)?.recordsRequestConflict).toEqual(expected);
    expect((await ws.getWorkspace(ORG, batch, membership)).batch.recordsRequestConflict).toEqual(
      expected,
    );
    // Another tenant cannot see the batch at all.
    expect(
      (await ws.listQueue(OTHER_ORG, { view: "open", limit: 200 })).items.find(
        (q) => q.id === batch,
      ),
    ).toBeUndefined();

    // Relinking to a THIRD referral keeps the warning …
    const third = (
      await admin.query(
        `INSERT INTO referral (organization_id, patient_name_at_receipt, patient_dob_at_receipt, source_channel)
         VALUES ($1,'THIRD, PERSON','1960-01-01','fax') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    await ws.relink(
      ORG,
      actor,
      batch,
      { patientId: null, referralId: third, reason: "filed under the wrong referral" },
      "f238-rr-relink-1",
    );
    expect((await ws.getWorkspace(ORG, batch, membership)).batch.recordsRequestConflict).toEqual(
      expected,
    );
    // … relinking to the request's referral links it, receives the request and clears the warning.
    await ws.relink(
      ORG,
      actor,
      batch,
      { patientId: null, referralId: referral, reason: "these answer our records request" },
      "f238-rr-relink-2",
    );
    expect(await conflictRow()).toEqual({
      referral_id: referral,
      records_request_id: req.id,
      records_request_conflict_id: null,
      records_request_conflict_kind: null,
    });
    expect((await requestStatus(req.id)).status).toBe("received");
    expect((await ws.getWorkspace(ORG, batch, membership)).batch.recordsRequestConflict).toBeNull();
  });
});
