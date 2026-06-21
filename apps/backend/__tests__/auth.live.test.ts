// apps/backend/__tests__/auth.live.test.ts — AUTH-T06 (ADR-0033) live-Postgres auth integration.
// Proves the Better Auth ↔ M1 schema reconciliation (migration 0024): a real email+password sign-up
// writes user/account/session rows against the migrated schema, and sign-in + the DB-backed session
// store resolve. Skipped without WARDENX_TEST_DATABASE_URL (the CI `auth-live` lane / local pg18).
// Also proves 2FA-at-rest encryption (ADR-0034) and the password-reset flow (token issuance via the
// sendResetPassword seam → resetPassword → credential rotation). Passkey enrollment is out of scope
// (a browser WebAuthn ceremony — not CI-testable without a virtual authenticator).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isSealed } from "@wardenx/auth";
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

  it("password reset issues a token, sets a new password, and rotates the credential (AUTH polish)", async () => {
    // A dedicated instance whose sendResetPassword captures the minted token (the M36 delivery seam).
    let captured: { url: string; token: string } | null = null;
    const { createDbClient: mkDb2 } = await import("@wardenx/db");
    const { createIdentityAuth: mk2 } = await import("@wardenx/auth");
    const handle2 = mkDb2({ connectionString: DB_URL as string });
    const authR = mk2(handle2.db as never, {
      sendResetPassword: ({ url, token }) => {
        captured = { url, token };
      },
    });

    const email = `pr${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
    const oldPw = `Wx9$${Math.random().toString(36).slice(2)}${Date.now()}Qz!`;
    const newPw = `Zr7#${Math.random().toString(36).slice(2)}${Date.now()}Lp!`;
    await authR.api.signUpEmail({ body: { email, password: oldPw, name: "PR User" } });

    // Step 1 — request the reset; the callback captures the single-use token.
    await authR.api.requestPasswordReset({ body: { email, redirectTo: "http://localhost:3000/reset-password" } });
    expect(captured).not.toBeNull();
    const token = (captured as unknown as { token: string }).token;
    expect(token.length).toBeGreaterThan(0);

    // Step 2 — consume the token to set the new password.
    await authR.api.resetPassword({ body: { newPassword: newPw, token } });

    // The credential rotated: the new password signs in; the old one no longer does.
    const ok = await authR.api.signInEmail({ body: { email, password: newPw }, asResponse: true });
    expect((ok as Response).status).toBe(200);
    await expect(authR.api.signInEmail({ body: { email, password: oldPw } })).rejects.toThrow();

    await handle2.close();
  });

  it("2FA enrollment stores the TOTP secret ENCRYPTED at rest (ADR-0034)", async () => {
    const email = `tf${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
    const password = `Wx9$${Math.random().toString(36).slice(2)}${Date.now()}Qz!`;
    // sign up (autoSignIn) → grab the session cookie from the response
    const signUp = (await auth.api.signUpEmail({ body: { email, password, name: "TF User" }, asResponse: true })) as Response;
    const cookie = (signUp.headers.get("set-cookie") ?? "").split(";")[0];
    // enrol TOTP (the twoFactor plugin writes the secret via the encrypting adapter decorator)
    await auth.api.enableTwoFactor({ body: { password }, headers: { cookie } });

    const u = await admin.query('SELECT id FROM "user" WHERE email = $1', [email]);
    const tf = await admin.query("SELECT secret_encrypted FROM two_factor WHERE user_id = $1", [u.rows[0].id]);
    expect(tf.rowCount).toBeGreaterThanOrEqual(1);
    const stored = String(tf.rows[0].secret_encrypted);
    expect(isSealed(stored)).toBe(true); // our AES-256-GCM token — NOT the plaintext base32 TOTP secret
  });

  it("M3 RBAC: the live effective-permission store resolves grants from membership ⋈ role ⋈ role_permission", async () => {
    const { createDbClient: mkDb3 } = await import("@wardenx/db");
    const { createDbEffectivePermissionStore, resolveEffectivePermissions } = await import("@wardenx/auth");
    const handle3 = mkDb3({ connectionString: DB_URL as string });
    const store = createDbEffectivePermissionStore(handle3.db as never);

    // Seed the full §2.2 grant graph as superuser (RLS bypassed for seeding).
    const email = `rb${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
    const password = `Wx9$${Math.random().toString(36).slice(2)}${Date.now()}Qz!`;
    await auth.api.signUpEmail({ body: { email, password, name: "RBAC User" } });
    const userId = (await admin.query('SELECT id FROM "user" WHERE email = $1', [email])).rows[0].id as string;

    const org = (await admin.query(
      "INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'RB','RB') RETURNING id",
      [`rb-${Date.now()}`],
    )).rows[0].id as string;
    const membership = (await admin.query(
      "INSERT INTO membership (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id",
      [userId, org],
    )).rows[0].id as string;
    await admin.query(
      "INSERT INTO permission (key,resource,action,category) VALUES ('patient.read','patient','read','clinical') ON CONFLICT (key) DO NOTHING",
    );

    // An ACTIVE role grant (permanent) and a SECOND grant whose window already closed (expired).
    const liveRole = (await admin.query(
      "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'rb-nurse','Nurse','clinical_staff',true) RETURNING id",
      [org],
    )).rows[0].id as string;
    const staleRole = (await admin.query(
      "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'rb-locum','Locum','clinical_staff',true) RETURNING id",
      [org],
    )).rows[0].id as string;
    await admin.query("INSERT INTO role_permission (organization_id,role_id,permission_key) VALUES ($1,$2,'patient.read')", [org, liveRole]);
    await admin.query("INSERT INTO role_permission (organization_id,role_id,permission_key) VALUES ($1,$2,'patient.read')", [org, staleRole]);
    await admin.query("INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)", [org, membership, liveRole]);
    await admin.query(
      "INSERT INTO membership_role (organization_id,membership_id,role_id,expires_at) VALUES ($1,$2,$3, now() - interval '1 day')",
      [org, membership, staleRole],
    );

    const grants = await store.loadGrants(org, userId);
    // The store is a thin reader: it returns BOTH grants (filtering is the engine's job).
    expect(grants.map((g) => g.roleKey).sort()).toEqual(["rb-locum", "rb-nurse"]);
    const live = grants.find((g) => g.roleKey === "rb-nurse");
    expect(live?.permissionKeys).toContain("patient.read");
    expect(live?.expiresAt).toBeNull();
    expect(grants.find((g) => g.roleKey === "rb-locum")?.expiresAt).toBeInstanceOf(Date);

    // The engine drops the expired grant; the permanent grant's permission survives.
    const eff = resolveEffectivePermissions(grants, Date.now());
    expect(eff.permissions.has("patient.read")).toBe(true);

    // No grants leak to a different org scope (defense in depth beneath RLS).
    expect(await store.loadGrants(org, crypto.randomUUID())).toEqual([]);

    await handle3.close();
  });
});
