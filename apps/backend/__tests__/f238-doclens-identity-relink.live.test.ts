/**
 * F-238 — LIVE Postgres proof that records land on the right PROSPECT, as the NOBYPASSRLS `wardenx_app` role,
 * with the REAL M6 ReferralReader and M5 PatientReader behind the identity ports.
 *
 * 1. A fax filed against an UNRESOLVED referral is checked against the name/DOB the referral was received
 *    with: the prospect's own document matches, another patient's page is a mismatch, a lab page with no
 *    identifiers is unverified — and the verdicts store FIELD names, never values.
 * 2. When M6 resolves the referral's patient, the workspace adopts it onto the batch and re-checks the
 *    documents against the chart patient.
 * 3. The review rules: completion is refused while a document may be another patient's; a field from a
 *    document marked `other_patient` cannot be approved, and one approved before the marking is never
 *    committed; the same-patient answer needs a reason (audit-denylisted).
 * 4. Relink: a fax misfiled under the wrong patient moves to the prospect's referral — history row,
 *    the source document follows, earlier resolutions are forgotten and the check re-runs; another
 *    tenant's referral is not found; a closed batch and a batch with a Part 2 detection refuse to move;
 *    the history is invisible to another tenant (RLS).
 * 5. The admission screen's "an address is waiting in intake review" read: counts + batch ids only (no value),
 *    excluding another patient's document, rejected candidates, completed reviews and other tenants.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:f238:doclens-identity-relink:live
 */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  M5_OUTBOX_EVENTS,
  buildM5IntakeSudPrivacyConsumer,
  createDrizzlePatientReaderStore,
  createPatientReader,
} from "../src/modules/05-patient/index";
import { createReferralReader } from "../src/modules/06-admission/seams/drizzle-store";
import {
  type DocLensClassifierPort,
  type DocLensExtractorPort,
  type IdentityTargetPorts,
  M22_OUTBOX_EVENTS,
  createCandidateValueCipher,
  createDbDocumentBackend,
  createPendingAddressService,
  createReviewWorkspaceService,
  runDocLensIntake,
} from "../src/modules/22-documents/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";

const block = (text: string, y: number) => ({
  text,
  bbox: [40, y, 400, y + 14] as [number, number, number, number],
  label: "text",
});
// Three documents: the prospect's transfer record, ANOTHER patient's H&P misfiled into the fax, a lab table.
const PAGES = [
  {
    page: 1,
    width: 612,
    height: 792,
    blocks: [
      { ...block("TRANSFER RECORD", 50), label: "section_header" },
      block("Patient: DOCLENS, ARTHUR", 90),
      block("DOB: 03/02/1941", 110),
      block("Home phone: (503) 555-0161", 130),
      block("Address: 12 Elm St, Salem", 150),
    ],
  },
  {
    page: 2,
    width: 612,
    height: 792,
    blocks: [
      { ...block("HISTORY AND PHYSICAL", 50), label: "section_header" },
      block("Patient: VANCE, ADA", 90),
      block("DOB: 11/19/1950", 110),
      block("Home phone: (503) 555-0199", 130),
      block("Address: 9 Oak Ave, Bend", 150),
    ],
  },
  {
    page: 3,
    width: 612,
    height: 792,
    blocks: [
      { ...block("LABORATORY RESULTS", 50), label: "section_header" },
      block("Sodium 134 mmol/L", 90),
    ],
  },
] as const;

const TYPE_OF: Record<number, string> = { 1: "transfer_record", 2: "hp", 3: "lab" };
const classifier: DocLensClassifierPort = {
  classify: async (i) => ({
    available: true,
    invocationId: `cls-${i.pageNumber}`,
    documentType: TYPE_OF[i.pageNumber ?? 0] as never,
    confidence: 0.95,
  }),
};
const f = (page: number, value: string, quote: string) => ({
  value,
  confidence: 0.95,
  sourceQuote: { page, text: quote },
});
// Off for the earlier cases (their candidate sets stay as they were); the pending-address case turns it on.
let extractAddress = false;
const address = (page: number) =>
  !extractAddress
    ? {}
    : page === 1
      ? {
          "patient.address.line1": f(1, "12 Elm St", "Address: 12 Elm St, Salem"),
          "patient.address.city": f(1, "Salem", "Address: 12 Elm St, Salem"),
        }
      : page === 2
        ? {
            "patient.address.line1": f(2, "9 Oak Ave", "Address: 9 Oak Ave, Bend"),
            "patient.address.city": f(2, "Bend", "Address: 9 Oak Ave, Bend"),
          }
        : {};
const extractor: DocLensExtractorPort = {
  extract: async (i) => {
    const page = i.pages?.[0]?.page ?? 0;
    const fields =
      page === 1
        ? {
            "patient.legalLastName": f(1, "DOCLENS", "Patient: DOCLENS, ARTHUR"),
            "patient.legalFirstName": f(1, "ARTHUR", "Patient: DOCLENS, ARTHUR"),
            "patient.dateOfBirth": f(1, "03/02/1941", "DOB: 03/02/1941"),
            "patient.phoneHome": f(1, "(503) 555-0161", "Home phone: (503) 555-0161"),
          }
        : page === 2
          ? {
              "patient.legalLastName": f(2, "VANCE", "Patient: VANCE, ADA"),
              "patient.legalFirstName": f(2, "ADA", "Patient: VANCE, ADA"),
              "patient.dateOfBirth": f(2, "11/19/1950", "DOB: 11/19/1950"),
              "patient.phoneHome": f(2, "(503) 555-0199", "Home phone: (503) 555-0199"),
            }
          : {};
    return {
      available: true,
      invocationId: `ext-${page}`,
      fields: { ...fields, ...address(page) } as never,
    };
  },
};

describe.skipIf(!DB_URL)(
  "F-238 — prospect records: referral link, identity check, relink — LIVE",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let svc: ReturnType<typeof createDbDocumentBackend>["service"];
    let workspace: ReturnType<typeof createReviewWorkspaceService>;
    let ports: IdentityTargetPorts;
    let m22Outbox: never;
    let dispatcher: ReturnType<typeof createOutboxDispatcher>;
    let membership: string;
    let actor: { userId: string; membershipId: string };
    let arthur: string;
    let mae: string;
    let referral: string;
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
      const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
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
    async function seedBatch(to: { patientId: string | null; referralId: string | null }) {
      const doc = (
        await admin.query(
          `INSERT INTO document (organization_id, patient_id, retention_class, source_kind, aggregate_type,
           title, created_by_membership_id)
         VALUES ($1,$2,'intake_artifact','fax_ingest','other','Older records',$3) RETURNING id`,
          [ORG, to.patientId, membership],
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
      const batch = (
        await admin.query(
          `INSERT INTO intake_upload_batch (organization_id, patient_id, referral_id, initial_document_id,
           source_channel, uploaded_by_membership_id, correlation_id)
         VALUES ($1,$2,$3,$4,'fax',$5,gen_random_uuid()) RETURNING id`,
          [ORG, to.patientId, to.referralId, doc, membership],
        )
      ).rows[0].id as string;
      return { batch, doc };
    }
    const run = (batchId: string) =>
      runDocLensIntake(
        {
          db: handle.db,
          docling: {
            parse: async () => ({ doclingVersion: "2.133.0", pages: PAGES as never }),
            render: async () => {
              throw new Error("no render in this suite");
            },
          },
          presignSource: async () => "https://minio.invalid/x?sig",
          cipher,
          classifier: () => classifier,
          extractor: () => extractor,
          outbox: m22Outbox,
          identityTargets: ports,
        },
        { organizationId: ORG, batchId, actorUserId: USER, correlationId: "f238-id" },
      );
    const docs = async (batchId: string) =>
      (
        await admin.query(
          `SELECT page_range_start AS p, identity_status AS s, identity_disagreeing AS d, identity_resolution AS r
           FROM classified_page WHERE intake_upload_batch_id=$1 ORDER BY 1`,
          [batchId],
        )
      ).rows as { p: number; s: string | null; d: string[] | null; r: string | null }[];
    const batchRow = async (batchId: string) =>
      (
        await admin.query(
          "SELECT patient_id, referral_id, identity_status FROM intake_upload_batch WHERE id=$1",
          [batchId],
        )
      ).rows[0] as {
        patient_id: string | null;
        referral_id: string | null;
        identity_status: string;
      };

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
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f238id@x.test')`, [USER]);
      membership = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [USER, ORG],
        )
      ).rows[0].id as string;
      actor = { userId: USER, membershipId: membership };
      const patient = async (mrn: string, first: string, last: string, dob: string) =>
        (
          await admin.query(
            `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
           VALUES ($1,$2,$3,$4,$5,'M','prospective') RETURNING id`,
            [ORG, mrn, first, last, dob],
          )
        ).rows[0].id as string;
      arthur = await patient("MRN-A", "Arthur", "Doclens", "1941-03-02");
      mae = await patient("MRN-M", "Mae", "Doclens", "1938-04-12");
      referral = (
        await admin.query(
          `INSERT INTO referral (organization_id, patient_name_at_receipt, patient_dob_at_receipt, source_channel)
         VALUES ($1,'DOCLENS, ARTHUR','1941-03-02','fax') RETURNING id`,
          [ORG],
        )
      ).rows[0].id as string;
      otherOrgReferral = (
        await admin.query(
          `INSERT INTO referral (organization_id, patient_name_at_receipt, patient_dob_at_receipt, source_channel)
         VALUES ($1,'SOMEONE, ELSE','1950-01-01','fax') RETURNING id`,
          [OTHER_ORG],
        )
      ).rows[0].id as string;

      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
      const catalog = buildBootOutboxCatalog([M5_OUTBOX_EVENTS, M22_OUTBOX_EVENTS]);
      const publisher = buildTxOutboxPublisher(catalog);
      const as = (callerModule: string) => ({
        publish: (tx: unknown, e: Parameters<typeof publisher.publish>[1]) =>
          publisher.publish(tx as never, { ...e, callerModule } as never),
      });
      m22Outbox = as("m22") as never;
      // The REAL M5 consumer behind the REAL dispatcher: the privacy flag must actually move.
      const orgs: ActiveOrgEnumerator = { listActiveOrgs: async () => [{ organizationId: ORG }] };
      dispatcher = createOutboxDispatcher({
        db: handle.db,
        orgs,
        consumers: [buildM5IntakeSudPrivacyConsumer({ db: handle.db, outbox: as("m5") as never })],
        eventCatalog: catalog,
        options: { log: () => {} },
      });
      svc = createDbDocumentBackend(handle.db, { outbox: m22Outbox, cipher }).service;

      // The REAL M5 / M6 readers (RLS-scoped, as wardenx_app) behind the identity ports.
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
      workspace = createReviewWorkspaceService({
        db: handle.db,
        cipher,
        outbox: m22Outbox,
        identity: {
          ports,
          canAccessReferral: (organizationId, userId, referralId) =>
            referrals.canAccessReferral({
              organizationId,
              userId,
              referralId: referralId as never,
            }),
        },
      });
    }, 240_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    let first: { batch: string; doc: string };

    it("checks every document against the UNRESOLVED referral's name/DOB — field names only, never values", async () => {
      first = await seedBatch({ patientId: null, referralId: referral });
      const summary = await run(first.batch);
      expect(summary).toMatchObject({ outcome: "extracted", identity: "mismatch" });
      expect(await docs(first.batch)).toEqual([
        { p: 1, s: "match", d: [], r: null },
        { p: 2, s: "mismatch", d: ["dateOfBirth", "lastName", "firstName"], r: null },
        { p: 3, s: "unverified", d: [], r: null },
      ]);
      expect(await batchRow(first.batch)).toEqual({
        patient_id: null,
        referral_id: referral,
        identity_status: "mismatch",
      });
      // No identity column carries a value.
      const raw = JSON.stringify(await docs(first.batch));
      expect(raw).not.toMatch(/VANCE|1950|DOCLENS/);
    });

    it("adopts the referral's patient once M6 resolves it, and re-checks against the chart patient", async () => {
      await admin.query(
        "UPDATE referral SET patient_id=$1, patient_resolution_status='matched' WHERE id=$2",
        [arthur, referral],
      );
      const ws = await workspace.getWorkspace(ORG, first.batch, membership);
      expect(ws.batch).toMatchObject({
        patientId: arthur,
        referralId: referral,
        identityStatus: "mismatch",
      });
      expect(ws.documents.map((d) => [d.pageFrom, d.identity.status])).toEqual([
        [1, "match"],
        [2, "mismatch"],
        [3, "unverified"],
      ]);
      expect((await batchRow(first.batch)).patient_id).toBe(arthur);
    });

    it("blocks completion until the other patient's document is resolved; its fields never reach the chart", async () => {
      const review = await svc.openReview(ORG, actor, first.batch);
      const ws = await workspace.getWorkspace(ORG, first.batch, membership);
      const phone = (page: number) =>
        ws.candidates.find((c) => c.page === page && c.fieldPath === "patient.phoneHome")
          ?.id as string;
      // Approved BEFORE anyone noticed the page belongs to someone else.
      await svc.recordDecision(ORG, actor, review.id, {
        candidateId: phone(2),
        decision: "approve",
      });
      await expect(svc.completeReview(ORG, actor, review.id)).rejects.toMatchObject({
        code: "IDENTITY_UNRESOLVED",
      });

      await expect(
        workspace.resolveIdentity(
          ORG,
          actor,
          first.batch,
          2,
          "other_patient",
          "Ada Vance's H&P, misfiled",
        ),
      ).resolves.toMatchObject({ identityStatus: "unverified" });
      // Once marked, a field on it cannot be approved.
      await expect(
        svc.recordDecision(ORG, actor, review.id, { candidateId: phone(2), decision: "approve" }),
      ).rejects.toMatchObject({ code: "DOCUMENT_IS_OTHER_PATIENT" });
      await svc.recordDecision(ORG, actor, review.id, {
        candidateId: phone(1),
        decision: "approve",
      });

      const done = await svc.completeReview(ORG, actor, review.id);
      expect(done.status).toBe("complete");
      // Only page 1's phone was committed; page 2's approval was excluded by the document's resolution.
      const committed = (
        await admin.query(
          "SELECT extraction_candidate_id FROM extraction_provenance WHERE organization_id=$1",
          [ORG],
        )
      ).rows.map((r) => r.extraction_candidate_id);
      expect(committed).toContain(phone(1));
      expect(committed).not.toContain(phone(2));
      // The resolution reason is audit-denylisted.
      const audit = (
        await admin.query(
          "SELECT after FROM audit_event WHERE resource_kind='classified_page' AND after->>'identity_resolution'='other_patient'",
        )
      ).rows[0]?.after as Record<string, unknown>;
      // (an UPDATE writes the trigger's `<changed>` marker in place of a denylisted value).
      expect(String(audit.identity_resolution_reason)).not.toContain("Vance");
      expect(JSON.stringify(audit)).not.toContain("misfiled");
    });

    it("a closed batch refuses to move", async () => {
      await expect(
        workspace.relink(
          ORG,
          actor,
          first.batch,
          { patientId: mae, referralId: null, reason: "testing a move" },
          "c1",
        ),
      ).rejects.toMatchObject({ code: "BATCH_CLOSED" });
    });

    it("moves a misfiled fax to the prospect's referral: history, the document follows, the check re-runs", async () => {
      // Arthur's older records, filed under Mae by mistake.
      const misfiled = await seedBatch({ patientId: mae, referralId: null });
      await run(misfiled.batch);
      expect((await docs(misfiled.batch)).map((d) => d.s)).toEqual([
        "mismatch",
        "mismatch",
        "unverified",
      ]);
      await workspace.resolveIdentity(
        ORG,
        actor,
        misfiled.batch,
        1,
        "same_patient",
        "accepting for now",
      );

      await expect(
        workspace.relink(
          ORG,
          actor,
          misfiled.batch,
          { patientId: null, referralId: otherOrgReferral, reason: "wrong tenant" },
          "c2",
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        workspace.relink(
          ORG,
          actor,
          misfiled.batch,
          { patientId: mae, referralId: referral, reason: "conflict" },
          "c3",
        ),
      ).rejects.toMatchObject({ code: "REFERRAL_PATIENT_CONFLICT" });

      const moved = await workspace.relink(
        ORG,
        actor,
        misfiled.batch,
        {
          patientId: null,
          referralId: referral,
          reason: "PCP records for Arthur, filed under Mae",
        },
        "c4",
      );
      expect(moved).toEqual({
        batchId: misfiled.batch,
        patientId: arthur,
        referralId: referral,
        identityStatus: "mismatch", // page 2 is still Ada Vance's
      });
      // Resolutions about the old target are forgotten.
      expect((await docs(misfiled.batch)).map((d) => [d.s, d.r])).toEqual([
        ["match", null],
        ["mismatch", null],
        ["unverified", null],
      ]);
      expect(
        (await admin.query("SELECT patient_id FROM document WHERE id=$1", [misfiled.doc])).rows[0]
          .patient_id,
      ).toBe(arthur);
      const hist = (
        await admin.query(
          "SELECT patient_id, from_patient_id, to_referral_id, relinked_by_membership_id FROM intake_batch_relink WHERE intake_upload_batch_id=$1",
          [misfiled.batch],
        )
      ).rows;
      expect(hist).toEqual([
        {
          patient_id: arthur,
          from_patient_id: mae,
          to_referral_id: referral,
          relinked_by_membership_id: membership,
        },
      ]);
      // The history is tenant-scoped (FORCEd RLS as wardenx_app): another org sees none of it.
      const app = new Client({ connectionString: appRoleUrl(DB_URL as string) });
      await app.connect();
      try {
        await app.query("SELECT set_config('app.org_id', $1, false)", [OTHER_ORG]);
        expect((await app.query("SELECT id FROM intake_batch_relink")).rows).toHaveLength(0);
        await app.query("SELECT set_config('app.org_id', $1, false)", [ORG]);
        expect((await app.query("SELECT id FROM intake_batch_relink")).rows).toHaveLength(1);
      } finally {
        await app.end();
      }
    });

    const sudFlags = async (patientId: string) =>
      (
        await admin.query(
          "SELECT flags, sud_flag_origin FROM patient_privacy_flag_snapshot WHERE patient_id=$1",
          [patientId],
        )
      ).rows[0] as { flags: string[]; sud_flag_origin: string | null } | undefined;
    const flagPatient = (patientId: string, origin: string) =>
      admin.query(
        `INSERT INTO patient_privacy_flag_snapshot (patient_id, organization_id, flags, sud_flag_origin)
         VALUES ($1,$2,'{sud}',$3)
         ON CONFLICT (patient_id) DO UPDATE SET flags='{sud}', sud_flag_origin=$3, invalidated_at=NULL`,
        [patientId, ORG, origin],
      );
    const relinkEvents = async (batch: string) =>
      (
        await admin.query(
          "SELECT payload FROM outbox_event WHERE event_type='m22.intake.sud_relinked' AND aggregate_id=$1",
          [batch],
        )
      ).rows.map((r) => r.payload);

    it("a fax with a Part 2 detection moves, and its privacy flag moves with it (M5)", async () => {
      await admin.query("DELETE FROM patient_privacy_flag_snapshot WHERE patient_id IN ($1,$2)", [
        mae,
        arthur,
      ]);
      // Close every earlier batch's detection so Mae's flag is held by this fax alone.
      await admin.query(
        `UPDATE intake_upload_batch SET sud_status='not_detected', sud_resolved_by_membership_id=NULL,
           sud_resolved_at=NULL, sud_resolution_reason=NULL WHERE organization_id=$1`,
        [ORG],
      );
      const flagged = await seedBatch({ patientId: mae, referralId: null });
      await admin.query("UPDATE intake_upload_batch SET sud_status='detected' WHERE id=$1", [
        flagged.batch,
      ]);
      await flagPatient(mae, "m22_intake_unconfirmed"); // what the detection did at intake
      const res = await workspace.relink(
        ORG,
        actor,
        flagged.batch,
        { patientId: arthur, referralId: null, reason: "Arthur's packet, filed under Mae" },
        "c5",
      );
      expect(res.patientId).toBe(arthur);
      expect(await relinkEvents(flagged.batch)).toEqual([
        expect.objectContaining({
          intakeBatchId: flagged.batch,
          fromPatientId: mae,
          toPatientId: arthur,
          sudStatus: "detected",
          fromPatientRetainsFlag: false,
          movedByMembershipId: membership,
        }),
      ]);
      // No snippet, term or reason rides on the event (Part 2: an outbox row is read by every consumer).
      expect(JSON.stringify(await relinkEvents(flagged.batch))).not.toMatch(/Arthur's packet/);
      await dispatcher.tick();
      expect(await sudFlags(arthur)).toEqual({
        flags: ["sud"],
        sud_flag_origin: "m22_intake_unconfirmed",
      });
      expect(await sudFlags(mae)).toEqual({ flags: [], sud_flag_origin: null });
    });

    it("the previous patient keeps the flag while another of their faxes still holds a detection", async () => {
      await admin.query("DELETE FROM patient_privacy_flag_snapshot WHERE patient_id IN ($1,$2)", [
        mae,
        arthur,
      ]);
      const keeps = await seedBatch({ patientId: mae, referralId: null });
      const moving = await seedBatch({ patientId: mae, referralId: null });
      await admin.query(
        `UPDATE intake_upload_batch SET sud_status='confirmed', sud_resolved_by_membership_id=$2,
           sud_resolved_at=now(), sud_resolution_reason='confirmed in review' WHERE id = ANY($1::uuid[])`,
        [[keeps.batch, moving.batch], membership],
      );
      await flagPatient(mae, "m22_intake_confirmed");
      await workspace.relink(
        ORG,
        actor,
        moving.batch,
        { patientId: arthur, referralId: null, reason: "second fax was Arthur's" },
        "c6",
      );
      expect(await relinkEvents(moving.batch)).toEqual([
        expect.objectContaining({ sudStatus: "confirmed", fromPatientRetainsFlag: true }),
      ]);
      await dispatcher.tick();
      expect(await sudFlags(mae)).toEqual({
        flags: ["sud"],
        sud_flag_origin: "m22_intake_confirmed",
      });
      expect(await sudFlags(arthur)).toEqual({
        flags: ["sud"],
        sud_flag_origin: "m22_intake_confirmed",
      });
    });

    it("a flag M39 consent state holds is never lifted by a move", async () => {
      await admin.query("DELETE FROM patient_privacy_flag_snapshot WHERE patient_id IN ($1,$2)", [
        mae,
        arthur,
      ]);
      await admin.query(
        `UPDATE intake_upload_batch SET sud_status='not_detected', sud_resolved_by_membership_id=NULL,
           sud_resolved_at=NULL, sud_resolution_reason=NULL WHERE organization_id=$1`,
        [ORG],
      );
      const flagged = await seedBatch({ patientId: mae, referralId: null });
      await admin.query("UPDATE intake_upload_batch SET sud_status='detected' WHERE id=$1", [
        flagged.batch,
      ]);
      // Consent-derived: no DocLens origin.
      await admin.query(
        `INSERT INTO patient_privacy_flag_snapshot (patient_id, organization_id, flags) VALUES ($1,$2,'{sud}')`,
        [mae, ORG],
      );
      await workspace.relink(
        ORG,
        actor,
        flagged.batch,
        { patientId: arthur, referralId: null, reason: "misfiled under Mae" },
        "c7",
      );
      await dispatcher.tick();
      expect(await sudFlags(mae)).toEqual({ flags: ["sud"], sud_flag_origin: null });
      expect((await sudFlags(arthur))?.flags).toEqual(["sud"]);
    });

    it("a referral-filed fax with a detection flags the patient its referral resolves to", async () => {
      await admin.query("DELETE FROM patient_privacy_flag_snapshot WHERE patient_id=$1", [arthur]);
      const prospect = (
        await admin.query(
          `INSERT INTO referral (organization_id, patient_name_at_receipt, patient_dob_at_receipt, source_channel)
           VALUES ($1,'DOCLENS, ARTHUR','1941-03-02','fax') RETURNING id`,
          [ORG],
        )
      ).rows[0].id as string;
      const early = await seedBatch({ patientId: null, referralId: prospect });
      await admin.query("UPDATE intake_upload_batch SET sud_status='detected' WHERE id=$1", [
        early.batch,
      ]);
      await admin.query(
        "UPDATE referral SET patient_id=$1, patient_resolution_status='matched' WHERE id=$2",
        [arthur, prospect],
      );
      await workspace.getWorkspace(ORG, early.batch, membership);
      expect(await relinkEvents(early.batch)).toEqual([
        expect.objectContaining({
          fromPatientId: null,
          toPatientId: arthur,
          movedByMembershipId: null,
        }),
      ]);
      await dispatcher.tick();
      expect((await sudFlags(arthur))?.flags).toEqual(["sud"]);
    });

    it("a fax with no live detection moves without touching any privacy flag", async () => {
      const plain = await seedBatch({ patientId: mae, referralId: null });
      await admin.query(
        `UPDATE intake_upload_batch SET sud_status='rejected', sud_resolved_by_membership_id=$2,
           sud_resolved_at=now(), sud_resolution_reason='methadone for pain' WHERE id=$1`,
        [plain.batch, membership],
      );
      await workspace.relink(
        ORG,
        actor,
        plain.batch,
        { patientId: arthur, referralId: null, reason: "misfiled under Mae" },
        "c8",
      );
      expect(await relinkEvents(plain.batch)).toEqual([]);
    });

    it("rejecting one fax's detection keeps the flag while another of the patient's faxes holds one", async () => {
      await admin.query("DELETE FROM patient_privacy_flag_snapshot WHERE patient_id=$1", [mae]);
      await admin.query(
        `UPDATE intake_upload_batch SET sud_status='not_detected', sud_resolved_by_membership_id=NULL,
           sud_resolved_at=NULL, sud_resolution_reason=NULL WHERE organization_id=$1`,
        [ORG],
      );
      const first = await seedBatch({ patientId: mae, referralId: null });
      const second = await seedBatch({ patientId: mae, referralId: null });
      await admin.query(
        "UPDATE intake_upload_batch SET sud_status='detected' WHERE id = ANY($1::uuid[])",
        [[first.batch, second.batch]],
      );
      await flagPatient(mae, "m22_intake_unconfirmed");
      const rejectedEvents = async (batch: string) =>
        (
          await admin.query(
            "SELECT payload FROM outbox_event WHERE event_type='m22.intake.sud_rejected' AND aggregate_id=$1",
            [batch],
          )
        ).rows.map((r) => r.payload);

      await workspace.resolveSud(ORG, actor, first.batch, "rejected", "methadone for pain");
      expect(await rejectedEvents(first.batch)).toEqual([
        expect.objectContaining({ patientId: mae, patientRetainsFlag: true }),
      ]);
      await dispatcher.tick();
      expect(await sudFlags(mae)).toEqual({
        flags: ["sud"],
        sud_flag_origin: "m22_intake_unconfirmed",
      });

      // The last live detection rejected: now the flag goes.
      await workspace.resolveSud(ORG, actor, second.batch, "rejected", "same prescription");
      expect(await rejectedEvents(second.batch)).toEqual([
        expect.objectContaining({ patientId: mae, patientRetainsFlag: false }),
      ]);
      await dispatcher.tick();
      expect(await sudFlags(mae)).toEqual({ flags: [], sud_flag_origin: null });
    });

    it("the admission hint: an extracted address waiting in review — counts + batch ids only, never a value", async () => {
      const pending = createPendingAddressService({ db: handle.db }); // as wardenx_app (RLS)
      extractAddress = true;
      const packet = await seedBatch({ patientId: arthur, referralId: null });
      try {
        await run(packet.batch);
      } finally {
        extractAddress = false;
      }
      // Every earlier batch of Arthur's is either complete or holds no address candidate.
      const before = await pending.pendingForPatient(ORG, arthur);
      expect(before).toEqual({
        items: [
          {
            batchId: packet.batch,
            batchStatus: expect.any(String),
            uploadedAt: expect.any(String),
            reviewStatus: "not_started",
            pendingCount: 4, // line1 + city on the transfer record AND on Ada Vance's misfiled H&P
            approvedCount: 0,
          },
        ],
        totalBatches: 1,
      });
      expect(JSON.stringify(before)).not.toMatch(/Elm|Oak|Salem|Bend/);
      // Another patient, and another tenant, see nothing.
      expect(await pending.pendingForPatient(ORG, mae)).toEqual({ items: [], totalBatches: 0 });
      expect(await pending.pendingForPatient(OTHER_ORG, arthur)).toEqual({
        items: [],
        totalBatches: 0,
      });

      // Ada Vance's page is marked as another patient's — its address never reaches Arthur's chart.
      await workspace.resolveIdentity(ORG, actor, packet.batch, 2, "other_patient", "Ada's H&P");
      expect((await pending.pendingForPatient(ORG, arthur)).items[0]).toMatchObject({
        pendingCount: 2,
        approvedCount: 0,
      });

      // Approved but not completed is still waiting; a rejected one is gone.
      const review = await svc.openReview(ORG, actor, packet.batch);
      const ws = await workspace.getWorkspace(ORG, packet.batch, membership);
      const cand = (fieldPath: string) =>
        ws.candidates.find((c) => c.page === 1 && c.fieldPath === fieldPath)?.id as string;
      await svc.recordDecision(ORG, actor, review.id, {
        candidateId: cand("patient.address.line1"),
        decision: "approve",
      });
      await svc.recordDecision(ORG, actor, review.id, {
        candidateId: cand("patient.address.city"),
        decision: "reject",
        reason: "wrong city",
      });
      expect((await pending.pendingForPatient(ORG, arthur)).items).toEqual([
        expect.objectContaining({
          batchId: packet.batch,
          reviewStatus: "in_progress",
          pendingCount: 0,
          approvedCount: 1,
        }),
      ]);

      // Once the review completes the address is on its way to M5 — nothing is waiting any more.
      await svc.completeReview(ORG, actor, review.id);
      expect(await pending.pendingForPatient(ORG, arthur)).toEqual({ items: [], totalBatches: 0 });
    });
  },
);
