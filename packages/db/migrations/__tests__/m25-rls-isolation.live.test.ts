/**
 * M25 Remittance & Denials — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / ADR-0010).
 *
 * The pure unit suites (apps/backend/.../25-remittance, packages/x12-835-client) exercise the domain +
 * adapter but never touch a database, so they cannot catch a wrong RLS predicate, a missing WITH CHECK, or
 * a base-table grant that leaks across tenants. This test applies the actual migrations to a real Postgres
 * and exercises the policies as the unprivileged `wardenx_app` role (no BYPASSRLS), proving cross-tenant
 * denial for real on ALL 11 M25 tables under the canonical `organization_id = current_setting('app.org_id')`
 * predicate — including the four monthly RANGE(received_at)-partitioned tables (the policy is on the parent
 * and propagates to every partition, PG11+).
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - CI: the `rls-live` job provides a postgres service + WARDENX_TEST_DATABASE_URL.
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
  advice: string;
  line: string;
  serviceLine: string;
  adjustment: string;
  remark: string;
  denial: string;
  assignment: string;
  appeal: string;
  appealEvent: string;
  overlay: string;
  prLedger: string;
};

const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "remittance_advice", key: "advice" },
  { table: "remittance_line", key: "line" },
  { table: "remittance_service_line", key: "serviceLine" },
  { table: "remittance_adjustment", key: "adjustment" },
  { table: "remittance_remark", key: "remark" },
  { table: "denial_case", key: "denial" },
  { table: "denial_case_assignment", key: "assignment" },
  { table: "appeal_case", key: "appeal" },
  { table: "appeal_case_event", key: "appealEvent" },
  { table: "denial_taxonomy_overlay", key: "overlay" },
  { table: "patient_responsibility_ledger", key: "prLedger" },
];

describe.skipIf(!DB_URL)("M25 Remittance & Denials — RLS cross-tenant denial — LIVE Postgres (§3.5)", () => {
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
        sql = sql.replace(
          /^.*EXTENSION IF NOT EXISTS "vector".*$/m,
          "-- (vector extension stripped: WARDENX_TEST_NO_PGVECTOR)",
        );
      }
      await db.query(sql);
    }
  }

  /** Seed one full M25 chain for `org` as superuser (RLS + grants bypassed). `n` distinguishes ISA/ST. */
  async function seedOrg(org: string, n: string): Promise<SeedIds> {
    const pe = "33333333-3333-3333-3333-333333333333";
    const advice = (
      await db.query(
        `INSERT INTO remittance_advice (organization_id, provider_entity_id, payer_id, payer_kind,
           interchange_control_number, transaction_set_control_number, payment_method, total_payment_amount,
           production_date, minio_object_key, file_sha256)
         VALUES ($1,$2,gen_random_uuid(),'medicare',$3,$4,'eft',1000,now(),'k','sha') RETURNING id`,
        [org, pe, `ICN${n}`, `ST${n}`],
      )
    ).rows[0].id as string;
    const line = (
      await db.query(
        `INSERT INTO remittance_line (organization_id, remittance_advice_id, clp02_status_code,
           clp03_total_charge_amount, clp04_total_payment_amount, received_at)
         VALUES ($1,$2,1,1000,800,now()) RETURNING id`,
        [org, advice],
      )
    ).rows[0].id as string;
    const serviceLine = (
      await db.query(
        `INSERT INTO remittance_service_line (organization_id, remittance_line_id, svc02_charge_amount, svc03_paid_amount, received_at)
         VALUES ($1,$2,1000,800,now()) RETURNING id`,
        [org, line],
      )
    ).rows[0].id as string;
    const adjustment = (
      await db.query(
        `INSERT INTO remittance_adjustment (organization_id, remittance_line_id, cas_group_code, cas_reason_code,
           adjustment_amount, post_action, taxonomy_status, received_at)
         VALUES ($1,$2,'CO','45',200,'auto_posted','mapped',now()) RETURNING id`,
        [org, line],
      )
    ).rows[0].id as string;
    const remark = (
      await db.query(
        `INSERT INTO remittance_remark (organization_id, remittance_line_id, remark_kind, remark_code, received_at)
         VALUES ($1,$2,'MOA','MA01',now()) RETURNING id`,
        [org, line],
      )
    ).rows[0].id as string;
    const denial = (
      await db.query(
        `INSERT INTO denial_case (organization_id, provider_entity_id, claim_id, carc_code, category, source,
           dollar_value, taxonomy_status)
         VALUES ($1,$2,gen_random_uuid(),'50','denial','remittance_adjustment',800,'mapped') RETURNING id`,
        [org, pe],
      )
    ).rows[0].id as string;
    const assignment = (
      await db.query(
        `INSERT INTO denial_case_assignment (organization_id, denial_case_id, assigned_to_membership_id, assigned_by_membership_id)
         VALUES ($1,$2,gen_random_uuid(),gen_random_uuid()) RETURNING id`,
        [org, denial],
      )
    ).rows[0].id as string;
    const appeal = (
      await db.query(
        `INSERT INTO appeal_case (organization_id, provider_entity_id, denial_case_id, claim_id, tier, tier_deadline_at)
         VALUES ($1,$2,$3,gen_random_uuid(),'redetermination', now() + interval '120 days') RETURNING id`,
        [org, pe, denial],
      )
    ).rows[0].id as string;
    const appealEvent = (
      await db.query(
        `INSERT INTO appeal_case_event (organization_id, appeal_case_id, event_kind) VALUES ($1,$2,'created') RETURNING id`,
        [org, appeal],
      )
    ).rows[0].id as string;
    const overlay = (
      await db.query(
        `INSERT INTO denial_taxonomy_overlay (organization_id, carc_code, suggested_action, owner_role, severity)
         VALUES ($1,'50','Verify F2F documentation','billing_specialist','warn') RETURNING id`,
        [org],
      )
    ).rows[0].id as string;
    const prLedger = (
      await db.query(
        `INSERT INTO patient_responsibility_ledger (organization_id, patient_id, remittance_line_id, remittance_adjustment_id, pr_amount)
         VALUES ($1,gen_random_uuid(),$2,$3,50) RETURNING id`,
        [org, line, adjustment],
      )
    ).rows[0].id as string;
    return { advice, line, serviceLine, adjustment, remark, denial, assignment, appeal, appealEvent, overlay, prLedger };
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
    a = await seedOrg(ORG_A, "A");
    await seedOrg(ORG_B, "B");
  }, 120_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  it("every M25 RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
    const rls = readFileSync(join(MIGRATIONS_DIR, "0083_remittance_m25_rls.sql"), "utf8");
    const policyBlocks = rls.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? [];
    expect(policyBlocks.length).toBeGreaterThan(0);
    for (const block of policyBlocks) {
      const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((m) => m[1]);
      expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
      expect(block).not.toMatch(/pg_has_role/i);
      expect(block).not.toMatch(/IS NULL/i);
    }
  });

  it.each(COVERED)("$table: org A sees its row, org B cannot (cross-tenant denial)", async ({ table, key }) => {
    const id = a[key];
    const seenByA = await withOrg(ORG_A, () => db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]));
    expect(seenByA.rows[0].n).toBe(1); // isolation is not "deny everything"
    const seenByB = await withOrg(ORG_B, () => db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]));
    expect(seenByB.rows[0].n).toBe(0); // org B cannot read org A's row
  });

  it("a WITH CHECK refuses an INSERT into another tenant's scope", async () => {
    await expect(
      withOrg(ORG_B, () =>
        db.query(
          `INSERT INTO denial_taxonomy_overlay (organization_id, carc_code, suggested_action, owner_role, severity)
           VALUES ($1,'99','x','billing_specialist','info')`,
          [ORG_A], // B tries to write a row scoped to A
        ),
      ),
    ).rejects.toThrow();
  });
});
