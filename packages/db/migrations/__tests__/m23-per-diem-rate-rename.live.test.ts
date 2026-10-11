/**
 * M23 — migration 1069 (`hipps_calculation` -> `per_diem_rate_calculation`) — LIVE Postgres.
 *
 * Replays every migration up to 1068 (the legacy `hipps_*` shape), seeds a POPULATED tenant (a legacy segments
 * jsonb carrying `hippsCharPosition`, a `hipps_coding_correct` rule-config row and validation result), applies 1069
 * (twice: it must be idempotent) and proves, connected as the real NOBYPASSRLS `wardenx_app` role:
 *   - the old table / columns / indexes / policies / triggers / audit function are gone, the new ones exist;
 *   - the row survived and its stored values were migrated (jsonb key, rule keys);
 *   - RLS is still ENABLED + FORCEd and still isolates tenants on the renamed table;
 *   - the append-only trigger still rejects UPDATE and the audit trigger now writes the new resource kind;
 *   - the append-only / audit triggers are re-enabled after the data rewrite.
 *
 * Run only against a PRIVATE pgvector/pgvector:pg18 container (the suite DROPs roles + the public schema).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const RENAME_MIGRATION = "1069_m23_per_diem_rate_rename.sql";
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const M = "00000000-0000-0000-0000-000000000000";
const NEW_TABLE = "per_diem_rate_calculation";
const OLD_RULE_KEY = "hipps_coding_correct";
const NEW_RULE_KEY = "per_diem_class_coding_correct";

describe.skipIf(!DB_URL)("M23 migration 1069 — per-diem class rename — LIVE Postgres", () => {
  let db: Client;
  let claimA: string;
  let rowA: string;

  const sqlFiles = () =>
    readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

  async function applyFile(f: string) {
    await db.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  async function withOrg<T>(org: string, fn: () => Promise<T>): Promise<T> {
    await db.query("SET ROLE wardenx_app");
    await db.query("SELECT set_config('app.org_id', $1, false)", [org]);
    try {
      return await fn();
    } finally {
      await db.query("RESET ROLE");
    }
  }

  async function one(sql: string, params: unknown[]): Promise<string> {
    return (await db.query(sql, params)).rows[0].id as string;
  }

  /** Seed one org's legacy-shaped chain (pre-1069 names) as superuser. */
  async function seedLegacy(org: string, n: number) {
    await db.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,'O','O')",
      [org, `org-${n}`],
    );
    const pe = await one(
      `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1,$2,'PE',$3,'enc','0930') RETURNING id`,
      [org, `00000${n}`, `123456789${n}`],
    );
    await db.query("SELECT create_claim_partition($1)", [pe]);
    for (const fn of [
      "create_claim_state_history_partition",
      "create_validation_run_partition",
      "create_validation_result_partition",
    ]) {
      await db.query(`SELECT ${fn}($1)`, [org]);
    }
    const seq = await one(
      `INSERT INTO sequestration_policy (organization_id, provider_entity_id, percentage, effective_from, set_by_membership_id)
       VALUES ($1,$2,'2.0',CURRENT_DATE + interval '30 days',$3) RETURNING id`,
      [org, pe, M],
    );
    const claim = await one(
      `INSERT INTO claim (organization_id, provider_entity_id, patient_id, admission_id,
         election_period_id_from, election_period_id_to, patient_payer_id, tob, service_from, service_to,
         claim_control_number, mac_jurisdiction, sequestration_applied_pct, sequestration_policy_id,
         created_by_membership_id)
       VALUES ($1,$2,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),
         '813','2026-01-01','2026-01-31',$3,'palmetto_jm','2.0',$4,$5) RETURNING id`,
      [org, pe, `CCN${n}-260101-0001`, seq, M],
    );
    const row = await one(
      `INSERT INTO hipps_calculation (organization_id, claim_id, hipps_code, hipps_rate_cents,
         wage_index_ccn, wage_index_fiscal_year, wage_index_factor, segments)
       VALUES ($1,$2,'R1000',10000,$3,2026,'1.0',$4::jsonb) RETURNING id`,
      [
        org,
        claim,
        `00000${n}`,
        JSON.stringify([
          { levelOfCare: "RHC", ratePerDiemCents: 10000, hippsCharPosition: 1 },
          { levelOfCare: "GIP", ratePerDiemCents: 90000, hippsCharPosition: 2 },
        ]),
      ],
    );
    const run = await one(
      `INSERT INTO validation_run (organization_id, claim_id, trigger, outcome, run_input_hash,
         rules_executed, rules_passed, rules_failed, rules_warn, rules_info, completed_at, duration_ms)
       VALUES ($1,$2,'initial_assembly','all_pass','hash',1,1,0,0,0,now(),5) RETURNING id`,
      [org, claim],
    );
    await db.query(
      `INSERT INTO validation_result (organization_id, validation_run_id, rule_key, rule_version, severity, outcome, remediation)
       VALUES ($1,$2,$3,1,'error','fail','{"fixAction":"recompute_hipps"}'::jsonb),($1,$2,'rule.other',1,'error','pass','{}'::jsonb)`,
      [org, run, OLD_RULE_KEY],
    );
    await db.query(
      `INSERT INTO validation_rule_config (organization_id, rule_key, severity, set_by_membership_id)
       VALUES ($1,$2,'warn',$3)`,
      [org, OLD_RULE_KEY, M],
    );
    return { claim, row };
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL });
    await db.connect();
    await db.query("DROP SCHEMA IF EXISTS public CASCADE");
    await db.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await db.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN
           EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    for (const f of sqlFiles().filter((x) => x < RENAME_MIGRATION)) await applyFile(f);
    ({ claim: claimA, row: rowA } = await seedLegacy(ORG_A, 1));
    await seedLegacy(ORG_B, 2);
    await applyFile(RENAME_MIGRATION);
    await applyFile(RENAME_MIGRATION); // idempotent re-run is a no-op
    for (const f of sqlFiles().filter((x) => x > RENAME_MIGRATION)) await applyFile(f);
  }, 240_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  it("the old table, columns, indexes, constraints, policies, triggers and audit function are gone", async () => {
    const { rows } = await db.query<{ kind: string; name: string }>(`
      SELECT 'rel' AS kind, relname::text AS name FROM pg_class WHERE relname ILIKE '%hipps%'
      UNION ALL SELECT 'con', conname::text FROM pg_constraint WHERE conname ILIKE '%hipps%'
      UNION ALL SELECT 'pol', polname::text FROM pg_policy WHERE polname ILIKE '%hipps%'
      UNION ALL SELECT 'trg', tgname::text FROM pg_trigger WHERE NOT tgisinternal AND tgname ILIKE '%hipps%'
      UNION ALL SELECT 'fn', proname::text FROM pg_proc WHERE proname ILIKE '%hipps%'
      UNION ALL SELECT 'col', attname::text FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relnamespace = 'public'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped AND attname ILIKE '%hipps%'`);
    expect(rows).toEqual([]);
  });

  it("the renamed table carries the renamed columns, constraints, policies and triggers", async () => {
    const cols = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = $1",
      [NEW_TABLE],
    );
    const names = cols.rows.map((c) => c.column_name);
    expect(names).toContain("per_diem_class_code");
    expect(names).toContain("per_diem_rate_cents");
    const pols = await db.query<{ polname: string }>(
      "SELECT polname::text FROM pg_policy WHERE polrelid = $1::regclass ORDER BY 1",
      [NEW_TABLE],
    );
    expect(pols.rows.map((p) => p.polname)).toEqual([
      "per_diem_rate_calculation_destruction",
      "per_diem_rate_calculation_org",
    ]);
    const trgs = await db.query<{ tgname: string; tgenabled: string }>(
      "SELECT tgname::text, tgenabled::text FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal ORDER BY 1",
      [NEW_TABLE],
    );
    expect(trgs.rows).toEqual([
      { tgname: "trg_append_only_per_diem_rate_calculation", tgenabled: "O" },
      { tgname: "trg_audit_per_diem_rate_calculation", tgenabled: "O" },
    ]);
  });

  it("the old table name no longer resolves", async () => {
    const { rows } = await db.query("SELECT to_regclass('public.hipps_calculation') AS r");
    expect(rows[0].r).toBeNull();
  });

  it("RLS is still ENABLED and FORCEd on the renamed table", async () => {
    const { rows } = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass",
      [NEW_TABLE],
    );
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("the populated row survived with its stored values migrated (jsonb key + rule keys)", async () => {
    const { rows } = await db.query(
      `SELECT per_diem_class_code, per_diem_rate_cents::int AS cents, segments
         FROM ${NEW_TABLE} WHERE id = $1`,
      [rowA],
    );
    expect(rows[0].per_diem_class_code).toBe("R1000");
    expect(rows[0].cents).toBe(10000);
    expect(rows[0].segments).toEqual([
      { levelOfCare: "RHC", ratePerDiemCents: 10000, perDiemClassCharPosition: 1 },
      { levelOfCare: "GIP", ratePerDiemCents: 90000, perDiemClassCharPosition: 2 },
    ]);
    const results = await db.query<{ rule_key: string }>(
      "SELECT rule_key FROM validation_result WHERE organization_id = $1 ORDER BY rule_key",
      [ORG_A],
    );
    expect(results.rows.map((r) => r.rule_key)).toEqual([NEW_RULE_KEY, "rule.other"]);
    const fix = await db.query<{ remediation: { fixAction?: string } }>(
      "SELECT remediation FROM validation_result WHERE organization_id = $1 AND rule_key = $2",
      [ORG_A, NEW_RULE_KEY],
    );
    expect(fix.rows[0].remediation).toEqual({ fixAction: "recompute_per_diem_class" });
    const cfg = await db.query(
      "SELECT rule_key FROM validation_rule_config WHERE organization_id = $1",
      [ORG_A],
    );
    expect(cfg.rows.map((r) => r.rule_key)).toEqual([NEW_RULE_KEY]);
    const stale = await db.query(
      "SELECT 1 FROM validation_result WHERE rule_key = $1 UNION ALL SELECT 1 FROM validation_rule_config WHERE rule_key = $1",
      [OLD_RULE_KEY],
    );
    expect(stale.rowCount).toBe(0);
  });

  it("as wardenx_app: a tenant reads only its own row; the other tenant's row is invisible", async () => {
    const own = await withOrg(ORG_A, () => db.query(`SELECT id FROM ${NEW_TABLE}`));
    expect(own.rows.map((r) => r.id)).toEqual([rowA]);
    const other = await withOrg(ORG_B, () =>
      db.query(`SELECT id FROM ${NEW_TABLE} WHERE id = $1`, [rowA]),
    );
    expect(other.rowCount).toBe(0);
  });

  it("as wardenx_app: WITH CHECK refuses a foreign organization_id; UPDATE is rejected (append-only)", async () => {
    await expect(
      withOrg(ORG_B, () =>
        db.query(
          `INSERT INTO ${NEW_TABLE} (organization_id, claim_id, per_diem_class_code, per_diem_rate_cents,
             wage_index_ccn, wage_index_fiscal_year, wage_index_factor, segments)
           VALUES ($1,$2,'R1000',1,'000001',2026,'1.0','[]'::jsonb)`,
          [ORG_A, claimA],
        ),
      ),
    ).rejects.toThrow();
    await expect(
      withOrg(ORG_A, () =>
        db.query(`UPDATE ${NEW_TABLE} SET per_diem_rate_cents = 1 WHERE id = $1`, [rowA]),
      ),
    ).rejects.toThrow();
  });

  it("the audit trigger writes the NEW resource kind on insert", async () => {
    const org = "33333333-3333-3333-3333-333333333333";
    const { claim, row } = await seedLegacyRenamed(org, 3);
    const { rows } = await db.query<{ event_type: string; resource_kind: string }>(
      "SELECT event_type, resource_kind FROM audit_event WHERE resource_id = $1",
      [row],
    );
    expect(claim).toBeTruthy();
    expect(rows).toEqual([
      { event_type: "per_diem_rate_calculation.insert", resource_kind: NEW_TABLE },
    ]);
  });

  /** Post-migration seed of a minimal claim + calculation row (new names). */
  async function seedLegacyRenamed(org: string, n: number) {
    await db.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,'O','O')",
      [org, `org-${n}`],
    );
    const pe = await one(
      `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1,$2,'PE',$3,'enc','0930') RETURNING id`,
      [org, `00000${n}`, `123456789${n}`],
    );
    await db.query("SELECT create_claim_partition($1)", [pe]);
    const seq = await one(
      `INSERT INTO sequestration_policy (organization_id, provider_entity_id, percentage, effective_from, set_by_membership_id)
       VALUES ($1,$2,'2.0',CURRENT_DATE + interval '30 days',$3) RETURNING id`,
      [org, pe, M],
    );
    const claim = await one(
      `INSERT INTO claim (organization_id, provider_entity_id, patient_id, admission_id,
         election_period_id_from, election_period_id_to, patient_payer_id, tob, service_from, service_to,
         claim_control_number, mac_jurisdiction, sequestration_applied_pct, sequestration_policy_id,
         created_by_membership_id)
       VALUES ($1,$2,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),
         '813','2026-01-01','2026-01-31',$3,'palmetto_jm','2.0',$4,$5) RETURNING id`,
      [org, pe, `CCN${n}-260101-0001`, seq, M],
    );
    const row = await one(
      `INSERT INTO ${NEW_TABLE} (organization_id, claim_id, per_diem_class_code, per_diem_rate_cents,
         wage_index_ccn, wage_index_fiscal_year, wage_index_factor, segments)
       VALUES ($1,$2,'R1000',10000,$3,2026,'1.0','[]'::jsonb) RETURNING id`,
      [org, claim, `00000${n}`],
    );
    return { claim, row };
  }
});
