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
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;

/**
 * Wrap a Drizzle client so every transaction runs as the RLS-enforced tenant role (`wardenx_app`),
 * not the superuser the live lane connects as — otherwise RLS is BYPASSED and org-scoping is never
 * actually tested. `SET LOCAL ROLE` is transaction-scoped (reset on commit), and withOrgContext's
 * `set_config('app.org_id', …)` runs right after, so the store's queries are genuinely RLS-filtered.
 * Bare (non-transaction) queries still run as the base role — only withOrgContext(FromRequest) paths
 * are hardened (which is exactly where tenant reads must live).
 */
// biome-ignore lint/suspicious/noExplicitAny: a structural transaction-wrapping proxy over the opaque db.
function asTenantRole<T extends { transaction: (...a: any[]) => any }>(db: T, role = "wardenx_app"): T {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "transaction") {
        // biome-ignore lint/suspicious/noExplicitAny: delegates to the real (typed) transaction.
        return (fn: any) =>
          (target.transaction as (f: unknown) => unknown)(async (tx: { execute: (q: unknown) => Promise<unknown> }) => {
            await tx.execute(sql`SET LOCAL ROLE ${sql.raw(role)}`);
            return fn(tx);
          });
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
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
    // The token-capturing override gives the single-use token directly (Better Auth puts it in the
    // reset-URL path, not a ?token= query — so the callback arg, not URL parsing, is the reliable source).
    let captured: { token: string } | null = null;
    const { createDbClient: mkDb2 } = await import("@wardenx/db");
    const { createIdentityAuth: mk2 } = await import("@wardenx/auth");
    const handle2 = mkDb2({ connectionString: DB_URL as string });
    const authR = mk2(handle2.db as never, {
      sendResetPassword: ({ token }) => {
        captured = { token };
      },
    });

    const email = `pr${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
    const oldPw = `Wx9$${Math.random().toString(36).slice(2)}${Date.now()}Qz!`;
    const newPw = `Zr7#${Math.random().toString(36).slice(2)}${Date.now()}Lp!`;
    await authR.api.signUpEmail({ body: { email, password: oldPw, name: "PR User" } });

    // Step 1 — request the reset; the override captures the single-use token.
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

    // Delivery path: with an email transport (no override), the reset link reaches the transport.
    let deliveredTo: string | null = null;
    const authT = mk2(handle2.db as never, {
      emailTransport: {
        async send(message) {
          deliveredTo = message.to;
        },
      },
    });
    await authT.api.requestPasswordReset({ body: { email, redirectTo: "http://localhost:3000/reset-password" } });
    expect(deliveredTo).toBe(email);

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

  it("M2/M3 actor enrichment: the live reader returns membershipId + current role keys", async () => {
    const { createDbClient: mkDb4 } = await import("@wardenx/db");
    const { createDbActorEnrichmentReader } = await import("@wardenx/auth");
    const handle4 = mkDb4({ connectionString: DB_URL as string });
    const reader = createDbActorEnrichmentReader(handle4.db as never);

    const email = `en${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
    const password = `Wx9$${Math.random().toString(36).slice(2)}${Date.now()}Qz!`;
    await auth.api.signUpEmail({ body: { email, password, name: "Enrich User" } });
    const userId = (await admin.query('SELECT id FROM "user" WHERE email = $1', [email])).rows[0].id as string;
    const org = (await admin.query(
      "INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'EN','EN') RETURNING id",
      [`en-${Date.now()}`],
    )).rows[0].id as string;
    const membership = (await admin.query(
      "INSERT INTO membership (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id",
      [userId, org],
    )).rows[0].id as string;
    const liveRole = (await admin.query(
      "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'en-rn','RN','clinical_staff',true) RETURNING id",
      [org],
    )).rows[0].id as string;
    const staleRole = (await admin.query(
      "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'en-temp','Temp','clinical_staff',true) RETURNING id",
      [org],
    )).rows[0].id as string;
    await admin.query("INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)", [org, membership, liveRole]);
    await admin.query(
      "INSERT INTO membership_role (organization_id,membership_id,role_id,expires_at) VALUES ($1,$2,$3, now() - interval '1 hour')",
      [org, membership, staleRole],
    );

    const enrichment = await reader.read({ orgId: org }, userId);
    expect(enrichment?.membershipId).toBe(membership);
    // Only the current (non-expired) role is reported; the closed window is dropped (§7.2).
    expect(enrichment?.roles).toEqual(["en-rn"]);

    // A user with no active membership in the org → null (no actor context).
    expect(await reader.read({ orgId: org }, crypto.randomUUID())).toBeNull();

    await handle4.close();
  });

  it("M3 RBAC: the live RoleStore lists the org's catalog (templates + own roles) with permission keys", async () => {
    const { createDbClient: mkDb5 } = await import("@wardenx/db");
    const { createDbRoleStore } = await import("../src/modules/03-authorization/role-store");
    const handle5 = mkDb5({ connectionString: DB_URL as string });
    // Under the RLS-enforced wardenx_app role: this exercises the 0025 policy fix (templates org_id
    // NULL must stay readable) AND real org-scoping of the catalog — not the superuser bypass.
    const store = createDbRoleStore(asTenantRole(handle5.db) as never);

    const org = (await admin.query(
      "INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'RS','RS') RETURNING id",
      [`rs-${Date.now()}`],
    )).rows[0].id as string;
    await admin.query("INSERT INTO permission (key,resource,action,category) VALUES ('role.read','role','read','admin') ON CONFLICT (key) DO NOTHING");
    // A platform template (org_id NULL, system_default) and this org's own custom role.
    const tmpl = (await admin.query(
      "INSERT INTO role (organization_id,key,name,category,system_default,enabled) VALUES (NULL,$1,'Nurse Template','clinical_staff',true,true) RETURNING id",
      [`rs-tmpl-${Date.now()}`],
    )).rows[0].id as string;
    const own = (await admin.query(
      "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'rs-custom','Custom RN','clinical_staff',true) RETURNING id",
      [org],
    )).rows[0].id as string;
    await admin.query("INSERT INTO role_permission (organization_id,role_id,permission_key) VALUES ($1,$2,'role.read')", [org, own]);

    const roles = await store.listForOrg(org);
    const byId = new Map(roles.map((r) => [r.roleId, r]));
    // Template (org_id NULL) visible under wardenx_app thanks to 0025; org row visible + customized.
    expect(byId.has(tmpl)).toBe(true); // would be FALSE under the pre-0025 org-only read policy
    expect(byId.get(tmpl)?.systemDefault).toBe(true);
    expect(byId.get(tmpl)?.customized).toBe(false);
    expect(byId.get(own)?.customized).toBe(true);
    expect(byId.get(own)?.permissionKeys).toContain("role.read");

    // A different org sees the template but NOT this org's custom role (RLS + the org predicate).
    const other = (await admin.query(
      "INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'RS2','RS2') RETURNING id",
      [`rs2-${Date.now()}`],
    )).rows[0].id as string;
    const otherRoleIds = (await store.listForOrg(other)).map((r) => r.roleId);
    expect(otherRoleIds).toContain(tmpl);
    expect(otherRoleIds).not.toContain(own);

    await handle5.close();
  });

  it("M2 members: the live repository lists the roster with isAdmin from the M3 org_admin reader", async () => {
    const { createDbClient: mkDb6 } = await import("@wardenx/db");
    const { createDbAdminMembershipReader } = await import("@wardenx/auth");
    const { createDbMembershipRepository } = await import("../src/modules/02-identity/membership-repository");
    const handle6 = mkDb6({ connectionString: DB_URL as string });
    // Run the store under the RLS-enforced wardenx_app role — this is the real test (the live lane
    // connects as a superuser, which would bypass RLS and never exercise org-scoping).
    const tdb = asTenantRole(handle6.db) as never;
    const repo = createDbMembershipRepository(tdb, createDbAdminMembershipReader(tdb));

    const adminEmail = `ma${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
    const rnEmail = `mr${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
    const pw = `Wx9$${Math.random().toString(36).slice(2)}${Date.now()}Qz!`;
    await auth.api.signUpEmail({ body: { email: adminEmail, password: pw, name: "Admin" } });
    await auth.api.signUpEmail({ body: { email: rnEmail, password: pw, name: "Nurse" } });
    const adminUser = (await admin.query('SELECT id FROM "user" WHERE email=$1', [adminEmail])).rows[0].id as string;
    const rnUser = (await admin.query('SELECT id FROM "user" WHERE email=$1', [rnEmail])).rows[0].id as string;

    const org = (await admin.query(
      "INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'MM','Maple Org') RETURNING id",
      [`mm-${Date.now()}`],
    )).rows[0].id as string;
    const adminMem = (await admin.query("INSERT INTO membership (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id", [adminUser, org])).rows[0].id as string;
    await admin.query("INSERT INTO membership (user_id,organization_id,status) VALUES ($1,$2,'active')", [rnUser, org]);
    // Grant the org_admin role to the first membership → it must read back as isAdmin.
    const adminRole = (await admin.query(
      "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'org_admin','Org Admin','admin_executive',true) RETURNING id",
      [org],
    )).rows[0].id as string;
    await admin.query("INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)", [org, adminMem, adminRole]);

    const { runWithRequestContext } = await import("@wardenx/tenancy");
    const inOrg = <T>(fn: () => Promise<T>) =>
      runWithRequestContext({ organizationId: org, userId: adminUser } as never, fn);

    const roster = await repo.listForOrg(org);
    expect(roster).toHaveLength(2);
    expect(roster.every((m) => m.organizationName === "Maple Org")).toBe(true);
    expect(roster.find((m) => m.membershipId === adminMem)?.isAdmin).toBe(true);
    expect(roster.find((m) => m.userId === rnUser)?.isAdmin).toBe(false);
    expect(await repo.activeAdminCount(org)).toBe(1);

    // ★ RLS proof (the point of running as wardenx_app): the by-id read is org-scoped. Under the
    // member's own org it resolves; under a DIFFERENT org's ambient context RLS denies it → null.
    // With the pre-#47 bare `WHERE id=…` read this would have LEAKED the row across tenants.
    const otherOrg = (await admin.query(
      "INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'MM2','Other Org') RETURNING id",
      [`mm2-${Date.now()}`],
    )).rows[0].id as string;
    expect((await inOrg(() => repo.get(adminMem)))?.membershipId).toBe(adminMem);
    const crossOrg = <T>(fn: () => Promise<T>) =>
      runWithRequestContext({ organizationId: otherOrg, userId: adminUser } as never, fn);
    expect(await crossOrg(() => repo.get(adminMem))).toBeNull();

    // A status change persists and the roster reflects it (get()/setStatus() resolve by id under the
    // ambient request org, so they're wrapped here).
    await inOrg(() => repo.setStatus(adminMem, "suspended"));
    expect((await inOrg(() => repo.get(adminMem)))?.status).toBe("suspended");
    expect(await repo.activeAdminCount(org)).toBe(0); // suspended admin no longer counts

    await handle6.close();
  });

  it("M3 MembershipRoleStore: assign/list/revoke role grants, RLS-scoped (wardenx_app)", async () => {
    const { createDbClient: mkDb7 } = await import("@wardenx/db");
    const { createDbMembershipRoleStore } = await import("../src/modules/03-authorization/membership-role-store");
    const { runWithRequestContext } = await import("@wardenx/tenancy");
    const handle7 = mkDb7({ connectionString: DB_URL as string });
    const store = createDbMembershipRoleStore(asTenantRole(handle7.db) as never);

    const email = `gr${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
    await auth.api.signUpEmail({ body: { email, password: `Wx9$${Math.random().toString(36).slice(2)}${Date.now()}Qz!`, name: "Grantee" } });
    const userId = (await admin.query('SELECT id FROM "user" WHERE email=$1', [email])).rows[0].id as string;
    const org = (await admin.query("INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'GR','GR') RETURNING id", [`gr-${Date.now()}`])).rows[0].id as string;
    const otherOrg = (await admin.query("INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'GR2','GR2') RETURNING id", [`gr2-${Date.now()}`])).rows[0].id as string;
    const membership = (await admin.query("INSERT INTO membership (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id", [userId, org])).rows[0].id as string;
    const role = (await admin.query("INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'gr-rn','RN','clinical_staff',true) RETURNING id", [org])).rows[0].id as string;

    const inOrg = <T>(fn: () => Promise<T>) => runWithRequestContext({ organizationId: org, userId } as never, fn);
    const inOther = <T>(fn: () => Promise<T>) => runWithRequestContext({ organizationId: otherOrg, userId } as never, fn);

    // assign carries the org explicitly; the grant reads back under the org's ambient context.
    const grant = await store.assign({ organizationId: org, membershipId: membership, roleId: role, roleKey: "gr-rn", grantedByUserId: userId });
    expect(grant.roleKey).toBe("gr-rn");
    expect((await inOrg(() => store.listForMembership(membership))).map((g) => g.roleId)).toEqual([role]);

    // RLS: the grant is NOT visible under a different org's ambient context.
    expect(await inOther(() => store.listForMembership(membership))).toEqual([]);

    // revoke removes it (and reports whether it existed).
    expect(await inOrg(() => store.revoke(membership, role))).toBe(true);
    expect(await inOrg(() => store.listForMembership(membership))).toEqual([]);
    expect(await inOrg(() => store.revoke(membership, role))).toBe(false); // already gone

    await handle7.close();
  });

  it("M4 Audit: the live AuditQuery searches/filters the org's audit_event log, RLS-scoped (wardenx_app)", async () => {
    const { createDbClient: mkDb8 } = await import("@wardenx/db");
    const { createDbAuditQuery } = await import("@wardenx/audit");
    const handle8 = mkDb8({ connectionString: DB_URL as string });
    const query = createDbAuditQuery(asTenantRole(handle8.db) as never);

    const org = (await admin.query("INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'AU','AU') RETURNING id", [`au-${Date.now()}`])).rows[0].id as string;
    const otherOrg = (await admin.query("INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'AU2','AU2') RETURNING id", [`au2-${Date.now()}`])).rows[0].id as string;
    const patientId = crypto.randomUUID();
    const ins = (orgId: string, eventType: string, resourceKind: string, resourceId: string | null, context: object) =>
      admin.query(
        "INSERT INTO audit_event (organization_id,actor_kind,event_type,resource_kind,resource_id,correlation_id,outcome,context) VALUES ($1,'user',$2,$3,$4,$5,'success',$6::jsonb)",
        [orgId, eventType, resourceKind, resourceId, `c-${Math.random().toString(36).slice(2)}`, JSON.stringify(context)],
      );
    await ins(org, "patient.viewed", "patient", patientId, { patientId, fields: ["name"] }); // access + touch
    await ins(org, "role.updated", "role", null, {}); // neither access nor patient-touch
    await ins(org, "patient.viewed", "patient", crypto.randomUUID(), {}); // access, other patient
    await ins(otherOrg, "patient.viewed", "patient", patientId, { patientId }); // different org — must NOT leak

    // searchEvents: the org's events (RLS hides otherOrg's), newest-first. The org-creation audit
    // trigger also writes a row for this org, so assert containment + org-scoping, not an exact count.
    const all = await query.searchEvents(org, {});
    expect(all.items.length).toBeGreaterThanOrEqual(3);
    expect(all.items.every((e) => e.organizationId === org)).toBe(true);
    const types = all.items.map((e) => e.eventType);
    expect(types).toContain("role.updated");
    expect(types.filter((t) => t === "patient.viewed")).toHaveLength(2);

    // patientId filter → only events touching that patient.
    const touching = await query.searchEvents(org, { patientId });
    expect(touching.items.map((e) => e.eventType)).toEqual(["patient.viewed"]);

    // patientAccess → access events touching the patient (the role.updated is excluded).
    const access = await query.patientAccess(org, patientId, {});
    expect(access.items).toHaveLength(1);
    expect(access.items[0]?.fields).toEqual(["name"]);

    // RLS: another org sees none of this org's events.
    expect((await query.searchEvents(otherOrg, {})).items.every((e) => e.organizationId === otherOrg)).toBe(true);
    expect((await query.searchEvents(otherOrg, { patientId })).items).toHaveLength(1); // its own row only

    await handle8.close();
  });

  it("M5 Patient census: the live read service lists/filters/paginates patients, RLS-scoped (wardenx_app)", async () => {
    const { createDbClient: mkDb9 } = await import("@wardenx/db");
    const { createDbPatientRouteService } = await import("../src/modules/05-patient/index");
    const handle9 = mkDb9({ connectionString: DB_URL as string });
    const svc = createDbPatientRouteService(asTenantRole(handle9.db) as never);

    const org = (await admin.query("INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'PT','PT') RETURNING id", [`pt-${Date.now()}`])).rows[0].id as string;
    const otherOrg = (await admin.query("INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'PT2','PT2') RETURNING id", [`pt2-${Date.now()}`])).rows[0].id as string;
    const addP = (orgId: string, mrn: string, first: string, last: string, status: string) =>
      admin.query(
        "INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status) VALUES ($1,$2,$3,$4,'1990-01-01','M',$5) RETURNING id",
        [orgId, mrn, first, last, status],
      );
    const p3 = (await addP(org, "MRN-S", "Sam", "Smith", "active")).rows[0].id as string;
    await addP(org, "MRN-A", "Al", "Adams", "active");
    await addP(org, "MRN-B", "Bo", "Brown", "prospective");
    await addP(otherOrg, "MRN-O", "Ot", "Other", "active");

    // list: org's patients, ordered by (lastName, firstName, id); RLS hides otherOrg.
    const all = await svc.list(org, {});
    expect(all.items.map((p) => p.lastName)).toEqual(["Adams", "Brown", "Smith"]);
    expect(all.items.every((p) => p.organizationId === org)).toBe(true);

    // q substring (name or MRN); status filter.
    expect((await svc.list(org, { q: "smit" })).items.map((p) => p.mrn)).toEqual(["MRN-S"]);
    expect((await svc.list(org, { status: "active" })).items.map((p) => p.lastName)).toEqual(["Adams", "Smith"]);

    // cursor pagination.
    const page1 = await svc.list(org, { limit: 2 });
    expect(page1.items.map((p) => p.lastName)).toEqual(["Adams", "Brown"]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await svc.list(org, { limit: 2, cursor: page1.nextCursor as string });
    expect(page2.items.map((p) => p.lastName)).toEqual(["Smith"]);
    expect(page2.nextCursor).toBeNull();

    // getPatient: in-org resolves; a different org's scope returns null (RLS, no leak).
    expect((await svc.getPatient(org, p3))?.mrn).toBe("MRN-S");
    expect(await svc.getPatient(otherOrg, p3)).toBeNull();

    await handle9.close();
  });

  it("M5 admission: admit inserts a patient (appears in census) and §7.1 MBI dedup hard-blocks (wardenx_app)", async () => {
    const { createDbClient: mkDb10 } = await import("@wardenx/db");
    const { createDbPatientRouteService } = await import("../src/modules/05-patient/index");
    const handle10 = mkDb10({ connectionString: DB_URL as string });
    const svc = createDbPatientRouteService(asTenantRole(handle10.db) as never);
    const org = (await admin.query("INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'AD','AD') RETURNING id", [`ad-${Date.now()}`])).rows[0].id as string;

    // admit → created; the new patient shows up in the real census.
    const a = await svc.admit(org, { lastName: "Nguyen", firstName: "Mai", dob: "1985-03-04", administrativeSex: "F", mbi: "1EG4TE5MK73" }, "u");
    expect(a.outcome).toBe("created");
    const census = await svc.list(org, {});
    expect(census.items.map((p) => p.lastName)).toContain("Nguyen");

    // §7.1: a second admit with the SAME MBI hard-blocks on the deterministic mbi rule (→ 409).
    const dup = await svc.admit(org, { lastName: "Different", firstName: "Name", dob: "1990-09-09", administrativeSex: "M", mbi: "1EG4TE5MK73" }, "u");
    expect(dup.outcome).toBe("hard_block");
    if (dup.outcome === "hard_block") {
      expect(dup.matchedOn).toBe("mbi");
      expect(dup.existingPatientId).toBe((a as { patientId: string }).patientId);
    }

    // bypassMatchReview skips the matcher → always creates.
    const b = await svc.admit(org, { lastName: "Solo", firstName: "Han", dob: "1977-07-07", administrativeSex: "M", bypassMatchReview: true }, "u");
    expect(b.outcome).toBe("created");
    expect((await svc.list(org, {})).items.map((p) => p.lastName).sort()).toEqual(["Nguyen", "Solo"]);

    await handle10.close();
  });
});
