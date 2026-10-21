/**
 * M34 tenant shred × M36 D9 — the ONE sole-tenant-user rule, LIVE Postgres.
 *
 * The tenant shred's identity eraser and M36's messaging eraser both erase per-USER state for users who
 * "belong only to the offboarded tenant" (M36 D9: "users in multiple tenants retain their cross-tenant
 * rows … a user is not the tenant"). They used to resolve that set with two DIFFERENT queries: M34's raw
 * `m34SoleTenantUserIds` ignored revoked memberships on BOTH sides, so
 *   - a user revoked here and nowhere else (every offboarded staff member) was never erased, and
 *   - a user active here but revoked in another tenant WAS erased — destroying an identity another
 *     tenant's membership row still references, which no shred can undo.
 * Both erasers now go through `buildSoleTenantUserResolver` (any membership elsewhere, any status, keeps
 * the user; any membership here, any status, makes them ours). This suite pins that rule against real
 * rows, through the real `withPlatformContext` entry and its mandatory `platform.bypass_invoked` audit.
 *
 * The resolver runs on the platform credential (`DATABASE_PLATFORM_URL`) by design — "has no membership
 * elsewhere" is a cross-tenant read `wardenx_app` can never prove under RLS. The suite builds the SAME
 * `wardenx_platform` carrier + BYPASSRLS `wardenx_platform_login` that `scripts/db/provision-runtime-roles.ts`
 * provisions, with only the two grants this read needs (`membership` SELECT, the 0187 audit function) —
 * so a missing production grant fails here, not in a shred.
 *
 * Gated on a live DB so the default `bun run test` stays green:
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m34:sole-tenant-users:live
 * (SUPERUSER connection string to a THROWAWAY db — the suite drops and recreates `public` and the roles.)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { registerPlatformJob } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSoleTenantUserResolver } from "../src/bootstrap/sole-tenant-user-resolver";
import { m34PlatformBypassAuditor } from "../src/index";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_platform_login",
  "wardenx_platform",
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "tenant_platform_writer",
];
const JOB_ID = "m34-shred-sole-tenant-resolver-live-test";

const ORG_SHREDDED = "11111111-1111-4111-8111-111111113401";
const ORG_OTHER = "22222222-2222-4222-8222-222222223402";

const USER_ACTIVE_HERE_ONLY = "a0000000-0000-4000-8000-000000003401";
const USER_REVOKED_HERE_ONLY = "a0000000-0000-4000-8000-000000003402";
const USER_ACTIVE_HERE_REVOKED_ELSEWHERE = "a0000000-0000-4000-8000-000000003403";
const USER_ACTIVE_IN_BOTH = "a0000000-0000-4000-8000-000000003404";
const USER_SUSPENDED_ELSEWHERE = "a0000000-0000-4000-8000-000000003405";
const USER_OTHER_TENANT_ONLY = "a0000000-0000-4000-8000-000000003406";

type Status = "pending" | "active" | "suspended" | "revoked";
const MEMBERSHIPS: ReadonlyArray<readonly [string, string, Status]> = [
  [USER_ACTIVE_HERE_ONLY, ORG_SHREDDED, "active"],
  [USER_REVOKED_HERE_ONLY, ORG_SHREDDED, "revoked"],
  [USER_ACTIVE_HERE_REVOKED_ELSEWHERE, ORG_SHREDDED, "active"],
  [USER_ACTIVE_HERE_REVOKED_ELSEWHERE, ORG_OTHER, "revoked"],
  [USER_ACTIVE_IN_BOTH, ORG_SHREDDED, "active"],
  [USER_ACTIVE_IN_BOTH, ORG_OTHER, "active"],
  [USER_SUSPENDED_ELSEWHERE, ORG_SHREDDED, "active"],
  [USER_SUSPENDED_ELSEWHERE, ORG_OTHER, "suspended"],
  [USER_OTHER_TENANT_ONLY, ORG_OTHER, "active"],
];

describe.skipIf(!DB_URL)("M34 shred × M36 D9 — sole-tenant users, LIVE Postgres", () => {
  let admin: Client;
  let platformHandle: ReturnType<typeof createDbClient>;

  const urlAs = (role: string, password: string): string => {
    const u = new URL(DB_URL as string);
    u.username = role;
    u.password = password;
    return u.toString();
  };

  async function applyMigrations() {
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }

  const resolve = () =>
    buildSoleTenantUserResolver({
      platformDb: platformHandle.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: JOB_ID,
    })(ORG_SHREDDED);

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    await applyMigrations();

    for (const [org, slug] of [
      [ORG_SHREDDED, "sole34a"],
      [ORG_OTHER, "sole34b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$3)",
        [org, slug, slug],
      );
    }
    const users = [...new Set(MEMBERSHIPS.map(([user]) => user))];
    for (const user of users) {
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [
        user,
        `${user.slice(-4)}@sole34.test`,
      ]);
    }
    for (const [user, org, status] of MEMBERSHIPS) {
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,$3)",
        [user, org, status],
      );
    }

    // Mirrors scripts/db/provision-runtime-roles.ts: the NOLOGIN carrier holds the grants; BYPASSRLS is
    // an attribute (never inherited), so it sits on the login role itself.
    await admin.query("CREATE ROLE wardenx_platform NOLOGIN");
    await admin.query("GRANT USAGE ON SCHEMA public TO wardenx_platform");
    await admin.query("GRANT SELECT ON membership TO wardenx_platform");
    await admin.query(
      "GRANT EXECUTE ON FUNCTION audit_writer_insert_platform_event(text, text, uuid, text, text, text, jsonb, text) TO wardenx_platform",
    );
    await admin.query(
      "CREATE ROLE wardenx_platform_login LOGIN IN ROLE wardenx_platform BYPASSRLS PASSWORD 'sole34_platform'",
    );
    platformHandle = createDbClient({
      connectionString: urlAs("wardenx_platform_login", "sole34_platform"),
    });
    registerPlatformJob(JOB_ID);
  }, 240_000);

  afterAll(async () => {
    await platformHandle?.close();
    await admin?.end();
  });

  it("erases users whose only memberships are in the shredded tenant, whatever their status", async () => {
    const subjects = await resolve();

    expect([...subjects].sort()).toEqual([USER_ACTIVE_HERE_ONLY, USER_REVOKED_HERE_ONLY].sort());
  });

  it("keeps a user revoked in another tenant — their identity is still that tenant's reference", async () => {
    const subjects = await resolve();

    expect(subjects).not.toContain(USER_ACTIVE_HERE_REVOKED_ELSEWHERE);
    expect(subjects).not.toContain(USER_SUSPENDED_ELSEWHERE);
    expect(subjects).not.toContain(USER_ACTIVE_IN_BOTH);
    expect(subjects).not.toContain(USER_OTHER_TENANT_ONLY);
  });

  it("audits every resolution as a platform.bypass_invoked event under its own job id", async () => {
    const before = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE event_type = 'platform.bypass_invoked' AND correlation_id LIKE $1",
      [`platform-bypass:${JOB_ID}:%`],
    );

    await resolve();

    const after = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE event_type = 'platform.bypass_invoked' AND correlation_id LIKE $1",
      [`platform-bypass:${JOB_ID}:%`],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
  });
});
