/**
 * M2 authentication hardening, end to end over HTTP, LIVE Postgres, as the RLS-enforced `wardenx_app` role
 * (GAP-002 / GAP-004 auth audit trail; GAP-003 / GAP-005 MFA matrix).
 *
 * The production composition, not a shim: REAL Better Auth behind the REAL Fastify bridge; the REAL audit sink
 * (`auditPlatformEvent` through the SECURITY DEFINER writer for pre-org events, `audit()` under `withOrgContext`
 * for org-bound ones); the REAL authenticate hook / DB session resolver; the REAL MFA gate over the REAL
 * `two_factor` / `passkey` readers and M3's `membershipRoleKeysForOrg`.
 *
 * What it proves (assertions on `audit_event` rows and HTTP answers):
 *   - a wrong then right password writes `m2.auth.login_failed` (emailHash, no address) then `m2.auth.login_succeeded`;
 *   - the 6th failure inside the window is refused 429 and writes `m2.auth.account_locked`;
 *   - sign-out from an org-bound session writes an ORG-scoped `m2.auth.logout` row attributed to the user;
 *   - no audit payload contains the password or the email address;
 *   - a password-only clinician's org-bound session is refused 403 MFA_ENROLMENT_REQUIRED on a clinical route while
 *     /api/auth/* stays reachable; a verified TOTP row lifts the hold; an org_admin with a TOTP but no passkey is
 *     still held until a passkey exists;
 *   - `two-factor/disable` is refused 403 for a clinician whose only factor is the TOTP.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m2:auth-hardening:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createCredentialThrottle,
  createDbActorEnrichmentReader,
  createDbSessionContextStore,
  createIdentityAuth,
  createInMemoryFailedLoginStore,
  createSessionContextResolver,
  getIdentitySession,
  registerIdentityAuth,
  requirePermission,
  resetAuthorizationContract,
  resetRbacEngine,
  resolveMfaEnforcement,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import { ChartWardenError } from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, createSessionAuthenticate } from "../src/bootstrap/index";
import { createAuthAuditSink } from "../src/modules/02-identity/audit/auth-event-audit";
import {
  createDbActiveMembershipLister,
  createMfaEnrolmentGate,
} from "../src/modules/02-identity/mfa-enrolment-gate";
import {
  createDbMfaEnrollmentReader,
  createDbSessionProofReader,
} from "../src/modules/02-identity/step-up-adapters-db";
import { membershipRoleKeysForOrg } from "../src/modules/03-authorization/membership-role-keys-for-org";
import { appRoleConnectionString } from "./_live-app-role";

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
const ORG = "33333333-3333-4333-8333-333333331001";
const ORIGIN = "http://localhost:3000";

describe.skipIf(!DB_URL)("M2 auth audit trail + MFA matrix, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let auth: ReturnType<typeof createIdentityAuth>;
  let app: FastifyInstance;

  const auditRows = async (eventType: string) =>
    (
      await admin.query(
        "SELECT organization_id, actor_user_id, outcome, severity, context FROM audit_event WHERE event_type=$1 ORDER BY created_at",
        [eventType],
      )
    ).rows as {
      organization_id: string | null;
      actor_user_id: string | null;
      outcome: string;
      severity: string;
      context: Record<string, unknown>;
    }[];

  async function seedStaff(label: string, roleKey: string) {
    const email = `${label}-${randomUUID().slice(0, 8)}@m2-hardening.test`;
    const password = `Wx9$${randomUUID()}Qz!`;
    await auth.api.signUpEmail({ body: { email, password, name: label } });
    const userId = (await admin.query(`SELECT id FROM "user" WHERE email=$1`, [email])).rows[0]
      .id as string;
    const membershipId = (
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [userId, ORG],
      )
    ).rows[0].id as string;
    const roleId = (
      await admin.query(
        "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,$2,$2,'clinical_staff',true) RETURNING id",
        [ORG, roleKey],
      )
    ).rows[0].id as string;
    await admin.query(
      "INSERT INTO role_permission (organization_id,role_id,permission_key) VALUES ($1,$2,'mfa.probe')",
      [ORG, roleId],
    );
    await admin.query(
      "INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)",
      [ORG, membershipId, roleId],
    );
    return { email, password, userId };
  }

  const signIn = (email: string, password: string) =>
    app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: ORIGIN },
      payload: { email, password },
    });

  /** Sign in and bind the session to ORG (the effect of select-organization); returns the cookie header. */
  async function boundSession(email: string, password: string, userId: string) {
    const res = await signIn(email, password);
    expect(res.statusCode).toBe(200);
    const sessionId = (
      await admin.query(
        "SELECT id FROM session WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",
        [userId],
      )
    ).rows[0].id as string;
    await admin.query("UPDATE session SET active_organization_id=$1 WHERE id=$2", [ORG, sessionId]);
    const cookie = res.cookies
      .filter((c) => c.name !== "wardenx_csrf")
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    return { cookie, sessionId };
  }

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET ??= "test-secret-at-least-32-characters-long-xx";
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'m2h','m2h','m2h','active')",
      [ORG],
    );
    await admin.query(
      "INSERT INTO permission (key,resource,action,category) VALUES ('mfa.probe','x','y','clinical') ON CONFLICT (key) DO NOTHING",
    );
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    auth = createIdentityAuth(handle.db as never);

    resetAuthorizationContract();
    resetRbacEngine();
    const { registerDbEffectivePermissionResolver } = await import("@chartwarden/auth");
    registerDbEffectivePermissionResolver(handle.db as never);

    const resolver = createSessionContextResolver(
      createDbSessionContextStore(
        handle.db as never,
        createDbActorEnrichmentReader(handle.db as never),
      ),
    );
    // Enforcement forced ON: the production default, regardless of NODE_ENV in this lane.
    const gate = createMfaEnrolmentGate({
      enforced: resolveMfaEnforcement({ CHARTWARDEN_MFA_ENFORCEMENT: "true" }),
      factors: createDbMfaEnrollmentReader(handle.db as never),
      sessionProvedFactor: createDbSessionProofReader(handle.db as never),
      roleKeysForMembership: async ({ organizationId, membershipId }) =>
        (await membershipRoleKeysForOrg(handle.db as never, organizationId, [membershipId])).get(
          membershipId,
        ) ?? [],
      activeMembershipsOf: createDbActiveMembershipLister(handle.db as never),
    });
    app = buildServer({
      db: handle.db as never,
      security: { rateLimitEnabled: false },
      authenticate: createSessionAuthenticate({
        getSnapshot: (request) => getIdentitySession(auth, request.raw.headers),
        getResolver: () => resolver,
        mfaEnrolment: {
          check: ({ userId, sessionId, roleKeys }) =>
            gate.forRoles({ userId, sessionId, roleKeys }),
        },
      }),
    });
    registerIdentityAuth(app, auth, {
      credentialThrottle: createCredentialThrottle(createInMemoryFailedLoginStore()),
      auditSink: createAuthAuditSink({ db: handle.db as never }),
      onAuditError: (err) => {
        throw err; // a lost audit write must fail this suite loudly
      },
      guard: async ({ relativePath, actor }) => {
        if (relativePath !== "/two-factor/disable" || !actor) return;
        if (!(await gate.forUserWithoutTotp(actor.userId)).satisfied)
          throw new ChartWardenError("MFA_REQUIRED_FOR_ROLE", "second factor required", 403);
      },
    });
    app.get(
      "/__probe/clinical",
      {
        preHandler: [requirePermission("mfa.probe")],
        config: { auditRead: { none: "test probe" } },
      },
      async () => ({ ok: true }),
    );
    await app.ready();
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    resetAuthorizationContract();
    resetRbacEngine();
    await handle?.close();
    await admin?.end();
  });

  it("a wrong then a right password write login_failed then login_succeeded, with no secrets", async () => {
    const u = await seedStaff("audit", "rn_audit");
    const wrong = await signIn(u.email, "definitely-the-wrong-password");
    expect(wrong.statusCode).toBe(401);
    const ok = await signIn(u.email, u.password);
    expect(ok.statusCode).toBe(200);

    const failed = await auditRows("m2.auth.login_failed");
    const succeeded = await auditRows("m2.auth.login_succeeded");
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed[failed.length - 1]?.outcome).toBe("failure");
    expect(failed[failed.length - 1]?.context.emailHash).toMatch(/^[0-9a-f]{32}$/);
    const mine = succeeded.find((r) => r.context.userId === u.userId);
    expect(mine?.outcome).toBe("success");
    const everything = JSON.stringify(
      (await admin.query("SELECT context FROM audit_event WHERE event_type LIKE 'm2.auth.%'")).rows,
    );
    expect(everything).not.toContain(u.password);
    expect(everything).not.toContain(u.email);
  });

  it("the 6th failure inside the window is refused and writes account_locked", async () => {
    const u = await seedStaff("lock", "rn_lock");
    for (let i = 0; i < 5; i += 1) await signIn(u.email, "wrong-wrong-wrong-1");
    const sixth = await signIn(u.email, "wrong-wrong-wrong-1");
    expect(sixth.statusCode).toBe(429);
    const locked = await auditRows("m2.auth.account_locked");
    expect(locked.length).toBeGreaterThanOrEqual(1);
    expect(locked[0]?.severity).toBe("critical");
  });

  it("sign-out from an org-bound session writes an ORG-scoped logout attributed to the user", async () => {
    const u = await seedStaff("logout", "rn_logout");
    const { cookie } = await boundSession(u.email, u.password, u.userId);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      headers: { origin: ORIGIN, cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const rows = (
      await admin.query(
        "SELECT organization_id, actor_user_id FROM audit_event WHERE event_type='m2.auth.logout' AND actor_user_id=$1",
        [u.userId],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].organization_id).toBe(ORG);
  });

  it("a password-only clinician is held at MFA enrolment; a verified TOTP lifts the hold", async () => {
    const u = await seedStaff("mfa", "rn_mfa");
    const { cookie, sessionId } = await boundSession(u.email, u.password, u.userId);
    const held = await app.inject({ method: "GET", url: "/__probe/clinical", headers: { cookie } });
    expect(held.statusCode).toBe(403);
    expect(held.json().error.code).toBe("MFA_ENROLMENT_REQUIRED");
    // Better Auth's own surface stays reachable so the user CAN enrol.
    const session = await app.inject({
      method: "GET",
      url: "/api/auth/get-session",
      headers: { cookie },
    });
    expect(session.statusCode).toBe(200);

    await admin.query(
      "INSERT INTO two_factor (user_id, secret_encrypted, verified) VALUES ($1,'sealed',true)",
      [u.userId],
    );
    // Enrolment alone is not assurance: the password-only session has not PROVED the factor.
    const stillHeld = await app.inject({
      method: "GET",
      url: "/__probe/clinical",
      headers: { cookie },
    });
    expect(stillHeld.statusCode).toBe(403);
    await admin.query(
      "UPDATE session SET last_step_up_at=now(), last_step_up_factor='totp' WHERE id=$1",
      [sessionId],
    );
    const lifted = await app.inject({
      method: "GET",
      url: "/__probe/clinical",
      headers: { cookie },
    });
    expect(lifted.statusCode).toBe(200);
  });

  it("an org_admin with only a TOTP stays held until a passkey exists", async () => {
    const u = await seedStaff("adm", "org_admin");
    // `org_admin` is a reserved platform key: only an org-NULL template row confers it, so the tenant-owned
    // row seeded above confers nothing. Seed the template once and re-point the grant at it.
    await admin.query(
      `INSERT INTO role (organization_id,key,name,category,enabled,system_default,scope_level)
         SELECT NULL,'org_admin','Organization Administrator','admin_executive',true,true,'organization'
         WHERE NOT EXISTS (SELECT 1 FROM role WHERE key='org_admin' AND organization_id IS NULL)`,
    );
    const templateId = (
      await admin.query("SELECT id FROM role WHERE key='org_admin' AND organization_id IS NULL")
    ).rows[0].id as string;
    await admin.query(
      "UPDATE membership_role SET role_id=$1 WHERE membership_id=(SELECT id FROM membership WHERE user_id=$2)",
      [templateId, u.userId],
    );
    await admin.query(
      "INSERT INTO role_permission (organization_id,role_id,permission_key) VALUES ($1,$2,'mfa.probe') ON CONFLICT DO NOTHING",
      [ORG, templateId],
    );
    await admin.query(
      "INSERT INTO two_factor (user_id, secret_encrypted, verified) VALUES ($1,'sealed',true)",
      [u.userId],
    );
    const { cookie, sessionId } = await boundSession(u.email, u.password, u.userId);
    const held = await app.inject({ method: "GET", url: "/__probe/clinical", headers: { cookie } });
    expect(held.statusCode).toBe(403);
    await admin.query(
      "INSERT INTO passkey (user_id, credential_id, public_key) VALUES ($1,$2,'pk')",
      [u.userId, randomUUID()],
    );
    // A passkey is enrolled but this session signed in on a password (and proved only a TOTP): still held.
    await admin.query(
      "UPDATE session SET last_step_up_at=now(), last_step_up_factor='totp' WHERE id=$1",
      [sessionId],
    );
    const unproven = await app.inject({
      method: "GET",
      url: "/__probe/clinical",
      headers: { cookie },
    });
    expect(unproven.statusCode).toBe(403);
    await admin.query("UPDATE session SET last_step_up_factor='webauthn' WHERE id=$1", [sessionId]);
    const lifted = await app.inject({
      method: "GET",
      url: "/__probe/clinical",
      headers: { cookie },
    });
    expect(lifted.statusCode).toBe(200);
  });

  it("two-factor/disable is refused 403 for a clinician whose only factor is the TOTP", async () => {
    const u = await seedStaff("dis", "rn_dis");
    await admin.query(
      "INSERT INTO two_factor (user_id, secret_encrypted, verified) VALUES ($1,'sealed',true)",
      [u.userId],
    );
    const { cookie } = await boundSession(u.email, u.password, u.userId);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/two-factor/disable",
      headers: { origin: ORIGIN, cookie },
      payload: { password: u.password },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("MFA_REQUIRED_FOR_ROLE");
    const stillThere = await admin.query("SELECT 1 FROM two_factor WHERE user_id=$1", [u.userId]);
    expect(stillThere.rowCount).toBe(1);
  });
});
