/**
 * F-235 (#248) — LIVE Postgres proof of the DocLens → M5 demographics chart writeback, end to end, under the
 * user's F-231 decisions A1 (medications never write back) + B (low-risk contact fields only, onto the
 * batch's already-resolved patient — never a headless create).
 *
 * Nothing on the M22/M5 path is stubbed: M22's real `createDbDocumentBackend` (as the NOBYPASSRLS
 * `wardenx_app` role) records the reviewer's decisions and completes the review, which decrypts the stored
 * candidate values server-side with the real tenant-DEK cipher, writes `extraction_provenance`, and
 * publishes `m22.extraction.commit_requested` through the real catalog-validating publisher; the real
 * `createOutboxDispatcher` delivers it to M5's real `m5.extraction-writeback` consumer (chart rows +
 * `m5.patient.draft_created_from_extraction`), then delivers that reply to M22's real
 * `m22.extraction-writeback-backref` (provenance stamp + `m22.extraction.commit_completed`).
 *
 * What is seeded rather than produced: the `classified_page` / `extraction_job` / `extraction_candidate`
 * rows. In production those are written by the DocLens pipeline, whose M32 classifier/extractor capability
 * is still a deny-stub at `DESIGN_REVIEW` (F-231 (d) — promotion is the AI Safety Owner's act). They are
 * seeded in exactly the shape that pipeline must write, with values encrypted by the real cipher.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:f235:doclens-m5-writeback:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  M5_OUTBOX_EVENTS,
  buildM5ExtractionWritebackConsumer,
} from "../src/modules/05-patient/index";
import {
  M22_OUTBOX_EVENTS,
  buildM22ExtractionBackrefConsumer,
  createCandidateValueCipher,
  createDbDocumentBackend,
} from "../src/modules/22-documents/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";

describe.skipIf(!DB_URL)("F-235 — DocLens → M5 demographics writeback — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbDocumentBackend>["service"];
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let membership: string;
  let actor: { userId: string; membershipId: string };
  const deks = new Map<string, Buffer>();
  const keys = {
    async dekForOrg(org: string) {
      return { version: "v1", key: dekOf(org) };
    },
    async dekForOrgVersion(org: string, version: string) {
      if (version !== "v1") throw new Error("unknown DEK version");
      return { version, key: dekOf(org) };
    },
  };
  function dekOf(org: string): Buffer {
    let k = deks.get(org);
    if (!k) {
      k = randomBytes(32);
      deks.set(org, k);
    }
    return k;
  }
  const cipher = createCandidateValueCipher(keys);

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

  async function seedPatient(org: string, mrn: string): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
         VALUES ($1,$2,'Ada','Lovelace','1940-01-01','F','active') RETURNING id`,
        [org, mrn],
      )
    ).rows[0].id as string;
  }

  /** A filed source document (document + active version) — what provenance cites. */
  async function seedSourceDocument(org: string, patientId: string | null): Promise<string> {
    const doc = (
      await admin.query(
        `INSERT INTO document (organization_id, patient_id, retention_class, source_kind, aggregate_type,
           title, created_by_membership_id)
         VALUES ($1,$2,'intake_artifact','fax_ingest','other','Referral fax',$3) RETURNING id`,
        [org, patientId, membership],
      )
    ).rows[0].id as string;
    const ver = (
      await admin.query(
        `INSERT INTO document_version (organization_id, document_id, version_number, minio_object_key,
           mime_type, byte_size, sha256_hex, uploaded_by_kind)
         VALUES ($1,$2,'1',$3,'application/pdf','2048','abc123','fax') RETURNING id`,
        [org, doc, `intake/${doc}/v1.pdf`],
      )
    ).rows[0].id as string;
    await admin.query("UPDATE document SET active_version_id=$1 WHERE id=$2", [ver, doc]);
    return doc;
  }

  interface SeedCandidate {
    fieldPath: string;
    value: string;
    riskLevel?: "low" | "medium" | "high";
    sudDetected?: boolean;
  }

  /** The DocLens pipeline's persisted output for one batch (see the file header — seeded, not produced). */
  async function seedBatch(opts: {
    org: string;
    patientId: string | null;
    sourceDocumentId: string;
    candidates: SeedCandidate[];
  }): Promise<{ batchId: string; candidateIds: string[] }> {
    const batchId = (
      await admin.query(
        `INSERT INTO intake_upload_batch (organization_id, patient_id, initial_document_id, source_channel,
           uploaded_by_membership_id, correlation_id, status)
         VALUES ($1,$2,$3,'fax',$4,gen_random_uuid(),'extraction_complete') RETURNING id`,
        [opts.org, opts.patientId, opts.sourceDocumentId, membership],
      )
    ).rows[0].id as string;
    const pageId = (
      await admin.query(
        `INSERT INTO classified_page (organization_id, intake_upload_batch_id, source_document_id,
           page_range_start, page_range_end, document_type, confidence, classifier_model_version_ref)
         VALUES ($1,$2,$3,1,2,'discharge_summary',0.97,'doclens-cls@test') RETURNING id`,
        [opts.org, batchId, opts.sourceDocumentId],
      )
    ).rows[0].id as string;
    const jobId = (
      await admin.query(
        `INSERT INTO extraction_job (organization_id, classified_page_id, document_type, status,
           extractor_model_version_ref, correlation_id)
         VALUES ($1,$2,'discharge_summary','ready_for_review','doclens-ext@test','f235') RETURNING id`,
        [opts.org, pageId],
      )
    ).rows[0].id as string;
    const candidateIds: string[] = [];
    for (const c of opts.candidates) {
      const env = await cipher.encrypt(opts.org, c.value);
      candidateIds.push(
        (
          await admin.query(
            `INSERT INTO extraction_candidate (organization_id, extraction_job_id, field_path, field_kind,
               risk_level, value_cipher, confidence, source_page, source_bounding_box, sud_detected)
             VALUES ($1,$2,$3,'text',$4,$5,0.95,1,'{"x1":0,"y1":0,"x2":10,"y2":10}'::jsonb,$6)
             RETURNING id`,
            [opts.org, jobId, c.fieldPath, c.riskLevel ?? "low", env, c.sudDetected ?? false],
          )
        ).rows[0].id as string,
      );
    }
    return { batchId, candidateIds };
  }

  async function outboxRows(org: string, eventType: string) {
    const { rows } = await admin.query(
      `SELECT id, status, payload FROM outbox_event WHERE organization_id=$1 AND event_type=$2
       ORDER BY created_at`,
      [org, eventType],
    );
    return rows as Array<{ id: string; status: string; payload: Record<string, unknown> }>;
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f235@x.test')`, [USER]);
    membership = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG_A],
      )
    ).rows[0].id as string;
    actor = { userId: USER, membershipId: membership };

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    const catalog = buildBootOutboxCatalog([M5_OUTBOX_EVENTS, M22_OUTBOX_EVENTS]);
    const publisher = buildTxOutboxPublisher(catalog);
    const as = (callerModule: string) => ({
      publish: (tx: unknown, e: Parameters<typeof publisher.publish>[1]) =>
        publisher.publish(tx as never, { ...e, callerModule } as never),
    });
    const m22Outbox = as("m22") as never;
    const m5Outbox = as("m5") as never;

    svc = createDbDocumentBackend(handle.db, { outbox: m22Outbox, cipher }).service;
    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [
        buildM5ExtractionWritebackConsumer({ db: handle.db, outbox: m5Outbox }),
        buildM22ExtractionBackrefConsumer({ db: handle.db, outbox: m22Outbox }),
      ],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("commits approved low-risk contacts to the resolved patient; SUD, identity and rejected fields never leave review, and no medication reaches M5", async () => {
    const patient = await seedPatient(ORG_A, "MRN-F235-1");
    const doc = await seedSourceDocument(ORG_A, patient);
    const { batchId, candidateIds } = await seedBatch({
      org: ORG_A,
      patientId: patient,
      sourceDocumentId: doc,
      candidates: [
        { fieldPath: "patient.phoneHome", value: "(503) 555-0100" }, // 0 approve
        { fieldPath: "patient.email", value: "Ada@Example.org" }, // 1 approve
        { fieldPath: "patient.address.line1", value: "12 Oak St" }, // 2 approve
        { fieldPath: "patient.address.city", value: "Salem" }, // 3 approve
        { fieldPath: "patient.address.state", value: "or" }, // 4 approve
        { fieldPath: "patient.address.postalCode", value: "97301" }, // 5 approve
        { fieldPath: "patient.preferredName", value: "Adda" }, // 6 approve_with_edit → "Ada"
        { fieldPath: "medications[0].name", value: "Morphine", riskLevel: "high" }, // 7 approve (A1)
        { fieldPath: "patient.phoneMobile", value: "503-555-0177", sudDetected: true }, // 8 approve (SUD)
        { fieldPath: "patient.legalLastName", value: "Byron" }, // 9 approve (identity, B)
        { fieldPath: "patient.phoneMobile", value: "503-555-0188" }, // 10 reject
      ],
    });

    const review = await svc.openReview(ORG_A, actor, batchId);
    const decide = (i: number, decision: string, editedValue?: string) =>
      svc.recordDecision(ORG_A, actor, review.id, {
        candidateId: candidateIds[i] as string,
        decision,
        ...(editedValue !== undefined ? { editedValue } : {}),
      });
    for (const i of [0, 1, 2, 3, 4, 5, 7, 8, 9]) await decide(i, "approve");
    await decide(6, "approve_with_edit", "Ada");
    await decide(10, "reject");

    const done = await svc.completeReview(ORG_A, actor, review.id);
    expect(done.status).toBe("complete");
    expect(done.writeback?.targetModule).toBe("m5");
    expect(done.writeback?.targetAggregateId).toBe(patient);
    expect([...(done.writeback?.committedFieldPaths ?? [])].sort()).toEqual(
      [
        "patient.address.city",
        "patient.address.line1",
        "patient.address.postalCode",
        "patient.address.state",
        "patient.email",
        "patient.phoneHome",
        "patient.preferredName",
      ].sort(),
    );
    const reasons = Object.fromEntries(
      (done.writeback?.excluded ?? []).map((e) => [e.fieldPath, e.reason]),
    );
    expect(reasons).toEqual({
      "medications[0].name": "not_a_writeback_target",
      "patient.phoneMobile": "sud_detected",
      "patient.legalLastName": "not_a_writeback_target",
    });

    // The commit event: one, carrying ONLY the allowlisted values — no medication, no SUD-flagged value.
    const commits = await outboxRows(ORG_A, "m22.extraction.commit_requested");
    expect(commits).toHaveLength(1);
    const wire = JSON.stringify(commits[0]?.payload);
    expect(wire).not.toContain("Morphine");
    expect(wire).not.toContain("0177");
    expect(wire).not.toContain("Byron");
    expect(commits[0]?.payload).toMatchObject({
      extractionCommitId: review.id,
      targetModule: "m5",
      targetAggregateId: patient,
      sourceDocumentIds: [doc],
    });
    // The DB never held the plaintext of an extracted value.
    const plain = await admin.query(
      "SELECT count(*)::int AS n FROM extraction_candidate WHERE value_text IS NOT NULL",
    );
    expect(plain.rows[0].n).toBe(0);

    const prov = await admin.query(
      `SELECT target_field_path, target_aggregate_id, source_document_version_id FROM extraction_provenance
       WHERE organization_id=$1 AND target_module='m5' ORDER BY target_field_path`,
      [ORG_A],
    );
    expect(prov.rows).toHaveLength(7);
    expect(prov.rows.every((r) => r.target_aggregate_id === null)).toBe(true);
    // F-238 — the approved medication line is no longer only review evidence: it is committed to M12 as a
    // reconciliation-only medication-history line (its own event + provenance row), never to M5 and never
    // as a medication_order. Its M12 consumer is not bound in this suite (see the F-238 live suite).
    const medProv = await admin.query(
      `SELECT target_field_path FROM extraction_provenance WHERE organization_id=$1 AND target_module='m12'`,
      [ORG_A],
    );
    expect(medProv.rows).toEqual([{ target_field_path: "medications[0].name" }]);

    // Hop 1: M5 applies. Hop 2: M22 stamps provenance.
    await dispatcher.tick();
    await dispatcher.tick();

    const phones = await admin.query(
      "SELECT kind, e164, is_primary FROM patient_phone WHERE patient_id=$1",
      [patient],
    );
    expect(phones.rows).toEqual([{ kind: "home", e164: "+15035550100", is_primary: false }]);
    const emails = await admin.query("SELECT email FROM patient_email WHERE patient_id=$1", [
      patient,
    ]);
    expect(emails.rows).toEqual([{ email: "ada@example.org" }]);
    const addrs = await admin.query(
      "SELECT line1, city, state, postal_code, is_primary FROM patient_address WHERE patient_id=$1",
      [patient],
    );
    expect(addrs.rows).toEqual([
      { line1: "12 Oak St", city: "Salem", state: "OR", postal_code: "97301", is_primary: false },
    ]);
    const alias = await admin.query(
      "SELECT kind, full_name FROM patient_name_alias WHERE patient_id=$1",
      [patient],
    );
    expect(alias.rows).toEqual([{ kind: "preferred", full_name: "Ada" }]);
    const p = await admin.query("SELECT legal_last_name FROM patient WHERE id=$1", [patient]);
    expect(p.rows[0].legal_last_name).toBe("Lovelace"); // identity untouched (B)

    const updated = await outboxRows(ORG_A, "m5.patient.updated");
    expect(updated).toHaveLength(1);
    expect((updated[0]?.payload.changed as string[]).sort()).toEqual(
      ["address", "email", "phoneHome", "preferredName"].sort(),
    );
    const replies = await outboxRows(ORG_A, "m5.patient.draft_created_from_extraction");
    expect(replies).toHaveLength(1);
    expect(replies[0]?.status).toBe("dispatched");

    const stamped = await admin.query(
      "SELECT count(*)::int AS n FROM extraction_provenance WHERE organization_id=$1 AND target_aggregate_id=$2",
      [ORG_A, patient],
    );
    expect(stamped.rows[0].n).toBe(7);
    const completed = await outboxRows(ORG_A, "m22.extraction.commit_completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.payload).toMatchObject({
      extractionCommitId: review.id,
      targetAggregateId: patient,
      skippedFieldPaths: [],
    });
    expect(completed[0]?.payload.provenanceIds as string[]).toHaveLength(7);

    // Idempotent re-completion: no second commit event.
    const again = await svc.completeReview(ORG_A, actor, review.id);
    expect(again).toEqual({ reviewId: review.id, status: "complete" });
    expect(await outboxRows(ORG_A, "m22.extraction.commit_requested")).toHaveLength(1);

    // Crash-retry redelivery of the commit: nothing new on the chart, a reply of `already_present`, and
    // the back-ref stamps nothing so there is no second terminal event.
    // (Both halves of the crash: the row back to pending AND no receipt — a receipt alone de-dupes.)
    await admin.query("DELETE FROM outbox_consumer_receipt WHERE event_id=$1", [commits[0]?.id]);
    await admin.query(
      "UPDATE outbox_event SET status='pending', next_attempt_at=now() WHERE id=$1",
      [commits[0]?.id],
    );
    await dispatcher.tick();
    await dispatcher.tick();
    const phones2 = await admin.query(
      "SELECT count(*)::int AS n FROM patient_phone WHERE patient_id=$1",
      [patient],
    );
    expect(phones2.rows[0].n).toBe(1);
    expect(await outboxRows(ORG_A, "m5.patient.updated")).toHaveLength(1);
    const replies2 = await outboxRows(ORG_A, "m5.patient.draft_created_from_extraction");
    expect(replies2).toHaveLength(2);
    const outcomes2 = replies2[1]?.payload.fieldOutcomes as Array<{ outcome: string }>;
    expect(outcomes2.every((o) => o.outcome === "already_present")).toBe(true);
    expect(await outboxRows(ORG_A, "m22.extraction.commit_completed")).toHaveLength(1);
  });

  it("a field M5 cannot normalize is skipped, reported back, and its provenance stays unstamped", async () => {
    const patient = await seedPatient(ORG_A, "MRN-F235-2");
    const doc = await seedSourceDocument(ORG_A, patient);
    const { batchId, candidateIds } = await seedBatch({
      org: ORG_A,
      patientId: patient,
      sourceDocumentId: doc,
      candidates: [
        { fieldPath: "patient.phoneHome", value: "ext 4410" },
        { fieldPath: "patient.email", value: "grace@example.org" },
      ],
    });
    const review = await svc.openReview(ORG_A, actor, batchId);
    for (const id of candidateIds) {
      await svc.recordDecision(ORG_A, actor, review.id, { candidateId: id, decision: "approve" });
    }
    await svc.completeReview(ORG_A, actor, review.id);
    await dispatcher.tick();
    await dispatcher.tick();

    const prov = await admin.query(
      `SELECT p.target_field_path, p.target_aggregate_id FROM extraction_provenance p
       JOIN extraction_decision d ON d.id = p.extraction_decision_id
       WHERE d.extraction_review_id=$1 ORDER BY p.target_field_path`,
      [review.id],
    );
    expect(prov.rows).toEqual([
      { target_field_path: "patient.email", target_aggregate_id: patient },
      { target_field_path: "patient.phoneHome", target_aggregate_id: null },
    ]);
    const completed = (await outboxRows(ORG_A, "m22.extraction.commit_completed")).find(
      (r) => r.payload.extractionCommitId === review.id,
    );
    expect(completed?.payload.skippedFieldPaths).toEqual(["patient.phoneHome"]);
    const phones = await admin.query(
      "SELECT count(*)::int AS n FROM patient_phone WHERE patient_id=$1",
      [patient],
    );
    expect(phones.rows[0].n).toBe(0);
  });

  it("B — a batch with no resolved patient completes with nothing written back and no commit event", async () => {
    const doc = await seedSourceDocument(ORG_A, null);
    const { batchId, candidateIds } = await seedBatch({
      org: ORG_A,
      patientId: null,
      sourceDocumentId: doc,
      candidates: [{ fieldPath: "patient.phoneHome", value: "503-555-0123" }],
    });
    const before = (await outboxRows(ORG_A, "m22.extraction.commit_requested")).length;
    const review = await svc.openReview(ORG_A, actor, batchId);
    await svc.recordDecision(ORG_A, actor, review.id, {
      candidateId: candidateIds[0] as string,
      decision: "approve",
    });
    const done = await svc.completeReview(ORG_A, actor, review.id);
    expect(done.writeback?.targetModule).toBeNull();
    expect(done.writeback?.excluded).toMatchObject([{ reason: "patient_unresolved" }]);
    expect(await outboxRows(ORG_A, "m22.extraction.commit_requested")).toHaveLength(before);
  });

  it("refuses to complete (409, review stays in progress) when the source document was never filed", async () => {
    const patient = await seedPatient(ORG_A, "MRN-F235-3");
    const unfiled = "99999999-9999-4999-8999-999999999999";
    const { batchId, candidateIds } = await seedBatch({
      org: ORG_A,
      patientId: patient,
      sourceDocumentId: unfiled,
      candidates: [{ fieldPath: "patient.phoneHome", value: "503-555-0124" }],
    });
    const review = await svc.openReview(ORG_A, actor, batchId);
    await svc.recordDecision(ORG_A, actor, review.id, {
      candidateId: candidateIds[0] as string,
      decision: "approve",
    });
    await expect(svc.completeReview(ORG_A, actor, review.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    const r = await admin.query("SELECT status FROM extraction_review WHERE id=$1", [review.id]);
    expect(r.rows[0].status).toBe("in_progress");
    const prov = await admin.query(
      `SELECT count(*)::int AS n FROM extraction_provenance p JOIN extraction_decision d
       ON d.id = p.extraction_decision_id WHERE d.extraction_review_id=$1`,
      [review.id],
    );
    expect(prov.rows[0].n).toBe(0);
  });

  it("RLS — org B cannot complete org A's review, and a cross-tenant ciphertext will not decrypt", async () => {
    const patient = await seedPatient(ORG_A, "MRN-F235-4");
    const doc = await seedSourceDocument(ORG_A, patient);
    const { batchId } = await seedBatch({
      org: ORG_A,
      patientId: patient,
      sourceDocumentId: doc,
      candidates: [{ fieldPath: "patient.phoneHome", value: "503-555-0125" }],
    });
    const review = await svc.openReview(ORG_A, actor, batchId);
    await expect(svc.completeReview(ORG_B, actor, review.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    const env = await cipher.encrypt(ORG_A, "503-555-0125");
    await expect(cipher.decrypt(ORG_B, env)).rejects.toThrow();
  });
});
