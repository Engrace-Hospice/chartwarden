/**
 * RLS cross-tenant isolation — LIVE Postgres proof (M1 §7.2 / M2 spec §9.3; slice-acceptance #3).
 *
 * This is the REAL proof the slice was missing. Its in-memory sibling
 * (cross-tenant-isolation.test.ts) runs a hand-written model of RLS and never touches a
 * database — so it cannot catch anything Postgres does at runtime (a wrong policy
 * predicate, a missing WITH CHECK, or a recursing trigger). This test applies the actual
 * migrations to a real Postgres and exercises the policies as the unprivileged
 * `wardenx_app` role (no BYPASSRLS), proving cross-tenant denial for real.
 *
 * It also pins the regression that the simulation missed: audit_event is RANGE-partitioned
 * by month, so an audited write routes to a dated child and the audit trigger fires with
 * TG_TABLE_NAME = that partition; if the trigger's recursion guard only matches the parent
 * name, every audited write recurses to "stack depth limit exceeded". See 0004's guard.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - CI: the `rls-live` job provides a postgres service + WARDENX_TEST_DATABASE_URL.
 *   - Local: `WARDENX_TEST_DATABASE_URL=postgres://… bun run test:rls:live`
 * The URL must be a SUPERUSER connection to a THROWAWAY database (the suite drops and
 * recreates the public schema + roles).
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

const PE_COLS = "(organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)";
const PE_VALS = "($1,'CCN','Legal','NPI','enc','12-31')";

describe.skipIf(!DB_URL)("RLS cross-tenant isolation — LIVE Postgres (§7.2/§9.3)", () => {
  let db: Client;
  let peA: string; // an org-A provider_entity, created under org A's context

  /** Run `fn` as the unprivileged app role with app.org_id = `org` (RLS enforced). */
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
      // drop owned objects + default privileges, then the role — only if it lingers
      await db.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
  }

  async function applyMigrations() {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8").replace(
        /^.*EXTENSION IF NOT EXISTS "vector".*$/m,
        "-- (vector extension stripped for tests — irrelevant to tenancy; not every PG ships pgvector)",
      );
      await db.query(sql);
    }
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL });
    await db.connect();
    await resetSchema();
    await applyMigrations();

    // Seed two orgs + a global and an org-A feature flag (as superuser — RLS bypassed).
    await db.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await db.query(
      `INSERT INTO feature_flag (organization_id,flag_key,flag_kind,value_type,value,targeting,kill_switch_active,created_at,updated_at)
       VALUES (NULL,'global_flag','product','bool','true'::jsonb,'{}'::jsonb,false,now(),now()),
              ($1,'org_a_flag','product','bool','true'::jsonb,'{}'::jsonb,false,now(),now())`,
      [ORG_A],
    );

    // Org A writes a provider_entity (+ a location under it). If the audit trigger recurses
    // through audit_event's monthly partition, THIS throws "stack depth limit exceeded" and
    // the whole suite fails — which is exactly the regression we want pinned.
    peA = await withOrg(ORG_A, async () => {
      const r = await db.query(`INSERT INTO provider_entity ${PE_COLS} VALUES ${PE_VALS} RETURNING id`, [ORG_A]);
      const id = r.rows[0].id as string;
      await db.query(
        `INSERT INTO location (provider_entity_id,name,address_line1,city,state,postal_code,timezone)
         VALUES ($1,'Loc-A','1 St','Town','OR','97000','America/Los_Angeles')`,
        [id],
      );
      return id;
    });
  }, 120_000);

  afterAll(async () => {
    await db?.end();
  });

  it("audited writes do NOT recurse through audit_event partitions (regression: 0004 guard)", async () => {
    expect(peA).toBeTruthy(); // the seed insert above succeeded → no stack-overflow
    // and the AFTER trigger actually wrote an audit row for it (read as superuser)
    const r = await db.query("SELECT count(*)::int AS n FROM audit_event WHERE resource_kind='provider_entity'");
    expect(r.rows[0].n).toBeGreaterThan(0);
  });

  it("org B sees NONE of org A's rows (org-column policy: provider_entity)", async () => {
    const r = await withOrg(ORG_B, () => db.query("SELECT count(*)::int AS n FROM provider_entity WHERE id=$1", [peA]));
    expect(r.rows[0].n).toBe(0);
  });

  it("org B sees NONE of org A's rows (join-scoped policy: location)", async () => {
    const r = await withOrg(ORG_B, () =>
      db.query("SELECT count(*)::int AS n FROM location WHERE provider_entity_id=$1", [peA]),
    );
    expect(r.rows[0].n).toBe(0);
  });

  it("rejects a cross-tenant write — org B cannot insert an org-A row (WITH CHECK)", async () => {
    await expect(
      withOrg(ORG_B, () => db.query(`INSERT INTO provider_entity ${PE_COLS} VALUES ${PE_VALS}`, [ORG_A])),
    ).rejects.toThrow();
  });

  it("feature_flag: org B reads the global (NULL) flag but NOT org A's flag", async () => {
    const r = await withOrg(ORG_B, () =>
      db.query("SELECT flag_key FROM feature_flag ORDER BY flag_key"),
    );
    const keys = r.rows.map((x) => x.flag_key);
    expect(keys).toContain("global_flag");
    expect(keys).not.toContain("org_a_flag");
  });

  it("org A still sees its OWN row (isolation is not just 'deny everything')", async () => {
    const r = await withOrg(ORG_A, () => db.query("SELECT count(*)::int AS n FROM provider_entity WHERE id=$1", [peA]));
    expect(r.rows[0].n).toBe(1);
  });

  it("audit_event is append-only to the app role (UPDATE + DELETE both denied)", async () => {
    await expect(withOrg(ORG_A, () => db.query("UPDATE audit_event SET created_at = now()"))).rejects.toThrow();
    await expect(withOrg(ORG_A, () => db.query("DELETE FROM audit_event"))).rejects.toThrow();
  });
});
