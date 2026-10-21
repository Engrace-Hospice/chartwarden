import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDrizzleDocumentReaderStore } from "../src/modules/22-documents/seams/drizzle-readers-store";
/**
 * M22 — `DocumentReader.linkSummary` (the M36 WP 3.2 clinical-link read seam) proven against real Postgres as
 * the NOBYPASSRLS `wardenx_app` role: found, unknown id, cross-tenant, exactly four keys (no title), a
 * null-patient document, and a superseded document that still reports its status.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m22:link-summary:live
 * (no pgvector locally: WARDENX_TEST_NO_PGVECTOR=1)
 */
import { createDocumentReader } from "../src/modules/22-documents/seams/readers";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const MISSING = "99999999-9999-9999-9999-999999999999";
const SECRET_TITLE = "Jane Q. Patient - signed NOR";

describe.skipIf(!DB_URL)("M22 DocumentReader.linkSummary — LIVE Postgres as wardenx_app", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let reader: ReturnType<typeof createDocumentReader>;
  let membership: string;

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
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }

  async function seedDoc(org: string, patient: string | null, status = "active"): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO document (organization_id, patient_id, retention_class, source_kind, aggregate_type,
           title, status, created_by_membership_id, created_at)
         VALUES ($1,$2,'clinical_record','user_upload','other',$3,$4,$5,'2031-03-15T12:00:00Z') RETURNING id`,
        [org, patient, SECRET_TITLE, status, membership],
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
    const user = (
      await admin.query(`INSERT INTO "user" (email) VALUES ('ls22@x.test') RETURNING id`)
    ).rows[0].id as string;
    membership = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [user, ORG_A],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    reader = createDocumentReader(createDrizzleDocumentReaderStore(handle.db));
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("proves the connection is the NOBYPASSRLS app role", async () => {
    const probe = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await probe.connect();
    const { rows } = await probe.query(
      "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user",
    );
    await probe.end();
    expect(rows[0]).toMatchObject({
      current_user: "wardenx_app",
      rolsuper: false,
      rolbypassrls: false,
    });
  });

  it("finds a document: id, patient, status and created_at, with exactly four keys and no title", async () => {
    const id = await seedDoc(ORG_A, PATIENT);
    const r = await reader.linkSummary(ORG_A, id);
    expect(r).toEqual({
      id,
      patientId: PATIENT,
      status: "active",
      occurredAt: "2031-03-15T12:00:00.000Z",
    });
    expect(Object.keys(r ?? {}).sort()).toEqual(["id", "occurredAt", "patientId", "status"]);
    expect(JSON.stringify(r)).not.toContain("Jane");
  });

  it("returns null for an unknown id", async () => {
    expect(await reader.linkSummary(ORG_A, MISSING)).toBeNull();
  });

  it("cross-tenant: org B cannot see org A's document", async () => {
    const id = await seedDoc(ORG_A, PATIENT);
    expect(await reader.linkSummary(ORG_B, id)).toBeNull();
    expect((await reader.linkSummary(ORG_A, id))?.id).toBe(id);
  });

  it("returns a null-patient document faithfully", async () => {
    const id = await seedDoc(ORG_A, null);
    expect((await reader.linkSummary(ORG_A, id))?.patientId).toBeNull();
  });

  it("does not hide a superseded document", async () => {
    const id = await seedDoc(ORG_A, PATIENT, "superseded");
    expect((await reader.linkSummary(ORG_A, id))?.status).toBe("superseded");
  });

  it("withholds a destroyed or legal-hold document exactly like a missing one", async () => {
    const gone = await seedDoc(ORG_A, PATIENT, "destroyed_tombstone");
    const hold = await seedDoc(ORG_A, PATIENT, "legal_hold");
    expect(await reader.linkSummary(ORG_A, gone)).toBeNull();
    expect(await reader.linkSummary(ORG_A, hold)).toBeNull();
  });

  it("fails closed on a blank org or id", async () => {
    await expect(reader.linkSummary("", MISSING)).rejects.toThrow();
    await expect(reader.linkSummary(ORG_A, "")).rejects.toThrow();
  });
});
