/**
 * M31 portal invitee SIGN-IN, end to end over HTTP, LIVE Postgres, as the RLS-enforced `wardenx_app` role.
 *
 * The production composition, not a header shim: REAL Better Auth (a REAL emailed magic link is requested and followed,
 * and a REAL password + TOTP-less sign-in is used for the "unverified email" case), the REAL `createSessionAuthenticate`
 * over the REAL `session` row, the REAL M2 `m31_list_own_portal_accounts` SECURITY DEFINER read, the REAL atomic session
 * bind, the REAL effective-permission resolver wrapped with the session-class permission set, the REAL M31 ABAC
 * predicates over the REAL Drizzle store, and the REAL catalog-validating outbox publisher for the select-patient event.
 *
 * What it proves (each assertion is on the database row or the HTTP answer, never on a mock):
 *   - a pre-org session becomes a portal session ONLY through the user's OWN, eligible account; the `session` row carries
 *     the org, the class and `scope.portalAccountId` together, and the next request is stamped from that row;
 *   - invited / suspended / unverified / inactive-tenant / no-live-grant accounts are refused with the typed reason and
 *     the `session` row is byte-for-byte unchanged (and the refusal is audited where the tenant is known);
 *   - a session bound as something else (a staff session) is never re-scoped; a replay of the identical bind is a 200;
 *   - two accounts => 409 until one is named; naming ANOTHER user's account id answers as "no account";
 *   - a portal session holds portal keys only: a user who is also a clinician cannot reach clinical routes from it;
 *   - failed binds trip the §5.3.1 budget (429 + Retry-After);
 *   - the definer function reveals only the passed user's accounts, and a bare wardenx_app read of portal_account with
 *     no tenant bound still returns nothing (RLS is intact).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m31:portal-signin:live
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
  createPredicateRegistry,
  createSessionContextResolver,
  getIdentitySession,
  registerAbacRegistry,
  registerDbEffectivePermissionResolver,
  registerIdentityAuth,
  requirePermission,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, createSessionAuthenticate, registerSeam } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createOrgScopedAuditExecutor } from "../src/modules/02-identity/identity-ports";
import { createDrizzlePortalSessionStore } from "../src/modules/02-identity/portal-session-store";
import { createPortalSignInStore } from "../src/modules/02-identity/portal-sign-in-store";
import {
  type PortalAbacPorts,
  buildPortalAbacPredicates,
} from "../src/modules/31-portal/abac-predicates";
import { createM31EventEmitter } from "../src/modules/31-portal/events";
import { M31_OUTBOX_EVENTS } from "../src/modules/31-portal/events-by-m31";
import { buildPortalAbacResolverFromStore } from "../src/modules/31-portal/index";
import { validateScopeSet } from "../src/modules/31-portal/lifecycle/scope-set";
import { registerPortalSessionRoutes } from "../src/modules/31-portal/routes/session.routes";
import { registerPortalSignInRoutes } from "../src/modules/31-portal/routes/sign-in.routes";
import { buildDrizzlePortalStore } from "../src/modules/31-portal/routes/store";
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
const ORG_A = "11111111-1111-4111-8111-111111120901";
const ORG_B = "22222222-2222-4222-8222-222222220902";
const ORG_DOWN = "33333333-3333-4333-8333-333333330903";
const ORIGIN = "http://localhost:3000";

interface Persona {
  readonly email: string;
  readonly userId: string;
}

describe.skipIf(!DB_URL)("M31 portal invitee sign-in, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let app: FastifyInstance;
  let auth: ReturnType<typeof createIdentityAuth>;
  const sentLinks: { to: string; url: string }[] = [];
  const peByOrg: Record<string, string> = {};
  const patientByOrg: Record<string, string> = {};
  const emailOf = (label: string) => `${label}-${randomUUID().slice(0, 8)}@m31-signin.test`;

  // ── fixtures (seeded as the superuser; every assertion below is made as wardenx_app) ──────────────────────────
  async function seedUser(label: string, verified = false): Promise<Persona> {
    const email = emailOf(label);
    const userId = (
      await admin.query(`INSERT INTO "user" (email, email_verified) VALUES ($1,$2) RETURNING id`, [
        email,
        verified,
      ])
    ).rows[0].id as string;
    return { email, userId };
  }

  async function seedAccount(
    org: string,
    userId: string,
    o: {
      relationship?: string;
      status?: string;
      grants?: "none" | "live" | "bereaved";
    } = {},
  ): Promise<string> {
    const status = o.status ?? "active";
    const accountId = (
      await admin.query(
        `INSERT INTO portal_account (organization_id, user_id, relationship, status, display_name_cipher, email_cipher, activated_at, suspended_at)
         VALUES ($1,$2,$3,$4,'c','c', $5, $6) RETURNING id`,
        [
          org,
          userId,
          o.relationship ?? "family_caregiver",
          status,
          status === "invited" ? null : new Date(),
          status === "suspended" ? new Date() : null,
        ],
      )
    ).rows[0].id as string;
    const grants = o.grants ?? "live";
    const grantKind = grants === "bereaved" ? "bereaved_family" : "family_caregiver";
    if (grants !== "none") {
      await admin.query(
        `INSERT INTO portal_access_grant
           (organization_id, provider_entity_id, portal_account_id, patient_id, grant_kind, scope_set_jsonb,
            source_consent_record_id, source_consent_version, granted_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,'1',$8)`,
        [
          org,
          peByOrg[org],
          accountId,
          patientByOrg[org],
          grantKind,
          JSON.stringify(validateScopeSet(grantKind, "1")),
          randomUUID(),
          randomUUID(),
        ],
      );
    }
    return accountId;
  }

  async function sessionRow(sessionId: string) {
    return (await admin.query("SELECT * FROM session WHERE id = $1", [sessionId])).rows[0];
  }

  /** Sign in through the REAL magic-link flow: request the link, follow it, return the browser's cookie jar. */
  async function signInByLink(persona: Persona): Promise<{ cookie: string; csrf: string }> {
    const before = sentLinks.length;
    const req = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/magic-link",
      headers: { origin: ORIGIN },
      payload: { email: persona.email, callbackURL: `${ORIGIN}/signed-in` },
    });
    expect(req.statusCode).toBe(200);
    expect(sentLinks.length).toBe(before + 1);
    const link = new URL(sentLinks[sentLinks.length - 1]?.url as string);
    const verify = await app.inject({
      method: "GET",
      url: `${link.pathname}${link.search}`,
      headers: { origin: ORIGIN },
    });
    expect(verify.statusCode).toBe(302);
    expect(verify.headers.location).toBe(`${ORIGIN}/signed-in`);
    return jar(verify.cookies);
  }

  function jar(cookies: ReadonlyArray<{ name: string; value: string }>) {
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const csrf = cookies.find((c) => c.name === "wardenx_csrf")?.value;
    return { cookie, csrf: csrf ?? "" };
  }

  /** A pre-org browser: a session cookie plus a CSRF pair (the CSRF cookie is minted by any first request). */
  async function withCsrf(session: { cookie: string; csrf: string }) {
    if (session.csrf) return session;
    const probe = await app.inject({
      method: "GET",
      url: "/api/v1/portal/sign-in/accounts",
      headers: { cookie: session.cookie },
    });
    const csrf = probe.cookies.find((c) => c.name === "wardenx_csrf")?.value ?? "";
    return { cookie: `${session.cookie}; wardenx_csrf=${csrf}`, csrf };
  }

  const sessionIdOf = async (userId: string): Promise<string> =>
    (
      await admin.query(
        "SELECT id FROM session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
        [userId],
      )
    ).rows[0].id as string;

  const establish = (
    s: { cookie: string; csrf: string },
    body: Record<string, unknown> = {},
    key = randomUUID(),
  ) =>
    app.inject({
      method: "POST",
      url: "/api/v1/portal/sign-in/establish",
      headers: { cookie: s.cookie, "x-csrf-token": s.csrf, "idempotency-key": key },
      payload: body,
    });
  const get = (s: { cookie: string }, url: string) =>
    app.inject({ method: "GET", url, headers: { cookie: s.cookie } });

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
    for (const [org, slug, status] of [
      [ORG_A, "m31si-a", "active"],
      [ORG_B, "m31si-b", "active"],
      [ORG_DOWN, "m31si-down", "suspended"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,$2,$2,$2,$3)",
        [org, slug, status],
      );
      peByOrg[org] = (
        await admin.query(
          "INSERT INTO provider_entity (organization_id, legal_name, ccn, npi, tax_id_encrypted, fiscal_year_end, status) VALUES ($1,'PE',$2,$3,'x','1231','active') RETURNING id",
          [org, `CCN${slug}`, `NPI${slug}`],
        )
      ).rows[0].id as string;
      patientByOrg[org] = (
        await admin.query(
          "INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status) VALUES ($1,$2,'Pat','Ient','1940-01-01','F','active') RETURNING id",
          [org, `MRN-${slug}`],
        )
      ).rows[0].id as string;
    }

    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    auth = createIdentityAuth(handle.db as never, {
      emailTransport: {
        async send(message) {
          const url = /https?:\/\/\S+/.exec(message.text)?.[0] ?? "";
          sentLinks.push({ to: message.to, url });
        },
      },
    });

    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    registerDbEffectivePermissionResolver(handle.db as never);
    const store = buildDrizzlePortalStore(handle.db);
    const ports: PortalAbacPorts = {
      consentActive: async () => false,
      bereavedWindowOpen: async () => false,
      primaryCaregiverUserId: async () => null,
      patientResidenceState: async () => null,
      engagementActive: async () => false,
    };
    const registry = createPredicateRegistry();
    for (const [name, predicate] of Object.entries(
      buildPortalAbacPredicates({ resolver: buildPortalAbacResolverFromStore(store), ports }),
    )) {
      registry.register(name, predicate);
    }
    registerAbacRegistry(registry);
    registerSeam("PortalSessionBinder", {
      async bindPortalSession() {
        throw new Error("not used");
      },
      async bindPortalPatient(input: {
        scope: { orgId: string };
        sessionId: string;
        patientId: string;
      }) {
        const s = createDrizzlePortalSessionStore(handle.db);
        await s.write(input.scope, input.sessionId, { scopePatch: { patientId: input.patientId } });
      },
    } as never);

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
    registerIdentityAuth(app, auth);
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M31_OUTBOX_EVENTS]));
    const events = createM31EventEmitter({
      db: handle.db,
      publisher: {
        publish: (tx, input) => publisher.publish(tx, { ...input, callerModule: "m31" } as never),
      },
    });
    const deps = {
      store,
      events,
      signIn: createPortalSignInStore(handle.db, createOrgScopedAuditExecutor(handle.db)),
      signInThrottle: createCredentialThrottle(createInMemoryFailedLoginStore(), {
        keyPrefix: "portal-signin",
      }),
    };
    registerPortalSignInRoutes(app, deps);
    registerPortalSessionRoutes(app, deps);
    // Probes behind the REAL requirePermission: one clinical key, one portal key.
    app.get("/__probe/clinical", { preHandler: [requirePermission("patient.read")] }, async () => ({
      ok: true,
    }));
    app.get(
      "/__probe/portal",
      {
        preHandler: [requirePermission("portal.session.read_own")],
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
    resetAbacRegistry();
    await handle?.close();
    await admin?.end();
  });

  it("harness bites: wardenx_app with no tenant bound sees no portal_account rows (superuser sees them)", async () => {
    const eligible = await seedUser("rls");
    await seedAccount(ORG_A, eligible.userId);
    const asApp = await handle.pool.query("SELECT count(*)::int AS n FROM portal_account");
    const asSuper = await admin.query("SELECT count(*)::int AS n FROM portal_account");
    expect(asSuper.rows[0].n).toBeGreaterThanOrEqual(1);
    expect(asApp.rows[0].n).toBe(0);
  });

  it("the definer read returns ONLY the passed user's accounts, with no contact PHI columns", async () => {
    const a = await seedUser("def-a");
    const b = await seedUser("def-b");
    const accA = await seedAccount(ORG_A, a.userId);
    const accB = await seedAccount(ORG_B, b.userId);
    const rowsA = (
      await handle.pool.query("SELECT * FROM m31_list_own_portal_accounts($1)", [a.userId])
    ).rows;
    expect(rowsA.map((r) => r.portal_account_id)).toEqual([accA]);
    expect(rowsA[0].live_grant_count).toBe(1);
    expect(Object.keys(rowsA[0])).not.toContain("email_cipher");
    expect(Object.keys(rowsA[0])).not.toContain("display_name_cipher");
    const rowsNull = (await handle.pool.query("SELECT * FROM m31_list_own_portal_accounts(NULL)"))
      .rows;
    expect(rowsNull).toEqual([]);
    expect(accB).not.toBe(accA);
    // wardenx_app cannot read the underlying tables through the definer role directly.
    await expect(handle.pool.query("SET ROLE portal_signin_reader")).rejects.toThrow();
  });

  it("unauthenticated callers get 401 and learn nothing", async () => {
    const accounts = await app.inject({ method: "GET", url: "/api/v1/portal/sign-in/accounts" });
    expect(accounts.statusCode).toBe(401);
    const bind = await app.inject({
      method: "POST",
      url: "/api/v1/portal/sign-in/establish",
      headers: { "idempotency-key": randomUUID() },
      payload: {},
    });
    expect([401, 403]).toContain(bind.statusCode);
  });

  it("magic link -> pre-org session -> establish binds org + class + account atomically; the next request is stamped from the row", async () => {
    const p = await seedUser("happy");
    const accountId = await seedAccount(ORG_A, p.userId);
    const s = await withCsrf(await signInByLink(p));
    const sessionId = await sessionIdOf(p.userId);
    const pre = await sessionRow(sessionId);
    expect(pre.active_organization_id).toBeNull();
    expect(pre.session_class).toBe("staff");

    // The link verified the email: that is what makes the account eligible.
    expect(
      (await admin.query(`SELECT email_verified FROM "user" WHERE id=$1`, [p.userId])).rows[0]
        .email_verified,
    ).toBe(true);

    // Before the bind, no portal route is reachable (no org).
    expect((await get(s, "/api/v1/portal/sessions/current")).statusCode).toBe(401);

    const listed = await get(s, "/api/v1/portal/sign-in/accounts");
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toEqual([
      expect.objectContaining({ portalAccountId: accountId, blockedReason: null }),
    ]);
    expect(JSON.stringify(listed.json())).not.toMatch(/patient|mrn|email/i);

    const res = await establish(s);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      portalAccountId: accountId,
      sessionClass: "caregiver_portal",
      replayed: false,
    });
    const bound = await sessionRow(sessionId);
    expect(bound.active_organization_id).toBe(ORG_A);
    expect(bound.session_class).toBe("caregiver_portal");
    expect(bound.scope).toEqual({ portalAccountId: accountId });

    // Audited, and the login stamped on the account.
    const audit = await admin.query(
      "SELECT outcome FROM audit_event WHERE event_type='m2.portal.session_established' AND resource_id=$1",
      [accountId],
    );
    expect(audit.rows.length).toBe(1);
    const acct = await admin.query("SELECT last_login_at FROM portal_account WHERE id=$1", [
      accountId,
    ]);
    expect(acct.rows[0].last_login_at).not.toBeNull();

    // The next request is a PORTAL request: stamped from the row, RBAC from the class set, ABAC from the store.
    const current = await get(s, "/api/v1/portal/sessions/current");
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ portalAccountId: accountId, activePatientId: null });
    const patients = await get(s, "/api/v1/portal/sessions/patients");
    expect(patients.statusCode).toBe(200);
    expect(patients.json().items.map((i: { patientId: string }) => i.patientId)).toEqual([
      patientByOrg[ORG_A],
    ]);

    // Replay of the identical bind is a 200 `replayed`, not a re-scope and not an error.
    const replay = await establish(s);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM audit_event WHERE event_type='m2.portal.session_established' AND resource_id=$1",
          [accountId],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("select-patient binds ONLY a patient the account is granted, emits the catalog-validated event, and refuses any other", async () => {
    const p = await seedUser("select");
    await seedAccount(ORG_A, p.userId);
    const s = await withCsrf(await signInByLink(p));
    expect((await establish(s)).statusCode).toBe(200);
    const sessionId = await sessionIdOf(p.userId);

    const other = await app.inject({
      method: "POST",
      url: "/api/v1/portal/sessions/select-patient",
      headers: { cookie: s.cookie, "x-csrf-token": s.csrf, "idempotency-key": randomUUID() },
      payload: { patientId: patientByOrg[ORG_B] },
    });
    expect(other.statusCode).toBe(403);
    expect((await sessionRow(sessionId)).scope.patientId).toBeUndefined();

    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/portal/sessions/select-patient",
      headers: { cookie: s.cookie, "x-csrf-token": s.csrf, "idempotency-key": randomUUID() },
      payload: { patientId: patientByOrg[ORG_A] },
    });
    expect(ok.statusCode).toBe(200);
    expect((await sessionRow(sessionId)).scope.patientId).toBe(patientByOrg[ORG_A]);
    const evt = await admin.query(
      "SELECT payload FROM outbox_event WHERE event_type='m31.portal_session.opened' AND organization_id=$1",
      [ORG_A],
    );
    expect(evt.rows.some((r) => r.payload.sessionId === sessionId)).toBe(true);
  });

  it.each([
    ["invited", { status: "invited" }, "SIGN_IN_ACCOUNT_NOT_ACTIVATED"],
    ["suspended", { status: "suspended" }, "SIGN_IN_ACCOUNT_NOT_ACTIVE"],
    ["no live grant", { grants: "none" as const }, "SIGN_IN_NO_ACTIVE_GRANT"],
  ])(
    "refuses a %s account with the typed reason, leaves the session row untouched and audits it",
    async (_label, opts, code) => {
      const p = await seedUser("refuse");
      const accountId = await seedAccount(ORG_A, p.userId, opts);
      const s = await withCsrf(await signInByLink(p));
      const sessionId = await sessionIdOf(p.userId);
      const before = await sessionRow(sessionId);
      const res = await establish(s);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe(code);
      expect(await sessionRow(sessionId)).toEqual(before);
      const audit = await admin.query(
        "SELECT context FROM audit_event WHERE event_type='m2.portal.session_refused' AND resource_id=$1",
        [accountId],
      );
      expect(audit.rows.length).toBeGreaterThanOrEqual(1);
    },
  );

  it("refuses a tenant that is not active, and a user whose email never verified", async () => {
    const down = await seedUser("down");
    await seedAccount(ORG_DOWN, down.userId);
    const sDown = await withCsrf(await signInByLink(down));
    const r1 = await establish(sDown);
    expect(r1.statusCode).toBe(403);
    expect(r1.json().error.code).toBe("SIGN_IN_ORGANIZATION_NOT_ACTIVE");

    // Password sign-in does not verify the email: an account whose address never proved itself is refused.
    const email = emailOf("unverified");
    const password = `Wx9$${randomUUID()}Qz!`;
    await auth.api.signUpEmail({ body: { email, password, name: "Unverified" } });
    const userId = (await admin.query(`SELECT id FROM "user" WHERE email=$1`, [email])).rows[0]
      .id as string;
    await seedAccount(ORG_A, userId);
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: ORIGIN },
      payload: { email, password },
    });
    expect(signIn.statusCode).toBe(200);
    const sPw = await withCsrf(jar(signIn.cookies));
    const r2 = await establish(sPw);
    expect(r2.statusCode).toBe(403);
    expect(r2.json().error.code).toBe("SIGN_IN_EMAIL_UNVERIFIED");
    expect((await sessionRow(await sessionIdOf(userId))).active_organization_id).toBeNull();
  });

  it("two eligible accounts need a choice; another user's account id is indistinguishable from none", async () => {
    const p = await seedUser("multi");
    const accA = await seedAccount(ORG_A, p.userId);
    const accB = await seedAccount(ORG_B, p.userId);
    const stranger = await seedUser("stranger");
    const strangerAcc = await seedAccount(ORG_A, stranger.userId);
    const s = await withCsrf(await signInByLink(p));
    const sessionId = await sessionIdOf(p.userId);

    const none = await establish(s);
    expect(none.statusCode).toBe(409);
    expect(none.json().error.code).toBe("SIGN_IN_ACCOUNT_SELECTION_REQUIRED");
    expect((await sessionRow(sessionId)).active_organization_id).toBeNull();

    const foreign = await establish(s, { portalAccountId: strangerAcc });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error.code).toBe("SIGN_IN_NO_PORTAL_ACCOUNT");
    expect((await sessionRow(sessionId)).active_organization_id).toBeNull();

    const named = await establish(s, { portalAccountId: accB });
    expect(named.statusCode).toBe(200);
    const bound = await sessionRow(sessionId);
    expect(bound.active_organization_id).toBe(ORG_B);
    expect(bound.scope.portalAccountId).toBe(accB);
    expect(accA).not.toBe(accB);
    // A second, DIFFERENT bind of an already-bound session is a refusal, never a silent re-scope.
    const rebind = await establish(s, { portalAccountId: accA });
    expect(rebind.statusCode).toBe(409);
    expect(rebind.json().error.code).toBe("SIGN_IN_SESSION_NOT_BINDABLE");
    expect((await sessionRow(sessionId)).active_organization_id).toBe(ORG_B);
  });

  it("a staff session (org-bound, class staff) is never re-scoped by the portal bind", async () => {
    const p = await seedUser("staff");
    await seedAccount(ORG_A, p.userId);
    const s = await withCsrf(await signInByLink(p));
    const sessionId = await sessionIdOf(p.userId);
    // Bind the session to ORG_B as a staff session would be (the select-organization effect).
    await admin.query("UPDATE session SET active_organization_id=$1 WHERE id=$2", [
      ORG_B,
      sessionId,
    ]);
    const before = await sessionRow(sessionId);
    const res = await establish(s);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("SIGN_IN_SESSION_NOT_BINDABLE");
    expect(await sessionRow(sessionId)).toEqual(before);
  });

  it("a portal session holds portal keys only: a clinician who also signs into the portal reaches no clinical route", async () => {
    const p = await seedUser("both");
    await seedAccount(ORG_A, p.userId);
    // Give the same user an ACTIVE staff membership with a clinical role in ORG_A.
    const membership = (
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [p.userId, ORG_A],
      )
    ).rows[0].id as string;
    await admin.query(
      "INSERT INTO permission (key,resource,action,category) VALUES ('patient.read','patient','read','clinical') ON CONFLICT (key) DO NOTHING",
    );
    const role = (
      await admin.query(
        "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'both-nurse','Nurse','clinical_staff',true) RETURNING id",
        [ORG_A],
      )
    ).rows[0].id as string;
    await admin.query(
      "INSERT INTO role_permission (organization_id,role_id,permission_key) VALUES ($1,$2,'patient.read')",
      [ORG_A, role],
    );
    await admin.query(
      "INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)",
      [ORG_A, membership, role],
    );
    const s = await withCsrf(await signInByLink(p));
    expect((await establish(s)).statusCode).toBe(200);
    const portalSessionId = await sessionIdOf(p.userId);
    // The user's membership role grants `patient.read` to a STAFF session; the PORTAL session must not carry it,
    // while it does hold the portal keys. (Probe routes behind the real requirePermission.)
    const clinical = await get(s, "/__probe/clinical");
    expect(clinical.statusCode).toBe(403);
    const portal = await get(s, "/__probe/portal");
    expect(portal.statusCode).toBe(200);
    // The SAME user, as a plain staff session in the same tenant, does hold the clinical key.
    const staff = await withCsrf(await signInByLink(p));
    const staffSessionId = await sessionIdOf(p.userId);
    expect(staffSessionId).not.toBe(portalSessionId);
    await admin.query("UPDATE session SET active_organization_id=$1 WHERE id=$2", [
      ORG_A,
      staffSessionId,
    ]);
    expect((await get(staff, "/__probe/clinical")).statusCode).toBe(200);
    expect((await get(staff, "/__probe/portal")).statusCode).toBe(403);
  });

  it("failed binds trip the §5.3.1 budget: the sixth refusal is 429 with Retry-After", async () => {
    const p = await seedUser("lockout");
    await seedAccount(ORG_A, p.userId, { status: "invited" });
    const s = await withCsrf(await signInByLink(p));
    for (let i = 0; i < 5; i += 1) {
      expect((await establish(s)).statusCode).toBe(403);
    }
    const locked = await establish(s);
    expect(locked.statusCode).toBe(429);
    expect(locked.headers["retry-after"]).toBeDefined();
    expect(locked.json().error.code).toBe("TOO_MANY_FAILED_ATTEMPTS");
  });

  it("two concurrent binds of the same session converge: one row write, both callers succeed", async () => {
    const p = await seedUser("race");
    const accountId = await seedAccount(ORG_A, p.userId);
    const s = await withCsrf(await signInByLink(p));
    const results = await Promise.all([establish(s), establish(s), establish(s)]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    const flags = results.map((r) => r.json().replayed as boolean);
    expect(flags.filter((x) => x === false).length).toBe(1);
    const row = await sessionRow(await sessionIdOf(p.userId));
    expect(row.scope).toEqual({ portalAccountId: accountId });
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM audit_event WHERE event_type='m2.portal.session_established' AND resource_id=$1",
          [accountId],
        )
      ).rows[0].n,
    ).toBe(1);
  });
});
