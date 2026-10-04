/**
 * F-237 — LIVE Postgres proof of DocLens stage 5, SUD detection and the review screen's server half, as the
 * NOBYPASSRLS `wardenx_app` role, with the REAL catalog-validating publisher and outbox dispatcher.
 *
 * 1. `runDocLensIntake` over a two-page synthetic referral: the SUD rules flag the methadone line (page 2),
 *    a model indicator whose quote is not on the page is dropped, every candidate on page 2 is tagged, the
 *    evidence is stored only as ciphertext, `m22.intake.sud_detected` is published atomically with
 *    completion — carrying no term — and M5's consumer puts an INTERIM `sud` flag on the patient.
 *    Stage 5 re-reads each high/medium-risk value from a padded crop: one agrees (verified), one does not
 *    (the reading stored encrypted), one is illegible (unverified); low-risk values are never sent.
 * 2. The workspace read decrypts values/readings/evidence for the reviewer; the queue counts them.
 * 3. The review rules: approving a vision-disagreed value unchanged needs a reason; a decision can be
 *    revised; completion is refused while SUD is unresolved; a rejection needs a reason, retires ONLY the
 *    DocLens-set flag in M5, and makes the SUD-page contact field committable again.
 * 4. The licence predicate's risk lookup is the candidate row's, constrained to the review's own batch.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:f237:doclens-review:live
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
import { buildPatientAdmissionClearanceReader } from "../src/modules/05-patient/admission-clearance-reader";
import { M5_OUTBOX_EVENTS, buildM5IntakeSudPrivacyConsumer } from "../src/modules/05-patient/index";
import {
  type DocLensClassifierPort,
  type DocLensExtractorPort,
  type DocLensSudDetectorPort,
  type DocLensVisionVerifierPort,
  M22_OUTBOX_EVENTS,
  createCandidateValueCipher,
  createDbDocumentAbacResolver,
  createDbDocumentBackend,
  createReviewWorkspaceService,
  runDocLensIntake,
} from "../src/modules/22-documents/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";

const block = (text: string, bbox: [number, number, number, number]) => ({
  text,
  bbox,
  label: "text",
});
const PAGES = [
  {
    page: 1,
    width: 612,
    height: 792,
    blocks: [
      block("TRANSFER RECORD", [40, 50, 300, 64]),
      block("Date of Birth: 04/12/1938", [40, 110, 260, 124]),
      block("Home phone: (503) 555-0142", [40, 130, 280, 144]),
    ],
  },
  {
    page: 2,
    width: 612,
    height: 792,
    blocks: [
      block("HISTORY AND PHYSICAL", [40, 50, 300, 64]),
      block("Email: mae@example.org", [40, 90, 300, 104]),
      block("Allergies: Penicillin", [40, 110, 300, 124]),
      block("Methadone 10 mg PO q8h for pain", [40, 130, 330, 144]),
    ],
  },
] as const;

describe.skipIf(!DB_URL)("F-237 — DocLens stage 5 + SUD + review rules — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let svc: ReturnType<typeof createDbDocumentBackend>["service"];
  let workspace: ReturnType<typeof createReviewWorkspaceService>;
  let m22Outbox: never;
  let membership: string;
  let actor: { userId: string; membershipId: string };
  let patient: string;
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
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }

  async function seedBatch(): Promise<string> {
    const doc = (
      await admin.query(
        `INSERT INTO document (organization_id, patient_id, retention_class, source_kind, aggregate_type,
           title, created_by_membership_id)
         VALUES ($1,$2,'intake_artifact','fax_ingest','other','Referral fax',$3) RETURNING id`,
        [ORG, patient, membership],
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
        `INSERT INTO intake_upload_batch (organization_id, patient_id, initial_document_id, source_channel,
           uploaded_by_membership_id, correlation_id) VALUES ($1,$2,$3,'fax',$4,gen_random_uuid()) RETURNING id`,
        [ORG, patient, doc, membership],
      )
    ).rows[0].id as string;
  }

  const classifier: DocLensClassifierPort = {
    classify: async (i) => ({
      available: true,
      invocationId: `cls-${i.pageNumber}`,
      documentType: i.pageNumber === 1 ? "transfer_record" : "hp",
      confidence: 0.92,
    }),
  };
  const q = (page: number, text: string) => ({ page, text });
  type Fields = Record<
    string,
    { value: string; confidence: number; sourceQuote: { page: number; text: string } }
  >;
  const extractor: DocLensExtractorPort = {
    extract: async (i) => ({
      available: true,
      invocationId: `ext-${i.documentType}`,
      fields: (i.documentType === "transfer_record"
        ? {
            "patient.dateOfBirth": {
              value: "04/12/1938",
              confidence: 0.9,
              sourceQuote: q(1, "Date of Birth: 04/12/1938"),
            },
            "patient.phoneHome": {
              value: "(503) 555-0142",
              confidence: 0.95,
              sourceQuote: q(1, "Home phone: (503) 555-0142"),
            },
          }
        : {
            "patient.email": {
              value: "mae@example.org",
              confidence: 0.9,
              sourceQuote: q(2, "Email: mae@example.org"),
            },
            "allergies[0].substance": {
              value: "Penicillin",
              confidence: 0.9,
              sourceQuote: q(2, "Allergies: Penicillin"),
            },
            "medications[0].name": {
              value: "Methadone 10 mg PO q8h",
              confidence: 0.88,
              sourceQuote: q(2, "Methadone 10 mg PO q8h for pain"),
            },
          }) as Fields,
    }),
  };
  // A list field reads every visible entry (Docling may return the whole list as one block).
  const READINGS: Record<string, string[] | null> = {
    "allergies[0].substance": ["Penicillin"],
    "medications[0].name": ["Furosemide 40 mg PO daily", "Methadone 20 mg PO q8h"],
    "patient.dateOfBirth": null, // illegible
  };
  const visionCalls: string[] = [];
  const vision: DocLensVisionVerifierPort = {
    async verify(i) {
      visionCalls.push(i.field.fieldPath);
      const reading = READINGS[i.field.fieldPath] ?? null;
      return reading === null
        ? { available: true, invocationId: `vis-${visionCalls.length}`, verdict: "uncertain" }
        : {
            available: true,
            invocationId: `vis-${visionCalls.length}`,
            verdict: "pass",
            observedValue: reading[0] as string,
            observedValues: reading,
          };
    },
  };
  const sudModel: DocLensSudDetectorPort = {
    detect: async () => ({
      available: true,
      invocationId: "sud-1",
      indicators: [
        { pageNumber: 2, snippet: "Methadone 10 mg", category: "medication" },
        // the fax never says this — an ungrounded model indicator must not count
        { pageNumber: 1, snippet: "history of heroin use", category: "social_history" },
      ],
    }),
  };
  const crops: Array<{ page: number; crop: readonly number[] | undefined; scale: number }> = [];

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')",
      [ORG],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f237@x.test')`, [USER]);
    membership = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG],
      )
    ).rows[0].id as string;
    actor = { userId: USER, membershipId: membership };
    patient = (
      await admin.query(
        `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
         VALUES ($1,'MRN-F237','Mae','Doclens','1938-04-12','F','active') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    // A pre-existing, unrelated flag that every SUD transition must leave alone.
    await admin.query(
      `INSERT INTO patient_privacy_flag_snapshot (patient_id, organization_id, flags) VALUES ($1,$2,'{hiv}')`,
      [patient, ORG],
    );

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    const catalog = buildBootOutboxCatalog([M5_OUTBOX_EVENTS, M22_OUTBOX_EVENTS]);
    const publisher = buildTxOutboxPublisher(catalog);
    const as = (callerModule: string) => ({
      publish: (tx: unknown, e: Parameters<typeof publisher.publish>[1]) =>
        publisher.publish(tx as never, { ...e, callerModule } as never),
    });
    m22Outbox = as("m22") as never;
    svc = createDbDocumentBackend(handle.db, { outbox: m22Outbox, cipher }).service;
    workspace = createReviewWorkspaceService({
      db: handle.db,
      cipher,
      outbox: m22Outbox,
      patientName: async () => "Doclens, Mae",
    });
    const orgs: ActiveOrgEnumerator = { listActiveOrgs: async () => [{ organizationId: ORG }] };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [buildM5IntakeSudPrivacyConsumer({ db: handle.db, outbox: as("m5") as never })],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  const snapshot = async () =>
    (
      await admin.query(
        "SELECT flags, sud_flag_origin FROM patient_privacy_flag_snapshot WHERE patient_id=$1",
        [patient],
      )
    ).rows[0] as { flags: string[]; sud_flag_origin: string | null };

  let batchId: string;

  it("runs stage 5 and SUD detection: tags, encrypted evidence, an id-only event, and M5's interim flag", async () => {
    batchId = await seedBatch();
    const summary = await runDocLensIntake(
      {
        db: handle.db,
        docling: {
          parse: async () => ({ doclingVersion: "2.133.0", pages: PAGES as never }),
          render: async (i) => {
            crops.push({ page: i.page, crop: i.crop, scale: i.scale });
            return {
              png: new Uint8Array([137, 80, 78, 71]),
              pageWidth: 612,
              pageHeight: 792,
              scale: i.scale,
            };
          },
        },
        presignSource: async () => "https://minio.invalid/x?sig",
        cipher,
        classifier: () => classifier,
        extractor: () => extractor,
        visionVerifier: () => vision,
        sudDetector: () => sudModel,
        outbox: m22Outbox,
      },
      { organizationId: ORG, batchId, actorUserId: USER, correlationId: "f237" },
    );
    expect(summary).toMatchObject({
      outcome: "extracted",
      candidates: 5,
      vision: { verified: 1, disagreed: 1, unverified: 1 },
      sud: { pages: [2] },
    });
    // Only high/medium-risk values went to the vision model; each crop is the value's box, padded.
    expect(visionCalls.sort()).toEqual(
      ["allergies[0].substance", "medications[0].name", "patient.dateOfBirth"].sort(),
    );
    expect(crops).toContainEqual({ page: 2, crop: [0, 104, 348, 130], scale: 3 });

    const cands = await admin.query(
      `SELECT c.field_path, c.source_page, c.sud_detected, c.vision_verified, c.vision_disagreement
       FROM extraction_candidate c JOIN extraction_job j ON j.id=c.extraction_job_id
       JOIN classified_page p ON p.id=j.classified_page_id WHERE p.intake_upload_batch_id=$1 ORDER BY 1`,
      [batchId],
    );
    const by = Object.fromEntries(cands.rows.map((r) => [r.field_path, r]));
    expect(by["patient.phoneHome"]).toMatchObject({ sud_detected: false, vision_verified: false });
    expect(by["patient.email"]).toMatchObject({ sud_detected: true });
    expect(by["allergies[0].substance"]).toMatchObject({
      vision_verified: true,
      vision_disagreement: null,
    });
    const disagreement = by["medications[0].name"].vision_disagreement as string;
    expect(disagreement).not.toContain("20 mg");
    expect(JSON.parse(await cipher.decrypt(ORG, disagreement))).toEqual({
      observedValue: "Methadone 20 mg PO q8h",
    });
    expect(by["patient.dateOfBirth"]).toMatchObject({
      vision_verified: false,
      vision_disagreement: null,
    });

    const b = (
      await admin.query(
        "SELECT sud_status, sud_evidence_cipher, sud_detector_ref, page_geometry FROM intake_upload_batch WHERE id=$1",
        [batchId],
      )
    ).rows[0];
    expect(b.sud_status).toBe("detected");
    expect(b.sud_detector_ref).toBe("rules:v1+ai_invocation:sud-1");
    expect(b.page_geometry).toEqual([
      { page: 1, width: 612, height: 792 },
      { page: 2, width: 612, height: 792 },
    ]);
    expect(b.sud_evidence_cipher).not.toMatch(/methadone/i);
    const evidence = JSON.parse(await cipher.decrypt(ORG, b.sud_evidence_cipher)) as Array<{
      page: number;
      ruleId: string;
    }>;
    expect(evidence.map((e) => [e.page, e.ruleId])).toEqual([
      [2, "med:methadone"],
      [2, "ai:medication"],
    ]);

    const events = await admin.query(
      "SELECT payload FROM outbox_event WHERE event_type='m22.intake.sud_detected' AND aggregate_id=$1",
      [batchId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].payload).toMatchObject({
      intakeBatchId: batchId,
      patientId: patient,
      candidateCount: 3,
      suggestedSudKind: "medication",
      pages: [2],
    });
    expect(JSON.stringify(events.rows[0].payload)).not.toMatch(/methadone/i);

    await dispatcher.tick();
    expect(await snapshot()).toEqual({
      flags: ["hiv", "sud"],
      sud_flag_origin: "m22_intake_unconfirmed",
    });
    // The M6 admission gate's M5 read (as the app role): the interim flag names intake review as the
    // workflow that lifts it — category-free.
    expect(
      await buildPatientAdmissionClearanceReader(handle.db).evaluatePatientAdmissionClearance({
        organizationId: ORG,
        patientId: patient,
      }),
    ).toEqual({
      allowed: false,
      reason: "PRIVACY_RESTRICTION",
      restriction: "INTAKE_DETECTION_UNREVIEWED",
      overrideAllowed: true,
    });
  });

  it("serves the workspace (decrypted for the reviewer) and the queue (counts only)", async () => {
    const ws = await workspace.getWorkspace(ORG, batchId, membership);
    expect(ws.batch).toMatchObject({ patientId: patient, patientName: "Doclens, Mae" });
    expect(ws.pages.map((p) => [p.page, p.documentType])).toEqual([
      [1, "transfer_record"],
      [2, "hp"],
    ]);
    expect(ws.sud.status).toBe("detected");
    expect(ws.sud.indicators[0]).toMatchObject({
      page: 2,
      term: "Methadone",
      category: "medication",
    });
    const c = Object.fromEntries(ws.candidates.map((x) => [x.fieldPath, x]));
    expect(c["patient.phoneHome"]).toMatchObject({
      value: "(503) 555-0142",
      riskLevel: "low",
      writebackTarget: true,
      vision: { status: "not_required" },
      bbox: [40, 130, 280, 144],
    });
    expect(c["medications[0].name"]).toMatchObject({
      vision: { status: "disagreed", observedValue: "Methadone 20 mg PO q8h" },
      writebackTarget: false,
      sudDetected: true,
    });
    expect(c["patient.dateOfBirth"]?.vision.status).toBe("unverified");
    expect(c["allergies[0].substance"]?.vision.status).toBe("verified");

    const queue = await workspace.listQueue(ORG, { view: "open" });
    expect(queue.items[0]).toMatchObject({
      id: batchId,
      sudStatus: "detected",
      candidates: { total: 5, highRisk: 2, visionDisagreed: 1 },
    });
    expect(JSON.stringify(queue)).not.toContain("555-0142");

    // The admission privacy dialog's lookup: this patient's batches whose detection is still pending.
    const pending = await workspace.listQueue(ORG, {
      view: "open",
      patientId: patient,
      sudStatus: "detected",
    });
    expect(pending.items.map((i) => i.id)).toEqual([batchId]);
    const otherPatient = await workspace.listQueue(ORG, {
      view: "open",
      patientId: "00000000-0000-4000-8000-0000000000ff",
      sudStatus: "detected",
    });
    expect(otherPatient.items).toEqual([]);
    const resolved = await workspace.listQueue(ORG, { view: "open", sudStatus: "rejected" });
    expect(resolved.items.map((i) => i.id)).not.toContain(batchId);
  });

  it("enforces the review rules, resolves SUD as a false positive, and then commits the SUD-page contact", async () => {
    const ws = await workspace.getWorkspace(ORG, batchId, membership);
    const id = (path: string) => ws.candidates.find((x) => x.fieldPath === path)?.id as string;
    const review = await svc.openReview(ORG, actor, batchId);
    const decide = (path: string, decision: string, extra: Record<string, string> = {}) =>
      svc.recordDecision(ORG, actor, review.id, { candidateId: id(path), decision, ...extra });

    await expect(decide("medications[0].name", "approve")).rejects.toMatchObject({
      code: "VISION_DISAGREEMENT_REASON_REQUIRED",
    });
    await decide("medications[0].name", "approve", { reason: "Checked the original: 10 mg" });
    await decide("patient.phoneHome", "reject", { reason: "not sure yet" });
    await decide("patient.phoneHome", "approve"); // a revised decision, not a duplicate
    await decide("patient.email", "approve");
    const decisions = await admin.query(
      "SELECT count(*)::int AS n FROM extraction_decision WHERE extraction_review_id=$1",
      [review.id],
    );
    expect(decisions.rows[0].n).toBe(3);

    await expect(svc.completeReview(ORG, actor, review.id)).rejects.toMatchObject({
      code: "SUD_DETECTION_UNRESOLVED",
    });
    await expect(workspace.resolveSud(ORG, actor, batchId, "rejected", null)).rejects.toMatchObject(
      { code: "SUD_REJECTION_REASON_REQUIRED" },
    );
    expect(
      await workspace.resolveSud(ORG, actor, batchId, "rejected", "Methadone prescribed for pain"),
    ).toEqual({ batchId, sudStatus: "rejected" });
    // idempotent; the opposite resolution is refused
    expect(await workspace.resolveSud(ORG, actor, batchId, "rejected", "again please")).toEqual({
      batchId,
      sudStatus: "rejected",
    });
    await expect(
      workspace.resolveSud(ORG, actor, batchId, "confirmed", null),
    ).rejects.toMatchObject({
      code: "SUD_NOT_PENDING",
    });
    const rejected = await admin.query(
      "SELECT payload FROM outbox_event WHERE event_type='m22.intake.sud_rejected' AND aggregate_id=$1",
      [batchId],
    );
    expect(rejected.rows).toHaveLength(1);
    expect(JSON.stringify(rejected.rows[0].payload)).not.toContain("pain");

    await dispatcher.tick();
    expect(await snapshot()).toEqual({ flags: ["hiv"], sud_flag_origin: null });
    expect(
      (
        await buildPatientAdmissionClearanceReader(handle.db).evaluatePatientAdmissionClearance({
          organizationId: ORG,
          patientId: patient,
        })
      ).restriction,
    ).toBe("RESTRICTED");

    const done = await svc.completeReview(ORG, actor, review.id);
    expect([...(done.writeback?.committedFieldPaths ?? [])].sort()).toEqual([
      "patient.email",
      "patient.phoneHome",
    ]);
    expect(done.writeback?.excluded).toEqual([
      expect.objectContaining({
        fieldPath: "medications[0].name",
        reason: "not_a_writeback_target",
      }),
    ]);
  });

  it("resolves the licence check's risk tier from the candidate row, only within the review's batch", async () => {
    const other = await seedBatch();
    const otherReview = await svc.openReview(ORG, actor, other);
    const ws = await workspace.getWorkspace(ORG, batchId, membership);
    const med = ws.candidates.find((x) => x.fieldPath === "medications[0].name")?.id as string;
    const phone = ws.candidates.find((x) => x.fieldPath === "patient.phoneHome")?.id as string;
    const reviewId = ws.review?.id as string;
    const resolver = createDbDocumentAbacResolver(handle.db);
    const risks = await resolver.loadReviewCandidateRisks(ORG, reviewId, [med, phone]);
    expect(Object.fromEntries(risks)).toEqual({ [med]: "high", [phone]: "low" });
    expect((await resolver.loadReviewCandidateRisks(ORG, otherReview.id, [med])).size).toBe(0);
  });
});
