/**
 * GAP-095 — M22's document-ROW write store, proven end-to-end over real Postgres.
 *
 * Before this fix: `registerDocumentSeams`'s ONE production call site never passed `store:`, so every
 * render's resulting row landed in a private per-process Map — a DIFFERENT port instance than the one
 * `readers`/`DocumentReader`/`RenderedDocumentProvider` query (the real `document`/`document_version`
 * tables). A render's `documentId` came back looking valid, but no reader seam could ever resolve it —
 * a permanently disconnected write path in every deployment, not a restart-loses-data bug.
 *
 * This test drives the REAL round-trip through the actual seam surface every consumer resolves:
 *   1. `getDocumentRenderer().render(...)` (genesis + addendum) writes through the new
 *      `createDrizzleDocumentSeamStore`.
 *   2. `getRenderedDocumentProvider().getRenderedDocumentForAggregate(...)` — the back-ref every source
 *      module's `m22-document-backref` consumer resolves — reads it back through the SEPARATE `readers`
 *      port (a different Drizzle store instance querying the SAME tables). This is the exact seam GAP-095
 *      broke: two ports over the same tables, one Map-backed and invisible to the other, before this fix.
 *   3. `getDocumentReader().documentMetadata()`/`documentsForPatient()` (M28/M31/M33's read surface).
 *   4. A legal-hold guard proves the store refuses to move a held document's active version.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/gap-095-document-seam-store-live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { runWithRequestContext, withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDrizzleDocumentReaderStore,
  createDrizzleDocumentSeamStore,
  createInMemoryObjectStore,
  getDocumentReader,
  getDocumentRenderer,
  getRenderedDocumentProvider,
  registerDocumentSeams,
} from "../src/modules/22-documents/index";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG = "77777777-7777-7777-7777-777777777777";

describe.skipIf(!DB_URL)("GAP-095 — M22 document-row write store, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let patientId: string;
  let actorUserId: string;

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

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-gap095','GAP-095','GAP-095')",
      [ORG],
    );
    patientId = (
      await admin.query(
        `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
         VALUES ($1,'MRN-GAP095','Riley','Render','1960-02-02','F','active') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    actorUserId = (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
        "gap095-actor@x.test",
      ])
    ).rows[0].id as string;
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });

    registerDocumentSeams({
      store: createDrizzleDocumentSeamStore(handle.db),
      readers: createDrizzleDocumentReaderStore(handle.db),
      objects: createInMemoryObjectStore().store,
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("a render is immediately visible through the SEPARATE reader ports — the exact round-trip GAP-095 broke", async () => {
    const aggregateId = "88888888-8888-8888-8888-888888888801";

    const { documentId } = await getDocumentRenderer().render({ orgId: ORG }, "cti", {
      aggregateId,
      patientId,
      title: "Certification of Terminal Illness — v1",
    });
    expect(documentId).toBeTruthy();

    // Same tables, DIFFERENT port instance (readers, not store) — this is the seam GAP-095 broke.
    const backRef = await runWithRequestContext({ organizationId: ORG, userId: actorUserId }, () =>
      getRenderedDocumentProvider().getRenderedDocumentForAggregate({
        aggregateType: "cti",
        aggregateId,
        organizationId: ORG,
      }),
    );
    expect(backRef).not.toBeNull();
    expect(backRef?.documentId).toBe(documentId);

    const metadata = await runWithRequestContext({ organizationId: ORG, userId: actorUserId }, () =>
      getDocumentReader().documentMetadata({ documentId, organizationId: ORG }),
    );
    expect(metadata?.title).toBe("Certification of Terminal Illness — v1");
    expect(metadata?.aggregateType).toBe("cti");
    expect(metadata?.retentionClass).toBe("compliance");
    expect(metadata?.patientId).toBe(patientId);
    expect(metadata?.activeVersionId).toBe(backRef?.versionId);

    const forPatient = await runWithRequestContext(
      { organizationId: ORG, userId: actorUserId },
      () => getDocumentReader().documentsForPatient({ patientId, organizationId: ORG }),
    );
    expect(forPatient.map((d) => d.documentId)).toContain(documentId);

    // The row really landed with real content columns, not just a Map-shaped id.
    const { rows } = await admin.query(
      `SELECT d.source_kind, d.created_by_membership_id, v.mime_type, v.byte_size, v.sha256_hex, v.uploaded_by_kind, v.uploaded_by_membership_id
       FROM document d JOIN document_version v ON v.id = d.active_version_id WHERE d.id = $1`,
      [documentId],
    );
    expect(rows[0].source_kind).toBe("form_render");
    expect(rows[0].created_by_membership_id).toBe("00000000-0000-0000-0000-000000000000");
    expect(rows[0].mime_type).toBe("application/pdf");
    expect(Number(rows[0].byte_size)).toBeGreaterThan(0);
    expect(rows[0].sha256_hex).toBeTruthy();
    expect(rows[0].uploaded_by_kind).toBe("system_render");
    expect(rows[0].uploaded_by_membership_id).toBeNull();
  });

  it("re-rendering the SAME aggregate appends a new version on the SAME document (W2 addendum), not a new document", async () => {
    const aggregateId = "88888888-8888-8888-8888-888888888802";

    const first = await getDocumentRenderer().render({ orgId: ORG }, "cti", {
      aggregateId,
      patientId,
      title: "CTI v1",
    });
    const second = await getDocumentRenderer().render({ orgId: ORG }, "cti", {
      aggregateId,
      patientId,
      title: "CTI v2 (corrected)",
    });

    expect(second.documentId).toBe(first.documentId);

    const { rows: versionRows } = await admin.query(
      "SELECT version_number FROM document_version WHERE document_id = $1 ORDER BY version_number",
      [first.documentId],
    );
    expect(versionRows.map((r) => r.version_number)).toEqual(["1", "2"]);

    const { rows: docRows } = await admin.query(
      "SELECT title, active_version_id FROM document WHERE id = $1",
      [first.documentId],
    );
    expect(docRows[0].title).toBe("CTI v2 (corrected)");

    const backRef = await runWithRequestContext({ organizationId: ORG, userId: actorUserId }, () =>
      getRenderedDocumentProvider().getRenderedDocumentForAggregate({
        aggregateType: "cti",
        aggregateId,
        organizationId: ORG,
      }),
    );
    expect(backRef?.documentId).toBe(first.documentId);
    expect(backRef?.versionId).toBe(docRows[0].active_version_id);
  });

  it("refuses to append a version to a legal-hold document", async () => {
    const aggregateId = "88888888-8888-8888-8888-888888888803";
    const { documentId } = await getDocumentRenderer().render({ orgId: ORG }, "cti", {
      aggregateId,
      patientId,
      title: "CTI under hold",
    });
    await withOrgContext(handle.db, { organizationId: ORG, userId: "" }, (tx) =>
      tx.execute(sql`UPDATE document SET status = 'legal_hold' WHERE id = ${documentId}`),
    );

    await expect(
      getDocumentRenderer().render({ orgId: ORG }, "cti", {
        aggregateId,
        patientId,
        title: "should be refused",
      }),
    ).rejects.toThrow(/DOCUMENT_IMMUTABLE|cannot accept a new rendered version/);
  });
});
