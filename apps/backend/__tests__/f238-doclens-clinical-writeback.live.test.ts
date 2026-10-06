/**
 * F-238 — LIVE Postgres proof of the DocLens → M12 medication-history and → M5 allergy writeback, end to end.
 *
 * Nothing on the path is stubbed: M22's real `createDbDocumentBackend` (as the NOBYPASSRLS `wardenx_app`
 * role) records the reviewer's decisions and completes the review — decrypting stored candidate values with
 * the real tenant-DEK cipher, writing `extraction_provenance`, and publishing
 * `m22.extraction.medication_history_requested` / `m22.extraction.allergies_requested` through the REAL
 * catalog-validating publisher; the real `createOutboxDispatcher` delivers them to M12's real
 * `m12.extraction-medication-history` and M5's real `m5.extraction-allergy-writeback`, and their replies to
 * M22's real `m22.extraction-clinical-writeback-backref`. The M12 reconcile path is the real DB backend; the
 * M5 allergy routes are the real Fastify handlers over the app-role connection.
 *
 * Governance asserted throughout: `medication_order` stays EMPTY (M12 D12 / AI Governance §2.1.1) — DocLens
 * medication lines become reconciliation-only history rows, and reconciling one mints nothing.
 *
 * Seeded rather than produced: the `classified_page` / `extraction_job` / `extraction_candidate` rows (the
 * F-235 suite's reasoning — the pipeline's AI capabilities are not promoted in a test DB), values encrypted
 * by the real cipher.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:f238:doclens-clinical-writeback:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  registerPredicateIdempotent,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { type DbClient, createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { buildServer } from "../src/bootstrap/index";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  M5_OUTBOX_EVENTS,
  buildM5ExtractionAllergyConsumer,
  buildM5ExtractionWritebackConsumer,
  registerPatientAllergyRoutes,
} from "../src/modules/05-patient/index";
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/index";
import {
  M12_OUTBOX_EVENTS,
  buildM12ExtractionMedicationHistoryConsumer,
  createDbDoseSpotBackend,
} from "../src/modules/12-dosespot/index";
import {
  M22_OUTBOX_EVENTS,
  buildM22ExtractionBackrefConsumer,
  buildM22ExtractionClinicalBackrefConsumer,
  createCandidateValueCipher,
  createDbDocumentBackend,
  createProspectSummaryService,
} from "../src/modules/22-documents/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { PASSING_M12_SAFETY_GATES } from "./_m12-safety-gates";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const USER_B = "55555555-5555-5555-5555-555555555555";

describe.skipIf(!DB_URL)(
  "F-238 — DocLens → M12 medication history + M5 allergies — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let svc: ReturnType<typeof createDbDocumentBackend>["service"];
    let m12: ReturnType<typeof createDbDoseSpotBackend>;
    let dispatcher: ReturnType<typeof createOutboxDispatcher>;
    let app: FastifyInstance;
    let membership: string;
    let membershipB: string;
    let actor: { userId: string; membershipId: string };
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

    async function applyMigrations() {
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const r of ROLES)
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
        );
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

    async function seedSourceDocument(org: string, patientId: string): Promise<string> {
      const doc = (
        await admin.query(
          `INSERT INTO document (organization_id, patient_id, retention_class, source_kind, aggregate_type,
           title, created_by_membership_id)
         VALUES ($1,$2,'intake_artifact','fax_ingest','other','Referral fax',$3) RETURNING id`,
          [org, patientId, org === ORG_A ? membership : membershipB],
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
      patientId: string;
      sourceDocumentId: string;
      candidates: SeedCandidate[];
    }): Promise<{ batchId: string; candidateIds: string[] }> {
      const by = opts.org === ORG_A ? membership : membershipB;
      const batchId = (
        await admin.query(
          `INSERT INTO intake_upload_batch (organization_id, patient_id, initial_document_id, source_channel,
           uploaded_by_membership_id, correlation_id, status)
         VALUES ($1,$2,$3,'fax',$4,gen_random_uuid(),'extraction_complete') RETURNING id`,
          [opts.org, opts.patientId, opts.sourceDocumentId, by],
        )
      ).rows[0].id as string;
      const pageId = (
        await admin.query(
          `INSERT INTO classified_page (organization_id, intake_upload_batch_id, source_document_id,
           page_range_start, page_range_end, document_type, confidence, classifier_model_version_ref)
         VALUES ($1,$2,$3,1,3,'med_recon',0.97,'doclens-cls@test') RETURNING id`,
          [opts.org, batchId, opts.sourceDocumentId],
        )
      ).rows[0].id as string;
      const jobId = (
        await admin.query(
          `INSERT INTO extraction_job (organization_id, classified_page_id, document_type, status,
           extractor_model_version_ref, correlation_id)
         VALUES ($1,$2,'med_recon','ready_for_review','doclens-ext@test','f238') RETURNING id`,
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
             VALUES ($1,$2,$3,'text',$4,$5,0.95,2,'{"x1":0,"y1":0,"x2":10,"y2":10}'::jsonb,$6)
             RETURNING id`,
              [opts.org, jobId, c.fieldPath, c.riskLevel ?? "high", env, c.sudDetected ?? false],
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
    const count = async (sql: string, params: unknown[] = []): Promise<number> =>
      (await admin.query(sql, params)).rows[0].n as number;

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await applyMigrations();
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
        [ORG_A, ORG_B],
      );
      await admin.query(
        `INSERT INTO "user" (id,email) VALUES ($1,'f238@x.test'),($2,'f238b@x.test')`,
        [USER, USER_B],
      );
      membership = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [USER, ORG_A],
        )
      ).rows[0].id as string;
      membershipB = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [USER_B, ORG_B],
        )
      ).rows[0].id as string;
      actor = { userId: USER, membershipId: membership };

      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      const catalog = buildBootOutboxCatalog([
        M5_OUTBOX_EVENTS,
        M12_OUTBOX_EVENTS,
        M22_OUTBOX_EVENTS,
      ]);
      const publisher = buildTxOutboxPublisher(catalog);
      const as = (callerModule: string) => ({
        publish: (tx: unknown, e: Parameters<typeof publisher.publish>[1]) =>
          publisher.publish(tx as never, { ...e, callerModule } as never),
      });
      const m22Outbox = as("m22") as never;
      const m5Outbox = as("m5") as never;
      const m12Outbox = as("m12") as never;

      svc = createDbDocumentBackend(handle.db, { outbox: m22Outbox, cipher }).service;
      m12 = createDbDoseSpotBackend(handle.db, m12Outbox, PASSING_M12_SAFETY_GATES);
      const orgs: ActiveOrgEnumerator = {
        listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
      };
      dispatcher = createOutboxDispatcher({
        db: handle.db,
        orgs,
        consumers: [
          buildM5ExtractionWritebackConsumer({ db: handle.db, outbox: m5Outbox }),
          buildM22ExtractionBackrefConsumer({ db: handle.db, outbox: m22Outbox }),
          buildM12ExtractionMedicationHistoryConsumer({ db: handle.db, outbox: m12Outbox }),
          buildM5ExtractionAllergyConsumer({ db: handle.db, outbox: m5Outbox }),
          buildM22ExtractionClinicalBackrefConsumer({ db: handle.db, outbox: m22Outbox }),
        ],
        eventCatalog: catalog,
        options: { log: () => {} },
      });

      // The M5 allergy routes, on the real app-role connection, behind the real permission + ABAC guards.
      resetAuthorizationContract();
      resetRbacEngine();
      registerEffectivePermissionResolver(
        createInMemoryEffectivePermissionStore([
          {
            orgId: ORG_A,
            userId: USER,
            grants: [
              {
                roleKey: "rn",
                enabled: true,
                expiresAt: null,
                permissionKeys: ["patient.read", "patient.edit"],
              },
            ],
          },
          {
            orgId: ORG_B,
            userId: USER_B,
            grants: [
              {
                roleKey: "rn",
                enabled: true,
                expiresAt: null,
                permissionKeys: ["patient.read", "patient.edit"],
              },
            ],
          },
        ]).store,
      );
      registerAbacRegistry();
      const predicates = buildCarePlanAbacPredicates({
        resolver: {
          async loadPlan() {
            return null;
          },
          async loadProblem() {
            return null;
          },
          async loadVersion() {
            return null;
          },
        },
        // Both test users are "on the caseload" of any patient id — the cross-tenant denial below is
        // therefore proven by RLS on the app-role connection, not by the guard.
        async isInCaseload() {
          return true;
        },
      });
      registerPredicateIdempotent("caseload_or_scope", predicates.caseload_or_scope);
      const headerAuth = (request: FastifyRequest): void => {
        const user = request.headers["x-test-user"];
        if (typeof user !== "string" || user.length === 0) return;
        request.context.userId = user;
        request.context.organizationId = user === USER ? ORG_A : ORG_B;
        request.context.roles = ["rn"];
        request.context.attributes = {
          ...request.context.attributes,
          membershipId: user === USER ? membership : membershipB,
        };
      };
      app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
      registerPatientAllergyRoutes(app, { db: handle.db as DbClient });
      await app.ready();
    }, 240_000);

    afterAll(async () => {
      await app?.close();
      resetAuthorizationContract();
      resetRbacEngine();
      await handle?.close();
      if (admin) await admin.end();
    });

    let patient: string;
    let historyIds: string[] = [];
    let allergyId: string;

    it("commits approved medication lines as reconciliation-only history and allergy lines as UNVERIFIED allergies; MAT, SUD-page and rejected lines never leave review; no medication_order", async () => {
      patient = await seedPatient(ORG_A, "MRN-F238-1");
      const doc = await seedSourceDocument(ORG_A, patient);
      const { batchId, candidateIds } = await seedBatch({
        org: ORG_A,
        patientId: patient,
        sourceDocumentId: doc,
        candidates: [
          { fieldPath: "medications[0].name", value: "Morphine sulfate 5 mg PO q4h PRN pain" }, // 0 approve
          { fieldPath: "medications[1].name", value: "Lasix 20 mg daily" }, // 1 edit → 40 mg
          { fieldPath: "medications[2].name", value: "Suboxone 8 mg/2 mg SL daily" }, // 2 approve (MAT)
          { fieldPath: "medications[3].name", value: "Lorazepam 0.5 mg", sudDetected: true }, // 3 (SUD page)
          { fieldPath: "medications[4].name", value: "Senna 8.6 mg HS" }, // 4 reject
          { fieldPath: "allergies[0].substance", value: "Penicillin - hives" }, // 5 approve
          { fieldPath: "patient.phoneHome", value: "(503) 555-0100", riskLevel: "low" }, // 6 approve (M5 demo)
        ],
      });
      const review = await svc.openReview(ORG_A, actor, batchId);
      const decide = (i: number, decision: string, editedValue?: string) =>
        svc.recordDecision(ORG_A, actor, review.id, {
          candidateId: candidateIds[i] as string,
          decision,
          ...(editedValue !== undefined ? { editedValue } : {}),
        });
      for (const i of [0, 2, 3, 5, 6]) await decide(i, "approve");
      await decide(1, "approve_with_edit", "Furosemide 40 mg PO daily");
      await decide(4, "reject");

      const done = await svc.completeReview(ORG_A, actor, review.id);
      expect(done.status).toBe("complete");
      expect(done.writeback?.committedFieldPaths).toEqual(["patient.phoneHome"]); // F-235 unchanged
      expect(done.clinicalWriteback).toMatchObject({
        targetPatientId: patient,
        medicationHistoryFieldPaths: ["medications[0].name", "medications[1].name"],
        allergyFieldPaths: ["allergies[0].substance"],
      });
      expect(
        Object.fromEntries(
          (done.clinicalWriteback?.excluded ?? []).map((e) => [e.fieldPath, e.reason]),
        ),
      ).toEqual({
        "medications[2].name": "sud_treatment_medication",
        "medications[3].name": "sud_detected",
      });

      const medReq = await outboxRows(ORG_A, "m22.extraction.medication_history_requested");
      const algReq = await outboxRows(ORG_A, "m22.extraction.allergies_requested");
      expect(medReq).toHaveLength(1);
      expect(algReq).toHaveLength(1);
      const wire = JSON.stringify(medReq[0]?.payload);
      expect(wire).toContain("Furosemide 40 mg PO daily"); // the reviewer's edit, not the extraction
      expect(wire).not.toContain("Lasix");
      expect(wire).not.toContain("Suboxone");
      expect(wire).not.toContain("Lorazepam");
      expect(wire).not.toContain("Senna");
      expect(medReq[0]?.payload).toMatchObject({
        targetModule: "m12",
        targetAggregateId: patient,
        reviewerMembershipId: membership,
        batchSudStatus: "not_detected",
      });

      const prov = await admin.query(
        `SELECT p.target_module, p.target_field_path, p.target_aggregate_id FROM extraction_provenance p
       JOIN extraction_decision d ON d.id = p.extraction_decision_id
       WHERE d.extraction_review_id=$1 ORDER BY p.target_field_path`,
        [review.id],
      );
      expect(prov.rows.map((r) => [r.target_module, r.target_field_path])).toEqual([
        ["m5", "allergies[0].substance"],
        ["m12", "medications[0].name"],
        ["m12", "medications[1].name"],
        ["m5", "patient.phoneHome"],
      ]);
      expect(prov.rows.every((r) => r.target_aggregate_id === null)).toBe(true);

      // Hop 1: M12 / M5 write. Hop 2: M22 stamps provenance.
      await dispatcher.tick();
      await dispatcher.tick();

      const hist = await admin.query(
        `SELECT id, source, drug_name, pull_id, strength, sig_text, rxnorm_rxcui, attested_by_membership_id,
              source_document_id, source_page, line_index, reconciliation_decision
       FROM medication_history_record WHERE patient_id=$1 ORDER BY line_index`,
        [patient],
      );
      expect(hist.rows).toMatchObject([
        {
          source: "doclens_intake",
          drug_name: "Morphine sulfate 5 mg PO q4h PRN pain",
          pull_id: null,
          strength: null,
          sig_text: null,
          rxnorm_rxcui: null,
          attested_by_membership_id: membership,
          source_document_id: doc,
          source_page: 2,
          line_index: 0,
          reconciliation_decision: null,
        },
        { source: "doclens_intake", drug_name: "Furosemide 40 mg PO daily", line_index: 1 },
      ]);
      historyIds = hist.rows.map((r) => r.id as string);

      const alg = await admin.query(
        `SELECT id, allergen_text, verification_status, source, reaction, severity, reported_by_membership_id,
              source_extraction_commit_id
       FROM patient_allergy WHERE patient_id=$1`,
        [patient],
      );
      expect(alg.rows).toMatchObject([
        {
          allergen_text: "Penicillin - hives",
          verification_status: "unverified",
          source: "intake_extraction",
          reaction: null,
          severity: null,
          reported_by_membership_id: membership,
          source_extraction_commit_id: review.id,
        },
      ]);
      allergyId = alg.rows[0].id as string;

      // Provenance: each clinical line stamped with the ROW it produced.
      const stamped = await admin.query(
        `SELECT p.target_field_path, p.target_aggregate_id FROM extraction_provenance p
       JOIN extraction_decision d ON d.id = p.extraction_decision_id
       WHERE d.extraction_review_id=$1 AND p.target_module IN ('m12','m5')
         AND p.target_field_path <> 'patient.phoneHome' ORDER BY p.target_field_path`,
        [review.id],
      );
      expect(stamped.rows).toEqual([
        { target_field_path: "allergies[0].substance", target_aggregate_id: allergyId },
        { target_field_path: "medications[0].name", target_aggregate_id: historyIds[0] },
        { target_field_path: "medications[1].name", target_aggregate_id: historyIds[1] },
      ]);
      const completed = await outboxRows(ORG_A, "m22.extraction.commit_completed");
      expect(completed.map((c) => c.payload.targetModule).sort()).toEqual(["m12", "m5", "m5"]);

      // The audit trigger scrubbed the allergen text.
      const audit = await admin.query(
        "SELECT after FROM audit_event WHERE resource_kind='patient_allergy' AND resource_id=$1",
        [allergyId],
      );
      expect(audit.rows).toHaveLength(1);
      expect(JSON.stringify(audit.rows[0].after)).not.toContain("Penicillin");

      // GOVERNANCE — no medication order exists anywhere.
      expect(await count("SELECT count(*)::int AS n FROM medication_order")).toBe(0);
    });

    it("is idempotent on redelivery (already_present) and flags a second fax's repeated lines as duplicates", async () => {
      // Crash-retry redelivery of the medication commit: nothing new, no second terminal event.
      const [medReq] = await outboxRows(ORG_A, "m22.extraction.medication_history_requested");
      const completedBefore = (await outboxRows(ORG_A, "m22.extraction.commit_completed")).length;
      await admin.query("DELETE FROM outbox_consumer_receipt WHERE event_id=$1", [medReq?.id]);
      await admin.query(
        "UPDATE outbox_event SET status='pending', next_attempt_at=now() WHERE id=$1",
        [medReq?.id],
      );
      await dispatcher.tick();
      await dispatcher.tick();
      expect(
        await count(
          "SELECT count(*)::int AS n FROM medication_history_record WHERE patient_id=$1",
          [patient],
        ),
      ).toBe(2);
      const replies = await outboxRows(
        ORG_A,
        "m12.medication_history_record.draft_created_from_extraction",
      );
      expect(replies).toHaveLength(2);
      expect(
        (replies[1]?.payload.lineOutcomes as Array<{ outcome: string }>).every(
          (o) => o.outcome === "already_present",
        ),
      ).toBe(true);
      expect(await outboxRows(ORG_A, "m22.extraction.commit_completed")).toHaveLength(
        completedBefore,
      );

      // A SECOND referral fax for the same patient repeating the same lines (different case/spacing).
      const doc2 = await seedSourceDocument(ORG_A, patient);
      const { batchId, candidateIds } = await seedBatch({
        org: ORG_A,
        patientId: patient,
        sourceDocumentId: doc2,
        candidates: [
          { fieldPath: "medications[0].name", value: "morphine sulfate 5 mg po  q4h prn pain." },
          { fieldPath: "allergies[0].substance", value: "PENICILLIN - HIVES" },
        ],
      });
      const review = await svc.openReview(ORG_A, actor, batchId);
      for (const id of candidateIds)
        await svc.recordDecision(ORG_A, actor, review.id, { candidateId: id, decision: "approve" });
      await svc.completeReview(ORG_A, actor, review.id);
      await dispatcher.tick();
      await dispatcher.tick();

      expect(
        await count(
          "SELECT count(*)::int AS n FROM medication_history_record WHERE patient_id=$1",
          [patient],
        ),
      ).toBe(2);
      expect(
        await count("SELECT count(*)::int AS n FROM patient_allergy WHERE patient_id=$1", [
          patient,
        ]),
      ).toBe(1);
      const dupReply = (
        await outboxRows(ORG_A, "m5.patient_allergy.draft_created_from_extraction")
      ).find((r) => r.payload.extractionCommitId === review.id);
      expect(dupReply?.payload.lineOutcomes).toEqual([
        { candidateId: candidateIds[1], outcome: "duplicate", recordId: allergyId },
      ]);
      // The repeat's provenance points at the row the chart already holds.
      const prov = await admin.query(
        `SELECT p.target_field_path, p.target_aggregate_id FROM extraction_provenance p
       JOIN extraction_decision d ON d.id = p.extraction_decision_id
       WHERE d.extraction_review_id=$1 ORDER BY p.target_field_path`,
        [review.id],
      );
      expect(prov.rows).toEqual([
        { target_field_path: "allergies[0].substance", target_aggregate_id: allergyId },
        { target_field_path: "medications[0].name", target_aggregate_id: historyIds[0] },
      ]);
    });

    it("M12 — the history read labels DocLens rows; reconciling one records the decision and mints NO order", async () => {
      const { records } = await m12.medicationHistory(ORG_A, patient);
      expect(records.map((r) => [r.source, r.drugName]).sort()).toEqual(
        [
          ["doclens_intake", "Furosemide 40 mg PO daily"],
          ["doclens_intake", "Morphine sulfate 5 mg PO q4h PRN pain"],
        ].sort(),
      );
      expect(records[0]).toMatchObject({
        attestedByMembershipId: membership,
        reconciliationDecision: null,
      });

      const res = await m12.reconcileHistory(
        ORG_A,
        membership,
        historyIds[0] as string,
        "carry_forward",
      );
      expect(res).toEqual({ resultingOrderId: null });
      const row = await admin.query(
        "SELECT reconciliation_decision, reconciled_by_membership_id FROM medication_history_record WHERE id=$1",
        [historyIds[0]],
      );
      expect(row.rows[0]).toEqual({
        reconciliation_decision: "carry_forward",
        reconciled_by_membership_id: membership,
      });
      const ev = await outboxRows(ORG_A, "m12.medication_history_reconciled");
      expect(ev.at(-1)?.payload).toEqual({
        historyRecordId: historyIds[0],
        decision: "carry_forward",
        resultingOrderId: null,
      });
      await expect(
        m12.reconcileHistory(ORG_A, membership, historyIds[0] as string, "discontinue"),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await count("SELECT count(*)::int AS n FROM medication_order")).toBe(0);
    });

    it("M5 — the allergy list shows the unverified row; verify and entered-in-error are clinician acts with attribution", async () => {
      const A = { "x-test-user": USER };
      const list = await app.inject({
        method: "GET",
        url: `/api/v1/patients/${patient}/allergies`,
        headers: A,
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().allergies).toMatchObject([
        {
          id: allergyId,
          verificationStatus: "unverified",
          source: "intake_extraction",
          sourcePage: 2,
        },
      ]);

      const v = await app.inject({
        method: "POST",
        url: `/api/v1/patients/${patient}/allergies/${allergyId}/verify`,
        headers: A,
        payload: { severity: "moderate", reaction: "hives" },
      });
      expect(v.statusCode).toBe(200);
      expect(v.json()).toMatchObject({
        verificationStatus: "verified",
        severity: "moderate",
        reaction: "hives",
      });
      const again = await app.inject({
        method: "POST",
        url: `/api/v1/patients/${patient}/allergies/${allergyId}/verify`,
        headers: A,
        payload: {},
      });
      expect(again.statusCode).toBe(409);
      const noReason = await app.inject({
        method: "POST",
        url: `/api/v1/patients/${patient}/allergies/${allergyId}/entered-in-error`,
        headers: A,
        payload: {},
      });
      expect(noReason.statusCode).toBe(422);
      const eie = await app.inject({
        method: "POST",
        url: `/api/v1/patients/${patient}/allergies/${allergyId}/entered-in-error`,
        headers: A,
        payload: { reason: "Wrong patient's fax page" },
      });
      expect(eie.statusCode).toBe(200);
      expect(eie.json().verificationStatus).toBe("entered_in_error");
      const row = await admin.query(
        `SELECT verified_by_membership_id, entered_in_error_by_membership_id, entered_in_error_reason
       FROM patient_allergy WHERE id=$1`,
        [allergyId],
      );
      expect(row.rows[0]).toEqual({
        verified_by_membership_id: membership,
        entered_in_error_by_membership_id: membership,
        entered_in_error_reason: "Wrong patient's fax page",
      });
      // The DB itself refuses a status without its attribution (shape CHECKs), even as the app role.
      await expect(
        withOrgContext(handle.db, { organizationId: ORG_A, userId: USER }, (tx) =>
          (tx as DbClient).execute(
            sql`UPDATE patient_allergy SET entered_in_error_reason=NULL WHERE id=${allergyId}`,
          ),
        ),
      ).rejects.toThrow();
    });

    it("RLS as the NOBYPASSRLS app role — org B can neither read nor change org A's allergies or history", async () => {
      const B = { "x-test-user": USER_B };
      const list = await app.inject({
        method: "GET",
        url: `/api/v1/patients/${patient}/allergies`,
        headers: B,
      });
      expect(list.statusCode).toBe(404);
      const v = await app.inject({
        method: "POST",
        url: `/api/v1/patients/${patient}/allergies/${allergyId}/entered-in-error`,
        headers: B,
        payload: { reason: "cross-tenant attempt" },
      });
      expect(v.statusCode).toBe(404);

      const seen = await withOrgContext(
        handle.db,
        { organizationId: ORG_B, userId: USER_B },
        async (tx) => {
          const r1 = await (tx as DbClient).execute(
            sql`SELECT count(*)::int AS n FROM patient_allergy`,
          );
          const r2 = await (tx as DbClient).execute(
            sql`SELECT count(*)::int AS n FROM medication_history_record`,
          );
          return [r1, r2] as unknown as Array<{ rows: Array<{ n: number }> }>;
        },
      );
      expect(seen.map((r) => r.rows[0]?.n)).toEqual([0, 0]);

      expect((await m12.medicationHistory(ORG_B, patient)).records).toEqual([]);
      await expect(
        m12.reconcileHistory(ORG_B, membershipB, historyIds[1] as string, "document_only"),
      ).rejects.toMatchObject({ statusCode: 404 });

      // WITH CHECK: an org-B session cannot write a row stamped with org A.
      await expect(
        withOrgContext(handle.db, { organizationId: ORG_B, userId: USER_B }, (tx) =>
          (tx as DbClient).execute(
            sql`INSERT INTO patient_allergy (organization_id, patient_id, allergen_text, allergen_key, source,
             reported_by_membership_id) VALUES (${ORG_A}, ${patient}, 'x', 'x', 'clinician_entry', ${membershipB})`,
          ),
        ),
      ).rejects.toThrow();

      // A cross-tenant commit payload is refused by the consumer (fail closed → DLQ), never applied.
      const consumer = buildM5ExtractionAllergyConsumer({
        db: handle.db,
        outbox: { publish: async () => {} },
      });
      await expect(
        consumer.handle({
          organizationId: ORG_B,
          payload: {
            extractionCommitId: "r",
            organizationId: ORG_A,
            intakeBatchId: "b",
            targetModule: "m5",
            targetAggregateId: patient,
            reviewerMembershipId: membership,
            batchSudStatus: "not_detected",
            lines: [],
            requestedAt: new Date().toISOString(),
          },
        }),
      ).rejects.toThrow(/org/);
      expect(await count("SELECT count(*)::int AS n FROM medication_order")).toBe(0);
    });

    // F-238 prospect summary — the DB reader on the app-role connection: 409 until complete, then only the
    // completed review's approved / edited values (rejected omitted, MAT line withheld), cited; org B 404.
    it("prospect summary: 409 before completion; approved values only once complete; RLS hides it from org B", async () => {
      const summaries = createProspectSummaryService({ db: handle.db as DbClient, cipher });
      const p = await seedPatient(ORG_A, "MRN-F238-SUM");
      const doc = await seedSourceDocument(ORG_A, p);
      const { batchId, candidateIds } = await seedBatch({
        org: ORG_A,
        patientId: p,
        sourceDocumentId: doc,
        candidates: [
          { fieldPath: "medications[0].name", value: "Metoprolol 25 mg PO BID" }, // 0 approve
          { fieldPath: "medications[1].name", value: "Lasix 20 mg daily" }, // 1 edit
          { fieldPath: "medications[2].name", value: "Senna 8.6 mg HS" }, // 2 reject
          { fieldPath: "medications[3].name", value: "Methadone 10 mg daily" }, // 3 approve (MAT)
          { fieldPath: "allergies[0].substance", value: "Sulfa - rash" }, // 4 approve
        ],
      });
      const review = await svc.openReview(ORG_A, actor, batchId);
      const decide = (i: number, decision: string, editedValue?: string) =>
        svc.recordDecision(ORG_A, actor, review.id, {
          candidateId: candidateIds[i] as string,
          decision,
          ...(editedValue !== undefined ? { editedValue } : {}),
        });
      for (const i of [0, 3, 4]) await decide(i, "approve");
      await decide(1, "approve_with_edit", "Furosemide 40 mg PO daily");
      await decide(2, "reject");

      await expect(summaries.getSummary(ORG_A, batchId)).rejects.toMatchObject({
        code: "REVIEW_NOT_COMPLETE",
        statusCode: 409,
      });
      await svc.completeReview(ORG_A, actor, review.id);

      const s = await summaries.getSummary(ORG_A, batchId);
      expect(s.reviewId).toBe(review.id);
      expect(s.completedAt).not.toBeNull();
      expect(s.medications.map((m) => [m.text, m.edited])).toEqual([
        ["Metoprolol 25 mg PO BID", false],
        ["Furosemide 40 mg PO daily", true],
      ]);
      expect(s.medications[0]?.citations).toEqual([
        { document: "Medication reconciliation", documentType: "med_recon", page: 2 },
      ]);
      expect(s.allergies.map((a) => a.text)).toEqual(["Sulfa - rash"]);
      expect(s.withheld.part2Values).toBe(1);
      expect(s.plainText).toContain(
        "- Furosemide 40 mg PO daily [corrected by reviewer] (Medication reconciliation p.2)",
      );
      expect(s.plainText).not.toMatch(/Lasix|Senna|Methadone/);

      await expect(summaries.getSummary(ORG_B, batchId)).rejects.toMatchObject({ statusCode: 404 });
      // The patient chart read: the same summary, newest first; nothing for org B (RLS).
      const forPatient = await summaries.listForPatient(ORG_A, p);
      expect(forPatient.items.map((i) => i.batchId)).toEqual([batchId]);
      expect(forPatient.items[0]?.plainText).toBe(s.plainText);
      expect((await summaries.listForPatient(ORG_B, p)).items).toEqual([]);
    });
  },
);
