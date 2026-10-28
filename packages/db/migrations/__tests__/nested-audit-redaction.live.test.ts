/**
 * WX-PR-016 — nested-JSONB-path audit redaction, proved against a real Postgres trigger.
 *
 * `check-audit-denylist-sync.ts` statically verifies that a table's `audit_phi_write_<table>()`
 * migration trigger TEXT contains the extract -> audit_scrub -> jsonb_set-back pattern for every
 * nested-path denylist entry. This test proves the RUNTIME behavior that pattern produces: writing a
 * row with sensitive nested-JSONB fields populated, then reading the resulting `audit_event` row back
 * and asserting the denylisted nested keys are `"<changed>"` while sibling, non-denylisted keys in the
 * SAME jsonb column survive untouched — the "selective redaction," not "blanket-wipe the whole column"
 * distinction that makes this mechanism worth having at all.
 *
 * Two representative tables (of the 6 that declare nested-path entries) exercise the two shapes the
 * denylist uses: `data->>infusionDilution` (a `->>` scalar-text path, M13 administration_record) and
 * `state_snapshot->goals` (a `->` object/array path, M15 discipline_care_plan_version). Both migration
 * triggers use the identical mechanism, so these two cases stand in for all 6 — the static gate covers
 * the rest on every CI run.
 *
 * CHARTWARDEN_TEST_DATABASE_URL=postgres://... bunx vitest run \
 *   packages/db/migrations/__tests__/nested-audit-redaction.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropLiveRoles } from "./_live-roles";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ORG = "11111111-1111-1111-1111-111111111111";
const PROVIDER_ENTITY = "22222222-2222-2222-2222-222222222222";
const LOCATION = "33333333-3333-3333-3333-333333333333";

describe.skipIf(!DB_URL)("Nested-path audit redaction — LIVE Postgres (WX-PR-016)", () => {
  let admin: Client;

  async function resetSchema(): Promise<void> {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    await dropLiveRoles(admin);
  }

  async function applyMigrations(): Promise<void> {
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')",
      [ORG],
    );
    await admin.query(
      `INSERT INTO provider_entity
         (id, organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1,$2,'123456','Provider A','1234567890','cipher:x','06-30')`,
      [PROVIDER_ENTITY, ORG],
    );
    await admin.query(
      `INSERT INTO location
         (id, provider_entity_id, name, address_line1, city, state, postal_code, timezone)
       VALUES ($1,$2,'Main','1 Main St','Portland','OR','97201','America/Los_Angeles')`,
      [LOCATION, PROVIDER_ENTITY],
    );
    await admin.query("SET session_replication_role = origin");
  }, 120_000);

  afterAll(async () => {
    await admin?.end();
  });

  it("M13.administration_record: redacts data->>infusionDilution but preserves a sibling data key", async () => {
    const patientId = "44444444-4444-4444-4444-444444444444";
    const admissionId = "55555555-5555-5555-5555-555555555555";
    const medicationOrderId = "66666666-6666-6666-6666-666666666666";
    const recordId = "77777777-7777-7777-7777-777777777777";
    await admin.query(
      `INSERT INTO administration_record
         (id, organization_id, patient_id, admission_id, medication_order_id, provider_entity_id,
          location_id, mode, status, data, drug_name_snapshot, route_snapshot, administered_at,
          actor_kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'single_dose','committed',$8,'Morphine','IV',now(),'clinician')`,
      [
        recordId,
        ORG,
        patientId,
        admissionId,
        medicationOrderId,
        PROVIDER_ENTITY,
        LOCATION,
        JSON.stringify({ infusionDilution: "50mg/50mL D5W", nonSensitiveField: "keep-me-visible" }),
      ],
    );
    const { rows } = await admin.query(
      `SELECT after FROM audit_event WHERE resource_id = $1 AND event_type = 'administration_record.insert' ORDER BY created_at DESC LIMIT 1`,
      [recordId],
    );
    expect(rows).toHaveLength(1);
    const data = rows[0].after.data;
    expect(data.infusionDilution).toBe("<changed>");
    expect(data.nonSensitiveField).toBe("keep-me-visible");
  });

  it("M15.discipline_care_plan_version: redacts state_snapshot->goals but preserves state_snapshot->status", async () => {
    const planId = "88888888-8888-8888-8888-888888888888";
    const patientId = "99999999-9999-9999-9999-999999999999";
    const admissionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const versionId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    await admin.query(
      `INSERT INTO discipline_care_plan
         (id, organization_id, patient_id, admission_id, provider_entity_id, location_id, kind, status)
       VALUES ($1,$2,$3,$4,$5,$6,'aide_poc','active')`,
      [planId, ORG, patientId, admissionId, PROVIDER_ENTITY, LOCATION],
    );
    await admin.query(
      `INSERT INTO discipline_care_plan_version
         (id, organization_id, provider_entity_id, location_id, plan_id, sequence, status, kind,
          state_snapshot)
       VALUES ($1,$2,$3,$4,$5,1,'draft','initial',$6)`,
      [
        versionId,
        ORG,
        PROVIDER_ENTITY,
        LOCATION,
        planId,
        JSON.stringify({
          goals: [{ text: "Patient-specific goal narrative" }],
          status: "keep-me-visible",
        }),
      ],
    );
    const { rows } = await admin.query(
      `SELECT after FROM audit_event WHERE resource_id = $1 AND event_type = 'discipline_care_plan_version.insert' ORDER BY created_at DESC LIMIT 1`,
      [versionId],
    );
    expect(rows).toHaveLength(1);
    const snapshot = rows[0].after.state_snapshot;
    expect(snapshot.goals).toBe("<changed>");
    expect(snapshot.status).toBe("keep-me-visible");
  });
});
