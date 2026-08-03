/**
 * M37-T02 — the IPU schema's RLS isolation + §3.6 audit-scrub, proven against real Postgres.
 *
 * M37 has no route service yet (T03+ build the domain cores), so this suite exercises the migrations
 * directly as the NOBYPASSRLS `wardenx_app` role: the canonical app.org_id policy on all 26 owned tables
 * isolates tenants, the WITH CHECK clause rejects a cross-tenant write, the partitioned tables inherit the
 * parent policy, and the GENERATED write-audit triggers scrub §3.6-denylisted free-text PHI (the restraint
 * justification) out of audit_event before/after.
 *
 * Gated on a live DB: WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m37:rls:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const UNIT_A = "aaaaaaaa-0000-4000-8000-000000000001";

describe.skipIf(!DB_URL)("M37 IPU — RLS isolation + audit scrub — LIVE Postgres (M37-T02)", () => {
  let admin: Client;
  let app: Client;

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
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql")).sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
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
    // A unit for org A (seeded as admin so RLS reads below start from a known row).
    await admin.query(
      "INSERT INTO inpatient_unit (id,organization_id,facility_id,display_name,bed_count) VALUES ($1,$2,gen_random_uuid(),'Unit 1',8)",
      [UNIT_A, ORG_A],
    );
    await admin.query("ALTER ROLE wardenx_app LOGIN");
    app = new Client({ connectionString: (DB_URL as string).replace("://postgres@", "://wardenx_app@") });
    await app.connect();
  }, 120_000);

  afterAll(async () => {
    await app?.end();
    if (admin) await admin.end();
  });

  async function asOrg(org: string) {
    await app.query("SELECT set_config('app.org_id',$1,false)", [org]);
    await app.query("SELECT set_config('app.user_id','',false)");
  }

  it("org A sees its own unit; org B sees none of it (canonical app.org_id RLS)", async () => {
    await asOrg(ORG_A);
    expect((await app.query("SELECT count(*)::int n FROM inpatient_unit")).rows[0].n).toBe(1);
    await asOrg(ORG_B);
    expect((await app.query("SELECT count(*)::int n FROM inpatient_unit")).rows[0].n).toBe(0);
  });

  it("a cross-tenant write is rejected by the WITH CHECK clause", async () => {
    await asOrg(ORG_B);
    // org B context inserting a row stamped with org A's id must fail the policy WITH CHECK.
    await expect(
      app.query(
        "INSERT INTO ipu_room (organization_id,unit_id,room_number,kind,bed_count) VALUES ($1,$2,'101','private',1)",
        [ORG_A, UNIT_A],
      ),
    ).rejects.toMatchObject({ code: "42501" }); // insufficient_privilege / RLS violation
  });

  it("partitioned ipu_visitor inherits the parent RLS policy across tenants", async () => {
    await asOrg(ORG_A);
    const adm = (
      await app.query(
        "INSERT INTO ipu_admission (organization_id,provider_entity_id,patient_id,admission_id,level_of_care_period_id,unit_id,kind,created_by) " +
          "VALUES ($1,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),$2,'gip',gen_random_uuid()) RETURNING id",
        [ORG_A, UNIT_A],
      )
    ).rows[0].id;
    await app.query(
      "INSERT INTO ipu_visitor (organization_id,ipu_admission_id,visitor_name,relationship,screening_outcome,consent_evaluator_result,checked_in_by) " +
        "VALUES ($1,$2,'Visitor One','friend','{}'::jsonb,'{}'::jsonb,gen_random_uuid())",
      [ORG_A, adm],
    );
    expect((await app.query("SELECT count(*)::int n FROM ipu_visitor")).rows[0].n).toBe(1);
    await asOrg(ORG_B);
    expect((await app.query("SELECT count(*)::int n FROM ipu_visitor")).rows[0].n).toBe(0);
  });

  it("the restraint justification is scrubbed out of the audit log (§3.6 D11 denylist)", async () => {
    await asOrg(ORG_A);
    const adm = (
      await app.query(
        "INSERT INTO ipu_admission (organization_id,provider_entity_id,patient_id,admission_id,level_of_care_period_id,unit_id,kind,created_by) " +
          "VALUES ($1,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),$2,'gip',gen_random_uuid()) RETURNING id",
        [ORG_A, UNIT_A],
      )
    ).rows[0].id;
    const secret = `SECRET-PHI-${"x".repeat(110)}`;
    await app.query(
      "INSERT INTO ipu_restraint_event (organization_id,ipu_admission_id,restraint_kind,restraint_justification_text,ordering_physician_id,ordering_order_id,applied_by_membership_id,applied_step_up_assertion_id,reassessment_interval_minutes) " +
        "VALUES ($1,$2,'soft_limb',$3,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),60)",
      [ORG_A, adm, secret],
    );
    const after = (
      await admin.query(
        "SELECT after FROM audit_event WHERE resource_kind='ipu_restraint_event' ORDER BY created_at DESC LIMIT 1",
      )
    ).rows[0]?.after;
    expect(after).toBeTruthy();
    // The column is present in the snapshot but its PHI value is replaced by the scrub sentinel.
    expect(after.restraint_justification_text).toBeDefined();
    expect(String(after.restraint_justification_text)).not.toContain("SECRET-PHI");
  });
});
