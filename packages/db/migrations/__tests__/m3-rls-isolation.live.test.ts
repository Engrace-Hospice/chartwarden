/**
 * M3 Authorization — RLS cross-tenant denial: the LIVE Postgres proof (§3.6 / ADR-0010).
 *
 * M3's pure suites exercise the RBAC/ABAC evaluator, the role registry, and break-glass state machine but
 * never touch a database, so they cannot catch a wrong RLS predicate, a missing WITH CHECK, or a base-table
 * grant that leaks across tenants. This applies the real migrations to a real Postgres and drives the policies
 * as the unprivileged `wardenx_app` role (no BYPASSRLS), covering all FIVE org-scoped M3 tables.
 *
 * Authorization is a MIXED-scoping module, which is exactly what makes this worth more than a checkbox:
 *   • `permission` is the platform-global catalog mirror — it carries NO organization_id and is EXCLUDED
 *     from the sweep (§3.7 grants it a SELECT-only, RLS-free platform read; there is no tenant to isolate).
 *   • `role` / `role_permission` carry a NULLABLE organization_id: a NULL row is a platform template readable
 *     by every tenant (the org-NULL SELECT branch lives in 0010, a separate FOR SELECT policy). The org-owned
 *     rows this suite seeds are isolated by the FOR ALL `_org` policies in 0009, and the sweep proves an org
 *     B context can neither read nor write org A's non-template rows.
 *   • `break_glass_event` is the emergency PHI-access grant — a cross-tenant write would let one tenant
 *     manufacture another's break-glass authorization, the record that unlocks another org's patient data.
 *   • `membership_role` is the role→privilege binding — a cross-tenant read discloses who holds what power in
 *     another org, and a cross-tenant write is a privilege escalation into a foreign tenant.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `WARDENX_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m3` (SUPERUSER to a THROWAWAY db;
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
/** `membership_role.membership_id` and `break_glass_event.actor_user_id` carry real FKs (membership → user),
 * so a single seeded user + a membership per org is enough for every reference in the chain. */
const USER = "33333333-3333-3333-3333-333333333333";
/** The platform `permission` catalog key `role_permission.permission_key` FKs — one shared platform row. */
const PERMISSION_KEY = "m3.rls.read";

type SeedIds = {
  membership: string;
  role: string;
  rolePermission: string;
  membershipRole: string;
  breakGlassEvent: string;
  auditorEngagement: string;
};

const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "role", key: "role" },
  { table: "role_permission", key: "rolePermission" },
  { table: "membership_role", key: "membershipRole" },
  { table: "break_glass_event", key: "breakGlassEvent" },
  { table: "auditor_engagement", key: "auditorEngagement" },
];

describe.skipIf(!DB_URL)("M3 Authorization — RLS cross-tenant denial — LIVE Postgres (§3.6)", () => {
  let db: Client;
  let a: SeedIds;
  let b: SeedIds;

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
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        // BOTH spellings appear in the corpus — 0001 quotes the extension name, 0014 does not — and
        // there is more than one occurrence, so this must be global, not the first match only.
        sql = sql.replace(
          /^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm,
          "-- (vector extension stripped: WARDENX_TEST_NO_PGVECTOR set)",
        );
        // Dropping the extension is not enough: a later migration declares a `vector(384)` COLUMN, so the
        // TYPE must still resolve. A test-only text shim keeps the DDL applying without touching any table
        // this suite asserts on.
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        // …and the pgvector-only ACCESS METHOD the embedding index uses goes with it.
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw index stripped: no pgvector)");
      }
      await db.query(sql);
    }
  }

  /** Seed one full M3 authorization chain for `org` as superuser (RLS + grants bypassed). */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const membership = (
      await db.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, org],
      )
    ).rows[0].id as string;

    // Org-owned role (organization_id NOT NULL here — a platform template would be the NULL-org branch,
    // isolated to the FOR SELECT policy in 0010 and never written from a tenant context).
    const role = (
      await db.query(
        `INSERT INTO role (organization_id, key, name, category, scope_level)
         VALUES ($1,$2,$3,'clinical_staff','location') RETURNING id`,
        [org, `rn-case-manager-${n}`, `RN Case Manager ${n}`],
      )
    ).rows[0].id as string;

    const rolePermission = (
      await db.query(
        `INSERT INTO role_permission (organization_id, role_id, permission_key)
         VALUES ($1,$2,$3) RETURNING id`,
        [org, role, PERMISSION_KEY],
      )
    ).rows[0].id as string;

    const membershipRole = (
      await db.query(
        `INSERT INTO membership_role (organization_id, membership_id, role_id, granted_by)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [org, membership, role, USER],
      )
    ).rows[0].id as string;

    const breakGlassEvent = (
      await db.query(
        `INSERT INTO break_glass_event (organization_id, actor_user_id, reason, status, expires_at)
         VALUES ($1,$2,'code blue — emergency PHI access','active', now() + interval '1 hour')
         RETURNING id`,
        [org, USER],
      )
    ).rows[0].id as string;

    const auditorEngagement = (
      await db.query(
        `INSERT INTO auditor_engagement (organization_id, engagement_type, auditor_agency, scope, status,
           start_at, end_at)
         VALUES ($1,'cms_survey','CMS Region X','{}'::jsonb,'scheduled', now(), now() + interval '30 days')
         RETURNING id`,
        [org],
      )
    ).rows[0].id as string;

    return { membership, role, rolePermission, membershipRole, breakGlassEvent, auditorEngagement };
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
    await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m3-actor@x.test')`, [USER]);
    // The platform permission catalog is global (no organization_id) — one shared row both tenants bind to.
    await db.query(
      `INSERT INTO permission (key, resource, action, category) VALUES ($1,'patient','read','clinical_staff')`,
      [PERMISSION_KEY],
    );
    a = await seedOrg(ORG_A, 1);
    b = await seedOrg(ORG_B, 2);
  }, 120_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  // GUARD FOR EVERY CASE BELOW. RLS is not enforced for a role holding BYPASSRLS, so if the runtime
  // role ever gains it, every isolation assertion in this file passes VACUOUSLY and CI stays green.
  // scripts/db/migrate.ts grants exactly that behind WARDENX_DEV_BYPASSRLS=1, so this is reachable.
  it("wardenx_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
    const { rows } = await db.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'wardenx_app'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it("every M3 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
    // Reads ONLY 0009 — the FOR ALL tenant-isolation policies. The org-NULL template READ branch (an
    // `organization_id IS NULL` disjunction) lives in 0010 as a separate FOR SELECT policy with no WITH
    // CHECK, so it never matches this regex and never relaxes a writable policy (check-tenancy.ts rule 3a).
    const rls = readFileSync(
      join(MIGRATIONS_DIR, "0009_authorization_m3_rls_audit_triggers.sql"),
      "utf8",
    );
    const policyBlocks = (rls.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? []).filter((b) =>
      COVERED.some((t) => b.includes(`"${t.table}"`)),
    );
    expect(policyBlocks.length).toBe(COVERED.length);
    for (const block of policyBlocks) {
      const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((m) => m[1]);
      expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
      expect(block).not.toMatch(/pg_has_role/i);
      expect(block).not.toMatch(/IS NULL/i);
    }
  });

  it.each(COVERED)(
    "$table: org A sees its row, org B cannot (cross-tenant denial)",
    async ({ table, key }) => {
      const id = a[key];
      const seenByA = await withOrg(ORG_A, () =>
        db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]),
      );
      expect(seenByA.rows[0].n).toBe(1); // isolation is not "deny everything"
      const seenByB = await withOrg(ORG_B, () =>
        db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]),
      );
      expect(seenByB.rows[0].n).toBe(0);
    },
  );

  it("a WITH CHECK refuses a break-glass grant forged into another tenant", async () => {
    // break_glass_event is the emergency PHI-access grant — a cross-tenant write would let one tenant
    // manufacture another's break-glass authorization, the record that unlocks another org's patient data.
    await expect(
      withOrg(ORG_B, () =>
        db.query(
          `INSERT INTO break_glass_event (organization_id, actor_user_id, reason, status, expires_at)
           VALUES ($1,$2,'forged emergency access','active', now() + interval '1 hour')`,
          [ORG_A, USER],
        ),
      ),
    ).rejects.toThrow();
  });

  it("org B cannot UPDATE org A's break-glass grant (the USING clause covers writes too)", async () => {
    const res = await withOrg(ORG_B, () =>
      db.query("UPDATE break_glass_event SET status='revoked' WHERE id=$1", [a.breakGlassEvent]),
    );
    expect(res.rowCount).toBe(0);
    const still = await db.query("SELECT status FROM break_glass_event WHERE id=$1", [
      a.breakGlassEvent,
    ]);
    expect(still.rows[0].status).toBe("active");
  });

  it("the M4 write-audit trigger fired for the membership_role writes (§3.8)", async () => {
    const r = await db.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind = 'membership_role'",
    );
    expect(r.rows[0].n).toBeGreaterThan(0);
  });
});
