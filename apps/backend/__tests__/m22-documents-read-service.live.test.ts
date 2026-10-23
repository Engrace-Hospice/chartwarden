/**
 * M22L-T01 — the Drizzle `createDbDocumentBackend` READ paths, proven against real Postgres.
 *
 * M22's pure suites drive the forms/intake/extraction state machines but never touch a database, and the
 * RLS live suite (`packages/db/migrations/__tests__/m22-rls-isolation.live.test.ts`) proves the policies as
 * raw SQL. Neither exercises the PRODUCTION read SERVICE — the one the composition root mounts. This drives
 * `createDbDocumentRouteService` over the real M22 tables under `withOrgContext` as the unprivileged
 * `chartwarden_app` role, proving the document-library / detail / version-ledger reads return the right rows,
 * RLS scopes every read by tenant, and every write fail-closes 501.
 *
 * Gated on a live DB (default `bun run test` skips it):
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test …
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbDocumentBackend } from "../src/modules/22-documents/documents-route-service-db";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
/** No M22 table carries an FK to membership/patient — every such column is a plain uuid, app-validated. */
const MEMBERSHIP = "44444444-4444-4444-4444-444444444444";
const PATIENT = "55555555-5555-5555-5555-555555555555";

describe.skipIf(!DB_URL)("M22 Drizzle read service — LIVE Postgres (M22L-T01)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof createDbDocumentBackend>["service"];
  const seeded: Record<string, { document: string; documentVersion: string }> = {};

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
  }

  async function applyMigrations() {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  /** Seed one document chain for `org` (provider entity + location + one document + one version). */
  async function seedOrg(org: string, n: number) {
    const pe = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-M22R${n}`, `M22R ${n}`, `NPI-M22R${n}`],
      )
    ).rows[0].id;
    const loc = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [pe, `Loc-M22R${n}`],
      )
    ).rows[0].id;
    const document = (
      await admin.query(
        `INSERT INTO document (organization_id, patient_id, provider_entity_id, location_id, retention_class,
           source_kind, aggregate_type, title, created_by_membership_id)
         VALUES ($1,$2,$3,$4,'clinical_record','user_upload','other','Chart doc',$5) RETURNING id`,
        [org, PATIENT, pe, loc, MEMBERSHIP],
      )
    ).rows[0].id;
    const documentVersion = (
      await admin.query(
        `INSERT INTO document_version (organization_id, document_id, version_number, minio_object_key,
           mime_type, byte_size, sha256_hex, uploaded_by_kind)
         VALUES ($1,$2,'1','minio/key-m22r${n}','application/pdf','1024','abc123','system') RETURNING id`,
        [org, document],
      )
    ).rows[0].id;
    seeded[org] = { document, documentVersion };
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m22r@x.test')`, [USER]);
    await seedOrg(ORG_A, 1);
    await seedOrg(ORG_B, 2);
    // Prod connects as the NOBYPASSRLS `chartwarden_app` role; `withOrgContext` does NOT SET ROLE. To exercise
    // RLS faithfully, connect AS chartwarden_app — it is NOLOGIN in the migrations, so grant LOGIN for the run.
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    service = createDbDocumentBackend(handle.db).service;
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("listDocuments returns the org's document (RLS-scoped), correct shape", async () => {
    const page = await service.listDocuments(ORG_A, {}, undefined, undefined);
    expect(page.items.length).toBe(1);
    expect(page.items[0].id).toBe(seeded[ORG_A].document);
    expect(page.items[0].patientId).toBe(PATIENT);
    expect(page.items[0].title).toBe("Chart doc");
    expect(page.items[0].retentionClass).toBe("clinical_record");
    expect(page.items[0].status).toBe("active");
    expect(page.nextCursor).toBeNull();
  });

  it("getDocument returns the detail with the append-only version count", async () => {
    const doc = await service.getDocument(ORG_A, seeded[ORG_A].document);
    expect(doc.id).toBe(seeded[ORG_A].document);
    expect(doc.title).toBe("Chart doc");
    // `document` carries no version counter — the version number IS the ledger count (one seeded version).
    expect(doc.versionsCount).toBe(1);
    expect(doc.version).toBe(1);
  });

  it("listVersions returns the seeded version ledger for a real document", async () => {
    const page = await service.listVersions(ORG_A, seeded[ORG_A].document, undefined, undefined);
    expect(page.items.length).toBe(1);
    expect(page.items[0].id).toBe(seeded[ORG_A].documentVersion);
    expect(page.items[0].versionNumber).toBe(1);
    expect(page.items[0].mimeType).toBe("application/pdf");
  });

  it("RLS: org B cannot see org A's document through the read service", async () => {
    const page = await service.listDocuments(ORG_B, {}, undefined, undefined);
    expect(page.items.every((i) => i.id !== seeded[ORG_A].document)).toBe(true);
    // getDocument fail-closes to a non-leaking 404 for a cross-tenant id (RLS hides the row).
    await expect(service.getDocument(ORG_B, seeded[ORG_A].document)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("uploadDocument fail-closes DEGRADED when this suite binds no object store (GAP-068: bound-store round-trip is the write suite)", async () => {
    // GAP-086 — this case used to assert the opposite: that `uploadDocument` INSERTs the document + its v1
    // version and round-trips through the RLS-scoped read. That was true when it was written and is not
    // anymore. Uploads were since moved behind `createVerifiedUploadService`, which presigns, then inspects
    // the stored object and persists only a byte size and SHA-256 it has VERIFIED — so the bare service
    // method now refuses instead of recording a version whose bytes nobody checked. The stale assertion
    // survived only because this suite has never run in CI; it is the current contract that gets pinned
    // here, and the real persisted round-trip lives in the write suite (m22-documents-write), which wires
    // the object-store port this one deliberately does not.
    await expect(
      service.uploadDocument(
        ORG_A,
        { userId: USER, membershipId: MEMBERSHIP },
        {
          patientId: PATIENT,
          admissionId: null,
          retentionClass: "clinical_record",
          aggregateType: "other",
          aggregateId: null,
          title: "Smoke upload",
          patientFacing: false,
          tags: [],
          content: { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), mimeType: "application/pdf" },
        },
      ),
    ).rejects.toMatchObject({ name: "DegradedError" });

    // And the refusal is total — nothing was written on the way to throwing.
    const page = await service.listDocuments(ORG_A, {}, undefined, 100);
    expect(page.items.every((d) => d.title !== "Smoke upload")).toBe(true);
  });

  // #592 F-023 — the list narrows by patient in SQL. Proven here (real Postgres, NOBYPASSRLS role) because the
  // in-memory route tests cannot catch a drizzle `inArray` / `sql\`false\`` regression.
  describe("patientScope (F-023)", () => {
    const OTHER_PATIENT = "66666666-6666-6666-6666-666666666666";

    async function insertCopy(title: string, patientId: string | null) {
      await admin.query(
        `INSERT INTO document (organization_id, patient_id, provider_entity_id, location_id, retention_class,
           source_kind, aggregate_type, title, created_by_membership_id)
         SELECT organization_id, $2, provider_entity_id, location_id, retention_class,
                source_kind, aggregate_type, $3, created_by_membership_id
           FROM document WHERE id = $1`,
        [seeded[ORG_A].document, patientId, title],
      );
    }

    const titlesFor = async (patientScope: readonly string[] | null) =>
      (await service.listDocuments(ORG_A, { patientScope }, undefined, 100)).items
        .map((d) => d.title)
        .filter((t) => t.startsWith("F023"))
        .sort();

    beforeAll(async () => {
      await insertCopy("F023 mine", PATIENT);
      await insertCopy("F023 other patient", OTHER_PATIENT);
      await insertCopy("F023 org level", null);
    });

    it("a caseload scope returns only that patient's documents", async () => {
      expect(await titlesFor([PATIENT])).toEqual(["F023 mine"]);
    });

    it("an empty scope returns nothing", async () => {
      expect(await titlesFor([])).toEqual([]);
    });

    it("the org-wide arm (null) returns every document, including org-level ones", async () => {
      expect(await titlesFor(null)).toEqual(["F023 mine", "F023 org level", "F023 other patient"]);
    });

    it("a patientId filter outside the scope cannot widen it", async () => {
      const page = await service.listDocuments(
        ORG_A,
        { patientScope: [PATIENT], patientId: OTHER_PATIENT },
        undefined,
        100,
      );
      expect(page.items).toEqual([]);
    });
  });
});
