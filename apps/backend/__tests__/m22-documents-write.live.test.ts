/**
 * M22L — the Drizzle Documents write lifecycle, proven against real Postgres.
 *
 * Drives the writes as the NOBYPASSRLS `wardenx_app` role over the M22-owned `documents/*` tables under
 * `withOrgContext`: document upload + the append-only version ledger, tag add/remove + legal-hold guard, patch,
 * intake batch upload + classify-confirm + the extraction review machine (open / record-decision / bulk-approve
 * / resolve-discrepancy / complete / abandon / discard), tenant-overlay publish (§2.5 optimistic concurrency),
 * and render retry. M22 route writes emit NO producer outbox event (M22's outbox is the CONSUMER-side render
 * handshake), so — unlike M6–M18 — there is no publisher to bind. RLS is exercised end-to-end.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m22:write:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbDocumentBackend } from "../src/modules/22-documents/documents-route-service-db";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const MEMBER = "33333333-3333-3333-3333-333333333333"; // document created_by etc. carry no FK — literal ok
const PATIENT = "44444444-4444-4444-4444-444444444444";

describe.skipIf(!DB_URL)("M22 Documents write lifecycle — LIVE Postgres (M22L)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbDocumentBackend>["service"];
  const tmpl: Record<string, { templateId: string; versionId: string }> = {};

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
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql")).sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }

  /** Seed a document + v1 directly (for the tag/patch/legal-hold tests that need an existing doc). */
  async function seedDocument(org: string): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO document (organization_id, patient_id, retention_class, source_kind, aggregate_type,
           title, created_by_membership_id)
         VALUES ($1,$2,'clinical_record','user_upload','other','Seed doc',$3) RETURNING id`,
        [org, PATIENT, MEMBER],
      )
    ).rows[0].id as string;
  }
  async function seedBatch(org: string): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO intake_upload_batch (organization_id, patient_id, initial_document_id, source_channel,
           uploaded_by_membership_id, correlation_id)
         VALUES ($1,$2,gen_random_uuid(),'fax',$3,gen_random_uuid()) RETURNING id`,
        [org, PATIENT, MEMBER],
      )
    ).rows[0].id as string;
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
    // Platform form-template + version (form_template* is platform reference; admin can seed).
    const templateId = (
      await admin.query(
        `INSERT INTO form_template (template_key, aggregate_type, title, render_engine, retention_class)
         VALUES ('election_statement','election_statement','Election Statement','react_pdf','compliance') RETURNING id`,
      )
    ).rows[0].id as string;
    const versionId = (
      await admin.query(
        `INSERT INTO form_template_version (template_id, version_label, source_path, payload_schema, status)
         VALUES ($1,'v1.0.0','tpl/election_v1.tsx','{}'::jsonb,'published') RETURNING id`,
        [templateId],
      )
    ).rows[0].id as string;
    await admin.query(`UPDATE form_template SET published_active_version_id=$1 WHERE id=$2`, [versionId, templateId]);
    tmpl.election = { templateId, versionId };

    await admin.query("ALTER ROLE wardenx_app LOGIN");
    handle = createDbClient({ connectionString: (DB_URL as string).replace("://postgres@", "://wardenx_app@") });
    svc = createDbDocumentBackend(handle.db).service;
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("uploadDocument creates the doc + v1 and sets the active head; uploadVersion appends v2", async () => {
    const doc = await svc.uploadDocument(ORG_A, MEMBER, {
      patientId: PATIENT,
      admissionId: null,
      retentionClass: "clinical_record",
      aggregateType: "other",
      aggregateId: null,
      title: "Care plan PDF",
      patientFacing: false,
    });
    expect(doc.versionsCount).toBe(1);
    const v2 = await svc.uploadVersion(ORG_A, doc.id);
    expect(v2.versionNumber).toBe(2);
    // The append-only ledger now has [1,2] and the active head flipped to v2.
    const versions = await svc.listVersions(ORG_A, doc.id, undefined, 100);
    expect(versions.items.map((v) => v.versionNumber).sort()).toEqual([1, 2]);
    const { rows } = await admin.query("SELECT active_version_id FROM document WHERE id=$1", [doc.id]);
    expect(rows[0].active_version_id).toBe(v2.id);
  });

  it("patchDocument updates fields; addTag/removeTag round-trip", async () => {
    const docId = await seedDocument(ORG_A);
    const patched = await svc.patchDocument(ORG_A, docId, { title: "Renamed", patientFacing: true });
    expect(patched.title).toBe("Renamed");
    expect(patched.patientFacing).toBe(true);
    const tag = await svc.addTag(ORG_A, docId, { tagKind: "structured", tagKey: "phase", tagValue: "IIA" });
    expect(tag.tagKey).toBe("phase");
    await svc.removeTag(ORG_A, docId, tag.id);
    // Removing again is a 404 (the row is gone).
    await expect(svc.removeTag(ORG_A, docId, tag.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("an active legal hold blocks patch/tag mutations (409)", async () => {
    const docId = await seedDocument(ORG_A);
    await admin.query(
      `INSERT INTO document_legal_hold (organization_id, document_id, legal_hold_event_id)
       VALUES ($1,$2,gen_random_uuid())`,
      [ORG_A, docId],
    );
    await expect(svc.patchDocument(ORG_A, docId, { title: "x" })).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      svc.addTag(ORG_A, docId, { tagKind: "free", tagKey: "k", tagValue: "v" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("intake batch → classify-confirm → review open/decision/bulk/complete drives the machine", async () => {
    const batch = await svc.uploadBatch(ORG_A, { patientId: PATIENT, sourceChannel: "fax" });
    expect(batch.status).toBe("uploaded");
    const confirmed = await svc.confirmClassification(ORG_A, batch.id);
    expect(confirmed.status).toBe("classifier_complete");

    const review = await svc.openReview(ORG_A, batch.id, MEMBER);
    expect(review.status).toBe("in_progress");
    expect((await admin.query("SELECT status FROM intake_upload_batch WHERE id=$1", [batch.id])).rows[0].status).toBe(
      "in_review",
    );

    const dec = await svc.recordDecision(ORG_A, review.id, {
      candidateId: "99999999-9999-4999-8999-999999999999",
      decision: "approve",
    });
    expect(dec.decisionId).toBeTruthy();
    const bulk = await svc.bulkApprove(ORG_A, review.id, [
      "88888888-8888-4888-8888-888888888881",
      "88888888-8888-4888-8888-888888888882",
    ]);
    expect(bulk.decisionsCreated).toBe(2);

    const completed = await svc.completeReview(ORG_A, review.id);
    expect(completed.status).toBe("complete");
    expect((await admin.query("SELECT status FROM intake_upload_batch WHERE id=$1", [batch.id])).rows[0].status).toBe(
      "writeback_complete",
    );
  });

  it("resolveDiscrepancy closes an open discrepancy; abandonReview + discardBatch terminate", async () => {
    const batch = await seedBatch(ORG_A);
    const review = await svc.openReview(ORG_A, batch, MEMBER);
    const disc = (
      await admin.query(
        `INSERT INTO extraction_discrepancy (organization_id, intake_upload_batch_id, discrepancy_kind,
           field_path, candidate_a_id, candidate_b_id)
         VALUES ($1,$2,'cross_source','patient.dob',gen_random_uuid(),gen_random_uuid()) RETURNING id`,
        [ORG_A, batch],
      )
    ).rows[0].id as string;
    const resolved = await svc.resolveDiscrepancy(ORG_A, review.id, disc);
    expect(resolved.status).toBe("resolved");
    expect((await admin.query("SELECT status FROM extraction_discrepancy WHERE id=$1", [disc])).rows[0].status).toBe(
      "resolved",
    );

    const abandoned = await svc.abandonReview(ORG_A, review.id);
    expect(abandoned.status).toBe("abandoned");
    const discarded = await svc.discardBatch(ORG_A, batch);
    expect(discarded.status).toBe("discarded");
  });

  it("publishOverlay enforces §2.5 optimistic concurrency; retryRender re-queues a form fill", async () => {
    // First publish requires If-Match version 0 → becomes version 1.
    const first = await svc.publishOverlay(ORG_A, "election_statement", 0);
    expect(first.version).toBe(1);
    // A stale If-Match (0 again) now conflicts (412).
    await expect(svc.publishOverlay(ORG_A, "election_statement", 0)).rejects.toMatchObject({ statusCode: 412 });
    // The next publish at the correct version succeeds.
    const second = await svc.publishOverlay(ORG_A, "election_statement", 1);
    expect(second.version).toBe(2);

    // retryRender flips a failed form_fill back to queued.
    const fill = (
      await admin.query(
        `INSERT INTO form_fill (organization_id, template_version_id, aggregate_type, aggregate_id,
           render_payload, status, correlation_id)
         VALUES ($1,$2,'election_statement',gen_random_uuid(),'{}'::jsonb,'failed',gen_random_uuid()) RETURNING id`,
        [ORG_A, tmpl.election.versionId],
      )
    ).rows[0].id as string;
    const retried = await svc.retryRender(ORG_A, fill);
    expect(retried.status).toBe("queued");
    expect((await admin.query("SELECT status FROM form_fill WHERE id=$1", [fill])).rows[0].status).toBe("queued");
  });

  it("RLS: org B cannot patch or read org A's document (404 under the wardenx_app policy)", async () => {
    const docId = await seedDocument(ORG_A);
    await expect(svc.getDocument(ORG_B, docId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.patchDocument(ORG_B, docId, { title: "hijack" })).rejects.toMatchObject({ statusCode: 404 });
  });
});
