/**
 * F-236 (ADR-0048) — LIVE Postgres proof of the DocLens intake job (stages 2–4) and of the M32 pipeline
 * built from its REAL Drizzle stores.
 *
 * Part 1 — `runDocLensIntake` as the NOBYPASSRLS `chartwarden_app` role: a filed source document, a Docling
 * parse (the REAL docling-worker output for the synthetic fax, served by a fake HTTP client), classifier
 * and extractor seams returning what a model returned, and the real tenant-DEK candidate cipher. Proves
 * grounding drops what it must (invented quote, value not in quote, path not in the schema), the tier is
 * the schema's, values are ciphertext only, a re-run is a no-op, an unfiled source is `parse_failed`, and
 * a refused AI call is `awaiting_capability` — never a silent empty review.
 *
 * Part 2 — `buildLiveAiInvocationPipeline` over the real `ai_capability` / `ai_model_backend` /
 * `ai_tenant_opt_in_record` / `ai_invocation` / `ai_token_ledger` / `organization.settings` rows: a
 * `local_only` pilot tenant is routed to the local backend and the ledger row's payloads are DEK
 * ciphertext; a tenant with no `ai_token_budgets` refuses at the cap gate; `ai.full` off records nothing.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:f236:doclens-intake:live
 */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type ModelBackend, createModelBackendRegistry } from "@chartwarden/ai-platform";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DocLensClassifierPort,
  type DocLensExtractorPort,
  createCandidateValueCipher,
  parseDoclingResponse,
  runDocLensIntake,
} from "../src/modules/22-documents/index";
import {
  buildLiveAiInvocationPipeline,
  createAiPayloadCipher,
} from "../src/modules/32-ai-platform/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "fixtures/docling-referral-parse.json"), "utf8"),
) as unknown;
const PAGES = parseDoclingResponse(FIXTURE).pages;

describe.skipIf(!DB_URL)("F-236 — DocLens intake job + live M32 pipeline — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let membership: string;
  const deks = new Map<string, Buffer>();
  const dek = (org: string) => {
    let k = deks.get(org);
    if (!k) {
      k = randomBytes(32);
      deks.set(org, k);
    }
    return k;
  };
  const keys = {
    dekForOrg: async (org: string) => ({ version: "v1", key: dek(org) }),
    dekForOrgVersion: async (org: string, version: string) => ({ version, key: dek(org) }),
  };
  const candidateCipher = createCandidateValueCipher(keys);

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

  async function seedBatch(org: string, filed: boolean): Promise<string> {
    let documentId = "99999999-9999-4999-8999-999999999999";
    if (filed) {
      documentId = (
        await admin.query(
          `INSERT INTO document (organization_id, retention_class, source_kind, aggregate_type, title,
             created_by_membership_id) VALUES ($1,'intake_artifact','fax_ingest','other','fax',$2) RETURNING id`,
          [org, membership],
        )
      ).rows[0].id as string;
      const v = (
        await admin.query(
          `INSERT INTO document_version (organization_id, document_id, version_number, minio_object_key,
             mime_type, byte_size, sha256_hex, uploaded_by_kind)
           VALUES ($1,$2,'1',$3,'application/pdf','1','abc','system') RETURNING id`,
          [org, documentId, `uploads/${documentId}/other-1`],
        )
      ).rows[0].id as string;
      await admin.query("UPDATE document SET active_version_id=$1 WHERE id=$2", [v, documentId]);
    }
    return (
      await admin.query(
        `INSERT INTO intake_upload_batch (organization_id, initial_document_id, source_channel,
           uploaded_by_membership_id, correlation_id) VALUES ($1,$2,'fax',$3,gen_random_uuid()) RETURNING id`,
        [org, documentId, membership],
      )
    ).rows[0].id as string;
  }

  /** The classifier/extractor answers a model gave on the real fixture (see the smoke run, F-236). */
  const classifier: DocLensClassifierPort = {
    async classify(input) {
      return {
        available: true,
        invocationId: `cls-${input.pageNumber}`,
        documentType: input.pageNumber === 1 ? "transfer_record" : "med_recon",
        confidence: 0.9,
      };
    },
  };
  const extractor: DocLensExtractorPort = {
    async extract(input) {
      const fields: Record<
        string,
        { value: string; confidence: number; sourceQuote: { page: number; text: string } }
      > =
        input.documentType === "transfer_record"
          ? {
              "patient.phoneHome": {
                value: "(503) 555-0142",
                confidence: 0.9,
                sourceQuote: { page: 1, text: "Home   phone:\n(503) 555-0142" },
              },
              "patient.email": {
                value: "mae.doclens@example.org",
                confidence: 0.9,
                sourceQuote: { page: 1, text: "Email:\nmae . doclens@example org" },
              },
              "patient.dateOfBirth": {
                value: "04/12/1938",
                confidence: 0.9,
                sourceQuote: { page: 1, text: "Date of Birth:\n04/12/1938" },
              },
              // invented quote — the fax never says this
              "patient.phoneMobile": {
                value: "503-555-0199",
                confidence: 0.9,
                sourceQuote: { page: 1, text: "Cell: 503-555-0199" },
              },
              // real quote, value "normalised" by the model
              "patient.address.postalCode": {
                value: "97303",
                confidence: 0.9,
                sourceQuote: { page: 1, text: "Salem, OR 97302" },
              },
              // a path the schema does not declare
              "patient.ssn": {
                value: "123",
                confidence: 0.9,
                sourceQuote: { page: 1, text: "Sex: F" },
              },
            }
          : {
              "medications[0].name": {
                value: "Furosemide 40 mg PO daily",
                confidence: 0.95,
                sourceQuote: { page: 2, text: "Furosemide 40 mg PO daily" },
              },
            };
      return { available: true, invocationId: `ext-${input.documentType}`, fields };
    },
  };
  const deps = (over: Partial<Parameters<typeof runDocLensIntake>[0]> = {}) => ({
    db: handle.db,
    docling: {
      parse: async () => ({ doclingVersion: "2.133.0", pages: PAGES }),
      render: async () => {
        throw new Error("F-236 suite runs no stage 5");
      },
    },
    presignSource: async () => "https://minio.invalid/x?sig",
    cipher: candidateCipher,
    classifier: () => classifier,
    extractor: () => extractor,
    ...over,
  });
  const job = (org: string, batchId: string) => ({
    organizationId: org,
    batchId,
    actorUserId: USER,
    correlationId: "c",
  });

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f236@x.test')`, [USER]);
    membership = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG_A],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("parses, classifies per page, extracts per run, grounds, and stores only ciphertext with the schema's tier", async () => {
    const batchId = await seedBatch(ORG_A, true);
    const summary = await runDocLensIntake(deps(), job(ORG_A, batchId));
    expect(summary).toMatchObject({ outcome: "extracted", pages: 2, jobs: 2, candidates: 4 });
    if (summary.outcome === "extracted") {
      expect(summary.dropped).toEqual({
        quote_not_found: 1,
        value_not_in_quote: 1,
        field_not_in_schema: 1,
      });
    }
    const pages = await admin.query(
      `SELECT page_range_start, document_type, classifier_model_version_ref FROM classified_page
       WHERE intake_upload_batch_id=$1 ORDER BY 1`,
      [batchId],
    );
    expect(pages.rows).toEqual([
      {
        page_range_start: 1,
        document_type: "transfer_record",
        classifier_model_version_ref: "ai_invocation:cls-1",
      },
      {
        page_range_start: 2,
        document_type: "med_recon",
        classifier_model_version_ref: "ai_invocation:cls-2",
      },
    ]);
    const cands = await admin.query(
      `SELECT c.field_path, c.risk_level, c.source_page, c.source_bounding_box, c.value_text, c.value_cipher
       FROM extraction_candidate c JOIN extraction_job j ON j.id=c.extraction_job_id
       JOIN classified_page p ON p.id=j.classified_page_id WHERE p.intake_upload_batch_id=$1 ORDER BY 1`,
      [batchId],
    );
    expect(cands.rows.map((r) => [r.field_path, r.risk_level, r.source_page])).toEqual([
      ["medications[0].name", "high", 2],
      ["patient.dateOfBirth", "medium", 1],
      ["patient.email", "low", 1],
      ["patient.phoneHome", "low", 1],
    ]);
    expect(cands.rows.every((r) => r.value_text === null)).toBe(true);
    const email = cands.rows.find((r) => r.field_path === "patient.email");
    expect(email.source_bounding_box).toEqual({ x1: 42, y1: 226, x2: 260.33, y2: 242 });
    expect(await candidateCipher.decrypt(ORG_A, email.value_cipher)).toBe(
      "mae.doclens@example.org",
    );
    const status = await admin.query("SELECT status FROM intake_upload_batch WHERE id=$1", [
      batchId,
    ]);
    expect(status.rows[0].status).toBe("extraction_complete");

    // Re-running a processed batch is a no-op.
    expect(await runDocLensIntake(deps(), job(ORG_A, batchId))).toEqual({
      outcome: "skipped",
      reason: "batch_already_extraction_complete",
    });
  });

  it("a refused AI call is awaiting_capability with the refusal recorded — never an empty review", async () => {
    const batchId = await seedBatch(ORG_A, true);
    const refusing: DocLensExtractorPort = {
      extract: async () => ({
        available: false,
        detail: "ai_full_flag: the 'ai.full' feature flag is off",
      }),
    };
    const summary = await runDocLensIntake(
      deps({ extractor: () => refusing }),
      job(ORG_A, batchId),
    );
    expect(summary).toMatchObject({ outcome: "awaiting_capability", candidates: 0 });
    const jobs = await admin.query(
      `SELECT j.status, j.failure_reason FROM extraction_job j JOIN classified_page p ON p.id=j.classified_page_id
       WHERE p.intake_upload_batch_id=$1`,
      [batchId],
    );
    expect(jobs.rows.every((r) => r.status === "awaiting_capability")).toBe(true);
    expect(jobs.rows[0].failure_reason).toContain("ai.full");
  });

  it("keeps a partially refused batch out of review and resumes only the awaiting job", async () => {
    const batchId = await seedBatch(ORG_A, true);
    let medReconAvailable = false;
    const partial: DocLensExtractorPort = {
      async extract(input) {
        if (input.documentType === "med_recon" && !medReconAvailable) {
          return { available: false, detail: "capability temporarily unavailable" };
        }
        return extractor.extract(input);
      },
    };

    const first = await runDocLensIntake(deps({ extractor: () => partial }), job(ORG_A, batchId));
    expect(first).toMatchObject({ outcome: "awaiting_capability", jobs: 2, candidates: 3 });
    expect(
      (await admin.query("SELECT status FROM intake_upload_batch WHERE id=$1", [batchId])).rows[0]
        ?.status,
    ).toBe("classifier_complete");

    medReconAvailable = true;
    const changedClassifier: DocLensClassifierPort = {
      classify: async (input) => ({
        available: true,
        invocationId: `cls-retry-${input.pageNumber}`,
        documentType: input.pageNumber === 1 ? "transfer_record" : "hp",
        confidence: 0.99,
      }),
    };
    const resumed = await runDocLensIntake(
      deps({ classifier: () => changedClassifier, extractor: () => partial }),
      job(ORG_A, batchId),
    );
    expect(resumed).toMatchObject({ outcome: "extracted", jobs: 2, candidates: 4 });
    expect(
      (
        await admin.query(
          `SELECT count(DISTINCT p.id)::int AS pages,
                  count(DISTINCT j.id)::int AS jobs,
                  count(c.id)::int AS candidates
             FROM classified_page p
             LEFT JOIN extraction_job j ON j.classified_page_id=p.id
             LEFT JOIN extraction_candidate c ON c.extraction_job_id=j.id
            WHERE p.intake_upload_batch_id=$1`,
          [batchId],
        )
      ).rows[0],
    ).toEqual({ pages: 2, jobs: 2, candidates: 4 });
    expect(
      (
        await admin.query(
          `SELECT p.document_type AS page_type, j.document_type AS job_type
             FROM classified_page p JOIN extraction_job j ON j.classified_page_id=p.id
            WHERE p.intake_upload_batch_id=$1 AND p.page_range_start=2`,
          [batchId],
        )
      ).rows[0],
    ).toEqual({ page_type: "med_recon", job_type: "med_recon" });
    expect(
      (await admin.query("SELECT status FROM intake_upload_batch WHERE id=$1", [batchId])).rows[0]
        ?.status,
    ).toBe("extraction_complete");
  });

  it("finalizes from persisted job readiness when another delivery wins the extractor race", async () => {
    const batchId = await seedBatch(ORG_A, true);
    const refusing: DocLensExtractorPort = {
      extract: async () => ({ available: false, detail: "capability temporarily unavailable" }),
    };
    await runDocLensIntake(deps({ extractor: () => refusing }), job(ORG_A, batchId));

    let entered!: () => void;
    let release!: () => void;
    const extractorStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const extractorMayFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const losingDelivery: DocLensExtractorPort = {
      extract: async () => {
        entered();
        await extractorMayFinish;
        return { available: false, detail: "stale refusal from losing delivery" };
      },
    };
    const running = runDocLensIntake(
      deps({ extractor: () => losingDelivery }),
      job(ORG_A, batchId),
    );
    await extractorStarted;
    await admin.query(
      `UPDATE extraction_job SET status='ready_for_review', failure_reason=NULL, completed_at=now()
        WHERE classified_page_id IN (SELECT id FROM classified_page WHERE intake_upload_batch_id=$1)`,
      [batchId],
    );
    release();
    await expect(running).resolves.toMatchObject({
      outcome: "extracted",
      jobs: 2,
      candidates: 0,
    });
    expect(
      (await admin.query("SELECT status FROM intake_upload_batch WHERE id=$1", [batchId])).rows[0]
        ?.status,
    ).toBe("extraction_complete");
  });

  it("does not expose extraction_complete until the patient identity refresh finishes", async () => {
    const patientId = (
      await admin.query(
        `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
         VALUES ($1,'MRN-F236-IDENTITY','Mae','Doclens','1938-04-12','F','active') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    const batchId = await seedBatch(ORG_A, true);
    await admin.query("UPDATE intake_upload_batch SET patient_id=$1 WHERE id=$2", [
      patientId,
      batchId,
    ]);
    let entered!: () => void;
    let release!: () => void;
    const identityStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const identityMayFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = runDocLensIntake(
      deps({
        identityTargets: {
          patient: async () => {
            entered();
            await identityMayFinish;
            return { lastName: "Doclens", firstName: "Mae", dateOfBirth: "1938-04-12" };
          },
        },
      }),
      job(ORG_A, batchId),
    );

    await identityStarted;
    expect(
      (await admin.query("SELECT status FROM intake_upload_batch WHERE id=$1", [batchId])).rows[0]
        ?.status,
    ).toBe("classifier_complete");
    release();
    await expect(running).resolves.toMatchObject({ outcome: "extracted" });
    expect(
      (
        await admin.query("SELECT status, identity_status FROM intake_upload_batch WHERE id=$1", [
          batchId,
        ])
      ).rows[0],
    ).toEqual({ status: "extraction_complete", identity_status: "unverified" });
  });

  it("lets a concurrent terminal discard win while Docling is in flight", async () => {
    const batchId = await seedBatch(ORG_A, true);
    let entered!: () => void;
    let release!: () => void;
    const parseStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const parseMayFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = runDocLensIntake(
      deps({
        docling: {
          parse: async () => {
            entered();
            await parseMayFinish;
            return { doclingVersion: "2.133.0", pages: PAGES };
          },
          render: async () => {
            throw new Error("F-236 suite runs no stage 5");
          },
        },
      }),
      job(ORG_A, batchId),
    );

    await parseStarted;
    await admin.query(
      "UPDATE intake_upload_batch SET status='discarded', disposition_at=now() WHERE id=$1",
      [batchId],
    );
    release();
    await expect(running).resolves.toEqual({
      outcome: "skipped",
      reason: "batch_became_discarded",
    });
    expect(
      (
        await admin.query(
          `SELECT b.status,
                  (SELECT count(*)::int FROM classified_page p WHERE p.intake_upload_batch_id=b.id) AS pages,
                  (SELECT count(*)::int FROM extraction_job j JOIN classified_page p ON p.id=j.classified_page_id
                    WHERE p.intake_upload_batch_id=b.id) AS jobs,
                  (SELECT count(*)::int FROM extraction_candidate c JOIN extraction_job j ON j.id=c.extraction_job_id
                    JOIN classified_page p ON p.id=j.classified_page_id WHERE p.intake_upload_batch_id=b.id) AS candidates
             FROM intake_upload_batch b WHERE b.id=$1`,
          [batchId],
        )
      ).rows[0],
    ).toEqual({ status: "discarded", pages: 0, jobs: 0, candidates: 0 });
  });

  it("fails closed on a stranded partial classification plan from an earlier worker", async () => {
    const batchId = await seedBatch(ORG_A, true);
    const sourceDocumentId = (
      await admin.query("SELECT initial_document_id FROM intake_upload_batch WHERE id=$1", [
        batchId,
      ])
    ).rows[0].initial_document_id as string;
    await admin.query(
      `INSERT INTO classified_page
         (organization_id, intake_upload_batch_id, source_document_id, page_range_start, page_range_end,
          document_type, confidence, classifier_model_version_ref, segment_boundary)
       VALUES ($1,$2,$3,1,1,'transfer_record',0.9,'legacy-partial','first_page')`,
      [ORG_A, batchId, sourceDocumentId],
    );
    const twoPagePacket = [
      {
        page: 1,
        width: 612,
        height: 792,
        blocks: [{ text: "Patient summary", bbox: [10, 10, 100, 30] as const, label: "text" }],
      },
      {
        page: 2,
        width: 612,
        height: 792,
        blocks: [{ text: "Clinical details", bbox: [10, 10, 100, 30] as const, label: "text" }],
      },
    ];
    await expect(
      runDocLensIntake(
        deps({
          docling: {
            parse: async () => ({ doclingVersion: "2.133.0", pages: twoPagePacket }),
            render: async () => {
              throw new Error("F-236 suite runs no stage 5");
            },
          },
        }),
        job(ORG_A, batchId),
      ),
    ).rejects.toMatchObject({ code: "DEGRADED" });
    expect(
      (
        await admin.query(
          `SELECT b.status,
                  (SELECT count(*)::int FROM extraction_job j JOIN classified_page p ON p.id=j.classified_page_id
                    WHERE p.intake_upload_batch_id=b.id) AS jobs
             FROM intake_upload_batch b WHERE b.id=$1`,
          [batchId],
        )
      ).rows[0],
    ).toEqual({ status: "docling_complete", jobs: 0 });
  });

  it("reuses the persisted classification boundaries when a retry classifier would split them", async () => {
    const batchId = await seedBatch(ORG_A, true);
    const twoPagePacket = [
      {
        page: 1,
        width: 612,
        height: 792,
        blocks: [{ text: "Patient summary", bbox: [10, 10, 100, 30] as const, label: "text" }],
      },
      {
        page: 2,
        width: 612,
        height: 792,
        blocks: [{ text: "Clinical details", bbox: [10, 10, 100, 30] as const, label: "text" }],
      },
    ];
    const refusing: DocLensExtractorPort = {
      extract: async () => ({ available: false, detail: "capability temporarily unavailable" }),
    };
    await expect(
      runDocLensIntake(
        deps({
          docling: {
            parse: async () => ({ doclingVersion: "2.133.0", pages: twoPagePacket }),
            render: async () => {
              throw new Error("F-236 suite runs no stage 5");
            },
          },
          classifier: () => ({
            classify: async () => ({
              available: true,
              invocationId: "same-type",
              documentType: "transfer_record",
              confidence: 0.9,
            }),
          }),
          extractor: () => refusing,
        }),
        job(ORG_A, batchId),
      ),
    ).resolves.toMatchObject({ outcome: "awaiting_capability" });

    let retryClassifierCalls = 0;
    await expect(
      runDocLensIntake(
        deps({
          docling: {
            parse: async () => ({ doclingVersion: "2.133.0", pages: twoPagePacket }),
            render: async () => {
              throw new Error("F-236 suite runs no stage 5");
            },
          },
          classifier: () => ({
            classify: async (input) => {
              retryClassifierCalls += 1;
              return {
                available: true,
                invocationId: `changed-${input.pageNumber}`,
                documentType: input.pageNumber === 1 ? "transfer_record" : "hp",
                confidence: 0.99,
              };
            },
          }),
          extractor: () => ({
            extract: async () => ({ available: true, invocationId: "resumed", fields: {} }),
          }),
        }),
        job(ORG_A, batchId),
      ),
    ).resolves.toMatchObject({ outcome: "extracted", jobs: 1, candidates: 0 });
    expect(retryClassifierCalls).toBe(0);
    expect(
      (
        await admin.query(
          `SELECT count(DISTINCT p.id)::int AS pages, min(p.page_range_start)::int AS page_from,
                  max(p.page_range_end)::int AS page_to, count(DISTINCT j.id)::int AS jobs
             FROM classified_page p LEFT JOIN extraction_job j ON j.classified_page_id=p.id
            WHERE p.intake_upload_batch_id=$1`,
          [batchId],
        )
      ).rows[0],
    ).toEqual({ pages: 1, page_from: 1, page_to: 2, jobs: 1 });
  });

  it("an unfiled source document is parse_failed (no guessing a file), and RLS hides org A's batch from org B", async () => {
    const unfiled = await seedBatch(ORG_A, false);
    expect(await runDocLensIntake(deps(), job(ORG_A, unfiled))).toEqual({
      outcome: "parse_failed",
      reason: "source_document_has_no_filed_version",
    });
    const filed = await seedBatch(ORG_A, true);
    expect(await runDocLensIntake(deps(), job(ORG_B, filed))).toEqual({
      outcome: "skipped",
      reason: "batch_not_found",
    });
  });

  describe("the M32 pipeline over its real Drizzle stores", () => {
    let capId: string;
    const seen: string[] = [];
    const local: ModelBackend = {
      backendKey: "local-llama-3.1-8b-instruct",
      kind: "local",
      capabilities: () => ({
        backendKey: "local-llama-3.1-8b-instruct",
        kind: "local",
        modelVersionPin: "ollama/llama3.1:8b",
        supportedModalities: ["text"],
        contextWindowTokens: 16384,
        maxOutputTokens: 4096,
        supportedFeatures: {
          structured_output: true,
          tool_use: false,
          vision: false,
          streaming: false,
        },
      }),
      health: async () => "healthy",
      complete: async (r) => {
        seen.push(r.prompt);
        return {
          text: '{"documentType":"transfer_record","confidence":0.9}',
          inputTokens: 300,
          outputTokens: 12,
          modelVersionPin: "ollama/llama3.1:8b",
        };
      },
    };
    const flagsOn = new Set<string>();
    const pipeline = () =>
      buildLiveAiInvocationPipeline({
        db: handle.db,
        platformDb: handle.db,
        auditBypass: { async record() {} } as never,
        keys,
        flags: { forOrg: async (org) => ({ "ai.full": flagsOn.has(org) }) },
        backends: [local],
      });
    const request = (org: string) => ({
      capabilityKey: "doclens_classify",
      organizationId: org,
      providerEntityId: "",
      actorMembershipId: membership,
      actorRole: "rn",
      consumerContextRef: { module: "m22", entityKind: "document", entityId: "d1" },
      prompt: { text: "PAGE TEXT: Mae Doclens" },
      chartContext: { documentId: "d1", pageCount: 2, pageNumber: 1 },
      invokedAt: new Date().toISOString(),
    });

    beforeAll(async () => {
      const pe = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,'CCN-F236','F236','NPI-F236','enc','12-31') RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      (request as unknown as { pe: string }).pe = pe;
      await admin.query(
        `INSERT INTO ai_model_backend (backend_key, kind, vendor, model_family, model_version_pin, supported_modalities,
           context_window_tokens, max_output_tokens, supported_features, zdr_status, license_terms, artifact_storage_ref,
           health_endpoint, last_health_status, baa_reference)
         VALUES ('local-llama-3.1-8b-instruct','local','meta','llama','ollama/llama3.1:8b','["text"]',16384,4096,
           '{"structured_output":true,"tool_use":false,"vision":false,"streaming":false}','not_applicable',
           'Llama 3.1 Community License','ollama://llama3.1:8b','http://o/api/tags','healthy',NULL),
           ('anthropic-claude-haiku-4-5','cloud','anthropic','claude','claude-haiku-4-5','["text"]',200000,4096,
           '{"structured_output":true,"tool_use":true,"vision":false,"streaming":true}','enabled',NULL,NULL,
           'https://api.anthropic.com/v1/models/claude-haiku-4-5','healthy','BAA-TEST')`,
      );
      capId = (
        await admin.query(
          `INSERT INTO ai_capability (capability_key, display_name, description, risk_tier, lifecycle_state,
             default_backend_key, allowed_backend_keys, fallback_chain_keys, tenant_opt_in_required, clinical_review_required)
           VALUES ('doclens_classify','DocLens classify','t','medium','PILOT','anthropic-claude-haiku-4-5',
             '["anthropic-claude-haiku-4-5","local-llama-3.1-8b-instruct"]','["local-llama-3.1-8b-instruct"]',true,false)
           RETURNING id`,
        )
      ).rows[0].id as string;
      for (const org of [ORG_A, ORG_B]) {
        const m =
          org === ORG_A
            ? membership
            : (
                await admin.query(
                  `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
                  [USER, org],
                )
              ).rows[0].id;
        await admin.query(
          `INSERT INTO ai_tenant_opt_in_record (organization_id, capability_id, status, org_admin_membership_id,
             disclosure_acknowledgments, routing_preference_snapshot, pilot_enrollment, opted_in_at)
           VALUES ($1,$2,'active',$3,'{}','local_only',true,now())`,
          [org, capId, m],
        );
      }
      await admin.query(
        `UPDATE organization SET settings = settings || '{"ai_token_budgets":{"doclens_classify":{"hardCapTokens":100000}}}'::jsonb
         WHERE id=$1`,
        [ORG_A],
      );
    });

    it("ai.full off ⇒ refused at gate 0 with NO ledger row", async () => {
      const r = await pipeline().invoke({
        ...request(ORG_A),
        providerEntityId: (request as unknown as { pe: string }).pe,
      });
      expect(r).toMatchObject({ available: false, gate: "ai_full_flag", ledgerRecorded: false });
    });

    it("a local_only pilot tenant routes to the LOCAL backend (never the cloud default) and the ledger holds ciphertext", async () => {
      flagsOn.add(ORG_A);
      const r = await pipeline().invoke({
        ...request(ORG_A),
        providerEntityId: (request as unknown as { pe: string }).pe,
      });
      expect(r).toMatchObject({
        available: true,
        route: { backendKey: "local-llama-3.1-8b-instruct" },
      });
      const row = await admin.query(
        `SELECT backend_key, model_version_pin, status, input_token_count, zdr_confirmed, prompt_payload_cipher
         FROM ai_invocation WHERE organization_id=$1`,
        [ORG_A],
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0]).toMatchObject({
        backend_key: "local-llama-3.1-8b-instruct",
        model_version_pin: "ollama/llama3.1:8b",
        status: "completed",
        input_token_count: 300,
      });
      const envelope = row.rows[0].prompt_payload_cipher as Buffer;
      expect(envelope.toString("utf8")).not.toContain("Mae Doclens");
      const plain = await createAiPayloadCipher(keys).decrypt(ORG_A, envelope);
      expect(plain).toContain("Mae Doclens");
      const ledger = await admin.query(
        "SELECT input_tokens, output_tokens FROM ai_token_ledger WHERE organization_id=$1",
        [ORG_A],
      );
      expect(ledger.rows).toEqual([{ input_tokens: 300, output_tokens: 12 }]);
    });

    it("a tenant with no ai_token_budgets refuses at the cap gate (recorded, nothing dispatched)", async () => {
      flagsOn.add(ORG_B);
      const before = seen.length;
      const pe = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,'CCN-F236B','F236B','NPI-F236B','enc','12-31') RETURNING id`,
          [ORG_B],
        )
      ).rows[0].id as string;
      const mB = (await admin.query("SELECT id FROM membership WHERE organization_id=$1", [ORG_B]))
        .rows[0].id;
      const r = await pipeline().invoke({
        ...request(ORG_B),
        providerEntityId: pe,
        actorMembershipId: mB,
      });
      expect(r).toMatchObject({ available: false, gate: "token_cap" });
      expect(seen.length).toBe(before);
    });
  });
});
