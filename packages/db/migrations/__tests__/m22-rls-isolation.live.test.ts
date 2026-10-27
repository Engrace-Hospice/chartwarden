/**
 * M22 Document Management — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / ADR-0010).
 *
 * M22's pure suites exercise the forms/intake/extraction state machines but never touch a database, so they
 * cannot catch a wrong RLS predicate, a missing WITH CHECK, or a base-table grant that leaks across tenants.
 * This applies the real migrations to a real Postgres and drives the policies as the unprivileged `chartwarden_app`
 * role (no BYPASSRLS), covering all SIXTEEN org-scoped M22 tables.
 *
 * Two of the fifteen carry the risk that makes this worth more than a checkbox:
 *   • `document` is the record itself — the PHI-bearing aggregate (it carries patient_id). A cross-tenant read
 *     is a disclosure of another org's chart; a cross-tenant write forges a document into their record.
 *   • `extraction_candidate` holds AI-extracted values from uploaded charts — incl. a `sud_detected` flag and a
 *     `value_cipher` — so a cross-tenant leak exposes another tenant's un-reviewed extracted PHI.
 *
 * Two of the eighteen owned tables are NON_ORG_SCOPED platform catalog and are EXCLUDED (no organization_id
 * by design — the same template is published to every tenant; §3.3): `form_template` + `form_template_version`.
 * Their RLS is dual-grant (read-all `USING(true)` to chartwarden_app, writes via chartwarden_admin), a different shape
 * than the org-pivot this suite asserts.
 *
 * Four of the fifteen org-scoped tables are PARTITION BY RANGE (document_access_log, form_fill, extraction_job,
 * extraction_candidate; §3.2 Phase 1.3). RLS lives on the partitioned PARENT and propagates to every leaf
 * (PG11+), so each parent still carries a direct `_org` WITH CHECK policy — they stay in BOTH the read/write
 * sweep and the policy count.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live` (SUPERUSER to a THROWAWAY db;
 *     for a local PG without pgvector, set CHARTWARDEN_TEST_NO_PGVECTOR=1).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ROLES = [
  "chartwarden_app",
  "chartwarden_admin",
  "chartwarden_readonly",
  "chartwarden_audit_writer",
];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** No M22 table carries an FK to `membership`, `user`, or `patient` — every such column is a plain uuid,
 * app-validated (the four partitioned tables even drop their SQL FKs). A single seeded user satisfies the
 * base fixture; the membership/patient references below are literals. */
const USER = "33333333-3333-3333-3333-333333333333";
const MEMBERSHIP = "44444444-4444-4444-4444-444444444444";
const PATIENT = "55555555-5555-5555-5555-555555555555";
/** candidate_a/b_id, legal_hold_event_id carry NO FK — literals are fine. */
const CANDIDATE_A = "66666666-6666-6666-6666-666666666666";
const CANDIDATE_B = "77777777-7777-7777-7777-777777777777";
const LEGAL_HOLD_EVENT = "88888888-8888-8888-8888-888888888888";

type SeedIds = {
  providerEntity: string;
  location: string;
  document: string;
  documentUpload: string;
  documentVersion: string;
  documentTag: string;
  documentAccessLog: string;
  documentLegalHold: string;
  tenantTemplateOverlay: string;
  formFill: string;
  intakeUploadBatch: string;
  classifiedPage: string;
  extractionJob: string;
  extractionCandidate: string;
  extractionDiscrepancy: string;
  extractionReview: string;
  extractionDecision: string;
  extractionProvenance: string;
};

/** The SIXTEEN org-scoped M22 tables. form_template + form_template_version are EXCLUDED: NON_ORG_SCOPED
 * platform catalog (no organization_id) with dual-grant read-all RLS, not the org-pivot asserted here. */
const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "document", key: "document" },
  { table: "document_upload", key: "documentUpload" },
  { table: "document_version", key: "documentVersion" },
  { table: "document_tag", key: "documentTag" },
  { table: "document_access_log", key: "documentAccessLog" }, // PARTITIONED (accessed_at)
  { table: "document_legal_hold", key: "documentLegalHold" },
  { table: "tenant_template_overlay", key: "tenantTemplateOverlay" },
  { table: "form_fill", key: "formFill" }, // PARTITIONED (created_at)
  { table: "intake_upload_batch", key: "intakeUploadBatch" },
  { table: "classified_page", key: "classifiedPage" },
  { table: "extraction_job", key: "extractionJob" }, // PARTITIONED (queued_at)
  { table: "extraction_candidate", key: "extractionCandidate" }, // PARTITIONED (extracted_at)
  { table: "extraction_discrepancy", key: "extractionDiscrepancy" },
  { table: "extraction_review", key: "extractionReview" },
  { table: "extraction_decision", key: "extractionDecision" },
  { table: "extraction_provenance", key: "extractionProvenance" },
];

describe.skipIf(!DB_URL)(
  "M22 Document Management — RLS cross-tenant denial — LIVE Postgres (§3.5)",
  () => {
    let db: Client;
    let a: SeedIds;
    let b: SeedIds;
    /** Platform catalog is seeded ONCE (no organization_id); tenant_template_overlay + form_fill reference it. */
    let templateId: string;
    let templateVersionId: string;

    async function withOrg<T>(org: string, fn: () => Promise<T>): Promise<T> {
      await db.query("SET ROLE chartwarden_app");
      await db.query("SELECT set_config('app.org_id', $1, false)", [org]);
      try {
        return await fn();
      } finally {
        await db.query("RESET ROLE");
      }
    }

    async function resetSchema() {
      await db.query("DROP SCHEMA IF EXISTS public CASCADE");
      await db.query("CREATE SCHEMA public");
      for (const r of ROLES) {
        await db.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
        );
      }
    }

    async function applyMigrations() {
      const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
      const files = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      for (const f of files) {
        let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
        if (stripVector) {
          sql = sql.replace(
            /^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm,
            "-- (vector extension stripped: CHARTWARDEN_TEST_NO_PGVECTOR set)",
          );
          sql = sql.replace(/\bvector\(\d+\)/g, "text");
          sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw index stripped: no pgvector)");
        }
        await db.query(sql);
      }
    }

    /** Seed one full M22 document/intake/extraction chain for `org` as superuser (RLS + grants bypassed). */
    async function seedOrg(org: string, n: number): Promise<SeedIds> {
      const providerEntity = (
        await db.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [org, `CCN-M22${n}`, `M22 Provider ${n}`, `NPI-M22${n}`],
        )
      ).rows[0].id as string;

      const location = (
        await db.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [providerEntity, `Loc-M22${n}`],
        )
      ).rows[0].id as string;

      const document = (
        await db.query(
          `INSERT INTO document (organization_id, patient_id, provider_entity_id, location_id, retention_class,
           source_kind, aggregate_type, title, created_by_membership_id)
         VALUES ($1,$2,$3,$4,'clinical_record','user_upload','other','Chart doc',$5) RETURNING id`,
          [org, PATIENT, providerEntity, location, MEMBERSHIP],
        )
      ).rows[0].id as string;

      const documentUpload = (
        await db.query(
          `INSERT INTO document_upload (organization_id, created_by_membership_id, patient_id,
           retention_class, aggregate_type, title, object_key, mime_type, expected_byte_size,
           expected_sha256_hex, expires_at)
         VALUES ($1,$2,$3,'clinical_record','other','Staged chart','uploads/m22-${n}',
           'application/pdf','1024',repeat('a',64),now() + interval '15 minutes') RETURNING id`,
          [org, MEMBERSHIP, PATIENT],
        )
      ).rows[0].id as string;

      const documentVersion = (
        await db.query(
          `INSERT INTO document_version (organization_id, document_id, version_number, minio_object_key,
           mime_type, byte_size, sha256_hex, uploaded_by_kind)
         VALUES ($1,$2,'1','minio/key-m22${n}','application/pdf','1024','abc123','system') RETURNING id`,
          [org, document],
        )
      ).rows[0].id as string;

      const documentTag = (
        await db.query(
          `INSERT INTO document_tag (organization_id, document_id, tag_kind, tag_key, tag_value,
           added_by_membership_id)
         VALUES ($1,$2,'system','category','clinical',$3) RETURNING id`,
          [org, document, MEMBERSHIP],
        )
      ).rows[0].id as string;

      const documentAccessLog = (
        await db.query(
          `INSERT INTO document_access_log (organization_id, document_id, document_version_id,
           accessor_membership_id, access_kind, purpose, correlation_id)
         VALUES ($1,$2,$3,$4,'metadata_read','treatment','corr-m22${n}') RETURNING id`,
          [org, document, documentVersion, MEMBERSHIP],
        )
      ).rows[0].id as string;

      const documentLegalHold = (
        await db.query(
          `INSERT INTO document_legal_hold (organization_id, document_id, legal_hold_event_id)
         VALUES ($1,$2,$3) RETURNING id`,
          [org, document, LEGAL_HOLD_EVENT],
        )
      ).rows[0].id as string;

      const tenantTemplateOverlay = (
        await db.query(
          `INSERT INTO tenant_template_overlay (organization_id, template_id, branding,
           published_by_membership_id)
         VALUES ($1,$2,'{}'::jsonb,$3) RETURNING id`,
          [org, templateId, MEMBERSHIP],
        )
      ).rows[0].id as string;

      const formFill = (
        await db.query(
          `INSERT INTO form_fill (organization_id, template_version_id, aggregate_type, aggregate_id,
           render_payload, correlation_id)
         VALUES ($1,$2,'other',$3,'{}'::jsonb,'corr-ff-m22${n}') RETURNING id`,
          [org, templateVersionId, document],
        )
      ).rows[0].id as string;

      const intakeUploadBatch = (
        await db.query(
          `INSERT INTO intake_upload_batch (organization_id, patient_id, provider_entity_id, location_id,
           initial_document_id, source_channel, uploaded_by_membership_id, correlation_id)
         VALUES ($1,$2,$3,$4,$5,'portal_upload',$6,'corr-batch-m22${n}') RETURNING id`,
          [org, PATIENT, providerEntity, location, document, MEMBERSHIP],
        )
      ).rows[0].id as string;

      const classifiedPage = (
        await db.query(
          `INSERT INTO classified_page (organization_id, intake_upload_batch_id, source_document_id,
           page_range_start, page_range_end, document_type, confidence, classifier_model_version_ref)
         VALUES ($1,$2,$3,1,2,'lab',0.950,'clf-v1') RETURNING id`,
          [org, intakeUploadBatch, document],
        )
      ).rows[0].id as string;

      const extractionJob = (
        await db.query(
          `INSERT INTO extraction_job (organization_id, classified_page_id, document_type,
           extractor_model_version_ref, correlation_id)
         VALUES ($1,$2,'lab','ext-v1','corr-job-m22${n}') RETURNING id`,
          [org, classifiedPage],
        )
      ).rows[0].id as string;

      const extractionCandidate = (
        await db.query(
          `INSERT INTO extraction_candidate (organization_id, extraction_job_id, field_path, field_kind,
           risk_level, confidence, source_page, source_bounding_box)
         VALUES ($1,$2,'lab.result','text','low',0.950,1,'{"x1":0,"y1":0,"x2":1,"y2":1}'::jsonb) RETURNING id`,
          [org, extractionJob],
        )
      ).rows[0].id as string;

      const extractionDiscrepancy = (
        await db.query(
          `INSERT INTO extraction_discrepancy (organization_id, intake_upload_batch_id, discrepancy_kind,
           field_path, candidate_a_id, candidate_b_id)
         VALUES ($1,$2,'cross_source','lab.result',$3,$4) RETURNING id`,
          [org, intakeUploadBatch, CANDIDATE_A, CANDIDATE_B],
        )
      ).rows[0].id as string;

      const extractionReview = (
        await db.query(
          `INSERT INTO extraction_review (organization_id, intake_upload_batch_id, reviewer_membership_id,
           correlation_id)
         VALUES ($1,$2,$3,'corr-rev-m22${n}') RETURNING id`,
          [org, intakeUploadBatch, MEMBERSHIP],
        )
      ).rows[0].id as string;

      const extractionDecision = (
        await db.query(
          `INSERT INTO extraction_decision (organization_id, extraction_candidate_id, extraction_review_id,
           decision, source_view_confirmed)
         VALUES ($1,$2,$3,'approve',true) RETURNING id`,
          [org, extractionCandidate, extractionReview],
        )
      ).rows[0].id as string;

      const extractionProvenance = (
        await db.query(
          `INSERT INTO extraction_provenance (organization_id, extraction_decision_id, extraction_candidate_id,
           source_document_id, source_document_version_id, source_page, source_bounding_box,
           classifier_model_version_ref, extractor_model_version_ref, target_module, target_field_path)
         VALUES ($1,$2,$3,$4,$5,1,'{"x1":0,"y1":0,"x2":1,"y2":1}'::jsonb,'clf-v1','ext-v1','m5','patient.mrn')
         RETURNING id`,
          [org, extractionDecision, extractionCandidate, document, documentVersion],
        )
      ).rows[0].id as string;

      return {
        providerEntity,
        location,
        document,
        documentUpload,
        documentVersion,
        documentTag,
        documentAccessLog,
        documentLegalHold,
        tenantTemplateOverlay,
        formFill,
        intakeUploadBatch,
        classifiedPage,
        extractionJob,
        extractionCandidate,
        extractionDiscrepancy,
        extractionReview,
        extractionDecision,
        extractionProvenance,
      };
    }

    beforeAll(async () => {
      db = new Client({ connectionString: DB_URL });
      await db.connect();
      await resetSchema();
      await applyMigrations();
      await db.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
        [ORG_A, ORG_B],
      );
      await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m22-actor@x.test')`, [USER]);

      // Platform catalog: NON_ORG_SCOPED, seeded ONCE (the same template published to every tenant, §3.3).
      templateId = (
        await db.query(
          `INSERT INTO form_template (template_key, aggregate_type, title, render_engine, retention_class)
         VALUES ('m22-election','election_statement','Election','react_pdf','clinical_record') RETURNING id`,
        )
      ).rows[0].id as string;
      templateVersionId = (
        await db.query(
          `INSERT INTO form_template_version (template_id, version_label, source_path, payload_schema)
         VALUES ($1,'v1','forms/election.tsx','{}'::jsonb) RETURNING id`,
          [templateId],
        )
      ).rows[0].id as string;

      a = await seedOrg(ORG_A, 1);
      b = await seedOrg(ORG_B, 2);
    }, 120_000);

    afterAll(async () => {
      if (db) await db.end();
    });

    // GUARD FOR EVERY CASE BELOW. RLS is not enforced for a role holding BYPASSRLS, so if the runtime
    // role ever gains it, every isolation assertion in this file passes VACUOUSLY and CI stays green.
    // scripts/db/migrate.ts grants exactly that behind CHARTWARDEN_DEV_BYPASSRLS=1, so this is reachable.
    it("chartwarden_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
      const { rows } = await db.query<{ rolbypassrls: boolean }>(
        "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'chartwarden_app'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].rolbypassrls).toBe(false);
    });

    it("every M22 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
      // All sixteen org-scoped tables — incl. the four PARTITIONED parents — carry a direct `_org` WITH CHECK
      // policy, so the covered-policy count equals COVERED.length. The two platform tables' policies are
      // FOR SELECT USING(true) (no WITH CHECK) and name no covered table, so they are filtered out.
      const rls = ["0049_documents_m22_rls_audit_triggers.sql", "0170_document_verified_upload.sql"]
        .map((name) => readFileSync(join(MIGRATIONS_DIR, name), "utf8"))
        .join("\n");
      const policyBlocks = (rls.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? []).filter(
        (b) => COVERED.some((t) => b.includes(`"${t.table}"`)),
      );
      expect(policyBlocks.length).toBe(COVERED.length);
      for (const block of policyBlocks) {
        const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((m) => m[1]);
        expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
        expect(block).not.toMatch(/pg_has_role/i);
        expect(block).not.toMatch(/IS NULL/i);
      }
    });

    it.each(COVERED)(
      "$table: org A sees its row, org B cannot (cross-tenant denial)",
      async ({ table, key }) => {
        const id = a[key];
        const seenByA = await withOrg(ORG_A, () =>
          db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]),
        );
        expect(seenByA.rows[0].n).toBe(1); // isolation is not "deny everything"
        const seenByB = await withOrg(ORG_B, () =>
          db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]),
        );
        expect(seenByB.rows[0].n).toBe(0);
      },
    );

    it("a WITH CHECK refuses a document forged into another tenant", async () => {
      // `document` is the PHI-bearing aggregate (it carries patient_id) — a cross-tenant write would let one
      // tenant plant a document (and, via its versions, a chart artifact) into another org's record.
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO document (organization_id, patient_id, retention_class, source_kind, aggregate_type,
             title, created_by_membership_id)
           VALUES ($1,$2,'clinical_record','user_upload','other','forged',$3)`,
            [ORG_A, PATIENT, MEMBERSHIP],
          ),
        ),
      ).rejects.toThrow();
    });

    it("org B cannot UPDATE org A's document (the USING clause covers writes too)", async () => {
      const res = await withOrg(ORG_B, () =>
        db.query("UPDATE document SET status='superseded' WHERE id=$1", [a.document]),
      );
      expect(res.rowCount).toBe(0);
      const still = await db.query("SELECT status FROM document WHERE id=$1", [a.document]);
      expect(still.rows[0].status).toBe("active");
    });

    it("the M4 write-audit trigger fired for the document writes (§3.8)", async () => {
      const r = await db.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind = 'document'",
      );
      expect(r.rows[0].n).toBeGreaterThan(0);
    });
  },
);
