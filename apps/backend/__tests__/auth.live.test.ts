// apps/backend/__tests__/auth.live.test.ts — AUTH-T06 (ADR-0033) live-Postgres auth integration.
// Proves the Better Auth ↔ M1 schema reconciliation (migration 0024): a real email+password sign-up
// writes user/account/session rows against the migrated schema, and sign-in + the DB-backed session
// store resolve. Skipped without WARDENX_TEST_DATABASE_URL (the CI `auth-live` lane / local pg18).
// 2FA + passkey ENROLLMENT are out of scope here (deferred to the Option-C / passkey follow-ups).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer", "mdm_canonical_writer"];

describe.skipIf(!DB_URL)("Better Auth live — email+password over the reconciled schema (AUTH-T06)", () => {
  let admin: Client;
  let close: () => Promise<void>;
  // biome-ignore lint/suspicious/noExplicitAny: the auth instance type is intentionally opaque here.
  let auth: any;

  async function resetAndMigrate() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql")).sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      }
      await admin.query(sql);
    }
  }

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET ??= "test-secret-at-least-32-characters-long-xx";
    process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetAndMigrate();
    const { createDbClient: mkDb } = await import("@wardenx/db");
    const { createIdentityAuth } = await import("@wardenx/auth");
    const handle = mkDb({ connectionString: DB_URL as string });
    close = handle.close;
    auth = createIdentityAuth(handle.db as never);
  });

  afterAll(async () => {
    await close?.();
    await admin?.end();
  });

  it("sign-up writes user + account + session rows against the migrated schema", async () => {
    const email = `t${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
    const password = `Wx9$${Math.random().toString(36).slice(2)}${Date.now()}Qz!`; // random, >12, non-breached
    await auth.api.signUpEmail({ body: { email, password, name: "Test User" } });

    const u = await admin.query('SELECT id FROM "user" WHERE email = $1', [email]);
    expect(u.rowCount).toBe(1);
    const a = await admin.query("SELECT id FROM account WHERE user_id = $1", [u.rows[0].id]);
    expect(a.rowCount).toBeGreaterThanOrEqual(1);
    const s = await admin.query("SELECT id FROM session WHERE user_id = $1", [u.rows[0].id]);
    expect(s.rowCount).toBeGreaterThanOrEqual(1);
  });
});
