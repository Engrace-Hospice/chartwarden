/**
 * F-238 dx-writeback — LIVE Postgres proof of the DocLens → M7 DIAGNOSIS writeback, end to end.
 *
 * Nothing on the M22/M7 path is stubbed except the M38 terminology answer (injected so the suite can show
 * `valid` vs `not_valid_as_of` without loading an ICD-10-CM release): M22's real `createDbDocumentBackend`
 * (as the NOBYPASSRLS `chartwarden_app` role) completes the review — decrypting the stored candidates with the
 * real tenant-DEK cipher, writing `extraction_provenance` and publishing
 * `m22.extraction.diagnosis_commit_requested` through the real catalog-validating publisher; the real
 * dispatcher delivers it to M7's `m7.extraction-diagnosis-writeback` (pending `problem_proposal` rows +
 * `m7.problem.draft_created_from_extraction`), then that reply to M22's `m22.extraction-diagnosis-backref`
 * (provenance stamped with the proposal ids + `m22.extraction.commit_completed`). The clinician side is M7's
 * real `createDbProblemProposalService`, and the claim read is M7's real `claimDiagnosesForOrg` — the seam
 * M23 claim assembly sequences diagnoses from.
 *
 * Seeded rather than produced: the DocLens pipeline's `classified_page` / `extraction_job` /
 * `extraction_candidate` rows (the F-235 suite's reason), the patient, and the care plan.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:f238:doclens-dx-writeback:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import type { ProblemProposalIcd10Validation } from "@chartwarden/types";
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
  M7_OUTBOX_EVENTS,
  buildM7ExtractionDiagnosisWritebackConsumer,
  claimDiagnosesForOrg,
  createDbProblemProposalService,
} from "../src/modules/07-care-plan/index";
import {
  M22_OUTBOX_EVENTS,
  buildM22ExtractionBackrefConsumer,
  buildM22ExtractionDiagnosisBackrefConsumer,
  createCandidateValueCipher,
  createDbDocumentBackend,
} from "../src/modules/22-documents/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const RANGE = { from: "2026-01-01", to: "2026-12-31" };

describe.skipIf(!DB_URL)("F-238 — DocLens → M7 diagnosis proposals — LIVE Postgres", () => {
  let admin: Client;
  let appUrl: string;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbDocumentBackend>["service"];
  let proposals: ReturnType<typeof createDbProblemProposalService>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let membership: string;
  let actor: { userId: string; membershipId: string };
  const clinician = () => ({
    userId: USER,
    membershipId: membership,
    sudDisclosureAllowed: true,
  });
  const deks = new Map<string, Buffer>();
  const dekOf = (org: string): Buffer => {
    let k = deks.get(org);
    if (!k) {
      k = randomBytes(32);
      deks.set(org, k);
    }
    return k;
  };
  const cipher = createCandidateValueCipher({
    async dekForOrg(org: string) {
      return { version: "v1", key: dekOf(org) };
    },
    async dekForOrgVersion(org: string, version: string) {
      if (version !== "v1") throw new Error("unknown DEK version");
      return { version, key: dekOf(org) };
    },
  });
  // The injected M38 answer: ICD-10-CM "loaded"; C34.90 / E11.9 / I11.9 / F11.20 exist, I50.1 does not.
  const KNOWN = new Set(["C34.90", "E11.9", "I11.9", "F11.20", "I50.9"]);
  const validateIcd10 = async (codes: readonly string[]) =>
    new Map<string, ProblemProposalIcd10Validation>(
      codes.map((c) => [c, KNOWN.has(c) ? "valid" : "not_valid_as_of"]),
    );

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

  async function seedPatient(org: string, mrn: string): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
         VALUES ($1,$2,'Ada','Lovelace','1940-01-01','F','active') RETURNING id`,
        [org, mrn],
      )
    ).rows[0].id as string;
  }
  async function seedCarePlan(org: string, patientId: string): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO care_plan (organization_id, patient_id, admission_id, status, initial_due_at)
         VALUES ($1,$2,$3,'active', now() + interval '5 days') RETURNING id`,
        [org, patientId, randomUUID()],
      )
    ).rows[0].id as string;
  }
  async function seedActiveProblem(org: string, planId: string, code: string, kind: string) {
    return (
      await admin.query(
        `INSERT INTO problem (organization_id, care_plan_id, icd10_code, description, kind, status)
         VALUES ($1,$2,$3,'seeded charted problem',$4,'active') RETURNING id`,
        [org, planId, code, kind],
      )
    ).rows[0].id as string;
  }
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
  async function seedBatch(opts: {
    org: string;
    patientId: string | null;
    sourceDocumentId: string;
    candidates: SeedCandidate[];
    sudStatus?: string;
  }): Promise<{ batchId: string; jobId: string; candidateIds: string[] }> {
    const batchId = (
      await admin.query(
        `INSERT INTO intake_upload_batch (organization_id, patient_id, initial_document_id, source_channel,
           uploaded_by_membership_id, correlation_id, status, sud_status, sud_resolved_by_membership_id,
           sud_resolved_at)
         VALUES ($1,$2,$3,'fax',$4,gen_random_uuid(),'extraction_complete',$5::intake_batch_sud_status,
           CASE WHEN $5::text IN ('confirmed','rejected') THEN $4::uuid END,
           CASE WHEN $5::text IN ('confirmed','rejected') THEN now() END) RETURNING id`,
        [
          opts.org,
          opts.patientId,
          opts.sourceDocumentId,
          membership,
          opts.sudStatus ?? "not_detected",
        ],
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
         VALUES ($1,$2,'discharge_summary','ready_for_review','doclens-ext@test','f238') RETURNING id`,
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
               risk_level, value_cipher, value_code, confidence, source_page, source_bounding_box, sud_detected)
             VALUES ($1,$2,$3,'text',$4,$5,$6,0.95,1,'{"x1":0,"y1":0,"x2":10,"y2":10}'::jsonb,$7)
             RETURNING id`,
            [
              opts.org,
              jobId,
              c.fieldPath,
              c.riskLevel ?? (c.fieldPath.startsWith("diagnoses") ? "high" : "low"),
              env,
              // A model-assigned code on EVERY candidate — the writeback must never read it.
              "Z00.00",
              c.sudDetected ?? false,
            ],
          )
        ).rows[0].id as string,
      );
    }
    return { batchId, jobId, candidateIds };
  }

  async function outboxRows(org: string, eventType: string) {
    const { rows } = await admin.query(
      `SELECT id, status, payload FROM outbox_event WHERE organization_id=$1 AND event_type=$2
       ORDER BY created_at`,
      [org, eventType],
    );
    return rows as Array<{ id: string; status: string; payload: Record<string, unknown> }>;
  }
  async function proposalRows(patientId: string) {
    const { rows } = await admin.query(
      `SELECT id, description, icd10_code, icd10_source, icd10_validation, document_role, sud_related,
              status, duplicate_of_problem_id, accepted_problem_id, source_item_key, version
         FROM problem_proposal WHERE patient_id=$1 ORDER BY source_item_key`,
      [patientId],
    );
    return rows as Array<Record<string, unknown>>;
  }
  async function completeAll(
    batchId: string,
    candidateIds: string[],
    edits: Record<number, { decision: string; editedCode?: string; editedValue?: string }> = {},
  ) {
    const review = await svc.openReview(ORG_A, actor, batchId);
    for (const [i, id] of candidateIds.entries()) {
      const e = edits[i] ?? { decision: "approve" };
      await svc.recordDecision(ORG_A, actor, review.id, { candidateId: id, ...e });
    }
    const done = await svc.completeReview(ORG_A, actor, review.id);
    return { review, done };
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f238@x.test')`, [USER]);
    membership = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG_A],
      )
    ).rows[0].id as string;
    actor = { userId: USER, membershipId: membership };

    appUrl = await appRoleConnectionString(admin, DB_URL as string);
    expect(LIVE_APP_ROLE_PASSWORD).toBeTruthy();
    handle = createDbClient({ connectionString: appUrl });

    const catalog = buildBootOutboxCatalog([M5_OUTBOX_EVENTS, M7_OUTBOX_EVENTS, M22_OUTBOX_EVENTS]);
    const publisher = buildTxOutboxPublisher(catalog);
    const as = (callerModule: string) => ({
      publish: (tx: unknown, e: Parameters<typeof publisher.publish>[1]) =>
        publisher.publish(tx as never, { ...e, callerModule } as never),
    });
    const m22Outbox = as("m22") as never;
    const m5Outbox = as("m5") as never;
    const m7Outbox = as("m7") as never;

    svc = createDbDocumentBackend(handle.db, { outbox: m22Outbox, cipher }).service;
    proposals = createDbProblemProposalService(handle.db, m7Outbox);
    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [
        buildM5ExtractionWritebackConsumer({ db: handle.db, outbox: m5Outbox }),
        buildM22ExtractionBackrefConsumer({ db: handle.db, outbox: m22Outbox }),
        buildM7ExtractionDiagnosisWritebackConsumer({
          db: handle.db,
          outbox: m7Outbox,
          validateIcd10,
        }),
        buildM22ExtractionDiagnosisBackrefConsumer({ db: handle.db, outbox: m22Outbox }),
      ],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("lands attested diagnoses as PENDING proposals (code as written, never a problem row); accept charts one with the clinician's kind", async () => {
    const patient = await seedPatient(ORG_A, "MRN-F238-1");
    const plan = await seedCarePlan(ORG_A, patient);
    const charted = await seedActiveProblem(ORG_A, plan, "E11.9", "related");
    const doc = await seedSourceDocument(ORG_A, patient);
    const { batchId, jobId, candidateIds } = await seedBatch({
      org: ORG_A,
      patientId: patient,
      sourceDocumentId: doc,
      candidates: [
        { fieldPath: "diagnoses[0].description", value: "Metastatic lung cancer" }, // 0
        { fieldPath: "diagnoses[0].icd10", value: "c34.90" }, // 1
        { fieldPath: "diagnoses[0].role", value: "Principal" }, // 2
        { fieldPath: "diagnoses[1].description", value: "Type 2 diabetes" }, // 3
        { fieldPath: "diagnoses[1].icd10", value: "E11.9" }, // 4
        { fieldPath: "diagnoses[2].description", value: "Hypertension" }, // 5
        { fieldPath: "diagnoses[2].icd10", value: "I10" }, // 6 — reviewer edits to I11.9
        { fieldPath: "diagnoses[3].description", value: "Dementia" }, // 7
        { fieldPath: "diagnoses[3].icd10", value: "dementia NOS" }, // 8 — malformed
        { fieldPath: "diagnoses[4].description", value: "Old MI" }, // 9
        { fieldPath: "diagnoses[4].icd10", value: "I50.1" }, // 10 — not in the loaded release
        { fieldPath: "patient.phoneHome", value: "(503) 555-0100" }, // 11 — the M5 half still runs
      ],
    });
    const { review, done } = await completeAll(batchId, candidateIds, {
      6: { decision: "approve_with_edit", editedCode: "I11.9" },
    });

    expect(done.diagnosisWriteback?.targetModule).toBe("m7");
    expect(done.diagnosisWriteback?.targetAggregateId).toBe(patient);
    expect(done.diagnosisWriteback?.committedItemKeys).toEqual(
      [0, 1, 2, 3, 4].map((i) => `${jobId}#${i}`),
    );
    expect(done.diagnosisWriteback?.excluded).toEqual([
      { candidateId: candidateIds[8], fieldPath: "diagnoses[3].icd10", reason: "icd10_malformed" },
    ]);
    // The M5 summary no longer lists the diagnosis paths as not_a_writeback_target.
    expect(done.writeback?.excluded ?? []).toEqual([]);
    expect(done.writeback?.committedFieldPaths).toEqual(["patient.phoneHome"]);

    const commits = await outboxRows(ORG_A, "m22.extraction.diagnosis_commit_requested");
    expect(commits).toHaveLength(1);
    const wire = JSON.stringify(commits[0]?.payload);
    expect(wire).not.toContain("Z00.00"); // the model-assigned code never travels
    expect(wire).not.toContain('"kind"');
    expect(commits[0]?.payload).toMatchObject({ targetModule: "m7", targetAggregateId: patient });

    // Hop 1: M5 + M7 apply. Hop 2: M22 stamps both back-refs.
    await dispatcher.tick();
    await dispatcher.tick();

    const rows = await proposalRows(patient);
    expect(
      rows.map((r) => [r.description, r.icd10_code, r.icd10_source, r.icd10_validation]),
    ).toEqual([
      ["Metastatic lung cancer", "C34.90", "document", "valid"],
      ["Type 2 diabetes", "E11.9", "document", "valid"],
      ["Hypertension", "I11.9", "reviewer_edit", "valid"],
      ["Dementia", null, null, null],
      ["Old MI", "I50.1", "document", "not_valid_as_of"], // kept, flagged — never dropped
    ]);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    expect(rows[0]?.document_role).toBe("principal"); // a label only
    expect(rows[1]?.duplicate_of_problem_id).toBe(charted); // flagged, not merged
    expect(rows[0]?.duplicate_of_problem_id).toBeNull();

    // NOTHING was charted: the only `problem` row is the seeded one, and the claim read sees only it.
    const probs = await admin.query("SELECT id FROM problem WHERE care_plan_id=$1", [plan]);
    expect(probs.rows.map((r) => r.id)).toEqual([charted]);
    const before = await claimDiagnosesForOrg(handle.db, ORG_A, patient, RANGE);
    expect(before.sequence).toEqual([{ position: 1, code: "E11.9", relationship: "related" }]);

    // Back-ref: every committed decision's provenance carries its proposal id.
    const prov = await admin.query(
      `SELECT p.target_field_path, p.target_aggregate_id FROM extraction_provenance p
       JOIN extraction_decision d ON d.id = p.extraction_decision_id
       WHERE d.extraction_review_id=$1 AND p.target_module='m7' ORDER BY p.target_field_path`,
      [review.id],
    );
    const byPath = Object.fromEntries(
      prov.rows.map((r) => [r.target_field_path, r.target_aggregate_id]),
    );
    expect(byPath["diagnoses[0].description"]).toBe(rows[0]?.id);
    expect(byPath["diagnoses[0].icd10"]).toBe(rows[0]?.id);
    expect(byPath["diagnoses[0].role"]).toBe(rows[0]?.id);
    expect(byPath["diagnoses[2].icd10"]).toBe(rows[2]?.id);
    expect(byPath["diagnoses[3].icd10"]).toBeUndefined(); // malformed code: no provenance, no commit
    const completed = (await outboxRows(ORG_A, "m22.extraction.commit_completed")).filter(
      (r) => r.payload.targetModule === "m7",
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]?.payload.provenanceIds as string[]).toHaveLength(prov.rows.length);

    // The clinician's list.
    const listed = await proposals.list(ORG_A, plan, {
      status: "pending",
      sudDisclosureAllowed: false,
    });
    expect(listed.proposals).toHaveLength(5);
    expect(listed.redacted).toBe(false);

    // ACCEPT — the clinician chooses `terminal`; the problem is charted with the visible extraction label.
    const lung = rows[0] as { id: string; version: number };
    const accepted = await proposals.accept(
      ORG_A,
      plan,
      lung.id,
      { ifVersion: lung.version, kind: "terminal" },
      clinician(),
    );
    const prob = await admin.query(
      "SELECT icd10_code, kind, source, status, added_by_membership_id, sud_related FROM problem WHERE id=$1",
      [accepted.problemId],
    );
    expect(prob.rows[0]).toEqual({
      icd10_code: "C34.90",
      kind: "terminal",
      source: "intake_extraction",
      status: "active",
      added_by_membership_id: membership,
      sud_related: false,
    });
    const after = await claimDiagnosesForOrg(handle.db, ORG_A, patient, RANGE);
    expect(after.sequence).toEqual([
      { position: 1, code: "C34.90", relationship: "terminal" },
      { position: 2, code: "E11.9", relationship: "related" },
    ]);
    const added = await outboxRows(ORG_A, "m7.problem.added");
    expect(added.map((r) => r.payload.problemId)).toContain(accepted.problemId);

    // Only a pending proposal can be decided; a stale version is a 412.
    await expect(
      proposals.accept(ORG_A, plan, lung.id, { ifVersion: 2, kind: "related" }, clinician()),
    ).rejects.toMatchObject({ statusCode: 409 });
    const htn = rows[2] as { id: string; version: number };
    await expect(
      proposals.dismiss(ORG_A, plan, htn.id, { ifVersion: htn.version + 5 }, clinician()),
    ).rejects.toMatchObject({ statusCode: 412 });
    // DISMISS — nothing is charted.
    const dismissed = await proposals.dismiss(
      ORG_A,
      plan,
      htn.id,
      { ifVersion: htn.version, reason: "already documented as I10" },
      clinician(),
    );
    expect(dismissed.status).toBe("dismissed");
    const probs2 = await admin.query(
      "SELECT count(*)::int AS n FROM problem WHERE care_plan_id=$1",
      [plan],
    );
    expect(probs2.rows[0].n).toBe(2);
    // A clinician-typed code at accept is validated for shape.
    const dementia = rows[3] as { id: string; version: number };
    await expect(
      proposals.accept(
        ORG_A,
        plan,
        dementia.id,
        { ifVersion: dementia.version, kind: "related", icd10Code: "dementia" },
        clinician(),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });

    // Crash-retry redelivery of the commit: `already_proposed`, no new rows, no second terminal event.
    await admin.query("DELETE FROM outbox_consumer_receipt WHERE event_id=$1", [commits[0]?.id]);
    await admin.query(
      "UPDATE outbox_event SET status='pending', next_attempt_at=now() WHERE id=$1",
      [commits[0]?.id],
    );
    await dispatcher.tick();
    await dispatcher.tick();
    expect(await proposalRows(patient)).toHaveLength(5);
    const replies = await outboxRows(ORG_A, "m7.problem.draft_created_from_extraction");
    const last = replies.at(-1)?.payload.itemOutcomes as Array<{ outcome: string }>;
    expect(last.every((o) => o.outcome === "already_proposed")).toBe(true);
    expect(
      (await outboxRows(ORG_A, "m22.extraction.commit_completed")).filter(
        (r) => r.payload.targetModule === "m7",
      ),
    ).toHaveLength(1);
  });

  it("dedupe: a second referral repeating a PENDING diagnosis reports the existing proposal; no duplicate", async () => {
    const patient = await seedPatient(ORG_A, "MRN-F238-2");
    await seedCarePlan(ORG_A, patient);
    const doc = await seedSourceDocument(ORG_A, patient);
    const first = await seedBatch({
      org: ORG_A,
      patientId: patient,
      sourceDocumentId: doc,
      candidates: [
        { fieldPath: "diagnoses[0].description", value: "COPD" },
        { fieldPath: "diagnoses[0].icd10", value: "J44.9" },
      ],
    });
    await completeAll(first.batchId, first.candidateIds);
    await dispatcher.tick();
    await dispatcher.tick();
    const second = await seedBatch({
      org: ORG_A,
      patientId: patient,
      sourceDocumentId: doc,
      candidates: [
        { fieldPath: "diagnoses[0].description", value: "Chronic obstructive pulmonary disease" },
        { fieldPath: "diagnoses[0].icd10", value: "J449" },
      ],
    });
    const { review } = await completeAll(second.batchId, second.candidateIds);
    await dispatcher.tick();
    await dispatcher.tick();
    const rows = await proposalRows(patient);
    expect(rows).toHaveLength(1);
    const reply = (await outboxRows(ORG_A, "m7.problem.draft_created_from_extraction")).find(
      (r) => r.payload.extractionCommitId === review.id,
    );
    expect(reply?.payload.itemOutcomes).toEqual([
      {
        itemKey: `${second.jobId}#0`,
        outcome: "already_proposed",
        proposalId: rows[0]?.id,
        duplicateOfProblemId: null,
      },
    ]);
    // Both referrals' provenance point at the one proposal.
    const prov = await admin.query(
      "SELECT count(*)::int AS n FROM extraction_provenance WHERE target_aggregate_id=$1",
      [rows[0]?.id],
    );
    expect(prov.rows[0].n).toBe(4);
  });

  it("42 CFR Part 2: a SUD-flagged page stays out; an F11 code goes FLAGGED and is hidden + undecidable without disclosure; a confirmed batch sends nothing SUD", async () => {
    const patient = await seedPatient(ORG_A, "MRN-F238-3");
    const plan = await seedCarePlan(ORG_A, patient);
    const doc = await seedSourceDocument(ORG_A, patient);
    const b = await seedBatch({
      org: ORG_A,
      patientId: patient,
      sourceDocumentId: doc,
      candidates: [
        { fieldPath: "diagnoses[0].description", value: "Chronic pain", sudDetected: true },
        { fieldPath: "diagnoses[1].description", value: "Opioid dependence, uncomplicated" },
        { fieldPath: "diagnoses[1].icd10", value: "F11.20" },
      ],
    });
    const { done } = await completeAll(b.batchId, b.candidateIds);
    expect(done.diagnosisWriteback?.excluded).toEqual([
      {
        candidateId: b.candidateIds[0],
        fieldPath: "diagnoses[0].description",
        reason: "sud_detected",
      },
    ]);
    await dispatcher.tick();
    await dispatcher.tick();
    const rows = await proposalRows(patient);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ icd10_code: "F11.20", sud_related: true });

    const hidden = await proposals.list(ORG_A, plan, { sudDisclosureAllowed: false });
    expect(hidden).toEqual({ proposals: [], redacted: true });
    const shown = await proposals.list(ORG_A, plan, { sudDisclosureAllowed: true });
    expect(shown.proposals).toHaveLength(1);
    const p = rows[0] as { id: string; version: number };
    await expect(
      proposals.accept(
        ORG_A,
        plan,
        p.id,
        { ifVersion: p.version, kind: "related" },
        { ...clinician(), sudDisclosureAllowed: false },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    // Accepted by an entitled clinician, it is charted `sud_related` — so the claim gate's consent rule
    // (unbound M39 ⇒ fail closed) withholds the code from the claim.
    await proposals.accept(
      ORG_A,
      plan,
      p.id,
      { ifVersion: p.version, kind: "related" },
      clinician(),
    );
    const claim = await claimDiagnosesForOrg(handle.db, ORG_A, patient, RANGE);
    expect(claim.sequence).toEqual([]);
    expect(claim.withheldForConsentCount).toBe(1);

    // A CONFIRMED-SUD batch: nothing SUD goes out at all.
    const c = await seedBatch({
      org: ORG_A,
      patientId: patient,
      sourceDocumentId: doc,
      sudStatus: "confirmed",
      candidates: [
        { fieldPath: "diagnoses[0].description", value: "Alcohol dependence" },
        { fieldPath: "diagnoses[0].icd10", value: "F10.20" },
        { fieldPath: "diagnoses[1].description", value: "Heart failure" },
        { fieldPath: "diagnoses[1].icd10", value: "I50.9" },
      ],
    });
    const cDone = await completeAll(c.batchId, c.candidateIds);
    expect(cDone.done.diagnosisWriteback?.committedItemKeys).toEqual([`${c.jobId}#1`]);
    expect(new Set(cDone.done.diagnosisWriteback?.excluded.map((e) => e.reason))).toEqual(
      new Set(["sud_confirmed_batch"]),
    );
    const wire = JSON.stringify(
      (await outboxRows(ORG_A, "m22.extraction.diagnosis_commit_requested")).at(-1)?.payload,
    );
    expect(wire).not.toContain("F10.20");
    expect(wire).not.toContain("Alcohol");
  });

  it("no care plan → every item skipped (`no_care_plan`), nothing created, provenance unstamped; no patient → no commit", async () => {
    const patient = await seedPatient(ORG_A, "MRN-F238-4");
    const doc = await seedSourceDocument(ORG_A, patient);
    const b = await seedBatch({
      org: ORG_A,
      patientId: patient,
      sourceDocumentId: doc,
      candidates: [{ fieldPath: "diagnoses[0].description", value: "CHF" }],
    });
    const { review } = await completeAll(b.batchId, b.candidateIds);
    await dispatcher.tick();
    await dispatcher.tick();
    expect(await proposalRows(patient)).toEqual([]);
    const reply = (await outboxRows(ORG_A, "m7.problem.draft_created_from_extraction")).find(
      (r) => r.payload.extractionCommitId === review.id,
    );
    expect(reply?.payload).toMatchObject({
      carePlanId: null,
      itemOutcomes: [{ itemKey: `${b.jobId}#0`, outcome: "skipped", reason: "no_care_plan" }],
    });
    const prov = await admin.query(
      `SELECT p.target_aggregate_id FROM extraction_provenance p JOIN extraction_decision d
       ON d.id = p.extraction_decision_id WHERE d.extraction_review_id=$1`,
      [review.id],
    );
    expect(prov.rows).toEqual([{ target_aggregate_id: null }]);

    const headless = await seedBatch({
      org: ORG_A,
      patientId: null,
      sourceDocumentId: doc,
      candidates: [{ fieldPath: "diagnoses[0].description", value: "CHF" }],
    });
    const before = (await outboxRows(ORG_A, "m22.extraction.diagnosis_commit_requested")).length;
    const h = await completeAll(headless.batchId, headless.candidateIds);
    expect(h.done.diagnosisWriteback?.targetModule).toBeNull();
    expect(h.done.diagnosisWriteback?.excluded).toMatchObject([{ reason: "patient_unresolved" }]);
    expect(await outboxRows(ORG_A, "m22.extraction.diagnosis_commit_requested")).toHaveLength(
      before,
    );
  });

  it("RLS — as the NOBYPASSRLS app role, org B sees none of org A's proposals and cannot decide them", async () => {
    const patient = await seedPatient(ORG_A, "MRN-F238-5");
    const plan = await seedCarePlan(ORG_A, patient);
    const doc = await seedSourceDocument(ORG_A, patient);
    const b = await seedBatch({
      org: ORG_A,
      patientId: patient,
      sourceDocumentId: doc,
      candidates: [{ fieldPath: "diagnoses[0].description", value: "ALS" }],
    });
    await completeAll(b.batchId, b.candidateIds);
    await dispatcher.tick();
    const [row] = (await proposalRows(patient)) as Array<{ id: string; version: number }>;
    expect(row).toBeDefined();

    await expect(proposals.list(ORG_B, plan, { sudDisclosureAllowed: true })).rejects.toMatchObject(
      {
        statusCode: 404,
      },
    );
    await expect(
      proposals.accept(
        ORG_B,
        plan,
        (row as { id: string }).id,
        { ifVersion: 1, kind: "terminal" },
        clinician(),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    const app = new Client({ connectionString: appUrl });
    await app.connect();
    try {
      const count = async (org: string) => {
        await app.query("BEGIN");
        await app.query("SELECT set_config('app.org_id', $1, true)", [org]);
        const r = await app.query(
          "SELECT count(*)::int AS n FROM problem_proposal WHERE patient_id=$1",
          [patient],
        );
        await app.query("COMMIT");
        return r.rows[0].n as number;
      };
      expect(await count(ORG_A)).toBe(1);
      expect(await count(ORG_B)).toBe(0);
      // And the app role cannot delete a proposal at all (append-only, like every care-plan table).
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
      await expect(
        app.query("DELETE FROM problem_proposal WHERE patient_id=$1", [patient]),
      ).rejects.toThrow(/permission denied/);
      await app.query("ROLLBACK");
    } finally {
      await app.end();
    }
  });
});
