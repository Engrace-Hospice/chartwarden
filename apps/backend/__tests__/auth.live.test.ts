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
function asTenantRole<T extends { transaction: (...a: any[]) => any }>(
  db: T,
  role = "wardenx_app",
): T {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "transaction") {
        return (fn: any) =>
          (target.transaction as (f: unknown) => unknown)(
            async (tx: { execute: (q: unknown) => Promise<unknown> }) => {
              await tx.execute(sql`SET LOCAL ROLE ${sql.raw(role)}`);
              return fn(tx);
            },
          );
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "mdm_canonical_writer",
];

describe.skipIf(!DB_URL)(
  "Better Auth live — email+password over the reconciled schema (AUTH-T06)",
  () => {
    let admin: Client;
    let close: () => Promise<void>;
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
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort()) {
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
      // 120s, matching every *-rls-isolation.live.test.ts. This hook REPLAYS ALL 119 MIGRATIONS, and
      // it was the only live suite relying on Vitest's 10s default — so it sat just under the limit
      // and failed as "Hook timed out in 10000ms" (11 tests SKIPPED, which reads like a config problem
      // rather than a slow hook) whenever a runner was cold or the corpus grew. Migrations 0117-0119
      // grew it: 0118 alone walks the catalog and issues ~800 ALTER TABLE statements. A replay-the-
      // world hook must not be governed by the default meant for a unit test.
    }, 120_000);

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
      await authR.api.requestPasswordReset({
        body: { email, redirectTo: "http://localhost:3000/reset-password" },
      });
      expect(captured).not.toBeNull();
      const token = (captured as unknown as { token: string }).token;
      expect(token.length).toBeGreaterThan(0);

      // Step 2 — consume the token to set the new password.
      await authR.api.resetPassword({ body: { newPassword: newPw, token } });

      // The credential rotated: the new password signs in; the old one no longer does.
      const ok = await authR.api.signInEmail({
        body: { email, password: newPw },
        asResponse: true,
      });
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
      await authT.api.requestPasswordReset({
        body: { email, redirectTo: "http://localhost:3000/reset-password" },
      });
      expect(deliveredTo).toBe(email);

      await handle2.close();
    });

    it("2FA enrollment stores the TOTP secret ENCRYPTED at rest (ADR-0034)", async () => {
      const email = `tf${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
      const password = `Wx9$${Math.random().toString(36).slice(2)}${Date.now()}Qz!`;
      // sign up (autoSignIn) → grab the session cookie from the response
      const signUp = (await auth.api.signUpEmail({
        body: { email, password, name: "TF User" },
        asResponse: true,
      })) as Response;
      const cookie = (signUp.headers.get("set-cookie") ?? "").split(";")[0];
      // enrol TOTP (the twoFactor plugin writes the secret via the encrypting adapter decorator)
      await auth.api.enableTwoFactor({ body: { password }, headers: { cookie } });

      const u = await admin.query('SELECT id FROM "user" WHERE email = $1', [email]);
      const tf = await admin.query("SELECT secret_encrypted FROM two_factor WHERE user_id = $1", [
        u.rows[0].id,
      ]);
      expect(tf.rowCount).toBeGreaterThanOrEqual(1);
      const stored = String(tf.rows[0].secret_encrypted);
      expect(isSealed(stored)).toBe(true); // our AES-256-GCM token — NOT the plaintext base32 TOTP secret
    });

    it("M3 RBAC: the live effective-permission store resolves grants from membership ⋈ role ⋈ role_permission", async () => {
      const { createDbClient: mkDb3 } = await import("@wardenx/db");
      const { createDbEffectivePermissionStore, resolveEffectivePermissions } = await import(
        "@wardenx/auth"
      );
      const handle3 = mkDb3({ connectionString: DB_URL as string });
      const store = createDbEffectivePermissionStore(handle3.db as never);

      // Seed the full §2.2 grant graph as superuser (RLS bypassed for seeding).
      const email = `rb${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
      const password = `Wx9$${Math.random().toString(36).slice(2)}${Date.now()}Qz!`;
      await auth.api.signUpEmail({ body: { email, password, name: "RBAC User" } });
      const userId = (await admin.query('SELECT id FROM "user" WHERE email = $1', [email])).rows[0]
        .id as string;

      const org = (
        await admin.query(
          "INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'RB','RB') RETURNING id",
          [`rb-${Date.now()}`],
        )
      ).rows[0].id as string;
      const membership = (
        await admin.query(
          "INSERT INTO membership (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id",
          [userId, org],
        )
      ).rows[0].id as string;
      await admin.query(
        "INSERT INTO permission (key,resource,action,category) VALUES ('patient.read','patient','read','clinical') ON CONFLICT (key) DO NOTHING",
      );

      // An ACTIVE role grant (permanent) and a SECOND grant whose window already closed (expired).
      const liveRole = (
        await admin.query(
          "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'rb-nurse','Nurse','clinical_staff',true) RETURNING id",
          [org],
        )
      ).rows[0].id as string;
      const staleRole = (
        await admin.query(
          "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'rb-locum','Locum','clinical_staff',true) RETURNING id",
          [org],
        )
      ).rows[0].id as string;
      await admin.query(
        "INSERT INTO role_permission (organization_id,role_id,permission_key) VALUES ($1,$2,'patient.read')",
        [org, liveRole],
      );
      await admin.query(
        "INSERT INTO role_permission (organization_id,role_id,permission_key) VALUES ($1,$2,'patient.read')",
        [org, staleRole],
      );
      await admin.query(
        "INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)",
        [org, membership, liveRole],
      );
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
      const userId = (await admin.query('SELECT id FROM "user" WHERE email = $1', [email])).rows[0]
        .id as string;
      const org = (
        await admin.query(
          "INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'EN','EN') RETURNING id",
          [`en-${Date.now()}`],
        )
      ).rows[0].id as string;
      // TASK-013/ARCH-008 — the PE/location scope the live reader must also assemble.
      const pe = crypto.randomUUID();
      const membership = (
        await admin.query(
          "INSERT INTO membership (user_id,organization_id,status,default_provider_entity_id,default_location_ids) VALUES ($1,$2,'active',$3,$4) RETURNING id",
          [userId, org, pe, JSON.stringify(["loc-a", "loc-b"])],
        )
      ).rows[0].id as string;
      const liveRole = (
        await admin.query(
          "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'en-rn','RN','clinical_staff',true) RETURNING id",
          [org],
        )
      ).rows[0].id as string;
      const staleRole = (
        await admin.query(
          "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'en-temp','Temp','clinical_staff',true) RETURNING id",
          [org],
        )
      ).rows[0].id as string;
      await admin.query(
        "INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)",
        [org, membership, liveRole],
      );
      await admin.query(
        "INSERT INTO membership_role (organization_id,membership_id,role_id,expires_at) VALUES ($1,$2,$3, now() - interval '1 hour')",
        [org, membership, staleRole],
      );

      const enrichment = await reader.read({ orgId: org }, userId);
      expect(enrichment?.membershipId).toBe(membership);
      // Only the current (non-expired) role is reported; the closed window is dropped (§7.2).
      expect(enrichment?.roles).toEqual(["en-rn"]);
      // TASK-013/ARCH-008 — the PE/location scope `authenticate.ts` stamps onto request.context.
      expect(enrichment?.providerEntityIds).toEqual([pe]);
      expect(enrichment?.locationIds).toEqual(["loc-a", "loc-b"]);

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

      const org = (
        await admin.query(
          "INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'RS','RS') RETURNING id",
          [`rs-${Date.now()}`],
        )
      ).rows[0].id as string;
      await admin.query(
        "INSERT INTO permission (key,resource,action,category) VALUES ('role.read','role','read','admin') ON CONFLICT (key) DO NOTHING",
      );
      // A platform template (org_id NULL, system_default) and this org's own custom role.
      const tmpl = (
        await admin.query(
          "INSERT INTO role (organization_id,key,name,category,system_default,enabled) VALUES (NULL,$1,'Nurse Template','clinical_staff',true,true) RETURNING id",
          [`rs-tmpl-${Date.now()}`],
        )
      ).rows[0].id as string;
      const own = (
        await admin.query(
          "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'rs-custom','Custom RN','clinical_staff',true) RETURNING id",
          [org],
        )
      ).rows[0].id as string;
      await admin.query(
        "INSERT INTO role_permission (organization_id,role_id,permission_key) VALUES ($1,$2,'role.read')",
        [org, own],
      );

      const roles = await store.listForOrg(org);
      const byId = new Map(roles.map((r) => [r.roleId, r]));
      // Template (org_id NULL) visible under wardenx_app thanks to 0025; org row visible + customized.
      expect(byId.has(tmpl)).toBe(true); // would be FALSE under the pre-0025 org-only read policy
      expect(byId.get(tmpl)?.systemDefault).toBe(true);
      expect(byId.get(tmpl)?.customized).toBe(false);
      expect(byId.get(own)?.customized).toBe(true);
      expect(byId.get(own)?.permissionKeys).toContain("role.read");

      // A different org sees the template but NOT this org's custom role (RLS + the org predicate).
      const other = (
        await admin.query(
          "INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'RS2','RS2') RETURNING id",
          [`rs2-${Date.now()}`],
        )
      ).rows[0].id as string;
      const otherRoleIds = (await store.listForOrg(other)).map((r) => r.roleId);
      expect(otherRoleIds).toContain(tmpl);
      expect(otherRoleIds).not.toContain(own);

      await handle5.close();
    });

    it("M2 members: the live repository lists the roster with isAdmin from the M3 org_admin reader", async () => {
      const { createDbClient: mkDb6 } = await import("@wardenx/db");
      const { createDbAdminMembershipReader } = await import("@wardenx/auth");
      const { createDbMembershipRepository } = await import(
        "../src/modules/02-identity/membership-repository"
      );
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
      const adminUser = (await admin.query('SELECT id FROM "user" WHERE email=$1', [adminEmail]))
        .rows[0].id as string;
      const rnUser = (await admin.query('SELECT id FROM "user" WHERE email=$1', [rnEmail])).rows[0]
        .id as string;

      const org = (
        await admin.query(
          "INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'MM','Maple Org') RETURNING id",
          [`mm-${Date.now()}`],
        )
      ).rows[0].id as string;
      const adminMem = (
        await admin.query(
          "INSERT INTO membership (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id",
          [adminUser, org],
        )
      ).rows[0].id as string;
      await admin.query(
        "INSERT INTO membership (user_id,organization_id,status) VALUES ($1,$2,'active')",
        [rnUser, org],
      );
      // Grant the org_admin role to the first membership → it must read back as isAdmin.
      const adminRole = (
        await admin.query(
          "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'org_admin','Org Admin','admin_executive',true) RETURNING id",
          [org],
        )
      ).rows[0].id as string;
      await admin.query(
        "INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)",
        [org, adminMem, adminRole],
      );

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
      const otherOrg = (
        await admin.query(
          "INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'MM2','Other Org') RETURNING id",
          [`mm2-${Date.now()}`],
        )
      ).rows[0].id as string;
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
      const { createDbMembershipRoleStore } = await import(
        "../src/modules/03-authorization/membership-role-store"
      );
      const { runWithRequestContext } = await import("@wardenx/tenancy");
      const handle7 = mkDb7({ connectionString: DB_URL as string });
      const store = createDbMembershipRoleStore(asTenantRole(handle7.db) as never);

      const email = `gr${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
      await auth.api.signUpEmail({
        body: {
          email,
          password: `Wx9$${Math.random().toString(36).slice(2)}${Date.now()}Qz!`,
          name: "Grantee",
        },
      });
      const userId = (await admin.query('SELECT id FROM "user" WHERE email=$1', [email])).rows[0]
        .id as string;
      const org = (
        await admin.query(
          "INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'GR','GR') RETURNING id",
          [`gr-${Date.now()}`],
        )
      ).rows[0].id as string;
      const otherOrg = (
        await admin.query(
          "INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'GR2','GR2') RETURNING id",
          [`gr2-${Date.now()}`],
        )
      ).rows[0].id as string;
      const membership = (
        await admin.query(
          "INSERT INTO membership (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id",
          [userId, org],
        )
      ).rows[0].id as string;
      const role = (
        await admin.query(
          "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'gr-rn','RN','clinical_staff',true) RETURNING id",
          [org],
        )
      ).rows[0].id as string;

      const inOrg = <T>(fn: () => Promise<T>) =>
        runWithRequestContext({ organizationId: org, userId } as never, fn);
      const inOther = <T>(fn: () => Promise<T>) =>
        runWithRequestContext({ organizationId: otherOrg, userId } as never, fn);

      // assign carries the org explicitly; the grant reads back under the org's ambient context.
      const grant = await store.assign({
        organizationId: org,
        membershipId: membership,
        roleId: role,
        roleKey: "gr-rn",
        grantedByUserId: userId,
      });
      expect(grant.roleKey).toBe("gr-rn");
      expect((await inOrg(() => store.listForMembership(membership))).map((g) => g.roleId)).toEqual(
        [role],
      );

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

      const org = (
        await admin.query(
          "INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'AU','AU') RETURNING id",
          [`au-${Date.now()}`],
        )
      ).rows[0].id as string;
      const otherOrg = (
        await admin.query(
          "INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'AU2','AU2') RETURNING id",
          [`au2-${Date.now()}`],
        )
      ).rows[0].id as string;
      const patientId = crypto.randomUUID();
      const ins = (
        orgId: string,
        eventType: string,
        resourceKind: string,
        resourceId: string | null,
        context: object,
      ) =>
        admin.query(
          "INSERT INTO audit_event (organization_id,actor_kind,event_type,resource_kind,resource_id,correlation_id,outcome,context) VALUES ($1,'user',$2,$3,$4,$5,'success',$6::jsonb)",
          [
            orgId,
            eventType,
            resourceKind,
            resourceId,
            `c-${Math.random().toString(36).slice(2)}`,
            JSON.stringify(context),
          ],
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
      expect(
        (await query.searchEvents(otherOrg, {})).items.every((e) => e.organizationId === otherOrg),
      ).toBe(true);
      expect((await query.searchEvents(otherOrg, { patientId })).items).toHaveLength(1); // its own row only

      await handle8.close();
    });

    it("M5 Patient census: the live read service lists/filters/paginates patients, RLS-scoped (wardenx_app)", async () => {
      const { createDbClient: mkDb9 } = await import("@wardenx/db");
      const { createDbPatientRouteService } = await import("../src/modules/05-patient/index");
      const handle9 = mkDb9({ connectionString: DB_URL as string });
      const svc = createDbPatientRouteService(asTenantRole(handle9.db) as never);

      const org = (
        await admin.query(
          "INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'PT','PT') RETURNING id",
          [`pt-${Date.now()}`],
        )
      ).rows[0].id as string;
      const otherOrg = (
        await admin.query(
          "INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'PT2','PT2') RETURNING id",
          [`pt2-${Date.now()}`],
        )
      ).rows[0].id as string;
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
      expect((await svc.list(org, { status: "active" })).items.map((p) => p.lastName)).toEqual([
        "Adams",
        "Smith",
      ]);

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

    it("TEST-003: a real HTTP sign-in cookie flows through the REAL authenticate hook (not the x-test-user shim) into a mounted route", async () => {
      // Every inject-suite in this repo (orders-routes.test.ts and the whole TASK-050A corpus) proves
      // routing/RBAC/ABAC wiring against a `headerAuth` shim that populates request.context directly
      // from x-test-user/x-test-org headers — a deliberate, explicit stand-in for the real
      // session→context binding (createSessionAuthenticate → getIdentitySession → SessionContextResolver),
      // which until now was NEVER exercised end-to-end over HTTP anywhere in the suite (only via direct,
      // non-HTTP calls to the resolver's dependencies elsewhere in this file). This test wires the exact
      // production composition (mountIdentityRoutes, registerIdentityAuth, createSessionAuthenticate,
      // createSessionContextResolver over createDbSessionContextStore) and drives it with a REAL
      // Better-Auth session cookie obtained via a real HTTP sign-in — no shim, no stub session.
      const { createDbClient: mkDb11 } = await import("@wardenx/db");
      const {
        getIdentitySession,
        registerIdentityAuth,
        createDbSessionContextStore,
        createDbActorEnrichmentReader,
        createSessionContextResolver,
        createDbAdminMembershipReader,
        registerDbEffectivePermissionResolver,
        resetAuthorizationContract,
        resetRbacEngine,
      } = await import("@wardenx/auth");
      const { createSessionAuthenticate, buildServer } = await import("../src/bootstrap/index");
      const { mountIdentityRoutes } = await import("../src/modules/02-identity/index");
      const { createDbPatientRouteService, registerPatientRoutes } = await import(
        "../src/modules/05-patient/index"
      );

      resetAuthorizationContract();
      resetRbacEngine();

      const handle11 = mkDb11({ connectionString: DB_URL as string });
      registerDbEffectivePermissionResolver(handle11.db as never);

      // Seed a real user, org, membership, role, and the patient.read grant (superuser — RLS bypassed
      // for seeding only, mirrors every other seeding block in this file).
      const email = `sess${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
      const password = `Wx9$${Math.random().toString(36).slice(2)}${Date.now()}Qz!`;
      await auth.api.signUpEmail({ body: { email, password, name: "Real Session User" } });
      const userId = (await admin.query('SELECT id FROM "user" WHERE email = $1', [email])).rows[0]
        .id as string;
      const org = (
        await admin.query(
          "INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'SS','SS') RETURNING id",
          [`ss-${Date.now()}`],
        )
      ).rows[0].id as string;
      const membership = (
        await admin.query(
          "INSERT INTO membership (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id",
          [userId, org],
        )
      ).rows[0].id as string;
      await admin.query(
        "INSERT INTO permission (key,resource,action,category) VALUES ('patient.read','patient','read','clinical') ON CONFLICT (key) DO NOTHING",
      );
      const role = (
        await admin.query(
          "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'ss-nurse','Nurse','clinical_staff',true) RETURNING id",
          [org],
        )
      ).rows[0].id as string;
      await admin.query(
        "INSERT INTO role_permission (organization_id,role_id,permission_key) VALUES ($1,$2,'patient.read')",
        [org, role],
      );
      await admin.query(
        "INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)",
        [org, membership, role],
      );
      // One patient so the census route has something to prove org-scoping over.
      await admin.query(
        "INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status) VALUES ($1,'MRN-SS','Sess','Ion','1990-01-01','M','active')",
        [org],
      );

      // The exact production wiring (apps/backend/src/index.ts): a live SessionContextResolver over the
      // live SessionContextStore/ActorEnrichmentReader, and the real authenticate hook reading the
      // session snapshot via getIdentitySession (Better Auth), not a header shim.
      const resolver = createSessionContextResolver(
        createDbSessionContextStore(
          handle11.db as never,
          createDbActorEnrichmentReader(handle11.db as never),
        ),
      );
      const authenticate = createSessionAuthenticate({
        getSnapshot: (request) => getIdentitySession(auth, request.raw.headers),
        getResolver: () => resolver,
      });
      const app = buildServer({ db: handle11.db as never, authenticate });
      registerIdentityAuth(app, auth); // mounts /api/auth/* (Better Auth's real HTTP handler)
      mountIdentityRoutes(
        app,
        handle11.db as never,
        createDbAdminMembershipReader(handle11.db as never),
      );
      registerPatientRoutes(app, {
        service: createDbPatientRouteService(asTenantRole(handle11.db) as never),
      });

      // 1. Real HTTP sign-in (not auth.api.signInEmail — the actual /api/auth/sign-in/email endpoint,
      //    via registerIdentityAuth's real Better-Auth-handler bridge) → a real Set-Cookie session token.
      const signIn = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        payload: { email, password },
      });
      expect(signIn.statusCode).toBe(200);
      expect(signIn.cookies.length).toBeGreaterThan(0);
      const cookieHeader = signIn.cookies.map((c) => `${c.name}=${c.value}`).join("; ");

      // 2. Before org selection: a pre-org session reaches the authenticate hook (userId populated) but
      //    has no organizationId yet — /auth/context reports it, and the org-scoped patient route 401s:
      //    `requirePermission` throws UnauthorizedError (not Forbidden) when `context.organizationId` is
      //    absent (require-role.ts) — a pre-org session is treated as not-yet-authenticated for
      //    permission purposes, distinct from "authenticated, org-bound, lacks the grant" (403, proven
      //    below). The x-test-user shim used everywhere else in this repo cannot express the pre-org
      //    state at all (it sets userId/organizationId atomically from the same headers).
      const preOrg = await app.inject({
        method: "GET",
        url: "/api/v1/auth/context",
        headers: { cookie: cookieHeader },
      });
      expect(preOrg.statusCode).toBe(200);
      expect(preOrg.json().userId).toBe(userId);
      expect(preOrg.json().organizationId).toBeNull();
      // The pre-org picker is a deliberately narrow RLS path: it may reveal this user's own
      // membership + organization name, but no arbitrary tenant data. This is the exact query a
      // newly signed-in browser (and the demo seed) needs before it can bind an organization.
      const memberships = await app.inject({
        method: "GET",
        url: "/api/v1/auth/memberships",
        headers: { cookie: cookieHeader },
      });
      expect(memberships.statusCode).toBe(200);
      expect(memberships.json().memberships).toEqual(
        expect.arrayContaining([expect.objectContaining({ organizationId: org })]),
      );
      // Browser-cookie mutations use the double-submit CSRF guard. The CSRF onRequest hook minted
      // the readable token on the HTTP sign-in response; the context GET is a fallback in case a
      // future auth adapter does not retain that response cookie.
      const csrfToken =
        signIn.cookies.find((cookie) => cookie.name === "wardenx_csrf")?.value ??
        preOrg.cookies.find((cookie) => cookie.name === "wardenx_csrf")?.value;
      expect(csrfToken).toBeTruthy();
      if (!csrfToken) throw new Error("the browser-auth flow did not mint a CSRF cookie");
      const authenticatedCookieHeader = cookieHeader.includes("wardenx_csrf=")
        ? cookieHeader
        : `${cookieHeader}; wardenx_csrf=${csrfToken}`;
      const preOrgCensus = await app.inject({
        method: "GET",
        url: "/api/v1/patients",
        headers: { cookie: cookieHeader },
      });
      expect(preOrgCensus.statusCode).toBe(401); // no org bound yet → requirePermission's UnauthorizedError

      // 3. select-organization (the real M2 route, real SessionWriter) binds the Better Auth session row
      //    — the exact write the authenticate hook's getIdentitySession reads back on every subsequent
      //    request via the SAME cookie (no new session, no re-login).
      const select = await app.inject({
        method: "POST",
        url: "/api/v1/auth/select-organization",
        headers: { cookie: authenticatedCookieHeader, "x-csrf-token": csrfToken },
        payload: { organizationId: org },
      });
      expect(select.statusCode).toBe(200);
      expect(select.json().activeOrganizationId).toBe(org);

      // 4. The SAME cookie now resolves the real, DB-backed org+role+permission chain end-to-end over
      //    HTTP: /auth/context reports the real membershipId/roles, and the patient census route — real
      //    RBAC (`requirePermission("patient.read")`) resolved via the LIVE effective-permission store,
      //    real RLS-scoped Drizzle read — returns exactly this org's one seeded patient.
      const postOrg = await app.inject({
        method: "GET",
        url: "/api/v1/auth/context",
        headers: { cookie: cookieHeader },
      });
      expect(postOrg.statusCode).toBe(200);
      expect(postOrg.json().organizationId).toBe(org);
      expect(postOrg.json().membershipId).toBe(membership);
      expect(postOrg.json().roles).toEqual(["ss-nurse"]);

      const census = await app.inject({
        method: "GET",
        url: "/api/v1/patients",
        headers: { cookie: cookieHeader },
      });
      expect(census.statusCode).toBe(200);
      expect(census.json().items).toHaveLength(1);
      expect(census.json().items[0].mrn).toBe("MRN-SS");

      // 5. A request with NO cookie at all stays anonymous — org-scoped routes still 403/401, proving
      //    the real hook does not leak the previous request's resolved context across requests.
      const anon = await app.inject({ method: "GET", url: "/api/v1/patients" });
      expect(anon.statusCode).toBe(401);

      resetAuthorizationContract();
      resetRbacEngine();
      await handle11.close();
    });

    it("M5 admission: admit inserts a patient (appears in census) and §7.1 MBI dedup hard-blocks (wardenx_app)", async () => {
      const { createDbClient: mkDb10 } = await import("@wardenx/db");
      const { createDbPatientRouteService } = await import("../src/modules/05-patient/index");
      const handle10 = mkDb10({ connectionString: DB_URL as string });
      const svc = createDbPatientRouteService(asTenantRole(handle10.db) as never);
      const org = (
        await admin.query(
          "INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,'AD','AD') RETURNING id",
          [`ad-${Date.now()}`],
        )
      ).rows[0].id as string;
      // The patient audit trigger attributes app.user_id (set from the admit actor) — must be a real
      // user uuid (audit_event.actor_user_id FKs users.id), as the authenticated route would pass.
      const actorEmail = `adm${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
      await auth.api.signUpEmail({
        body: {
          email: actorEmail,
          password: `Wx9$${Math.random().toString(36).slice(2)}${Date.now()}Qz!`,
          name: "Admitter",
        },
      });
      const actor = (await admin.query('SELECT id FROM "user" WHERE email=$1', [actorEmail]))
        .rows[0].id as string;

      // admit → created; the new patient shows up in the real census.
      const a = await svc.admit(
        org,
        {
          lastName: "Nguyen",
          firstName: "Mai",
          dob: "1985-03-04",
          administrativeSex: "F",
          mbi: "1EG4TE5MK73",
        },
        actor,
      );
      expect(a.outcome).toBe("created");
      const census = await svc.list(org, {});
      expect(census.items.map((p) => p.lastName)).toContain("Nguyen");

      // §7.1: a second admit with the SAME MBI hard-blocks on the deterministic mbi rule (→ 409).
      const dup = await svc.admit(
        org,
        {
          lastName: "Different",
          firstName: "Name",
          dob: "1990-09-09",
          administrativeSex: "M",
          mbi: "1EG4TE5MK73",
        },
        actor,
      );
      expect(dup.outcome).toBe("hard_block");
      if (dup.outcome === "hard_block") {
        expect(dup.matchedOn).toBe("mbi");
        expect(dup.existingPatientId).toBe((a as { patientId: string }).patientId);
      }

      // bypassMatchReview skips the matcher → always creates.
      const b = await svc.admit(
        org,
        {
          lastName: "Solo",
          firstName: "Han",
          dob: "1977-07-07",
          administrativeSex: "M",
          bypassMatchReview: true,
        },
        actor,
      );
      expect(b.outcome).toBe("created");
      expect((await svc.list(org, {})).items.map((p) => p.lastName).sort()).toEqual([
        "Nguyen",
        "Solo",
      ]);

      // §7.4 address + §7.7 amendment lifecycle (real writes under RLS).
      const patientId = (a as { patientId: string }).patientId;
      const addr = await svc.addAddress(
        org,
        patientId,
        { line1: "1 Elm St", city: "Portland", state: "OR", postalCode: "97201", isPrimary: true },
        actor,
      );
      expect(addr.cascadeEmitted).toBe("m5.patient.address_changed");
      // §3.3 list shows the current row; §7.4/D5 a new primary rotates atomically (the partial unique
      // index `is_primary && effective_to IS NULL` would reject a second open primary if rotation broke).
      const afterFirst = await svc.listAddresses(org, patientId);
      expect(afterFirst).toHaveLength(1);
      expect(afterFirst![0]!.current).toBe(true);
      expect(afterFirst![0]!.isPrimary).toBe(true);
      await svc.addAddress(
        org,
        patientId,
        { line1: "2 Oak Ave", city: "Salem", state: "OR", postalCode: "97301", isPrimary: true },
        actor,
      );
      const afterRotate = await svc.listAddresses(org, patientId);
      expect(afterRotate).toHaveLength(2); // append-only: prior primary kept as history
      expect(afterRotate!.filter((r) => r.current && r.isPrimary)).toHaveLength(1); // exactly one open primary
      expect(afterRotate!.find((r) => r.line1 === "2 Oak Ave")!.current).toBe(true);
      expect(afterRotate!.find((r) => r.line1 === "1 Elm St")!.effectiveTo).not.toBeNull();
      const amd = await svc.submitAmendment(
        org,
        patientId,
        { scope: "demographic", rationale: "name correction" },
        actor,
      );
      expect(amd.status).toBe("pending");
      expect(new Date(amd.slaDueAt).getTime()).toBeGreaterThan(Date.now()); // ~received + 60d
      // a denial requires a reason; an accept transitions to accepted.
      await expect(svc.decideAmendment(org, amd.id, { accept: false }, actor)).rejects.toThrow();
      expect((await svc.decideAmendment(org, amd.id, { accept: true }, actor)).status).toBe(
        "accepted",
      );

      await handle10.close();
    });
  },
);

// ── F-030: `session_scope_chk` against a real database ────────────────────────────────────────────
//
// Two findings, both surfaced by EXECUTING this constraint rather than reading it:
//
//  1. The five classes M16/M19/M31's ABAC predicates gate on were not in the `session_class` enum, so
//     no session could ever carry one and every one of those predicates denied unconditionally.
//     Migration 0219 adds them; 0220 teaches the CHECK what scope each requires.
//
//  2. A PRE-EXISTING hole in the same constraint: `scope ? 'patientId'` on a NULL `scope` is NULL, not
//     false, and **a CHECK constraint passes when its expression is NULL**. So the collaborator/funeral
//     branch never bound on a row with no scope at all — an `external_collaborator` session, a one-time
//     magic link whose entire purpose is to be pinned to ONE patient, could be written unpinned. The
//     app-layer mirror (`isSessionScopeValid`) never had the hole, which is why nothing going through
//     the auth layer ever hit it, and why the DB floor being the LOOSER of the two went unnoticed.
//
// This suite is the constraint's only executable proof: `arch:tenancy` and the schema gates read
// migrations as text, and every unit-level test of session scope goes through the app-layer mirror.
describe.skipIf(!DB_URL)("session_scope_chk (F-030) — live", () => {
  const client = () => new Client({ connectionString: DB_URL });
  const USER = "11111111-1111-4111-8111-0000000f0300";

  /** Try one INSERT; resolve to null on success or the constraint name on refusal. */
  async function insertSession(
    db: InstanceType<typeof Client>,
    id: string,
    sessionClass: string,
    scope: string | null,
  ): Promise<string | null> {
    try {
      await db.query(
        `INSERT INTO session(id,user_id,token,expires_at,session_class,scope)
         VALUES ($1,$2,$3, now() + interval '1 hour', $4::session_class, $5::jsonb)`,
        [id, USER, `tok-${id}`, sessionClass, scope],
      );
      return null;
    } catch (err) {
      return (err as { constraint?: string }).constraint ?? "unknown";
    }
  }

  beforeAll(async () => {
    const db = client();
    await db.connect();
    await db.query(
      `INSERT INTO "user"(id,name,email,email_verified) VALUES ($1,'F030','f030@wardenx.local',true)
       ON CONFLICT (id) DO NOTHING`,
      [USER],
    );
    await db.query("DELETE FROM session WHERE user_id = $1", [USER]);
    await db.end();
  });

  afterAll(async () => {
    const db = client();
    await db.connect();
    await db.query("DELETE FROM session WHERE user_id = $1", [USER]);
    await db.query('DELETE FROM "user" WHERE id = $1', [USER]);
    await db.end();
  });

  it("the enum carries all nine classes, in the order the migrations added them", async () => {
    const db = client();
    await db.connect();
    const { rows } = await db.query<{ labels: string }>(
      `SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder) AS labels
         FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'session_class'`,
    );
    await db.end();
    expect(rows[0]?.labels).toBe(
      "staff,auditor,external_collaborator,funeral_home," +
        "patient_portal,caregiver_portal,bereaved_portal," +
        "external_triage_vendor,external_triage_operator",
    );
  });

  it("refuses a portal session with no portal account", async () => {
    const db = client();
    await db.connect();
    // The mint-then-select flow means the PATIENT is optional; the ACCOUNT never is.
    expect(await insertSession(db, "f030-a", "caregiver_portal", null)).toBe("session_scope_chk");
    expect(await insertSession(db, "f030-b", "patient_portal", '{"patientId":"pt-1"}')).toBe(
      "session_scope_chk",
    );
    await db.end();
  });

  it("accepts a portal session with an account and NO patient — the state between mint and select", async () => {
    const db = client();
    await db.connect();
    expect(
      await insertSession(db, "f030-c", "caregiver_portal", '{"portalAccountId":"acct-1"}'),
    ).toBeNull();
    await db.end();
  });

  it("merges the patient onto the scope without dropping the account (the binder's write)", async () => {
    const db = client();
    await db.connect();
    // `||` is a right-biased jsonb merge. A REPLACING write would drop `portalAccountId`, and the
    // session would 403 on its very next request — the binder's two operations write different keys.
    await db.query(
      `UPDATE session SET scope = COALESCE(scope,'{}'::jsonb) || '{"patientId":"pt-9"}'::jsonb
        WHERE id = 'f030-c'`,
    );
    const { rows } = await db.query<{ scope: Record<string, string> }>(
      "SELECT scope FROM session WHERE id = 'f030-c'",
    );
    await db.end();
    expect(rows[0]?.scope).toEqual({ portalAccountId: "acct-1", patientId: "pt-9" });
  });

  // This assertion INVERTED at migration 0223, and the inversion is the point.
  //
  // 0220 gave the two vendor classes no scope requirement, like `staff`, reasoning that an M19
  // answering-service session is scoped to the organization rather than to a patient. That is true and
  // the conclusion does not follow: a session that is not PATIENT-scoped is not therefore UNSCOPED, and
  // these are VENDOR-scoped. Nothing carried the vendor, so `external_triage_actor` — which compares the
  // SHIFT's `external_actor_id` against the SESSION's — could never admit one. 0223 makes
  // `externalActorId` a requirement of both classes, so a vendor session with no vendor on it is now
  // refused at the database instead of being minted into a permanent refusal.
  it("requires a vendor on a vendor-class session, and nothing on a staff one", async () => {
    const db = client();
    await db.connect();
    expect(await insertSession(db, "f030-d", "external_triage_vendor", null)).toBe(
      "session_scope_chk",
    );
    expect(await insertSession(db, "f030-e", "external_triage_operator", null)).toBe(
      "session_scope_chk",
    );
    // …and accepted WITH it, so 0223 tightened exactly the unscoped case and nothing else.
    expect(
      await insertSession(
        db,
        "f030-d2",
        "external_triage_vendor",
        '{"externalActorId":"vendor-1"}',
      ),
    ).toBeNull();
    expect(
      await insertSession(
        db,
        "f030-e2",
        "external_triage_operator",
        '{"externalActorId":"vendor-1"}',
      ),
    ).toBeNull();
    expect(await insertSession(db, "f030-f", "staff", null)).toBeNull();
    await db.end();
  });

  it("refuses an UNSCOPED collaborator / funeral session — the pre-existing NULL hole", async () => {
    // This is the case that passed before 0220. `NULL ? 'patientId'` is NULL, the other branches are
    // false, `NULL OR false` is NULL, and a CHECK passes on NULL — so the one-patient pin that is the
    // entire point of these two classes was never enforced at the database.
    const db = client();
    await db.connect();
    expect(await insertSession(db, "f030-g", "external_collaborator", null)).toBe(
      "session_scope_chk",
    );
    expect(await insertSession(db, "f030-h", "funeral_home", null)).toBe("session_scope_chk");
    // Still accepted WITH the pin, so the fix tightened exactly the NULL case and nothing else.
    expect(
      await insertSession(db, "f030-i", "external_collaborator", '{"patientId":"pt-2"}'),
    ).toBeNull();
    await db.end();
  });

  it("still refuses an auditor session with no engagement window (branch untouched)", async () => {
    const db = client();
    await db.connect();
    expect(await insertSession(db, "f030-j", "auditor", null)).toBe("session_scope_chk");
    await db.end();
  });
});
