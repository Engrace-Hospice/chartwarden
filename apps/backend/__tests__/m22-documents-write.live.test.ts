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
import { createVerifiedUploadService } from "../src/modules/22-documents/routes/verified-upload";
import type { ObjectStorePort } from "../src/modules/22-documents/seams/store";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const MEMBER = "33333333-3333-3333-3333-333333333333"; // document created_by etc. carry no FK — literal ok
const PATIENT = "44444444-4444-4444-4444-444444444444";
const MEMBERSHIP = "77777777-7777-4777-8777-777777777777";
/** GAP-039 — every write carries BOTH ids: the audit actor (`user.id`, FK-checked by audit_event)
 *  and the membership the `*_by_membership_id` columns record. */
const ACTOR = { userId: MEMBER, membershipId: MEMBERSHIP };

describe.skipIf(!DB_URL)("M22 Documents write lifecycle — LIVE Postgres (M22L)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbDocumentBackend>["service"];
  let verifiedUpload: ReturnType<typeof createVerifiedUploadService>;
  let lastStagedObject: { bucket: string; objectKey: string } | null = null;
  const objectMetadata = new Map<
    string,
    { byteSize: number; mimeType: string; sha256Hex: string }
  >();
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m22w@x.test')`, [MEMBER]);
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
    await admin.query("UPDATE form_template SET published_active_version_id=$1 WHERE id=$2", [
      versionId,
      templateId,
    ]);
    tmpl.election = { templateId, versionId };

    await admin.query("ALTER ROLE wardenx_app LOGIN PASSWORD 'wardenx_app_test'");
    const runtimeUrl = new URL(DB_URL as string);
    runtimeUrl.username = "wardenx_app";
    runtimeUrl.password = "wardenx_app_test";
    handle = createDbClient({
      connectionString: runtimeUrl.toString(),
    });
    svc = createDbDocumentBackend(handle.db).service;
    const objects: ObjectStorePort = {
      async putObject() {
        throw new Error("not used by direct-upload test");
      },
      async presignUpload({ bucket, objectKey, mimeType, sha256Hex }) {
        lastStagedObject = { bucket, objectKey };
        return {
          url: `https://object.invalid/${bucket}/${objectKey}`,
          headers: { "content-type": mimeType, "x-amz-checksum-sha256": sha256Hex },
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        };
      },
      async inspectObject({ bucket, objectKey }) {
        return objectMetadata.get(`${bucket}/${objectKey}`) ?? null;
      },
      async presign() {
        throw new Error("not used by direct-upload test");
      },
      async destroyAllVersions({ bucket, objectKey }) {
        objectMetadata.delete(`${bucket}/${objectKey}`);
      },
    };
    verifiedUpload = createVerifiedUploadService({ db: handle.db, objects });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("verified direct upload creates v1 only after HEAD verification; completion replay is idempotent", async () => {
    const sha256Hex = "a".repeat(64);
    const initiated = await verifiedUpload.initiate({
      organizationId: ORG_A,
      userId: MEMBER,
      membershipId: MEMBER,
      input: {
        mode: "new_document",
        targetDocumentId: null,
        patientId: PATIENT,
        admissionId: null,
        retentionClass: "clinical_record",
        aggregateType: "other",
        aggregateId: null,
        title: "Care plan PDF",
        patientFacing: false,
        mimeType: "application/pdf",
        byteSize: 4096,
        sha256Hex,
      },
    });
    expect(initiated.uploadUrl).toContain(initiated.uploadId);
    expect(
      (await admin.query("SELECT count(*)::int AS n FROM document WHERE title='Care plan PDF'"))
        .rows[0].n,
    ).toBe(0);
    if (!lastStagedObject) throw new Error("presign did not capture staged object");
    objectMetadata.set(`${lastStagedObject.bucket}/${lastStagedObject.objectKey}`, {
      byteSize: 4096,
      mimeType: "application/pdf",
      sha256Hex,
    });

    const completed = await verifiedUpload.complete({
      organizationId: ORG_A,
      userId: MEMBER,
      membershipId: MEMBER,
      uploadId: initiated.uploadId,
    });
    expect(completed.versionNumber).toBe(1);
    await expect(
      verifiedUpload.complete({
        organizationId: ORG_A,
        userId: MEMBER,
        membershipId: MEMBER,
        uploadId: initiated.uploadId,
      }),
    ).resolves.toEqual(completed);

    const v2Initiated = await verifiedUpload.initiate({
      organizationId: ORG_A,
      userId: MEMBER,
      membershipId: MEMBER,
      input: {
        mode: "new_version",
        targetDocumentId: completed.documentId,
        patientId: PATIENT,
        admissionId: null,
        retentionClass: "clinical_record",
        aggregateType: "other",
        aggregateId: null,
        title: "Care plan PDF corrected",
        patientFacing: false,
        mimeType: "application/pdf",
        byteSize: 8192,
        sha256Hex,
      },
    });
    if (!lastStagedObject) throw new Error("presign did not capture staged object");
    objectMetadata.set(`${lastStagedObject.bucket}/${lastStagedObject.objectKey}`, {
      byteSize: 8192,
      mimeType: "application/pdf",
      sha256Hex,
    });
    const v2 = await verifiedUpload.complete({
      organizationId: ORG_A,
      userId: MEMBER,
      membershipId: MEMBER,
      uploadId: v2Initiated.uploadId,
    });
    expect(v2.documentId).toBe(completed.documentId);
    expect(v2.versionNumber).toBe(2);

    const doc = await svc.getDocument(ORG_A, completed.documentId);
    expect(doc.versionsCount).toBe(2);
    const versions = await svc.listVersions(ORG_A, completed.documentId, undefined, 100);
    expect(versions.items.map((v) => v.versionNumber).sort()).toEqual([1, 2]);
    const { rows } = await admin.query("SELECT active_version_id FROM document WHERE id=$1", [
      completed.documentId,
    ]);
    expect(rows[0].active_version_id).toBe(v2.versionId);
  });

  it("patchDocument updates fields; addTag/removeTag round-trip", async () => {
    const docId = await seedDocument(ORG_A);
    const patched = await svc.patchDocument(ORG_A, ACTOR, docId, {
      title: "Renamed",
      patientFacing: true,
    });
    expect(patched.title).toBe("Renamed");
    expect(patched.patientFacing).toBe(true);
    const tag = await svc.addTag(ORG_A, ACTOR, docId, {
      tagKind: "structured",
      tagKey: "phase",
      tagValue: "IIA",
    });
    expect(tag.tagKey).toBe("phase");
    await svc.removeTag(ORG_A, ACTOR, docId, tag.id);
    // Removing again is a 404 (the row is gone).
    await expect(svc.removeTag(ORG_A, ACTOR, docId, tag.id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("an active legal hold blocks patch/tag mutations (409)", async () => {
    const docId = await seedDocument(ORG_A);
    await admin.query(
      `INSERT INTO document_legal_hold (organization_id, document_id, legal_hold_event_id)
       VALUES ($1,$2,gen_random_uuid())`,
      [ORG_A, docId],
    );
    await expect(svc.patchDocument(ORG_A, ACTOR, docId, { title: "x" })).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(
      svc.addTag(ORG_A, ACTOR, docId, { tagKind: "free", tagKey: "k", tagValue: "v" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("intake batch → classify-confirm → review open/decision/bulk/complete drives the machine", async () => {
    const batch = await svc.uploadBatch(ORG_A, ACTOR, { patientId: PATIENT, sourceChannel: "fax" });
    expect(batch.status).toBe("uploaded");
    const confirmed = await svc.confirmClassification(ORG_A, ACTOR, batch.id);
    expect(confirmed.status).toBe("classifier_complete");

    const review = await svc.openReview(ORG_A, ACTOR, batch.id);
    expect(review.status).toBe("in_progress");
    expect(
      (await admin.query("SELECT status FROM intake_upload_batch WHERE id=$1", [batch.id])).rows[0]
        .status,
    ).toBe("in_review");

    const dec = await svc.recordDecision(ORG_A, ACTOR, review.id, {
      candidateId: "99999999-9999-4999-8999-999999999999",
      decision: "approve",
    });
    expect(dec.decisionId).toBeTruthy();
    const bulk = await svc.bulkApprove(ORG_A, ACTOR, review.id, [
      "88888888-8888-4888-8888-888888888881",
      "88888888-8888-4888-8888-888888888882",
    ]);
    expect(bulk.decisionsCreated).toBe(2);

    const completed = await svc.completeReview(ORG_A, ACTOR, review.id);
    expect(completed.status).toBe("complete");
    expect(
      (await admin.query("SELECT status FROM intake_upload_batch WHERE id=$1", [batch.id])).rows[0]
        .status,
    ).toBe("writeback_complete");
  });

  it("resolveDiscrepancy closes an open discrepancy; abandonReview + discardBatch terminate", async () => {
    const batch = await seedBatch(ORG_A);
    const review = await svc.openReview(ORG_A, ACTOR, batch);
    const disc = (
      await admin.query(
        `INSERT INTO extraction_discrepancy (organization_id, intake_upload_batch_id, discrepancy_kind,
           field_path, candidate_a_id, candidate_b_id)
         VALUES ($1,$2,'cross_source','patient.dob',gen_random_uuid(),gen_random_uuid()) RETURNING id`,
        [ORG_A, batch],
      )
    ).rows[0].id as string;
    const resolved = await svc.resolveDiscrepancy(ORG_A, ACTOR, review.id, disc);
    expect(resolved.status).toBe("resolved");
    expect(
      (await admin.query("SELECT status FROM extraction_discrepancy WHERE id=$1", [disc])).rows[0]
        .status,
    ).toBe("resolved");

    const abandoned = await svc.abandonReview(ORG_A, ACTOR, review.id);
    expect(abandoned.status).toBe("abandoned");
    const discarded = await svc.discardBatch(ORG_A, ACTOR, batch);
    expect(discarded.status).toBe("discarded");
  });

  it("publishOverlay enforces §2.5 optimistic concurrency; retryRender re-queues a form fill", async () => {
    // First publish requires If-Match version 0 → becomes version 1.
    const first = await svc.publishOverlay(ORG_A, ACTOR, "election_statement", 0);
    expect(first.version).toBe(1);
    // A stale If-Match (0 again) now conflicts (412).
    await expect(svc.publishOverlay(ORG_A, ACTOR, "election_statement", 0)).rejects.toMatchObject({
      statusCode: 412,
    });
    // The next publish at the correct version succeeds.
    const second = await svc.publishOverlay(ORG_A, ACTOR, "election_statement", 1);
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
    const retried = await svc.retryRender(ORG_A, ACTOR, fill);
    expect(retried.status).toBe("queued");
    expect(
      (await admin.query("SELECT status FROM form_fill WHERE id=$1", [fill])).rows[0].status,
    ).toBe("queued");
  });

  it("GAP-039: every write is attributed — audit actor + membership, not NULL and not a sentinel", async () => {
    // Before GAP-039 these writes ran under `withOrgContext(userId: "")`, so M4's trigger resolved
    // `NULLIF(current_setting('app.user_id', true), '')::uuid` to NULL and the entire M22 write history
    // recorded WHAT changed and nothing about WHO. The `*_by_membership_id` columns took a hardcoded
    // sentinel constant. Both ids were sitting on `request.context` the whole time.
    // Everything the ADMIN (superuser) seeds happens first: its inserts fire the same triggers with no
    // `app.user_id` set, and a seed row's unattributed event would mask the very thing under test.
    const docId = await seedDocument(ORG_A);
    const seededBatch = await seedBatch(ORG_A);
    const disc = (
      await admin.query(
        `INSERT INTO extraction_discrepancy (organization_id, intake_upload_batch_id, discrepancy_kind,
           field_path, candidate_a_id, candidate_b_id)
         VALUES ($1,$2,'cross_source','patient.dob',gen_random_uuid(),gen_random_uuid()) RETURNING id`,
        [ORG_A, seededBatch],
      )
    ).rows[0].id as string;
    await admin.query("DELETE FROM audit_event WHERE organization_id = $1", [ORG_A]);

    // From here every row change is the production service's, through the app role.
    await svc.patchDocument(ORG_A, ACTOR, docId, { title: "Attributed" });
    const tag = await svc.addTag(ORG_A, ACTOR, docId, {
      tagKind: "structured",
      tagKey: "attr",
      tagValue: "yes",
    });
    const batch = await svc.uploadBatch(ORG_A, ACTOR, { patientId: PATIENT, sourceChannel: "fax" });
    const review = await svc.openReview(ORG_A, ACTOR, seededBatch);
    await svc.resolveDiscrepancy(ORG_A, ACTOR, review.id, disc);
    // §2.5 If-Match is the CURRENT overlay-row count, which earlier cases in this suite have already
    // advanced — read it rather than assuming a fresh template.
    const overlayVersion = Number(
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM tenant_template_overlay WHERE organization_id = $1
             AND template_id = $2`,
          [ORG_A, tmpl.election.templateId],
        )
      ).rows[0].n,
    );
    await svc.publishOverlay(ORG_A, ACTOR, "election_statement", overlayVersion);
    // The DELETE trigger must be attributed too; a second tag survives for the column assertion below.
    await svc.removeTag(ORG_A, ACTOR, docId, tag.id);
    await svc.addTag(ORG_A, ACTOR, docId, {
      tagKind: "structured",
      tagKey: "attr2",
      tagValue: "kept",
    });

    // 1. The M4 write triggers recorded the acting USER on every row they touched.
    const events = await admin.query(
      "SELECT event_type, actor_user_id::text FROM audit_event WHERE organization_id = $1",
      [ORG_A],
    );
    expect(events.rows.length).toBeGreaterThan(0);
    const unattributed = events.rows.filter((r) => r.actor_user_id === null);
    expect(unattributed).toEqual([]);
    expect(new Set(events.rows.map((r) => r.actor_user_id))).toEqual(new Set([MEMBER]));

    // 2. The `*_by_membership_id` columns hold the real MEMBERSHIP — a different id space, and the
    //    reason a write takes a `DocumentWriteActor` instead of one string that could be either.
    for (const [table, column, filter] of [
      ["document_tag", "added_by_membership_id", `document_id = '${docId}'`],
      ["intake_upload_batch", "uploaded_by_membership_id", `id = '${batch.id}'`],
      ["extraction_review", "reviewer_membership_id", `id = '${review.id}'`],
      ["extraction_discrepancy", "resolved_by_membership_id", `id = '${disc}'`],
      ["tenant_template_overlay", "published_by_membership_id", "is_active = true"],
    ] as const) {
      const { rows } = await admin.query(
        `SELECT ${column}::text AS v FROM ${table} WHERE organization_id = $1 AND ${filter}`,
        [ORG_A],
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.v).toBe(MEMBERSHIP);
    }
  });

  // F-060 (#153) — `document_tag` had an INSERT, a DELETE-by-id and no SELECT anywhere in the
  // codebase. The write half above has always been live-proven; what was never proven is that the
  // row can be read BACK, because nothing could read it. Both queries the table's two indexes were
  // built for run here for the first time.
  it("F-060: tags are readable — listTags round-trips the row addTag wrote, and the DELETE is reachable from it", async () => {
    const docId = await seedDocument(ORG_A);
    const written = await svc.addTag(ORG_A, ACTOR, docId, {
      tagKind: "structured",
      tagKey: "phase",
      tagValue: "IIA",
    });
    // The reload: nothing of the POST response survives it, so the id must come from the read.
    const page = await svc.listTags(ORG_A, docId, undefined, undefined);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: written.id,
      tagKind: "structured",
      tagKey: "phase",
      tagValue: "IIA",
    });
    // addTag's returned instant is the one the row actually carries — not a client-side guess.
    expect(page.items[0]?.addedAt).toBe(written.addedAt);
    await svc.removeTag(ORG_A, ACTOR, docId, page.items[0]!.id);
    expect((await svc.listTags(ORG_A, docId, undefined, undefined)).items).toHaveLength(0);
  });

  it("F-060: a bare key round-trips as a null value, and newest-first ordering holds", async () => {
    const docId = await seedDocument(ORG_A);
    await svc.addTag(ORG_A, ACTOR, docId, { tagKind: "free", tagKey: "first", tagValue: null });
    await svc.addTag(ORG_A, ACTOR, docId, { tagKind: "free", tagKey: "second", tagValue: "v" });
    const { items } = await svc.listTags(ORG_A, docId, undefined, undefined);
    expect(items.map((t) => t.tagKey)).toEqual(["second", "first"]);
    expect(items.find((t) => t.tagKey === "first")?.tagValue).toBeNull();
  });

  it("F-060: listDocuments filters by tag — the cross-document query document_tag_org_key_idx exists for", async () => {
    const match = await seedDocument(ORG_A);
    const otherValue = await seedDocument(ORG_A);
    const untagged = await seedDocument(ORG_A);
    await svc.addTag(ORG_A, ACTOR, match, {
      tagKind: "structured",
      tagKey: "campaign",
      tagValue: "hit",
    });
    await svc.addTag(ORG_A, ACTOR, otherValue, {
      tagKind: "structured",
      tagKey: "campaign",
      tagValue: "miss",
    });
    // A document matching a key TWICE must stay one row — EXISTS, never a join.
    await svc.addTag(ORG_A, ACTOR, match, {
      tagKind: "structured",
      tagKey: "campaign",
      tagValue: "hit-again",
    });

    const byKey = await svc.listDocuments(ORG_A, { tagKey: "campaign" }, undefined, undefined);
    const byKeyIds = byKey.items.map((d) => d.id);
    expect(byKeyIds).toContain(match);
    expect(byKeyIds).toContain(otherValue);
    expect(byKeyIds).not.toContain(untagged);
    expect(byKeyIds.filter((id) => id === match)).toHaveLength(1);

    const byValue = await svc.listDocuments(
      ORG_A,
      { tagKey: "campaign", tagValue: "hit" },
      undefined,
      undefined,
    );
    expect(byValue.items.map((d) => d.id)).toEqual([match]);
  });

  it("F-060: RLS — org B cannot list org A's tags, and its tag filter never crosses the tenant", async () => {
    const docId = await seedDocument(ORG_A);
    await svc.addTag(ORG_A, ACTOR, docId, {
      tagKind: "free",
      tagKey: "private",
      tagValue: "org A only",
    });
    // The document itself is a non-leaking 404 for org B, so its tags cannot even be asked for.
    await expect(svc.listTags(ORG_B, docId, undefined, undefined)).rejects.toMatchObject({
      statusCode: 404,
    });
    const crossTenant = await svc.listDocuments(
      ORG_B,
      { tagKey: "private" },
      undefined,
      undefined,
    );
    expect(crossTenant.items).toHaveLength(0);
  });

  it("RLS: org B cannot patch or read org A's document (404 under the wardenx_app policy)", async () => {
    const docId = await seedDocument(ORG_A);
    await expect(svc.getDocument(ORG_B, docId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.patchDocument(ORG_B, ACTOR, docId, { title: "hijack" })).rejects.toMatchObject(
      {
        statusCode: 404,
      },
    );
  });
});
