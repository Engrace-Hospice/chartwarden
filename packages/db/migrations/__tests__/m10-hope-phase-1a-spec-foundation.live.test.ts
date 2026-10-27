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
const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const PATIENT = "33333333-3333-3333-3333-333333333333";
const ADMISSION = "44444444-4444-4444-4444-444444444444";

describe.skipIf(!DB_URL)("M10 HOPE Phase 1A spec foundation — LIVE Postgres", () => {
  let db: Client;
  let membershipId: string;
  let providerEntityId: string;
  let locationId: string;
  let assessmentId: string;
  let specVersionId: string;
  let otherSpecVersionId: string;
  let itemId: string;
  let otherItemId: string;

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

  async function insertSpecVersion(code: string) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO hope_spec_version
        (code, item_set_version, effective_from, effective_to, source_label, source_release)
       VALUES ($1, '1.00', '2025-10-01', NULL, 'HOPE Data Specifications fixture', 'FINAL')
       RETURNING id`,
      [code],
    );
    return rows[0].id;
  }

  async function insertSpecItem(versionId: string, code: string, masterKey: string) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO hope_spec_item (
         spec_version_id, cms_item_master_key, item_code, database_item_code, short_label,
         section_label, item_sort_order, section_sort_order, cms_item_type_code, kind,
         source_metadata
       ) VALUES ($1,$2,$3,$4,'Fixture item','Administrative',10,1,'C','assessment',$5::jsonb)
       RETURNING id`,
      [versionId, masterKey, code, `${code}_DB`, JSON.stringify({ source: "test" })],
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL });
    await db.connect();
    await resetSchema();
    await applyMigrations();

    await db.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'hope1a','HOPE 1A','HOPE 1A')",
      [ORG],
    );
    await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'hope-phase-1a@x.test')`, [USER]);
    membershipId = (
      await db.query<{ id: string }>(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG],
      )
    ).rows[0].id;
    providerEntityId = (
      await db.query<{ id: string }>(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN1A','HOPE Provider','NPI1A','enc','12-31') RETURNING id`,
        [ORG],
      )
    ).rows[0].id;
    locationId = (
      await db.query<{ id: string }>(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'HOPE Location','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntityId],
      )
    ).rows[0].id;

    specVersionId = await insertSpecVersion("1.00.1");
    otherSpecVersionId = await insertSpecVersion("1.00.2");
    itemId = await insertSpecItem(specVersionId, "A0250", "mstr-A0250-v1");
    otherItemId = await insertSpecItem(specVersionId, "J2051", "mstr-J2051-v1");

    assessmentId = (
      await db.query<{ id: string }>(
        `INSERT INTO hope_assessment (
           organization_id, patient_id, admission_id, rfa_kind, spec_version_id, isc,
           data, target_date, created_by_membership_id
         ) VALUES ($1,$2,$3,'01_admission',$4,'HA','{}'::jsonb, now(), $5) RETURNING id`,
        [ORG, PATIENT, ADMISSION, specVersionId, membershipId],
      )
    ).rows[0].id;
  }, 120_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  it("creates immutable-style spec versions and rejects duplicate codes", async () => {
    const id = await insertSpecVersion("fixture-unique");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    await expect(insertSpecVersion("fixture-unique")).rejects.toThrow();
  });

  it("allows the same item code in different spec versions but rejects duplicates in one version", async () => {
    const sameCodeOtherVersion = await insertSpecItem(otherSpecVersionId, "A0250", "mstr-A0250-v2");
    expect(sameCodeOtherVersion).toMatch(/^[0-9a-f-]{36}$/);

    await expect(insertSpecItem(specVersionId, "A0250", "mstr-A0250-duplicate")).rejects.toThrow();
  });

  it("stores the ISC activation matrix as one row per item and rejects duplicate item+ISC rows", async () => {
    await db.query(
      `INSERT INTO hope_spec_item_isc (spec_item_id, isc, active)
       VALUES ($1,'HA',true),($1,'HUV',false),($1,'HD',false),($1,'XX',true)`,
      [itemId],
    );

    const { rows } = await db.query<{ isc: string; active: boolean }>(
      "SELECT isc, active FROM hope_spec_item_isc WHERE spec_item_id=$1 ORDER BY isc",
      [itemId],
    );
    expect(rows.map((r) => r.isc).sort()).toEqual(["HA", "HD", "HUV", "XX"]);

    await expect(
      db.query(
        "INSERT INTO hope_spec_item_isc (spec_item_id, isc, active) VALUES ($1,'HA',false)",
        [itemId],
      ),
    ).rejects.toThrow();
  });

  it("stores allowed values as text and scopes value uniqueness to one item", async () => {
    await db.query(
      `INSERT INTO hope_spec_item_option (spec_item_id, cms_item_value_key, sort_order, value_code, label)
       VALUES ($1,'val-9-a0250',1,'9','Not applicable'),($2,'val-9-j2051',1,'9','Not applicable')`,
      [itemId, otherItemId],
    );

    await expect(
      db.query(
        `INSERT INTO hope_spec_item_option (spec_item_id, cms_item_value_key, sort_order, value_code, label)
         VALUES ($1,'val-9-dup',2,'9','Duplicate')`,
        [itemId],
      ),
    ).rejects.toThrow();
  });

  it("enforces one answer per assessment item and the skipped/null answered/non-null value contract", async () => {
    await db.query(
      `INSERT INTO hope_assessment_answer (
         organization_id, provider_entity_id, location_id, hope_assessment_id, spec_version_id,
         spec_item_id, state, value, source, answered_at, answered_by_membership_id
       ) VALUES ($1, NULL, NULL, $2, $3, $4, 'answered', '"9"'::jsonb, 'user', now(), $5)`,
      [ORG, assessmentId, specVersionId, itemId, membershipId],
    );

    await expect(
      db.query(
        `INSERT INTO hope_assessment_answer (
           organization_id, hope_assessment_id, spec_version_id, spec_item_id, state, value, source
         ) VALUES ($1,$2,$3,$4,'answered','"1"'::jsonb,'user')`,
        [ORG, assessmentId, specVersionId, itemId],
      ),
    ).rejects.toThrow();

    await expect(
      db.query(
        `INSERT INTO hope_assessment_answer (
           organization_id, hope_assessment_id, spec_version_id, spec_item_id, state, value, source
         ) VALUES ($1,$2,$3,$4,'answered',NULL,'user')`,
        [ORG, assessmentId, specVersionId, otherItemId],
      ),
    ).rejects.toThrow();

    await expect(
      db.query(
        `INSERT INTO hope_assessment_answer (
           organization_id, hope_assessment_id, spec_version_id, spec_item_id, state, value, source
         ) VALUES ($1,$2,$3,$4,'skipped','"^"'::jsonb,'user')`,
        [ORG, assessmentId, specVersionId, otherItemId],
      ),
    ).rejects.toThrow();

    await db.query(
      `INSERT INTO hope_assessment_answer (
         organization_id, hope_assessment_id, spec_version_id, spec_item_id, state, value, source
       ) VALUES ($1,$2,$3,$4,'skipped',NULL,'user')`,
      [ORG, assessmentId, specVersionId, otherItemId],
    );
  });

  it("keeps hope_assessment_answer provider/location nullable and does not FK to the partitioned assessment parent", async () => {
    const nullable = await db.query<{
      provider_entity_id: string | null;
      location_id: string | null;
    }>(
      "SELECT provider_entity_id, location_id FROM hope_assessment_answer WHERE hope_assessment_id=$1 LIMIT 1",
      [assessmentId],
    );
    expect(nullable.rows[0]).toEqual({
      provider_entity_id: null,
      location_id: null,
    });

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text
       FROM pg_constraint
       WHERE conrelid = 'hope_assessment_answer'::regclass
         AND confrelid = 'hope_assessment'::regclass`,
    );
    expect(rows[0].count).toBe("0");
  });

  it("allows chartwarden_app to delete HOPE assessment answers", async () => {
    const { rows } = await db.query<{ allowed: boolean }>(
      `SELECT has_table_privilege(
      'chartwarden_app',
      'public.hope_assessment_answer',
      'DELETE'
    ) AS allowed`,
    );

    expect(rows[0]?.allowed).toBe(true);
  });
});
