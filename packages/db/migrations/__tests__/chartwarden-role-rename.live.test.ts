/**
 * Migration 1139 — wardenx_* -> chartwarden_* role rename — the LIVE Postgres proof.
 *
 * Applies every migration BEFORE 1139 (so the cluster holds the legacy `wardenx_*` roles, as production
 * does), snapshots what the renamed roles hold, applies 1139, and asserts the rename carried every grant and
 * RLS policy over, left only the privilege-free `wardenx_destruction` alias (the ten applied function bodies
 * that test `pg_has_role(current_user, 'wardenx_destruction', 'MEMBER')` keep working), is idempotent, and
 * leaves the LOGIN role's SCRAM password intact.
 *
 * Roles are cluster-global, so run it on a fresh cluster (a private pgvector container), one database at a
 * time:
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://postgres:…@host/throwaway bun run test:roles-rename:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const RENAME_MIGRATION = "1139_chartwarden_role_rename.sql";
const CARRIERS = ["app", "admin", "readonly", "audit_writer", "destruction"] as const;
const LOGIN_PASSWORD = "throwaway-rename-check";

describe.skipIf(!DB_URL)("migration 1139 — role rename — LIVE Postgres", () => {
  let db: Client;
  const count = async (sql: string, params: unknown[] = []) =>
    (await db.query(sql, params)).rows[0].n as number;
  const grantCount = (role: string) =>
    count("SELECT count(*)::int n FROM information_schema.role_table_grants WHERE grantee = $1", [
      role,
    ]);
  const policyCount = (role: string) =>
    count("SELECT count(*)::int n FROM pg_policies WHERE $1 = ANY(roles::text[])", [role]);

  const grantsBefore = new Map<string, number>();
  const policiesBefore = new Map<string, number>();

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL });
    await db.connect();
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql") && f < RENAME_MIGRATION)
      .sort();
    for (const f of files) await db.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    await db.query("SET password_encryption = 'scram-sha-256'");
    await db.query(`ALTER ROLE wardenx_app WITH LOGIN PASSWORD '${LOGIN_PASSWORD}'`);
    for (const r of CARRIERS) {
      grantsBefore.set(r, await grantCount(`wardenx_${r}`));
      policiesBefore.set(r, await policyCount(`wardenx_${r}`));
    }
    await db.query(readFileSync(join(MIGRATIONS_DIR, RENAME_MIGRATION), "utf8"));
  }, 600_000);

  afterAll(async () => {
    await db?.end();
  });

  it("renames every carrier and keeps only the destruction alias under the old name", async () => {
    const names = (
      await db.query("SELECT rolname FROM pg_roles WHERE rolname ~ '^(wardenx|chartwarden)_'")
    ).rows.map((r) => r.rolname as string);
    for (const r of CARRIERS) expect(names).toContain(`chartwarden_${r}`);
    expect(names.filter((n) => n.startsWith("wardenx_"))).toEqual(["wardenx_destruction"]);
  });

  it.each(CARRIERS)(
    "carries chartwarden_%s's grants and RLS policies over unchanged",
    async (r) => {
      expect(await grantCount(`chartwarden_${r}`)).toBe(grantsBefore.get(r));
      expect(await policyCount(`chartwarden_${r}`)).toBe(policiesBefore.get(r));
    },
  );

  it("keeps the applied pg_has_role('wardenx_destruction') bodies true for the new role, via a privilege-free alias", async () => {
    const member = await db.query(
      "SELECT pg_has_role('chartwarden_destruction', 'wardenx_destruction', 'MEMBER') t",
    );
    expect(member.rows[0].t).toBe(true);
    const alias = await db.query(
      "SELECT rolcanlogin, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'wardenx_destruction'",
    );
    expect(alias.rows[0]).toEqual({ rolcanlogin: false, rolbypassrls: false, rolsuper: false });
    expect(await grantCount("wardenx_destruction")).toBe(0);
    const members = await db.query(
      "SELECT m.rolname FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles m ON m.oid = am.member WHERE r.rolname = 'wardenx_destruction'",
    );
    expect(members.rows.map((x) => x.rolname)).toEqual(["chartwarden_destruction"]);
  });

  it("does not widen RLS: the app role still has NOBYPASSRLS", async () => {
    const r = await db.query("SELECT rolbypassrls FROM pg_roles WHERE rolname = 'chartwarden_app'");
    expect(r.rows[0].rolbypassrls).toBe(false);
  });

  it("is idempotent", async () => {
    await db.query(readFileSync(join(MIGRATIONS_DIR, RENAME_MIGRATION), "utf8"));
    expect(await grantCount("chartwarden_app")).toBe(grantsBefore.get("app"));
  });

  it("keeps the SCRAM password: the renamed role still authenticates", async () => {
    const u = new URL(DB_URL as string);
    u.username = "chartwarden_app";
    u.password = LOGIN_PASSWORD;
    const login = new Client({ connectionString: u.toString() });
    await login.connect();
    const who = await login.query("SELECT current_user u");
    await login.end();
    expect(who.rows[0].u).toBe("chartwarden_app");
  });
});
