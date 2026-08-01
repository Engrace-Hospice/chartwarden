/**
 * M24 Billing — Medicaid — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / §8.1 / ADR-0010).
 *
 * The pure unit suites (apps/backend/.../24-billing-medicaid, packages/medicaid-adapters) exercise the domain
 * but never touch a database, so they cannot catch a wrong RLS predicate, a missing WITH CHECK, or a base-table
 * grant that leaks across tenants. This test applies the actual migrations to a real Postgres and exercises the
 * policies as the unprivileged `wardenx_app` role (no BYPASSRLS), proving cross-tenant denial for real on ALL
 * 14 org-scoped M24 tables under the canonical `organization_id = current_setting('app.org_id')` ONE-SHAPE
 * policy (ADR-0010 D3 — no second PERMISSIVE provider_entity policy; PE narrowing is the M3 ABAC at the
 * handler) — including the six LIST-partitioned tables (the parent policy propagates to every partition incl.
 * DEFAULT, PG11+).
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `WARDENX_TEST_DATABASE_URL=postgres://… bun run test:rls:live` (SUPERUSER to a THROWAWAY db;
 *     for a local PG without pgvector, set WARDENX_TEST_NO_PGVECTOR=1).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

type SeedIds = {
  pe: string;
  claim: string;
  claimLine: string;
  lineEncounter: string;
  stateHistory: string;
  submission: string;
  acknowledgment: string;
  validationRun: string;
  validationResult: string;
  validationOverride: string;
  ruleConfig: string;
  eligibility: string;
  rbArrangement: string;
  rbDay: string;
  credential: string;
};

const COVERED: { table: string; key: keyof SeedIds; idCol?: string }[] = [
  { table: "medicaid_claim", key: "claim" },
  { table: "medicaid_claim_line", key: "claimLine" },
  { table: "medicaid_claim_line_encounter", key: "lineEncounter", idCol: "medicaid_claim_line_id" },
  { table: "medicaid_claim_state_history", key: "stateHistory" },
  { table: "medicaid_submission", key: "submission" },
  { table: "medicaid_acknowledgment", key: "acknowledgment" },
  { table: "medicaid_validation_run", key: "validationRun" },
  { table: "medicaid_validation_result", key: "validationResult" },
  { table: "medicaid_validation_override", key: "validationOverride" },
  { table: "medicaid_validation_rule_config", key: "ruleConfig" },
  { table: "medicaid_eligibility_check", key: "eligibility" },
  { table: "rb_arrangement", key: "rbArrangement" },
  { table: "rb_day", key: "rbDay" },
  { table: "state_medicaid_trading_partner_credential", key: "credential" },
];

describe.skipIf(!DB_URL)("M24 Billing — Medicaid — RLS cross-tenant denial — LIVE Postgres (§3.5)", () => {
  let db: Client;
  let a: SeedIds;

  async function withOrg<T>(org: string, fn: () => Promise<T>): Promise<T> {
    await db.query("SET ROLE wardenx_app");
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
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      }
      await db.query(sql);
    }
  }

  /** Seed one full M24 chain for `org` as superuser (RLS + grants bypassed). `n` distinguishes the rows. */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const st = "OR";
    const from = "2026-01-01";
    const to = "2026-01-31";
    const patient = "44444444-4444-4444-4444-444444444444";
    const m = "00000000-0000-0000-0000-000000000000"; // membership sentinel
    const pe = (
      await db.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'00000${n}','PE','123456789${n}','enc','0930') RETURNING id`,
        [org],
      )
    ).rows[0].id as string;
    const claim = (
      await db.query(
        `INSERT INTO medicaid_claim (organization_id, provider_entity_id, patient_id, patient_payer_id, admission_id,
           service_state, kind, tob, service_from, service_to, state_plan_code_id, state_plan_code_snapshot,
           medicaid_claim_control_number, created_by_membership_id, updated_by_membership_id)
         VALUES ($1,$2,$3,gen_random_uuid(),gen_random_uuid(),$4,'hospice_only','0813',$5,$6,gen_random_uuid(),
           'OHP', $7, $8, $8) RETURNING id`,
        [org, pe, patient, st, from, to, `000000-OR-260101-0000${n}-00`, m],
      )
    ).rows[0].id as string;
    const claimLine = (
      await db.query(
        `INSERT INTO medicaid_claim_line (organization_id, provider_entity_id, medicaid_claim_id, line_number,
           service_date, revenue_code, q_code, level_of_care, loc_period_id, units, rate_at_assembly_cents,
           state_rate_schedule_id_snapshot, charges_cents)
         VALUES ($1,$2,$3,1,$4,'0651','Q5001','RHC',gen_random_uuid(),1,10000,gen_random_uuid(),10000) RETURNING id`,
        [org, pe, claim, from],
      )
    ).rows[0].id as string;
    const lineEncounter = (
      await db.query(
        `INSERT INTO medicaid_claim_line_encounter (medicaid_claim_line_id, encounter_id, organization_id)
         VALUES ($1,gen_random_uuid(),$2) RETURNING medicaid_claim_line_id AS id`,
        [claimLine, org],
      )
    ).rows[0].id as string;
    const stateHistory = (
      await db.query(
        `INSERT INTO medicaid_claim_state_history (organization_id, medicaid_claim_id, to_state, trigger_source)
         VALUES ($1,$2,'DRAFT','user') RETURNING id`,
        [org, claim],
      )
    ).rows[0].id as string;
    const submission = (
      await db.query(
        `INSERT INTO medicaid_submission (organization_id, medicaid_claim_id, provider_entity_id, service_state,
           channel, medicaid_claim_control_number, adapter_vendor, adapter_version)
         VALUES ($1,$2,$3,$4,'direct_mmis',$5,'deferred','0') RETURNING id`,
        [org, claim, pe, st, `000000-OR-260101-0000${n}-00`],
      )
    ).rows[0].id as string;
    const acknowledgment = (
      await db.query(
        `INSERT INTO medicaid_acknowledgment (organization_id, medicaid_claim_id, medicaid_submission_id, kind, outcome)
         VALUES ($1,$2,$3,'sync_277ca','accepted') RETURNING id`,
        [org, claim, submission],
      )
    ).rows[0].id as string;
    const validationRun = (
      await db.query(
        `INSERT INTO medicaid_validation_run (organization_id, medicaid_claim_id, rule_registry_version, triggered_by,
           claim_state_at_trigger, idempotency_key)
         VALUES ($1,$2,'1','manual','DRAFT',$3) RETURNING id`,
        [org, claim, `idem-${n}`],
      )
    ).rows[0].id as string;
    const validationResult = (
      await db.query(
        `INSERT INTO medicaid_validation_result (organization_id, medicaid_validation_run_id, rule_key, rule_version, outcome)
         VALUES ($1,$2,'medicaid.eligibility.active',1,'pass') RETURNING id`,
        [org, validationRun],
      )
    ).rows[0].id as string;
    const validationOverride = (
      await db.query(
        `INSERT INTO medicaid_validation_override (organization_id, medicaid_validation_result_id, medicaid_claim_id,
           rule_key, override_role_applied, reason, step_up_auth_token_at, actor_membership_id)
         VALUES ($1,$2,$3,'medicaid.eligibility.active','billing_manager',
           'a deliberate override reason that exceeds forty chars', now(), gen_random_uuid()) RETURNING id`,
        [org, validationResult, claim],
      )
    ).rows[0].id as string;
    const ruleConfig = (
      await db.query(
        `INSERT INTO medicaid_validation_rule_config (organization_id, rule_key, regulatory_required_snapshot, updated_by_membership_id)
         VALUES ($1,$2,false,$3) RETURNING id`,
        [org, `custom.rule.${n}`, m],
      )
    ).rows[0].id as string;
    const eligibility = (
      await db.query(
        `INSERT INTO medicaid_eligibility_check (organization_id, patient_id, patient_payer_id, service_state,
           as_of_service_date, outcome, stale_at)
         VALUES ($1,$2,gen_random_uuid(),$3,$4,'active', now() + interval '30 days') RETURNING id`,
        [org, patient, st, from],
      )
    ).rows[0].id as string;
    const rbArrangement = (
      await db.query(
        `INSERT INTO rb_arrangement (organization_id, patient_id, provider_entity_id, nf_facility_mdm_id,
           nf_facility_name_snapshot, effective_from, nf_per_diem_routine_cents, nf_per_diem_resp_cents,
           nf_per_diem_gip_cents, pass_through_pct, retention_pct, created_by_membership_id, updated_by_membership_id)
         VALUES ($1,$2,$3,gen_random_uuid(),'NF',$4,20000,25000,80000,95,5,$5,$5) RETURNING id`,
        [org, patient, pe, from, m],
      )
    ).rows[0].id as string;
    const rbDay = (
      await db.query(
        `INSERT INTO rb_day (organization_id, provider_entity_id, patient_id, rb_arrangement_id, service_date,
           loc_of_day, loc_period_id_snapshot, per_diem_cents_snapshot)
         VALUES ($1,$2,$3,$4,$5,'NF_RB',gen_random_uuid(),20000) RETURNING id`,
        [org, pe, patient, rbArrangement, from],
      )
    ).rows[0].id as string;
    const credential = (
      await db.query(
        `INSERT INTO state_medicaid_trading_partner_credential (organization_id, provider_entity_id, service_state,
           channel, trading_partner_id, active_from, created_by_membership_id, updated_by_membership_id)
         VALUES ($1,$2,$3,'direct_mmis','TP1',$4,$5,$5) RETURNING id`,
        [org, pe, st, from, m],
      )
    ).rows[0].id as string;
    return {
      pe,
      claim,
      claimLine,
      lineEncounter,
      stateHistory,
      submission,
      acknowledgment,
      validationRun,
      validationResult,
      validationOverride,
      ruleConfig,
      eligibility,
      rbArrangement,
      rbDay,
      credential,
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
    a = await seedOrg(ORG_A, 1);
    await seedOrg(ORG_B, 2);
  }, 120_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  // GUARD FOR EVERY CASE BELOW. RLS is not enforced for a role holding BYPASSRLS, so if the runtime
  // role ever gains it, every isolation assertion in this file passes VACUOUSLY and CI stays green.
  // scripts/db/migrate.ts grants exactly that behind WARDENX_DEV_BYPASSRLS=1, so this is reachable,
  // not theoretical. Six of fifteen suites asserted this and NONE of the four suites CI runs did.
  it("wardenx_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
    const { rows } = await db.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'wardenx_app'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rolbypassrls).toBe(false);
  });
  
  it("every M24 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
    const rls = readFileSync(join(MIGRATIONS_DIR, "0096_billing_medicaid_m24_rls.sql"), "utf8");
    const policyBlocks = rls.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? [];
    expect(policyBlocks.length).toBe(14);
    for (const block of policyBlocks) {
      const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((mm) => mm[1]);
      expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
      expect(block).not.toMatch(/pg_has_role/i);
      expect(block).not.toMatch(/IS NULL/i);
    }
  });

  it.each(COVERED)("$table: org A sees its row, org B cannot (cross-tenant denial)", async ({ table, key, idCol }) => {
    const id = a[key];
    const col = idCol ?? "id";
    const seenByA = await withOrg(ORG_A, () => db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${col}=$1`, [id]));
    expect(seenByA.rows[0].n).toBe(1); // isolation is not "deny everything"
    const seenByB = await withOrg(ORG_B, () => db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${col}=$1`, [id]));
    expect(seenByB.rows[0].n).toBe(0); // org B cannot read org A's row
  });

  it("a WITH CHECK refuses an INSERT into another tenant's scope", async () => {
    await expect(
      withOrg(ORG_B, () =>
        db.query(
          `INSERT INTO medicaid_validation_rule_config (organization_id, rule_key, regulatory_required_snapshot, updated_by_membership_id)
           VALUES ($1,'cross.tenant.rule',false,'00000000-0000-0000-0000-000000000000')`,
          [ORG_A], // B tries to write a row scoped to A
        ),
      ),
    ).rejects.toThrow();
  });
});
