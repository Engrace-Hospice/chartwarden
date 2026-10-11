/**
 * M23 — migration 1069 (`hipps_calculation` -> `per_diem_rate_calculation`) — LIVE Postgres.
 *
 * Replays every migration up to 1068 (the legacy `hipps_*` shape), seeds a POPULATED tenant (a legacy segments
 * jsonb carrying `hippsCharPosition`, a `hipps_coding_correct` rule-config row and validation result), applies 1069
 * (twice: it must be idempotent) and proves, connected as the real NOBYPASSRLS `wardenx_app` role:
 *   - the old table / columns / indexes / policies / triggers / audit function are gone, the new ones exist;
 *   - append-only HISTORY IS NOT REWRITTEN: validation_result rows and the segments jsonb are byte-identical, the
 *     append-only triggers were never disabled (all `tgenabled = 'O'`) and still reject UPDATE, audit_event rows already
 *     written keep the old resource kind; the migration file contains no DISABLE / ENABLE TRIGGER at all;
 *   - the mutable tenant overlay `validation_rule_config.rule_key` IS renamed in place, with its audit trigger enabled,
 *     so the rename is on the audit trail;
 *   - the re-created audit function is the hardened 1062 form (SECURITY DEFINER, pg_temp pinned, owned by
 *     wardenx_audit_writer) and writes the new resource kind for an INSERT made as wardenx_app and a DELETE made as
 *     a wardenx_destruction member;
 *   - RLS is still ENABLED + FORCEd and still isolates tenants on the renamed table;
 *   - re-applying 1069 from a PARTIALLY migrated state (table renamed, the rest not) converges.
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
const DESTROYER = "m23_rename_destroyer";

describe.skipIf(!DB_URL)("M23 migration 1069 — per-diem class rename — LIVE Postgres", () => {
  let db: Client;
  let claimA: string;
  let rowA: string;
  let rowB: string;
  /** Pre-migration snapshots of the append-only history the migration must leave untouched. */
  let resultsBefore: unknown[];
  let segmentsBefore: string;
  let legacyAuditBefore: { id: string; event_type: string; resource_kind: string }[];

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
    ({ row: rowB } = await seedLegacy(ORG_B, 2));
    resultsBefore = (
      await db.query("SELECT to_jsonb(v) AS j FROM validation_result v ORDER BY v.id")
    ).rows.map((r) => r.j);
    segmentsBefore = (
      await db.query("SELECT segments::text AS t FROM hipps_calculation WHERE id = $1", [rowA])
    ).rows[0].t;
    legacyAuditBefore = (
      await db.query(
        "SELECT id::text, event_type, resource_kind FROM audit_event WHERE resource_kind = 'hipps_calculation' ORDER BY id",
      )
    ).rows;
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

  it("the migration file never disables a trigger", () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, RENAME_MIGRATION), "utf8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(/DISABLE\s+TRIGGER|ENABLE\s+TRIGGER|session_replication_role/i);
  });

  it("the populated calculation row survived; its append-only segments history is byte-identical (legacy key kept)", async () => {
    const { rows } = await db.query(
      `SELECT per_diem_class_code, per_diem_rate_cents::int AS cents, segments::text AS segments_text, segments
         FROM ${NEW_TABLE} WHERE id = $1`,
      [rowA],
    );
    expect(rows[0].per_diem_class_code).toBe("R1000");
    expect(rows[0].cents).toBe(10000);
    expect(rows[0].segments_text).toBe(segmentsBefore);
    expect(rows[0].segments).toEqual([
      { levelOfCare: "RHC", ratePerDiemCents: 10000, hippsCharPosition: 1 },
      { levelOfCare: "GIP", ratePerDiemCents: 90000, hippsCharPosition: 2 },
    ]);
  });

  it("validation_result history is unchanged (legacy rule key and fixAction kept)", async () => {
    const after = (
      await db.query("SELECT to_jsonb(v) AS j FROM validation_result v ORDER BY v.id")
    ).rows.map((r) => r.j);
    expect(after).toEqual(resultsBefore);
    const legacy = await db.query<{ rule_key: string; remediation: { fixAction?: string } }>(
      "SELECT rule_key, remediation FROM validation_result WHERE organization_id = $1 ORDER BY rule_key",
      [ORG_A],
    );
    expect(legacy.rows.map((r) => r.rule_key)).toEqual([OLD_RULE_KEY, "rule.other"]);
    expect(legacy.rows[0].remediation).toEqual({ fixAction: "recompute_hipps" });
  });

  it("an UPDATE on validation_result is still rejected after the migration", async () => {
    await expect(
      db.query("UPDATE validation_result SET rule_key = $1 WHERE organization_id = $2", [
        NEW_RULE_KEY,
        ORG_A,
      ]),
    ).rejects.toThrow(/M23_TABLE_APPEND_ONLY/);
    await expect(
      withOrg(ORG_A, () =>
        db.query("UPDATE validation_result SET rule_key = $1 WHERE organization_id = $2", [
          NEW_RULE_KEY,
          ORG_A,
        ]),
      ),
    ).rejects.toThrow();
  });

  it("every trigger on the renamed table, validation_rule_config and validation_result (and its partitions) is ENABLED", async () => {
    const { rows } = await db.query<{ rel: string; tgname: string; tgenabled: string }>(`
      SELECT c.relname::text AS rel, t.tgname::text, t.tgenabled::text
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal
         AND (c.relname IN ('${NEW_TABLE}', 'validation_rule_config', 'validation_result')
              OR c.oid IN (SELECT inhrelid FROM pg_inherits WHERE inhparent = 'validation_result'::regclass))`);
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows.filter((r) => r.tgenabled !== "O")).toEqual([]);
    expect(rows.some((r) => r.rel === "validation_rule_config")).toBe(true);
    expect(rows.some((r) => r.rel.startsWith("validation_result"))).toBe(true);
  });

  it("validation_rule_config.rule_key is renamed in place, and the rename is on the audit trail", async () => {
    const cfg = await db.query(
      "SELECT rule_key FROM validation_rule_config WHERE organization_id = $1",
      [ORG_A],
    );
    expect(cfg.rows.map((r) => r.rule_key)).toEqual([NEW_RULE_KEY]);
    const stale = await db.query("SELECT 1 FROM validation_rule_config WHERE rule_key = $1", [
      OLD_RULE_KEY,
    ]);
    expect(stale.rowCount).toBe(0);
    const audit = await db.query<{ before: { rule_key?: string }; after: { rule_key?: string } }>(
      `SELECT before, after FROM audit_event
        WHERE resource_kind = 'validation_rule_config' AND event_type = 'validation_rule_config.update'
          AND organization_id = $1`,
      [ORG_A],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].before.rule_key).toBe(OLD_RULE_KEY);
    expect(audit.rows[0].after.rule_key).toBe(NEW_RULE_KEY);
  });

  it("audit_event rows written before the migration keep the old resource kind text", async () => {
    expect(legacyAuditBefore.length).toBeGreaterThan(0);
    const now = await db.query<{ id: string; event_type: string; resource_kind: string }>(
      "SELECT id::text, event_type, resource_kind FROM audit_event WHERE id = ANY($1::uuid[]) ORDER BY id",
      [legacyAuditBefore.map((r) => r.id)],
    );
    expect(now.rows).toEqual(legacyAuditBefore);
    expect(now.rows.every((r) => r.resource_kind === "hipps_calculation")).toBe(true);
  });

  it("the re-created audit function is the hardened 1062 form", async () => {
    const { rows } = await db.query<{
      proconfig: string[] | null;
      prosecdef: boolean;
      owner: string;
      src: string;
    }>(
      `SELECT p.proconfig, p.prosecdef, pg_get_userbyid(p.proowner)::text AS owner, p.prosrc AS src
         FROM pg_proc p WHERE p.proname = 'audit_phi_write_per_diem_rate_calculation'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].prosecdef).toBe(true);
    expect(rows[0].owner).toBe("wardenx_audit_writer");
    const searchPath = (rows[0].proconfig ?? []).find((c) => c.startsWith("search_path="));
    expect(searchPath).toMatch(/pg_temp/);
    expect(rows[0].src).toContain("public.audit_scrub");
    expect(rows[0].src).toContain("INSERT INTO public.audit_event");
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

  it("as wardenx_app: INSERT works on the renamed table and the SECURITY DEFINER trigger writes the NEW resource kind", async () => {
    const org = "33333333-3333-3333-3333-333333333333";
    const { claim } = await seedClaimOnly(org, 3);
    const row = await withOrg(org, async () =>
      one(
        `INSERT INTO ${NEW_TABLE} (organization_id, claim_id, per_diem_class_code, per_diem_rate_cents,
           wage_index_ccn, wage_index_fiscal_year, wage_index_factor, segments)
         VALUES ($1,$2,'R1000',10000,'000003',2026,'1.0','[]'::jsonb) RETURNING id`,
        [org, claim],
      ),
    );
    const { rows } = await db.query<{ event_type: string; resource_kind: string }>(
      "SELECT event_type, resource_kind FROM audit_event WHERE resource_id = $1",
      [row],
    );
    expect(rows).toEqual([
      { event_type: "per_diem_rate_calculation.insert", resource_kind: NEW_TABLE },
    ]);
  });

  it("as a wardenx_destruction member: DELETE on the renamed table works (erase cascade) and audits the new kind", async () => {
    await db.query(`DROP ROLE IF EXISTS ${DESTROYER}`);
    await db.query(`CREATE ROLE ${DESTROYER} LOGIN PASSWORD 'x' IN ROLE wardenx_destruction`);
    try {
      await db.query(`SET ROLE ${DESTROYER}`);
      await db.query("SELECT set_config('app.org_id', $1, false)", [ORG_B]);
      let deleted: number | null;
      try {
        deleted = (await db.query(`DELETE FROM ${NEW_TABLE} WHERE id = $1`, [rowB])).rowCount;
      } finally {
        await db.query("RESET ROLE");
      }
      expect(deleted).toBe(1);
    } finally {
      await db.query(`DROP OWNED BY ${DESTROYER}`);
      await db.query(`DROP ROLE IF EXISTS ${DESTROYER}`);
    }
    const { rows } = await db.query<{ event_type: string; resource_kind: string }>(
      "SELECT event_type, resource_kind FROM audit_event WHERE resource_id = $1 AND event_type LIKE '%.delete'",
      [rowB],
    );
    expect(rows).toEqual([
      { event_type: "per_diem_rate_calculation.delete", resource_kind: NEW_TABLE },
    ]);
  });

  it("converges when re-applied from a partially migrated state (table renamed, columns / policy / trigger / function not)", async () => {
    // Put the database into the half-way state a crashed deploy of a non-transactional runner could leave behind.
    await db.query(`ALTER TABLE ${NEW_TABLE} RENAME COLUMN per_diem_class_code TO hipps_code`);
    await db.query(
      `ALTER TABLE ${NEW_TABLE} RENAME COLUMN per_diem_rate_cents TO hipps_rate_cents`,
    );
    await db.query(`ALTER POLICY ${NEW_TABLE}_org ON ${NEW_TABLE} RENAME TO hipps_calculation_org`);
    await db.query(
      `ALTER TRIGGER trg_audit_${NEW_TABLE} ON ${NEW_TABLE} RENAME TO trg_audit_hipps_calculation`,
    );
    await db.query(
      `ALTER FUNCTION audit_phi_write_${NEW_TABLE}() RENAME TO audit_phi_write_hipps_calculation`,
    );
    await db.query("UPDATE validation_rule_config SET rule_key = $1 WHERE rule_key = $2", [
      OLD_RULE_KEY,
      NEW_RULE_KEY,
    ]);

    await applyFile(RENAME_MIGRATION);
    await applyFile(RENAME_MIGRATION);

    const cols = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = $1",
      [NEW_TABLE],
    );
    const names = cols.rows.map((c) => c.column_name);
    expect(names).toContain("per_diem_class_code");
    expect(names).toContain("per_diem_rate_cents");
    expect(names).not.toContain("hipps_code");
    const { rows } = await db.query<{ name: string }>(`
      SELECT polname::text AS name FROM pg_policy WHERE polname ILIKE '%hipps%'
      UNION ALL SELECT tgname::text FROM pg_trigger WHERE NOT tgisinternal AND tgname ILIKE '%hipps%'
      UNION ALL SELECT proname::text FROM pg_proc WHERE proname ILIKE '%hipps%'`);
    expect(rows).toEqual([]);
    const fn = await db.query<{ prosecdef: boolean; owner: string }>(
      `SELECT prosecdef, pg_get_userbyid(proowner)::text AS owner FROM pg_proc
        WHERE proname = 'audit_phi_write_${NEW_TABLE}'`,
    );
    expect(fn.rows).toEqual([{ prosecdef: true, owner: "wardenx_audit_writer" }]);
    const cfg = await db.query(
      "SELECT rule_key FROM validation_rule_config WHERE organization_id = $1",
      [ORG_A],
    );
    expect(cfg.rows.map((r) => r.rule_key)).toEqual([NEW_RULE_KEY]);
  });

  /** Post-migration seed of an org + minimal claim (the calculation row is inserted by the caller, as wardenx_app). */
  async function seedClaimOnly(org: string, n: number) {
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
    return { claim };
  }
});
