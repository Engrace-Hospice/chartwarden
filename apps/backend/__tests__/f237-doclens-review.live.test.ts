/**
 * F-237 — LIVE Postgres proof of DocLens stage 5, SUD detection and the review screen's server half, as the
 * NOBYPASSRLS `chartwarden_app` role, with the REAL catalog-validating publisher and outbox dispatcher.
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
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:f237:doclens-review:live
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildPatientAdmissionClearanceReader } from "../src/modules/05-patient/admission-clearance-reader";
import { M5_OUTBOX_EVENTS, buildM5IntakeSudPrivacyConsumer } from "../src/modules/05-patient/index";
import type { SudContentAccess } from "../src/modules/22-documents/extraction/sud-content-gate";
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
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
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
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
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

  async function seedBatch(patientId: string | null = patient): Promise<string> {
    const doc = (
      await admin.query(
        `INSERT INTO document (organization_id, patient_id, retention_class, source_kind, aggregate_type,
           title, created_by_membership_id)
         VALUES ($1,$2,'intake_artifact','fax_ingest','other','Referral fax',$3) RETURNING id`,
        [ORG, patientId, membership],
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
        [ORG, patientId, doc, membership],
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

    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
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

  it("refuses field review before extraction without creating a review row", async () => {
    const pending = await seedBatch();
    await expect(svc.openReview(ORG, actor, pending)).rejects.toMatchObject({
      code: "EXTRACTION_NOT_READY",
    });
    const rows = await admin.query(
      "SELECT id FROM extraction_review WHERE intake_upload_batch_id=$1",
      [pending],
    );
    expect(rows.rows).toHaveLength(0);
    const status = await admin.query("SELECT status FROM intake_upload_batch WHERE id=$1", [
      pending,
    ]);
    expect(status.rows[0]?.status).toBe("uploaded");
  });

  it("refuses intermediate and failed processing states without creating reviews", async () => {
    const pending = await seedBatch();
    for (const state of ["docling_complete", "classifier_complete", "parse_failed"] as const) {
      await admin.query("UPDATE intake_upload_batch SET status=$1 WHERE id=$2", [state, pending]);
      await expect(svc.openReview(ORG, actor, pending)).rejects.toMatchObject({
        code: state === "parse_failed" ? "BATCH_STATE_CONFLICT" : "EXTRACTION_NOT_READY",
      });
    }
    const rows = await admin.query(
      "SELECT id FROM extraction_review WHERE intake_upload_batch_id=$1",
      [pending],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("opens and completes a document-level review when extraction produced zero candidates", async () => {
    const empty = await seedBatch();
    await admin.query(
      "UPDATE intake_upload_batch SET status='extraction_complete', identity_status='match' WHERE id=$1",
      [empty],
    );
    const review = await svc.openReview(ORG, actor, empty);
    const rows = await admin.query(
      "SELECT id, candidates_total, candidates_decided FROM extraction_review WHERE intake_upload_batch_id=$1",
      [empty],
    );
    expect(rows.rows).toEqual([{ id: review.id, candidates_total: 0, candidates_decided: 0 }]);
    await expect(svc.completeReview(ORG, actor, review.id)).resolves.toMatchObject({
      reviewId: review.id,
      status: "complete",
      writeback: { committedFieldPaths: [] },
    });
    const batch = await admin.query(
      "SELECT status, disposition_at IS NOT NULL AS disposed FROM intake_upload_batch WHERE id=$1",
      [empty],
    );
    expect(batch.rows).toEqual([{ status: "writeback_complete", disposed: true }]);
    expect(
      (
        await admin.query(
          `SELECT count(*)::int AS n
             FROM extraction_provenance p
             JOIN extraction_decision d ON d.id=p.extraction_decision_id
            WHERE d.extraction_review_id=$1`,
          [review.id],
        )
      ).rows[0]?.n,
    ).toBe(0);
  });

  it("serializes duplicate starts, returns the same review to its owner, and rejects lock takeover", async () => {
    const empty = await seedBatch();
    await admin.query("UPDATE intake_upload_batch SET status='extraction_complete' WHERE id=$1", [
      empty,
    ]);
    const [first, replay] = await Promise.all([
      svc.openReview(ORG, actor, empty),
      svc.openReview(ORG, actor, empty),
    ]);
    expect(replay.id).toBe(first.id);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM extraction_review WHERE intake_upload_batch_id=$1 AND status='in_progress'",
          [empty],
        )
      ).rows[0]?.n,
    ).toBe(1);

    const other = {
      userId: "44444444-4444-4444-8444-444444444444",
      membershipId: randomUUID(),
    };
    await expect(svc.openReview(ORG, other, empty)).rejects.toMatchObject({
      code: "REVIEW_ALREADY_IN_PROGRESS",
      statusCode: 409,
    });
    await expect(svc.abandonReview(ORG, other, first.id)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(svc.discardBatch(ORG, other, empty)).rejects.toMatchObject({ statusCode: 403 });
    expect(
      (
        await admin.query(
          `SELECT b.status AS batch_status, r.status AS review_status
             FROM intake_upload_batch b JOIN extraction_review r ON r.intake_upload_batch_id=b.id
            WHERE b.id=$1 AND r.id=$2`,
          [empty, first.id],
        )
      ).rows[0],
    ).toEqual({ batch_status: "in_review", review_status: "in_progress" });

    await expect(svc.abandonReview(ORG, actor, first.id)).resolves.toEqual({
      reviewId: first.id,
      status: "abandoned",
    });
    expect(
      (await admin.query("SELECT status FROM intake_upload_batch WHERE id=$1", [empty])).rows[0]
        ?.status,
    ).toBe("extraction_complete");
    const reopened = await svc.openReview(ORG, actor, empty);
    expect(reopened.id).not.toBe(first.id);
  });

  it("fails closed when a patient-bound document review has no resolved identity target", async () => {
    const empty = await seedBatch();
    await admin.query("UPDATE intake_upload_batch SET status='extraction_complete' WHERE id=$1", [
      empty,
    ]);
    const review = await svc.openReview(ORG, actor, empty);
    for (const identityStatus of [null, "no_target"] as const) {
      await admin.query("UPDATE intake_upload_batch SET identity_status=$1 WHERE id=$2", [
        identityStatus,
        empty,
      ]);
      await expect(svc.completeReview(ORG, actor, review.id)).rejects.toMatchObject({
        code: "IDENTITY_NOT_CHECKED",
        statusCode: 409,
      });
    }
    expect(
      (
        await admin.query(
          `SELECT b.status AS batch_status, r.status AS review_status,
                  (SELECT count(*)::int
                     FROM extraction_provenance p
                     JOIN extraction_decision d ON d.id=p.extraction_decision_id
                    WHERE d.extraction_review_id=r.id) AS provenance
             FROM intake_upload_batch b JOIN extraction_review r ON r.intake_upload_batch_id=b.id
            WHERE b.id=$1 AND r.id=$2`,
          [empty, review.id],
        )
      ).rows[0],
    ).toEqual({ batch_status: "in_review", review_status: "in_progress", provenance: 0 });
  });

  it("serializes completion against discard without deadlocking or changing a completed batch", async () => {
    const empty = await seedBatch();
    await admin.query(
      "UPDATE intake_upload_batch SET status='extraction_complete', identity_status='match' WHERE id=$1",
      [empty],
    );
    const review = await svc.openReview(ORG, actor, empty);
    const settled = await Promise.allSettled([
      svc.completeReview(ORG, actor, review.id),
      svc.discardBatch(ORG, actor, empty),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected");
    expect(rejected).toBeDefined();
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toMatchObject({ statusCode: 409 });
    }
    const state = (
      await admin.query(
        `SELECT b.status AS batch_status, r.status AS review_status
           FROM intake_upload_batch b JOIN extraction_review r ON r.intake_upload_batch_id=b.id
          WHERE b.id=$1`,
        [empty],
      )
    ).rows[0];
    expect([
      { batch_status: "writeback_complete", review_status: "complete" },
      { batch_status: "discarded", review_status: "abandoned" },
    ]).toContainEqual(state);
  });

  it("keeps persisted Part 2 page evidence authoritative when a retry detector refuses", async () => {
    const retryBatch = await seedBatch(null);
    let hpAvailable = false;
    const partialExtractor: DocLensExtractorPort = {
      extract: async (input) =>
        input.documentType === "hp" && !hpAvailable
          ? { available: false, detail: "capability temporarily unavailable" }
          : extractor.extract(input),
    };
    const baseDeps = {
      db: handle.db,
      docling: {
        parse: async () => ({ doclingVersion: "2.133.0", pages: PAGES as never }),
        render: async () => {
          throw new Error("retry test does not run stage 5");
        },
      },
      presignSource: async () => "https://minio.invalid/x?sig",
      cipher,
      classifier: () => classifier,
      outbox: m22Outbox,
      identityTargets: {
        patient: async () => ({
          lastName: "Doclens",
          firstName: "Mae",
          dateOfBirth: "1938-04-12",
        }),
      },
    };
    await expect(
      runDocLensIntake(
        {
          ...baseDeps,
          extractor: () => partialExtractor,
          sudDetector: () => sudModel,
        },
        {
          organizationId: ORG,
          batchId: retryBatch,
          actorUserId: USER,
          correlationId: "f237-sud-first",
        },
      ),
    ).resolves.toMatchObject({ outcome: "awaiting_capability", sud: { pages: [2] } });

    hpAvailable = true;
    await expect(
      runDocLensIntake(
        {
          ...baseDeps,
          extractor: () => partialExtractor,
          sudDetector: () => ({
            detect: async () => ({ available: false, detail: "detector temporarily unavailable" }),
          }),
        },
        {
          organizationId: ORG,
          batchId: retryBatch,
          actorUserId: USER,
          correlationId: "f237-sud-retry",
        },
      ),
    ).resolves.toMatchObject({ outcome: "extracted", sud: { pages: [2] } });
    expect(
      (
        await admin.query(
          `SELECT b.status, b.sud_status,
                  count(c.id) FILTER (WHERE c.source_page=2)::int AS page_two_candidates,
                  count(c.id) FILTER (WHERE c.source_page=2 AND c.sud_detected)::int AS protected_candidates,
                  (SELECT count(*)::int FROM outbox_event o
                    WHERE o.event_type='m22.intake.sud_detected' AND o.aggregate_id=b.id) AS events
             FROM intake_upload_batch b
             JOIN classified_page p ON p.intake_upload_batch_id=b.id
             JOIN extraction_job j ON j.classified_page_id=p.id
             LEFT JOIN extraction_candidate c ON c.extraction_job_id=j.id
            WHERE b.id=$1 GROUP BY b.id`,
          [retryBatch],
        )
      ).rows[0],
    ).toEqual({
      status: "extraction_complete",
      sud_status: "detected",
      page_two_candidates: 3,
      protected_candidates: 3,
      events: 1,
    });
  });

  it("retries a legacy rules-only detector ref and remains fail-closed on refusal", async () => {
    const legacyBatch = await seedBatch(null);
    await admin.query(
      "UPDATE intake_upload_batch SET status='classifier_complete', sud_detector_ref='rules:v1' WHERE id=$1",
      [legacyBatch],
    );
    let detectorCalls = 0;
    let detectorAvailable = false;
    const deps = {
      db: handle.db,
      docling: {
        parse: async () => ({ doclingVersion: "2.133.0", pages: PAGES as never }),
        render: async () => {
          throw new Error("legacy retry test does not run stage 5");
        },
      },
      presignSource: async () => "https://minio.invalid/x?sig",
      cipher,
      classifier: () => classifier,
      extractor: () => extractor,
      sudDetector: () => ({
        detect: async () => {
          detectorCalls += 1;
          return detectorAvailable
            ? sudModel.detect({} as never)
            : { available: false as const, detail: "legacy detector refusal" };
        },
      }),
      outbox: m22Outbox,
      identityTargets: {
        patient: async () => ({
          lastName: "Doclens",
          firstName: "Mae",
          dateOfBirth: "1938-04-12",
        }),
      },
    };
    await expect(
      runDocLensIntake(deps, {
        organizationId: ORG,
        batchId: legacyBatch,
        actorUserId: USER,
        correlationId: "f237-sud-legacy-refusal",
      }),
    ).resolves.toMatchObject({ outcome: "awaiting_capability" });
    expect(detectorCalls).toBe(1);
    expect(
      (
        await admin.query("SELECT status, sud_detector_ref FROM intake_upload_batch WHERE id=$1", [
          legacyBatch,
        ])
      ).rows[0],
    ).toEqual({ status: "classifier_complete", sud_detector_ref: "rules:v1" });

    detectorAvailable = true;
    await expect(
      runDocLensIntake(deps, {
        organizationId: ORG,
        batchId: legacyBatch,
        actorUserId: USER,
        correlationId: "f237-sud-legacy-retry",
      }),
    ).resolves.toMatchObject({ outcome: "extracted", sud: { pages: [2] } });
    expect(detectorCalls).toBe(2);
    expect(
      (
        await admin.query("SELECT sud_detector_ref FROM intake_upload_batch WHERE id=$1", [
          legacyBatch,
        ])
      ).rows[0]?.sud_detector_ref,
    ).toBe("rules:v1+ai_invocation:sud-1");
  });

  it("serializes competing SUD scans so a non-detecting delivery cannot finalize first", async () => {
    const concurrentBatch = await seedBatch(null);
    let releaseDetector!: () => void;
    const detectorReleased = new Promise<void>((resolve) => {
      releaseDetector = resolve;
    });
    let signalDetectorEntered!: () => void;
    const detectorEntered = new Promise<void>((resolve) => {
      signalDetectorEntered = resolve;
    });
    let detectingCalls = 0;
    let nonDetectingCalls = 0;
    const baseDeps = {
      db: handle.db,
      docling: {
        parse: async () => ({ doclingVersion: "2.133.0", pages: PAGES as never }),
        render: async () => {
          throw new Error("concurrency test does not run stage 5");
        },
      },
      presignSource: async () => "https://minio.invalid/x?sig",
      cipher,
      classifier: () => classifier,
      extractor: () => extractor,
      outbox: m22Outbox,
      identityTargets: {
        patient: async () => ({
          lastName: "Doclens",
          firstName: "Mae",
          dateOfBirth: "1938-04-12",
        }),
      },
    };
    const detecting = runDocLensIntake(
      {
        ...baseDeps,
        sudDetector: () => ({
          detect: async () => {
            detectingCalls += 1;
            signalDetectorEntered();
            await detectorReleased;
            return {
              available: true as const,
              invocationId: "sud-concurrent-detecting",
              indicators: [{ pageNumber: 2, snippet: "Methadone 10 mg", category: "medication" }],
            };
          },
        }),
      },
      {
        organizationId: ORG,
        batchId: concurrentBatch,
        actorUserId: USER,
        correlationId: "f237-sud-concurrent-detecting",
      },
    );
    await detectorEntered;
    const competing = runDocLensIntake(
      {
        ...baseDeps,
        sudDetector: () => ({
          detect: async () => {
            nonDetectingCalls += 1;
            return {
              available: true as const,
              invocationId: "sud-concurrent-empty",
              indicators: [],
            };
          },
        }),
      },
      {
        organizationId: ORG,
        batchId: concurrentBatch,
        actorUserId: USER,
        correlationId: "f237-sud-concurrent-empty",
      },
    );
    releaseDetector();
    const outcomes = await Promise.all([detecting, competing]);

    expect(detectingCalls).toBe(1);
    expect(nonDetectingCalls).toBe(0);
    expect(outcomes.some((outcome) => outcome.outcome === "extracted")).toBe(true);
    expect(
      (
        await admin.query(
          `SELECT b.status, b.sud_status, b.sud_detector_ref,
                  count(c.id) FILTER (WHERE c.source_page=2)::int AS page_two_candidates,
                  count(c.id) FILTER (WHERE c.source_page=2 AND c.sud_detected)::int AS protected_candidates,
                  (SELECT count(*)::int FROM outbox_event o
                    WHERE o.event_type='m22.intake.sud_detected' AND o.aggregate_id=b.id) AS events
             FROM intake_upload_batch b
             JOIN classified_page p ON p.intake_upload_batch_id=b.id
             JOIN extraction_job j ON j.classified_page_id=p.id
             LEFT JOIN extraction_candidate c ON c.extraction_job_id=j.id
            WHERE b.id=$1 GROUP BY b.id`,
          [concurrentBatch],
        )
      ).rows[0],
    ).toEqual({
      status: "extraction_complete",
      sud_status: "detected",
      sud_detector_ref: "rules:v1+ai_invocation:sud-concurrent-detecting",
      page_two_candidates: 3,
      protected_candidates: 3,
      events: 1,
    });
  });

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
        identityTargets: {
          patient: async () => ({
            lastName: "Doclens",
            firstName: "Mae",
            dateOfBirth: "1938-04-12",
          }),
        },
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
      candidateCount: 0,
      suggestedSudKind: "medication",
      pages: [2],
    });
    expect(JSON.stringify(events.rows[0].payload)).not.toMatch(/methadone/i);

    await dispatcher.tick();
    expect(await snapshot()).toEqual({
      flags: ["hiv", "sud"],
      sud_flag_origin: "m22_intake_unconfirmed",
    });
    // The M6 admission gate's M5 read (as the app role) — category-free. F-238: the interim DocLens
    // flag is advisory to M6 (`INTAKE_DETECTION_UNREVIEWED` does not block activation) only when it is
    // the patient's sole flag; here the unrelated `hiv` flag is the binding restriction.
    const clearance = () =>
      buildPatientAdmissionClearanceReader(handle.db).evaluatePatientAdmissionClearance({
        organizationId: ORG,
        patientId: patient,
      });
    expect(await clearance()).toEqual({
      allowed: false,
      reason: "PRIVACY_RESTRICTION",
      restriction: "RESTRICTED",
      overrideAllowed: true,
    });
    // With the interim flag alone, the clearance names intake review as the workflow that lifts it.
    await admin.query(
      "UPDATE patient_privacy_flag_snapshot SET flags='{sud}' WHERE patient_id=$1",
      [patient],
    );
    try {
      expect(await clearance()).toEqual({
        allowed: false,
        reason: "PRIVACY_RESTRICTION",
        restriction: "INTAKE_DETECTION_UNREVIEWED",
        overrideAllowed: true,
      });
    } finally {
      await admin.query(
        "UPDATE patient_privacy_flag_snapshot SET flags='{hiv,sud}' WHERE patient_id=$1",
        [patient],
      );
    }
  });

  // GAP-067 — the route composes the Part 2 probes (licence + `sud_consent_present` on the batch's patient)
  // and hands the service this object; the service defaults to DENY when it is absent. A PENDING detection
  // needs only the licence (adjudicating it is internal use, before any consent exists); a CONFIRMED batch
  // needs the licence AND consent.
  const sudAllowed: SudContentAccess = {
    reviewerEligible: async () => true,
    consentPresent: async (patientId) => patientId !== "",
  };
  const sudLicensedNoConsent: SudContentAccess = {
    reviewerEligible: async () => true,
    consentPresent: async () => false,
  };
  const sudDenied: SudContentAccess = {
    reviewerEligible: async () => false,
    consentPresent: async () => true,
  };

  it("a licensed reviewer WITHOUT consent can read a PENDING detection, so the RN does not adjudicate blind (GAP-067)", async () => {
    const ws = await workspace.getWorkspace(ORG, batchId, membership, sudLicensedNoConsent);
    expect(ws.sud.status).toBe("detected");
    expect(ws.sud.contentRedacted).toBe(false);
    expect(ws.sud.indicators[0]).toMatchObject({ term: "Methadone" });
    expect(ws.candidates.find((x) => x.fieldPath === "medications[0].name")?.redacted).toBe(false);
  });

  it("withholds SUD values and evidence from a viewer without the Part 2 need-to-know (GAP-067)", async () => {
    for (const viewer of [undefined, sudDenied]) {
      const ws = await workspace.getWorkspace(ORG, batchId, membership, viewer);
      expect(ws.sud.status).toBe("detected");
      expect(ws.sud.contentRedacted).toBe(true);
      expect(ws.sud.indicators).toEqual([]);
      const med = ws.candidates.find((x) => x.fieldPath === "medications[0].name");
      expect(med).toMatchObject({ value: null, redacted: true, sudDetected: true });
      expect(med?.vision.observedValue).toBeNull();
      expect(JSON.stringify(ws)).not.toMatch(/methadone/i);
      // The same batch's non-SUD fields stay readable for review.
      expect(ws.candidates.find((x) => x.fieldPath === "patient.phoneHome")?.value).toBe(
        "(503) 555-0142",
      );
    }
  });

  it("refuses a Part 2 batch's page image without the need-to-know, before any render (GAP-067)", async () => {
    for (const viewer of [undefined, sudDenied]) {
      await expect(
        workspace.renderPage(ORG, batchId, 1, "corr-gap067", viewer),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  // ADR-0115 — a support-session read passes a scope. A patient-scoped grant covers the filed patient only, so the
  // real service reads the batch only when that patient's identity is PROVEN (the check ran and is positive), and the
  // batch must still be filed under the patient the grant was authorized against.
  describe("support-session scope on the real service", () => {
    const supportAccess: SudContentAccess = {
      administratorOverride: async () => true,
      reviewerEligible: async () => false,
      consentPresent: async () => false,
    };
    const patientScope = () => ({ patientContentOnly: true, expectedPatientId: patient });
    const orgScope = () => ({ patientContentOnly: false, expectedPatientId: patient });

    async function withIdentity(
      batchStatus: string | null,
      pages: { status: string | null; resolution: string | null },
      run: () => Promise<void>,
    ) {
      const batch = (
        await admin.query("SELECT identity_status FROM intake_upload_batch WHERE id=$1", [batchId])
      ).rows[0];
      const before = (
        await admin.query(
          `SELECT id, identity_status, identity_resolution, identity_resolved_by_membership_id,
                  identity_resolved_at, identity_resolution_reason
             FROM classified_page WHERE intake_upload_batch_id=$1`,
          [batchId],
        )
      ).rows;
      try {
        await admin.query("UPDATE intake_upload_batch SET identity_status=$1 WHERE id=$2", [
          batchStatus,
          batchId,
        ]);
        await admin.query(
          `UPDATE classified_page SET identity_status=$1, identity_resolution=$2,
             identity_resolved_by_membership_id = CASE WHEN $2::text IS NULL THEN NULL ELSE $4::uuid END,
             identity_resolved_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
             identity_resolution_reason = CASE WHEN $2::text IS NULL THEN NULL ELSE 'live test' END
           WHERE intake_upload_batch_id=$3`,
          [pages.status, pages.resolution, batchId, membership],
        );
        await run();
      } finally {
        await admin.query("UPDATE intake_upload_batch SET identity_status=$1 WHERE id=$2", [
          batch.identity_status,
          batchId,
        ]);
        for (const p of before) {
          await admin.query(
            `UPDATE classified_page SET identity_status=$1, identity_resolution=$2,
               identity_resolved_by_membership_id=$3, identity_resolved_at=$4,
               identity_resolution_reason=$5 WHERE id=$6`,
            [
              p.identity_status,
              p.identity_resolution,
              p.identity_resolved_by_membership_id,
              p.identity_resolved_at,
              p.identity_resolution_reason,
              p.id,
            ],
          );
        }
      }
    }

    it("refuses a patient-scoped read until the filed patient's identity is proven", async () => {
      const unproven: Array<[string | null, string | null, string | null]> = [
        [null, null, null],
        ["no_target", null, null],
        ["unverified", "unverified", null],
        ["possible", "possible", null],
        ["mismatch", "mismatch", null],
        ["match", "match", "other_patient"],
      ];
      for (const [batchStatus, status, resolution] of unproven) {
        await withIdentity(batchStatus, { status, resolution }, async () => {
          await expect(
            workspace.getWorkspace(ORG, batchId, membership, supportAccess, patientScope()),
          ).rejects.toMatchObject({ code: "FORBIDDEN" });
          await expect(
            workspace.renderPage(ORG, batchId, 1, "corr-support", supportAccess, patientScope()),
          ).rejects.toMatchObject({ code: "FORBIDDEN" });
        });
      }
    });

    it("reads a proven batch under a patient-scoped grant, refuses a page no classified document covers, and needs no proof for an organization-scoped grant", async () => {
      await withIdentity("match", { status: "match", resolution: null }, async () => {
        const ws = await workspace.getWorkspace(
          ORG,
          batchId,
          membership,
          supportAccess,
          patientScope(),
        );
        expect(ws.sud.contentRedacted).toBe(false);
        expect(ws.batch.patientId).toBe(patient);
        // The render proceeds past the scope checks; it may stop at an unconfigured renderer, never at the scope.
        const rendered = await workspace
          .renderPage(ORG, batchId, 1, "corr-support", supportAccess, patientScope())
          .catch((error: unknown) => error);
        expect((rendered as { code?: string }).code).not.toBe("FORBIDDEN");
        await expect(
          workspace.renderPage(ORG, batchId, 9, "corr-support", supportAccess, patientScope()),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
      });
      await withIdentity(null, { status: null, resolution: null }, async () => {
        const ws = await workspace.getWorkspace(
          ORG,
          batchId,
          membership,
          supportAccess,
          orgScope(),
        );
        expect(ws.batch.patientId).toBe(patient);
      });
    });

    it("does not treat a re-sent copy as proven by the duplicate mark alone, only once a reviewer confirms it", async () => {
      // The splitter's duplicate mark is a fuzzy text match and batch identity skips such pages, so another patient's
      // page on the same form template can carry it. A page with a mark and no verdict of its own must be refused.
      const original = (
        await admin.query(
          "SELECT id, duplicate_of_page FROM classified_page WHERE intake_upload_batch_id=$1",
          [batchId],
        )
      ).rows;
      await withIdentity("match", { status: null, resolution: null }, async () => {
        try {
          await admin.query(
            "UPDATE classified_page SET duplicate_of_page=1 WHERE intake_upload_batch_id=$1",
            [batchId],
          );
          await expect(
            workspace.getWorkspace(ORG, batchId, membership, supportAccess, patientScope()),
          ).rejects.toMatchObject({ code: "FORBIDDEN" });
          await expect(
            workspace.renderPage(ORG, batchId, 1, "corr-support", supportAccess, patientScope()),
          ).rejects.toMatchObject({ code: "FORBIDDEN" });

          await admin.query(
            `UPDATE classified_page SET identity_resolution='same_patient',
               identity_resolved_by_membership_id=$2, identity_resolved_at=now(),
               identity_resolution_reason='live test'
             WHERE intake_upload_batch_id=$1`,
            [batchId, membership],
          );
          const ws = await workspace.getWorkspace(
            ORG,
            batchId,
            membership,
            supportAccess,
            patientScope(),
          );
          expect(ws.sud.contentRedacted).toBe(false);
        } finally {
          for (const p of original) {
            await admin.query("UPDATE classified_page SET duplicate_of_page=$1 WHERE id=$2", [
              p.duplicate_of_page,
              p.id,
            ]);
          }
        }
      });
    });

    it("fails as a retryable conflict (409) when the batch is no longer filed under the authorized patient", async () => {
      await withIdentity("match", { status: "match", resolution: null }, async () => {
        const stale = { patientContentOnly: false, expectedPatientId: randomUUID() };
        await expect(
          workspace.getWorkspace(ORG, batchId, membership, supportAccess, stale),
        ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/re-filed/) });
        await expect(
          workspace.renderPage(ORG, batchId, 1, "corr-support", supportAccess, stale),
        ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/re-filed/) });
      });
    });
  });

  it("serves the workspace (decrypted for the reviewer) and the queue (counts only)", async () => {
    const ws = await workspace.getWorkspace(ORG, batchId, membership, sudAllowed);
    expect(ws.sud.contentRedacted).toBe(false);
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
    expect(pending.items.map((i) => i.id)).toContain(batchId);
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
    expect(
      (
        await admin.query(
          `SELECT array_agg(j.status::text ORDER BY j.id) AS statuses
             FROM extraction_job j
             JOIN classified_page p ON p.id=j.classified_page_id
            WHERE p.intake_upload_batch_id=$1`,
          [batchId],
        )
      ).rows[0]?.statuses,
    ).toEqual(["in_review", "in_review"]);
    const decide = (path: string, decision: string, extra: Record<string, string> = {}) =>
      svc.recordDecision(ORG, actor, review.id, { candidateId: id(path), decision, ...extra });

    const otherReviewer = { userId: randomUUID(), membershipId: randomUUID() };
    await expect(
      workspace.resolveSud(ORG, otherReviewer, batchId, "rejected", "Not substance-use content"),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      workspace.resolveIdentity(
        ORG,
        otherReviewer,
        batchId,
        1,
        "same_patient",
        "Matched the patient identifiers",
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    const relinkWorkspace = createReviewWorkspaceService({
      db: handle.db,
      cipher,
      outbox: m22Outbox,
      identity: {
        ports: {
          patient: async () => ({
            lastName: "Doclens",
            firstName: "Mae",
            dateOfBirth: "1938-04-12",
          }),
        },
        canAccessReferral: async () => true,
      },
    });
    await expect(
      relinkWorkspace.relink(
        ORG,
        otherReviewer,
        batchId,
        { patientId: patient, referralId: null, reason: "Correct patient filing" },
        "f237-lock-owner",
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(
      (
        await admin.query(
          `SELECT b.sud_status, p.identity_resolution,
                  (SELECT count(*)::int FROM intake_batch_relink r WHERE r.intake_upload_batch_id=b.id) AS relinks
             FROM intake_upload_batch b
             JOIN classified_page p ON p.intake_upload_batch_id=b.id
            WHERE b.id=$1 ORDER BY p.page_range_start LIMIT 1`,
          [batchId],
        )
      ).rows[0],
    ).toEqual({ sud_status: "detected", identity_resolution: null, relinks: 0 });

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
    expect(
      (
        await admin.query(
          "SELECT candidates_total, candidates_decided FROM extraction_review WHERE id=$1",
          [review.id],
        )
      ).rows[0],
    ).toEqual({ candidates_total: 5, candidates_decided: 3 });

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

    await expect(svc.completeReview(ORG, actor, review.id)).rejects.toMatchObject({
      code: "REVIEW_INCOMPLETE",
      statusCode: 409,
    });
    for (const candidate of ws.candidates.filter(
      (c) => !["medications[0].name", "patient.phoneHome", "patient.email"].includes(c.fieldPath),
    )) {
      await decide(candidate.fieldPath, "reject", { reason: "Not needed for this intake" });
    }
    expect(
      (
        await admin.query(
          "SELECT candidates_total, candidates_decided FROM extraction_review WHERE id=$1",
          [review.id],
        )
      ).rows[0],
    ).toEqual({ candidates_total: 5, candidates_decided: 5 });

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
    expect(
      (
        await admin.query(
          `SELECT array_agg(j.status::text ORDER BY j.id) AS statuses
             FROM extraction_job j
             JOIN classified_page p ON p.id=j.classified_page_id
            WHERE p.intake_upload_batch_id=$1`,
          [batchId],
        )
      ).rows[0]?.statuses,
    ).toEqual(["committed", "committed"]);
  });

  it("resolves the licence check's risk tier from the candidate row, only within the review's batch", async () => {
    const other = await seedBatch();
    await admin.query("UPDATE intake_upload_batch SET status='extraction_complete' WHERE id=$1", [
      other,
    ]);
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
