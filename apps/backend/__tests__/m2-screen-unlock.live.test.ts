/**
 * #589 / #600 - the idle screen-lock "Unlock" resumes the SAME session, end to end over HTTP, LIVE Postgres, as the
 * RLS-enforced `chartwarden_app` role. Nothing here is mocked: REAL Better Auth behind the REAL Fastify bridge, the
 * REAL `mountIdentityRoutes` (select-organization + unlock), the REAL authenticate hook / DB session resolver, the
 * REAL org-scoped audit executor and the REAL catalog-validating outbox publisher.
 *
 * The bug it pins: the lock overlay used to call Better Auth sign-in, which mints a NEW session with no active
 * organization (the org binds only in select-organization). The next org-scoped request then 401'd and the web shell
 * sent the user to /expired and wiped their drafts. The old web tests mocked `authClient` entirely, so nothing ever
 * exercised that second session.
 *
 * What it proves:
 *   - sign in -> select-organization -> unlock keeps the SAME session id, writes no new `session` row, and an
 *     org-scoped request is still 200 afterwards;
 *   - the unlock lands an org-scoped `m2.session.unlocked` audit row and a `m2.session.unlocked` outbox row, and
 *     never a second `m2.session.created` (it is not a new billing seat);
 *   - a wrong password is 401 INVALID_CREDENTIALS, audited as `m2.session.unlock_failed`, and the session survives;
 *   - the 5th wrong password ENDS the session (423, cookie dead), a correct password refunds the budget, and a
 *     parallel burst cannot overdraw it; the POST needs the CSRF header;
 *   - a fresh sign-in (what the old unlock did) is org-less, and its org-scoped 401 carries ORGANIZATION_NOT_SELECTED
 *     so the web shell can tell it from a dead session.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m2:screen-unlock:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createCredentialThrottle,
  createDbActorEnrichmentReader,
  createDbAdminMembershipReader,
  createDbSessionContextStore,
  createIdentityAuth,
  createInMemoryFailedLoginStore,
  createPasswordVerifier,
  createSessionContextResolver,
  getIdentitySession,
  registerDbEffectivePermissionResolver,
  registerIdentityAuth,
  requirePermission,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, createSessionAuthenticate } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M2_OUTBOX_EVENTS, createUnlockGuard, mountIdentityRoutes } from "../src/modules/02-identity/index";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "chartwarden_platform_login",
  "chartwarden_platform",
  "chartwarden_app",
  "chartwarden_admin",
  "chartwarden_readonly",
  "chartwarden_audit_writer",
  "tenant_platform_writer",
];
const ORG = "33333333-3333-4333-8333-333333332001";
const ORIGIN = "http://localhost:3000";
const CSRF = { "x-csrf-token": "x" };

describe.skipIf(!DB_URL)("#589 screen-lock unlock keeps the session, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let auth: ReturnType<typeof createIdentityAuth>;
  let app: FastifyInstance;

  async function seedStaff(label: string) {
    const email = `${label}-${randomUUID().slice(0, 8)}@m2-unlock.test`;
    const password = `Wx9$${randomUUID()}Qz!`;
    await auth.api.signUpEmail({ body: { email, password, name: label } });
    const userId = (await admin.query(`SELECT id FROM "user" WHERE email=$1`, [email])).rows[0]
      .id as string;
    // Better Auth's sign-up signs the new user in; drop that session so each case counts only its own.
    await admin.query(`DELETE FROM session WHERE user_id=$1`, [userId]);
    const membershipId = (
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [userId, ORG],
      )
    ).rows[0].id as string;
    const roleId = (
      await admin.query(
        "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,$2,$2,'clinical_staff',true) RETURNING id",
        [ORG, `rn_${label}`],
      )
    ).rows[0].id as string;
    await admin.query(
      "INSERT INTO role_permission (organization_id,role_id,permission_key) VALUES ($1,$2,'unlock.probe')",
      [ORG, roleId],
    );
    await admin.query(
      "INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)",
      [ORG, membershipId, roleId],
    );
    return { email, password, userId };
  }

  const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
    `${res.cookies
      .filter((c) => c.name !== "chartwarden_csrf")
      .map((c) => `${c.name}=${c.value}`)
      .join("; ")}; chartwarden_csrf=x`;

  async function signIn(email: string, password: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: ORIGIN },
      payload: { email, password },
    });
    expect(res.statusCode).toBe(200);
    return cookieOf(res);
  }

  /** The real sign-in -> select-organization sequence every login passes through. */
  async function signInAndBind(u: { email: string; password: string }) {
    const cookie = await signIn(u.email, u.password);
    const bound = await app.inject({
      method: "POST",
      url: "/api/v1/auth/select-organization",
      headers: { cookie, ...CSRF },
      payload: { organizationId: ORG },
    });
    expect(bound.statusCode).toBe(200);
    return cookie;
  }

  const unlock = (cookie: string, password: string) =>
    app.inject({
      method: "POST",
      url: "/api/v1/auth/unlock",
      headers: { cookie, ...CSRF },
      payload: { password },
    });
  const probe = (cookie: string) =>
    app.inject({ method: "GET", url: "/__probe/org", headers: { cookie } });

  const sessionsOf = async (userId: string) =>
    (
      await admin.query(
        "SELECT id, active_organization_id FROM session WHERE user_id=$1 ORDER BY created_at",
        [userId],
      )
    ).rows as { id: string; active_organization_id: string | null }[];
  const auditCount = async (eventType: string, userId: string) =>
    Number(
      (
        await admin.query(
          "SELECT count(*) FROM audit_event WHERE event_type=$1 AND actor_user_id=$2",
          [eventType, userId],
        )
      ).rows[0].count,
    );
  const outboxRows = async (eventType: string, sessionId: string) =>
    (
      await admin.query(
        "SELECT organization_id, payload FROM outbox_event WHERE event_type=$1 AND aggregate_id=$2",
        [eventType, sessionId],
      )
    ).rows as { organization_id: string; payload: Record<string, unknown> }[];

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
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'m2u','m2u','m2u','active')",
      [ORG],
    );
    await admin.query(
      "INSERT INTO permission (key,resource,action,category) VALUES ('unlock.probe','x','y','clinical') ON CONFLICT (key) DO NOTHING",
    );
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    auth = createIdentityAuth(handle.db as never);

    resetAuthorizationContract();
    resetRbacEngine();
    registerDbEffectivePermissionResolver(handle.db as never);

    const resolver = createSessionContextResolver(
      createDbSessionContextStore(
        handle.db as never,
        createDbActorEnrichmentReader(handle.db as never),
      ),
    );
    app = buildServer({
      db: handle.db as never,
      security: { rateLimitEnabled: false },
      authenticate: createSessionAuthenticate({
        getSnapshot: (request) => getIdentitySession(auth, request.raw.headers),
        getResolver: () => resolver,
      }),
    });
    registerIdentityAuth(app, auth, {
      credentialThrottle: createCredentialThrottle(createInMemoryFailedLoginStore()),
    });
    // The real publisher validates every payload against the M2 catalog, so an off-catalog or wrong-shape
    // `m2.session.unlocked` fails this suite instead of being swallowed by a no-op.
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M2_OUTBOX_EVENTS]));
    mountIdentityRoutes(app, handle.db as never, createDbAdminMembershipReader(handle.db as never), {
      outbox: { publish: (tx, input) => publisher.publish(tx, { ...input, callerModule: "m2" }) },
      passwordVerifier: createPasswordVerifier(auth),
      unlockGuard: createUnlockGuard(createInMemoryFailedLoginStore()),
    });
    app.get(
      "/__probe/org",
      {
        preHandler: [requirePermission("unlock.probe")],
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

  it("unlock keeps the same session, binds nothing new, and org-scoped calls still succeed", async () => {
    const u = await seedStaff("keep");
    const cookie = await signInAndBind(u);
    const before = await sessionsOf(u.userId);
    expect(before).toHaveLength(1);
    expect(before[0]?.active_organization_id).toBe(ORG);
    expect((await probe(cookie)).statusCode).toBe(200);

    const res = await unlock(cookie, u.password);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: before[0]?.id, activeOrganizationId: ORG });
    expect(await sessionsOf(u.userId)).toEqual(before); // same id, same org, no second session
    expect((await probe(cookie)).statusCode).toBe(200); // the call that 401'd -> /expired before the fix

    expect(await auditCount("m2.session.unlocked", u.userId)).toBe(1);
    const unlocked = await outboxRows("m2.session.unlocked", before[0]?.id as string);
    expect(unlocked).toHaveLength(1);
    expect(unlocked[0]?.organization_id).toBe(ORG);
    expect(unlocked[0]?.payload).toMatchObject({
      sessionId: before[0]?.id,
      userId: u.userId,
      organizationId: ORG,
    });
    // select-organization published `created` once; unlock must not count a second seat.
    expect(await outboxRows("m2.session.created", before[0]?.id as string)).toHaveLength(1);
  });

  it("a wrong password is 401 INVALID_CREDENTIALS, audited, and the session survives", async () => {
    const u = await seedStaff("wrong");
    const cookie = await signInAndBind(u);

    const res = await unlock(cookie, "definitely-the-wrong-password");

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_CREDENTIALS");
    expect(await auditCount("m2.session.unlock_failed", u.userId)).toBe(1);
    expect(await auditCount("m2.session.unlocked", u.userId)).toBe(0);
    expect((await probe(cookie)).statusCode).toBe(200);
    const trail = JSON.stringify(
      (await admin.query("SELECT context FROM audit_event WHERE actor_user_id=$1", [u.userId])).rows,
    );
    expect(trail).not.toContain(u.password);
  });

  it("the 5th wrong password ENDS the session (423); the cookie is dead and nothing more is hashed", async () => {
    const u = await seedStaff("lock");
    const cookie = await signInAndBind(u);
    const [session] = await sessionsOf(u.userId);
    for (let i = 0; i < 4; i += 1) {
      expect((await unlock(cookie, "wrong-wrong-wrong-1")).statusCode).toBe(401);
    }

    const fifth = await unlock(cookie, "wrong-wrong-wrong-1");

    expect(fifth.statusCode).toBe(423);
    expect(fifth.json().error.code).toBe("UNLOCK_LOCKED_OUT");
    expect(await sessionsOf(u.userId)).toEqual([]); // the session row is gone
    expect(session).toBeTruthy();
    expect((await probe(cookie)).statusCode).toBe(401); // the cookie is dead, even for the RIGHT password
    expect((await unlock(cookie, u.password)).statusCode).toBe(401);
    expect(await auditCount("m2.session.unlock_failed", u.userId)).toBe(5);
    expect(await auditCount("m2.session.terminated_unlock_lockout", u.userId)).toBe(1);
  });

  it("a correct password refunds the budget, so earlier typos do not accumulate toward a lockout", async () => {
    const u = await seedStaff("refund");
    const cookie = await signInAndBind(u);
    for (let i = 0; i < 4; i += 1) await unlock(cookie, "wrong-wrong-wrong-1");
    expect((await unlock(cookie, u.password)).statusCode).toBe(200);

    for (let i = 0; i < 4; i += 1) {
      expect((await unlock(cookie, "wrong-wrong-wrong-1")).statusCode).toBe(401);
    }
    expect((await probe(cookie)).statusCode).toBe(200); // still alive after 4 more
  });

  it("a parallel burst cannot overdraw the budget: only 5 passwords are ever checked, the rest are throttled", async () => {
    const u = await seedStaff("burst");
    const cookie = await signInAndBind(u);

    const burst = await Promise.all(
      Array.from({ length: 12 }, () => unlock(cookie, "wrong-wrong-wrong-1")),
    );

    // Exactly 5 attempts reserved a slot and were hashed (each audits `unlock_failed`); the other 7 were refused or
    // met the already-dead cookie. Whichever raced last, the session is gone and one request saw the lockout.
    expect(await auditCount("m2.session.unlock_failed", u.userId)).toBe(5);
    expect(burst.map((r) => r.statusCode)).toContain(423);
    expect(await sessionsOf(u.userId)).toEqual([]);
  });

  it("refuses the POST without the CSRF double-submit header", async () => {
    const u = await seedStaff("csrf");
    const cookie = await signInAndBind(u);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/unlock",
      headers: { cookie },
      payload: { password: u.password },
    });

    expect(res.statusCode).toBe(403);
  });

  it("is 401 without a session and 422 without a password", async () => {
    const u = await seedStaff("edge");
    const cookie = await signInAndBind(u);

    const anonymous = await app.inject({
      method: "POST",
      url: "/api/v1/auth/unlock",
      headers: CSRF,
      payload: { password: "x" },
    });
    const empty = await app.inject({
      method: "POST",
      url: "/api/v1/auth/unlock",
      headers: { cookie, ...CSRF },
      payload: {},
    });

    expect(anonymous.statusCode).toBe(401);
    expect(empty.statusCode).toBe(422);
  });

  it("a fresh sign-in (the old unlock) is org-less, and its 401 says ORGANIZATION_NOT_SELECTED, not 'dead'", async () => {
    const u = await seedStaff("orgless");
    await signInAndBind(u);
    const second = await signIn(u.email, u.password); // what signIn.email did on unlock

    const rows = await sessionsOf(u.userId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.active_organization_id === null)).toHaveLength(1);
    const res = await probe(second);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("ORGANIZATION_NOT_SELECTED");
    // A request with no session at all stays a plain UNAUTHORIZED (a genuinely dead session).
    const anonymous = await app.inject({ method: "GET", url: "/__probe/org" });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.code).toBe("UNAUTHORIZED");
  });
});
