/**
 * M2 funeral-home / external-collaborator LINK REDEMPTION, end to end over HTTP, LIVE Postgres, as the RLS-enforced
 * `chartwarden_app` role (GAP-115 follow-up; migration 0521 `collaborator_link`).
 *
 * The production composition, not a shim: REAL Better Auth mints the session cookie through the server-only link-session
 * plugin; the REAL durable store claims the use in one conditional UPDATE; the REAL authenticate hook / resolver /
 * effective-permission resolver (session-class permission set) / ABAC predicate answer the funeral read; the REAL
 * catalog-validating outbox publisher carries `m2.funeral.invited` and `m2.collaborator.session_started`.
 *
 * What it proves (assertions on database rows and HTTP answers):
 *   - invite -> email -> redeem -> scoped session -> the ONE read. The raw token appears in no table (not the link row,
 *     not an audit row, not an outbox row); only its sha256 is stored. The invite response never carries the token.
 *   - replay is refused (409), expiry and revocation are refused (410); a malformed token never 500s and writes nothing;
 *   - cross-tenant: the same secret under another tenant's prefix finds nothing; staff of tenant B cannot mint for tenant
 *     A's patient; a tenant-B funeral session reads tenant B's decedent only;
 *   - exactly one of N concurrent redeemers wins (use_count = 1, one session);
 *   - eligibility is re-proved at redemption (patient no longer deceased => refused, the use handed back);
 *   - a failing session mint hands the use back (the link is NOT burned) and a retry succeeds;
 *   - one active session per link (bounded multi-use link): the earlier session ends when the next is minted;
 *   - fail closed on delivery: no delivery port / a failing send => no live link (503), a living patient => 409, no
 *     recipient => 422;
 *   - a funeral session holds exactly `funeral.case_read`: it cannot mint links, and the synthetic principal cannot sign in;
 *   - RLS is intact: a bare chartwarden_app read of collaborator_link with no tenant returns nothing.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m2:link-redemption:live
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createCredentialThrottle,
  createDbActorEnrichmentReader,
  createDbSessionContextStore,
  createIdentityAuth,
  createInMemoryFailedLoginStore,
  createLinkSessionMinter,
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
import { buildServer, createSessionAuthenticate } from "../src/bootstrap/index";
import { registerSeam } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { funeralSessionPinnedPatientPredicate } from "../src/modules/02-identity/abac-predicates";
import {
  type LinkPatientSitePort,
  createDbCollaboratorLinkStore,
  hashLinkToken,
} from "../src/modules/02-identity/collaborator-link-store-db";
import {
  createContextActorResolver,
  createOrgScopedAuditExecutor,
  createOrgScopedIdentityOutbox,
} from "../src/modules/02-identity/identity-ports";
import { M2_OUTBOX_EVENTS } from "../src/modules/02-identity/index";
import { createLinkDelivery } from "../src/modules/02-identity/link-delivery";
import { registerLinkRoutes } from "../src/modules/02-identity/routes/link-routes";
import { createDbSessionWriter } from "../src/modules/02-identity/session-writer-db";
import {
  caseloadMembershipPredicate,
  createCaseloadProvider,
} from "../src/modules/05-patient/seams/caseload-provider";
import { funeralCaseForOrg } from "../src/modules/05-patient/seams/funeral-case-for-org";
import { patientIsDeceasedForOrg } from "../src/modules/05-patient/seams/patient-deceased-for-org";
import { patientSiteForOrg } from "../src/modules/06-admission/seams/patient-site-for-org";
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
const ORG_A = "11111111-1111-4111-8111-111111121001";
const ORG_B = "22222222-2222-4222-8222-222222221002";
const ORIGIN = "http://localhost:3000";
const FUNERAL_CASE_SECONDS = 72 * 3600;

describe.skipIf(!DB_URL)("M2 funeral / collaborator link redemption, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let auth: ReturnType<typeof createIdentityAuth>;
  let app: FastifyInstance;
  let appNoDelivery: FastifyInstance;
  let appFlaky: FastifyInstance;
  const sent: { to: string; text: string }[] = [];
  let failNextSend = false;
  let failNextMint = false;
  const pe: Record<string, string> = {};
  const deceasedA = { id: "", name: "Ada Lovelace", died: "2026-09-30" };
  let deceasedA2 = "";
  let livingA = "";
  let deceasedB = "";
  let staffA: { cookie: string; csrf: string; userId: string; membershipId: string };
  let staffB: { cookie: string; csrf: string; userId: string; membershipId: string };

  // ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────
  const tokenFromLastEmail = (): string => {
    const text = sent[sent.length - 1]?.text ?? "";
    const match = /#token=([^\s]+)/.exec(text);
    return decodeURIComponent(match?.[1] ?? "");
  };

  async function seedPatient(
    org: string,
    status: "active" | "deceased",
    last: string,
  ): Promise<string> {
    const id = (
      await admin.query(
        `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status,deceased_date)
         VALUES ($1,$2,'Ada',$3,'1930-12-10','F',$4,$5) RETURNING id`,
        [
          org,
          `MRN-${randomUUID().slice(0, 8)}`,
          last,
          status,
          status === "deceased" ? "2026-09-30" : null,
        ],
      )
    ).rows[0].id as string;
    await admin.query(
      "INSERT INTO admission (organization_id,provider_entity_id,patient_id) VALUES ($1,$2,$3)",
      [org, pe[org], id],
    );
    return id;
  }

  async function seedStaff(org: string, label: string) {
    const email = `${label}-${randomUUID().slice(0, 8)}@m2-link.test`;
    const password = `Wx9$${randomUUID()}Qz!`;
    await auth.api.signUpEmail({ body: { email, password, name: label } });
    const userId = (await admin.query(`SELECT id FROM "user" WHERE email=$1`, [email])).rows[0]
      .id as string;
    const membershipId = (
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [userId, org],
      )
    ).rows[0].id as string;
    const roleId = (
      await admin.query(
        "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,$2,'Social worker','clinical_staff',true) RETURNING id",
        [org, `sw-${randomUUID().slice(0, 6)}`],
      )
    ).rows[0].id as string;
    await admin.query(
      "INSERT INTO role_permission (organization_id,role_id,permission_key) VALUES ($1,$2,'funeral.invite'), ($1,$2,'collaborator.invite')",
      [org, roleId],
    );
    await admin.query(
      "INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)",
      [org, membershipId, roleId],
    );
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: ORIGIN },
      payload: { email, password },
    });
    expect(signIn.statusCode).toBe(200);
    const sessionId = (
      await admin.query(
        "SELECT id FROM session WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",
        [userId],
      )
    ).rows[0].id as string;
    // The effect of select-organization (the org bind); the link flow is what is under test here.
    await admin.query("UPDATE session SET active_organization_id=$1 WHERE id=$2", [org, sessionId]);
    const sessionCookies = signIn.cookies.filter((c) => c.name !== "chartwarden_csrf");
    // The CSRF double-submit pair: minted on the sign-in response when the request carried none.
    let csrf = signIn.cookies.find((c) => c.name === "chartwarden_csrf")?.value ?? "";
    if (!csrf) {
      const probe = await app.inject({ method: "GET", url: "/__probe/open" });
      csrf = probe.cookies.find((c) => c.name === "chartwarden_csrf")?.value ?? "";
    }
    const cookie = `${sessionCookies.map((c) => `${c.name}=${c.value}`).join("; ")}; chartwarden_csrf=${csrf}`;
    return { cookie, csrf, userId, membershipId };
  }

  const invite = (
    staff: { cookie: string; csrf: string },
    body: Record<string, unknown>,
    target: FastifyInstance = app,
    path = "/api/v1/funeral/invite",
  ) =>
    target.inject({
      method: "POST",
      url: path,
      headers: {
        cookie: staff.cookie,
        "x-csrf-token": staff.csrf,
        "idempotency-key": randomUUID(),
      },
      payload: body,
    });

  const redeem = (token: unknown, target: FastifyInstance = app) =>
    target.inject({
      method: "POST",
      url: "/api/v1/collaborators/consume",
      headers: { origin: ORIGIN, "idempotency-key": randomUUID() },
      payload: { token },
    });

  const linkRow = async (token: string) =>
    (
      await admin.query("SELECT * FROM collaborator_link WHERE token_hash=$1", [
        hashLinkToken(token),
      ])
    ).rows[0];

  const cookieOf = (res: { cookies: ReadonlyArray<{ name: string; value: string }> }) =>
    res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  async function issue(
    patientId: string,
    email = `funeral-${randomUUID().slice(0, 6)}@home.test`,
    staff = staffA,
  ): Promise<string> {
    const res = await invite(staff, { patientId, recipientEmail: email });
    expect(res.statusCode).toBe(201);
    return tokenFromLastEmail();
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
    for (const [org, slug] of [
      [ORG_A, "m2l-a"],
      [ORG_B, "m2l-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,$2,$2,$2,'active')",
        [org, slug],
      );
      pe[org] = (
        await admin.query(
          "INSERT INTO provider_entity (organization_id, legal_name, ccn, npi, tax_id_encrypted, fiscal_year_end, status) VALUES ($1,'PE',$2,$3,'x','1231','active') RETURNING id",
          [org, `CCN${slug}`, `NPI${slug}`],
        )
      ).rows[0].id as string;
    }
    for (const key of ["funeral.invite", "collaborator.invite"]) {
      await admin.query(
        "INSERT INTO permission (key,resource,action,category) VALUES ($1,'x','y','clinical') ON CONFLICT (key) DO NOTHING",
        [key],
      );
    }
    deceasedA.id = await seedPatient(ORG_A, "deceased", "Lovelace");
    deceasedA2 = await seedPatient(ORG_A, "deceased", "Babbage");
    livingA = await seedPatient(ORG_A, "active", "Living");
    deceasedB = await seedPatient(ORG_B, "deceased", "Turing");

    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    auth = createIdentityAuth(handle.db as never);

    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    registerDbEffectivePermissionResolver(handle.db as never);
    const registry = createPredicateRegistry();
    // GAP-001: the REAL M5 `caseload_membership` predicate body (not an allow-all stub) over the real
    // CaseloadProvider contract, so an M2<->M5 target-key mismatch cannot hide. Staff are assigned
    // to every patient of their own org (assignment rows are M5's and not under test).
    registerSeam(
      "CaseloadProvider",
      createCaseloadProvider({
        isAssigned: async (org, user) =>
          (user === staffA?.userId && org === ORG_A) || (user === staffB?.userId && org === ORG_B),
        assignedPatientIds: async () => [],
      }),
    );
    registry.register("caseload_membership", caseloadMembershipPredicate);
    registry.register(
      "funeral_session_pinned_patient",
      funeralSessionPinnedPatientPredicate as never,
    );
    registerAbacRegistry(registry);

    const site: LinkPatientSitePort = {
      siteForPatient: (organizationId, patientId) =>
        patientSiteForOrg(handle.db, organizationId, patientId),
    };
    const m2Publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M2_OUTBOX_EVENTS]));
    const outbox = createOrgScopedIdentityOutbox(handle.db, {
      publish: (tx, input) => m2Publisher.publish(tx, { ...input, callerModule: "m2" } as never),
    });
    const delivery = createLinkDelivery({
      transport: {
        async send(message) {
          if (failNextSend) {
            failNextSend = false;
            throw new Error("smtp down");
          }
          sent.push({ to: message.to, text: message.text });
        },
      },
      baseUrl: "https://portal.test",
    });
    const realMinter = createLinkSessionMinter(auth as never);
    const flakyMinter = {
      async mint(...args: Parameters<typeof realMinter.mint>) {
        if (failNextMint) {
          failNextMint = false;
          throw new Error("auth store unavailable");
        }
        return realMinter.mint(...args);
      },
    };
    const resolver = createSessionContextResolver(
      createDbSessionContextStore(
        handle.db as never,
        createDbActorEnrichmentReader(handle.db as never),
      ),
    );
    const buildApp = (extra: Record<string, unknown>): FastifyInstance => {
      const instance = buildServer({
        db: handle.db as never,
        security: { rateLimitEnabled: false },
        authenticate: createSessionAuthenticate({
          getSnapshot: (request) => getIdentitySession(auth, request.raw.headers),
          getResolver: () => resolver,
        }),
      });
      registerIdentityAuth(instance, auth);
      instance.get(
        "/__probe/open",
        { config: { auditRead: { none: "test probe" } } },
        async () => ({
          ok: true,
        }),
      );
      instance.get(
        "/__probe/clinical",
        {
          preHandler: [requirePermission("patient.read")],
          config: { auditRead: { none: "test probe" } },
        },
        async () => ({ ok: true }),
      );
      registerLinkRoutes(instance, {
        actors: createContextActorResolver(),
        sessions: createDbSessionWriter(handle.db),
        collaborators: createDbCollaboratorLinkStore(handle.db, { site }),
        deceasedPatients: {
          isDeceased: (org: string, patient: string) =>
            patientIsDeceasedForOrg(handle.db, org, patient),
        },
        audit: createOrgScopedAuditExecutor(handle.db),
        outbox,
        linkRecipientRequired: true,
        funeralCases: {
          read: (org: string, patient: string) => funeralCaseForOrg(handle.db, org, patient),
        },
        ...extra,
      } as never);
      return instance;
    };
    const throttle = createCredentialThrottle(createInMemoryFailedLoginStore(), {
      keyPrefix: "link-redeem",
      policy: { perUsernameLimit: 5, perIpLimit: 40, windowMs: 600_000 },
    });
    app = buildApp({
      linkSessions: flakyMinter,
      linkDelivery: delivery,
      linkRedeemThrottle: throttle,
    });
    appNoDelivery = buildApp({ linkSessions: realMinter });
    appFlaky = buildApp({ linkSessions: realMinter, linkDelivery: delivery });
    await Promise.all([app.ready(), appNoDelivery.ready(), appFlaky.ready()]);
    staffA = await seedStaff(ORG_A, "staff-a");
    staffB = await seedStaff(ORG_B, "staff-b");
  }, 300_000);

  afterAll(async () => {
    await Promise.all([app?.close(), appNoDelivery?.close(), appFlaky?.close()]);
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    await handle?.close();
    await admin?.end();
  });

  it("harness bites: a bare chartwarden_app read of collaborator_link with no tenant returns nothing", async () => {
    await issue(deceasedA.id);
    const asApp = await handle.pool.query("SELECT count(*)::int AS n FROM collaborator_link");
    const asSuper = await admin.query("SELECT count(*)::int AS n FROM collaborator_link");
    expect(asSuper.rows[0].n).toBeGreaterThanOrEqual(1);
    expect(asApp.rows[0].n).toBe(0);
    await expect(handle.pool.query("DELETE FROM collaborator_link")).rejects.toThrow();
  });

  it("invite -> email -> redeem -> scoped session -> the one read; the raw token is stored nowhere", async () => {
    const res = await invite(staffA, {
      patientId: deceasedA.id,
      recipientEmail: "director@home.test",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "linkId"]);
    const token = tokenFromLastEmail();
    expect(token).toMatch(new RegExp(`^${ORG_A}\\.[A-Za-z0-9_-]{43}$`));
    expect(sent[sent.length - 1]?.to).toBe("director@home.test");
    expect(sent[sent.length - 1]?.text).not.toMatch(/Lovelace|Ada/); // the email is PHI-free

    const row = await linkRow(token);
    expect(row.id).toBe(body.linkId);
    expect(row.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(row).toMatchObject({
      kind: "funeral_home",
      max_uses: 1,
      use_count: 0,
      patient_id: deceasedA.id,
    });
    expect(row.provider_entity_id).toBe(pe[ORG_A]);
    // The raw token (and its secret half) appear in no table: link row, audit, outbox.
    const secret = token.split(".")[1] as string;
    for (const [table, col] of [
      ["collaborator_link", "to_jsonb(t)::text"],
      ["audit_event", "to_jsonb(t)::text"],
      ["outbox_event", "to_jsonb(t)::text"],
    ] as const) {
      const hit = await admin.query(`SELECT count(*)::int n FROM ${table} t WHERE ${col} LIKE $1`, [
        `%${secret}%`,
      ]);
      expect(hit.rows[0].n).toBe(0);
    }
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM outbox_event WHERE event_type='m2.funeral.invited' AND organization_id=$1",
          [ORG_A],
        )
      ).rows[0].n,
    ).toBeGreaterThanOrEqual(1);

    // Redeem (no cookie, no session: the token is the credential).
    const redeemed = await redeem(token);
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json()).toMatchObject({
      sessionClass: "funeral_home",
      scope: { patientId: deceasedA.id },
    });
    expect(redeemed.cookies.some((c) => c.name.includes("session_token"))).toBe(true);
    const after = await linkRow(token);
    expect(after.use_count).toBe(1);
    expect(after.consumed_at).not.toBeNull();
    expect(after.principal_user_id).not.toBeNull();
    const principal = (
      await admin.query(`SELECT email FROM "user" WHERE id=$1`, [after.principal_user_id])
    ).rows[0];
    expect(principal.email).toMatch(/@principals\.chartwarden\.invalid$/);
    expect(
      (
        await admin.query("SELECT count(*)::int n FROM account WHERE user_id=$1", [
          after.principal_user_id,
        ])
      ).rows[0].n,
    ).toBe(0);

    const session = (
      await admin.query("SELECT * FROM session WHERE user_id=$1", [after.principal_user_id])
    ).rows;
    expect(session).toHaveLength(1);
    expect(session[0]).toMatchObject({
      session_class: "funeral_home",
      active_organization_id: ORG_A,
    });
    expect(session[0].scope).toEqual({ patientId: deceasedA.id });
    const lifetimeSec = (new Date(session[0].expires_at).getTime() - Date.now()) / 1000;
    expect(lifetimeSec).toBeGreaterThan(FUNERAL_CASE_SECONDS - 120);
    expect(lifetimeSec).toBeLessThanOrEqual(FUNERAL_CASE_SECONDS + 5);

    // The ONE read the session holds: the minimum decedent facts, session-pinned.
    const cookie = cookieOf(redeemed);
    const read = await app.inject({
      method: "GET",
      url: "/api/v1/funeral/case",
      headers: { cookie },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({
      patientId: deceasedA.id,
      decedentName: "Ada Lovelace",
      dateOfDeath: "2026-09-30",
    });
    expect(JSON.stringify(read.json())).not.toMatch(/dob|mrn|1930|sex/i);
    const readAudit = await admin.query(
      "SELECT 1 FROM audit_event WHERE resource_kind='funeral_case' AND organization_id=$1",
      [ORG_A],
    );
    expect(readAudit.rows.length).toBeGreaterThanOrEqual(1);
    // ...and nothing else: no clinical route, and it cannot mint links of its own.
    expect(
      (await app.inject({ method: "GET", url: "/__probe/clinical", headers: { cookie } }))
        .statusCode,
    ).toBe(403);
    const csrf = read.cookies.find((c) => c.name === "chartwarden_csrf")?.value ?? "x";
    const mint = await app.inject({
      method: "POST",
      url: "/api/v1/funeral/invite",
      headers: {
        cookie: `${cookie}; chartwarden_csrf=${csrf}`,
        "x-csrf-token": csrf,
        "idempotency-key": randomUUID(),
      },
      payload: { patientId: deceasedA.id, recipientEmail: "x@y.test" },
    });
    expect([401, 403]).toContain(mint.statusCode);

    // Audited: issued, redeemed, session started.
    const events = (
      await admin.query(
        "SELECT event_type FROM audit_event WHERE organization_id=$1 AND resource_id=$2",
        [ORG_A, body.linkId],
      )
    ).rows.map((r) => r.event_type);
    expect(events).toEqual(expect.arrayContaining(["m2.funeral.invited", "m2.link.redeemed"]));
  });

  it("replay is refused (409) and spends nothing more; the refusal is audited with the link id", async () => {
    const token = await issue(deceasedA2);
    expect((await redeem(token)).statusCode).toBe(200);
    const again = await redeem(token);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("LINK_ALREADY_USED");
    expect(again.cookies.some((c) => c.name.includes("session_token"))).toBe(false);
    const row = await linkRow(token);
    expect(row.use_count).toBe(1);
    expect(
      (
        await admin.query("SELECT count(*)::int n FROM session WHERE user_id=$1", [
          row.principal_user_id,
        ])
      ).rows[0].n,
    ).toBe(1);
    const refused = await admin.query(
      "SELECT context FROM audit_event WHERE event_type='m2.link.redemption_refused' AND resource_id=$1",
      [row.id],
    );
    expect(refused.rows[0].context).toMatchObject({ kind: "funeral_home", reason: "used" });
  });

  it("reuses a principal minted under the pre-rename domain instead of minting a second one", async () => {
    const token = await issue(deceasedA2);
    const row = await linkRow(token);
    const legacyEmail = `link-${row.id}@principals.wardenx.invalid`;
    const legacy = await admin.query(
      `INSERT INTO "user" (email, email_verified, name) VALUES ($1, true, 'External collaborator') RETURNING id`,
      [legacyEmail],
    );
    expect((await redeem(token)).statusCode).toBe(200);
    const after = await linkRow(token);
    expect(after.principal_user_id).toBe(legacy.rows[0].id);
    expect(
      (
        await admin.query(`SELECT count(*)::int n FROM "user" WHERE email LIKE $1`, [
          `link-${row.id}@%`,
        ])
      ).rows[0].n,
    ).toBe(1);
  });

  it("an expired link and a revoked link are refused (410) and mint no session", async () => {
    const expiredTok = await issue(deceasedA.id);
    await admin.query(
      "UPDATE collaborator_link SET expires_at = now() - interval '1 second' WHERE token_hash=$1",
      [hashLinkToken(expiredTok)],
    );
    const expired = await redeem(expiredTok);
    expect(expired.statusCode).toBe(410);
    expect((await linkRow(expiredTok)).use_count).toBe(0);

    const revokedTok = await issue(deceasedA.id);
    await admin.query("UPDATE collaborator_link SET revoked_at = now() WHERE token_hash=$1", [
      hashLinkToken(revokedTok),
    ]);
    const revoked = await redeem(revokedTok);
    expect(revoked.statusCode).toBe(410);
    expect((await linkRow(revokedTok)).use_count).toBe(0);
    const reasons = (
      await admin.query(
        "SELECT context->>'reason' r FROM audit_event WHERE event_type='m2.link.redemption_refused' AND resource_id IN ($1,$2)",
        [(await linkRow(expiredTok)).id, (await linkRow(revokedTok)).id],
      )
    ).rows.map((r) => r.r);
    expect(reasons.sort()).toEqual(["expired", "revoked"]);
  });

  it("malformed, truncated, foreign and unknown tokens answer 410 (or 422), never 500, and write nothing", async () => {
    const before = (await admin.query("SELECT count(*)::int n FROM session")).rows[0].n;
    const auditBefore = (await admin.query("SELECT count(*)::int n FROM audit_event")).rows[0].n;
    for (const bad of [
      "garbage",
      `${ORG_A}.short`,
      `${ORG_A}.${"A".repeat(43)}`, // well-formed, unknown secret
      `${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}.${"A".repeat(43)}`, // unknown org
      `${ORG_A}.${"A".repeat(44)}`,
      "' OR 1=1 --",
    ]) {
      const res = await redeem(bad);
      expect([410, 422]).toContain(res.statusCode);
    }
    expect((await redeem("")).statusCode).toBe(422);
    expect((await redeem({ evil: true })).statusCode).toBe(422);
    expect((await admin.query("SELECT count(*)::int n FROM session")).rows[0].n).toBe(before);
    // An unknown token leaves no audit row (nothing to attribute it to) - no oracle, no log flooding.
    expect((await admin.query("SELECT count(*)::int n FROM audit_event")).rows[0].n).toBe(
      auditBefore,
    );
  });

  it("cross-tenant: the same secret under another tenant's prefix finds nothing, and tenant B cannot mint for tenant A's patient", async () => {
    const token = await issue(deceasedA.id);
    const secret = token.split(".")[1] as string;
    const swapped = `${ORG_B}.${secret}`;
    const res = await redeem(swapped);
    expect(res.statusCode).toBe(410);
    expect((await linkRow(token)).use_count).toBe(0);
    expect((await linkRow(swapped)) ?? null).toBeNull();

    // Staff of B asks for a funeral link for A's decedent: not deceased IN B, so refused; no row for A's patient is created.
    const rowsBefore = (
      await admin.query("SELECT count(*)::int n FROM collaborator_link WHERE patient_id=$1", [
        deceasedA.id,
      ])
    ).rows[0].n;
    const cross = await invite(staffB, { patientId: deceasedA.id, recipientEmail: "x@y.test" });
    expect(cross.statusCode).toBe(409);
    expect(
      (
        await admin.query("SELECT count(*)::int n FROM collaborator_link WHERE patient_id=$1", [
          deceasedA.id,
        ])
      ).rows[0].n,
    ).toBe(rowsBefore);

    // A tenant-B funeral link reads tenant B's decedent only.
    const tokenB = await issue(deceasedB, "b@home.test", staffB);
    expect(tokenB.startsWith(ORG_B)).toBe(true);
    const redeemedB = await redeem(tokenB);
    expect(redeemedB.statusCode).toBe(200);
    const readB = await app.inject({
      method: "GET",
      url: "/api/v1/funeral/case",
      headers: { cookie: cookieOf(redeemedB) },
    });
    expect(readB.json().decedentName).toBe("Ada Turing");
    expect(
      (
        await admin.query("SELECT active_organization_id FROM session WHERE user_id=$1", [
          (await linkRow(tokenB)).principal_user_id,
        ])
      ).rows[0].active_organization_id,
    ).toBe(ORG_B);
  });

  it("exactly one of N concurrent redeemers wins; the rest are told 'already used'", async () => {
    const token = await issue(deceasedA.id);
    const results = await Promise.all(Array.from({ length: 6 }, () => redeem(token)));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(5);
    const row = await linkRow(token);
    expect(row.use_count).toBe(1);
    expect(
      (
        await admin.query("SELECT count(*)::int n FROM session WHERE user_id=$1", [
          row.principal_user_id,
        ])
      ).rows[0].n,
    ).toBe(1);
  });

  it("eligibility is re-proved at redemption: a patient who is no longer deceased reads nothing and the use is handed back", async () => {
    const patient = await seedPatient(ORG_A, "deceased", "Reversed");
    const token = await issue(patient);
    await admin.query("UPDATE patient SET status='active', deceased_date=NULL WHERE id=$1", [
      patient,
    ]);
    const res = await redeem(token);
    expect(res.statusCode).toBe(410);
    const row = await linkRow(token);
    expect(row.use_count).toBe(0);
    expect(
      (
        await admin.query("SELECT count(*)::int n FROM session WHERE user_id=$1", [
          row.principal_user_id,
        ])
      ).rows[0].n,
    ).toBe(0);
    const refused = await admin.query(
      "SELECT context->>'reason' r FROM audit_event WHERE event_type='m2.link.redemption_refused' AND resource_id=$1",
      [row.id],
    );
    expect(refused.rows[0].r).toBe("not_eligible");
  });

  it("a failed session mint hands the use back: the link is NOT burned and a retry succeeds", async () => {
    const token = await issue(deceasedA.id);
    failNextMint = true;
    const failed = await redeem(token);
    expect(failed.statusCode).toBe(503);
    expect(failed.json().error.code).toBe("LINK_SESSION_UNAVAILABLE");
    const row = await linkRow(token);
    expect(row.use_count).toBe(0);
    expect(row.consumed_at).toBeNull();
    const retry = await redeem(token);
    expect(retry.statusCode).toBe(200);
    expect((await linkRow(token)).use_count).toBe(1);
  });

  it("a bounded multi-use link keeps ONE active session: redeeming again ends the earlier session", async () => {
    const store = createDbCollaboratorLinkStore(handle.db, {
      site: { siteForPatient: (o, p) => patientSiteForOrg(handle.db, o, p) },
    });
    const created = await store.create({
      organizationId: ORG_A,
      patientId: deceasedA.id,
      invitedByMembershipId: staffA.membershipId,
      kind: "funeral_home",
      maxUses: 2,
    });
    const token = created.token as string;
    const first = await redeem(token);
    const second = await redeem(token);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    const row = await linkRow(token);
    expect(row.use_count).toBe(2);
    const sessions = await admin.query("SELECT id FROM session WHERE user_id=$1", [
      row.principal_user_id,
    ]);
    expect(sessions.rows).toHaveLength(1);
    // The FIRST cookie no longer resolves to a session.
    const stale = await app.inject({
      method: "GET",
      url: "/api/v1/funeral/case",
      headers: { cookie: cookieOf(first) },
    });
    expect([401, 403]).toContain(stale.statusCode);
    const live = await app.inject({
      method: "GET",
      url: "/api/v1/funeral/case",
      headers: { cookie: cookieOf(second) },
    });
    expect(live.statusCode).toBe(200);
    // A third use is refused: the bound is the bound.
    expect((await redeem(token)).statusCode).toBe(409);
  });

  it("fails closed on delivery: no delivery port, a failing send, a living patient and a missing recipient mint no live link", async () => {
    const count = async () =>
      (await admin.query("SELECT count(*)::int n FROM collaborator_link")).rows[0].n as number;

    const base = await count();
    const noDelivery = await invite(
      staffA,
      { patientId: deceasedA.id, recipientEmail: "a@b.test" },
      appNoDelivery,
    );
    expect(noDelivery.statusCode).toBe(503);
    expect(noDelivery.json().error.code).toBe("LINK_DELIVERY_UNAVAILABLE");
    expect(await count()).toBe(base);

    failNextSend = true;
    const failing = await invite(
      staffA,
      { patientId: deceasedA.id, recipientEmail: "a@b.test" },
      appFlaky,
    );
    expect(failing.statusCode).toBe(503);
    expect(failing.json().error.code).toBe("LINK_DELIVERY_FAILED");
    const dead = await admin.query(
      "SELECT revoked_at FROM collaborator_link WHERE patient_id=$1 ORDER BY created_at DESC LIMIT 1",
      [deceasedA.id],
    );
    expect(dead.rows[0].revoked_at).not.toBeNull(); // minted, undeliverable, therefore revoked at once

    const living = await invite(staffA, { patientId: livingA, recipientEmail: "a@b.test" });
    expect(living.statusCode).toBe(409);
    expect(living.json().error.code).toBe("PATIENT_NOT_DECEASED");
    expect(
      (
        await admin.query("SELECT count(*)::int n FROM collaborator_link WHERE patient_id=$1", [
          livingA,
        ])
      ).rows[0].n,
    ).toBe(0);

    const noRecipient = await invite(staffA, { patientId: deceasedA.id });
    expect(noRecipient.statusCode).toBe(422);
    const badRecipient = await invite(staffA, {
      patientId: deceasedA.id,
      recipientEmail: "not-an-email",
    });
    expect(badRecipient.statusCode).toBe(422);
  });

  it("the synthetic principal cannot sign in any other way", async () => {
    const token = await issue(deceasedA.id);
    expect((await redeem(token)).statusCode).toBe(200);
    const principalEmail = (
      await admin.query(`SELECT email FROM "user" WHERE id=$1`, [
        (await linkRow(token)).principal_user_id,
      ])
    ).rows[0].email as string;
    const attempt = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: ORIGIN },
      payload: { email: principalEmail, password: "Wx9$AnyPasswordAtAll12345!" },
    });
    expect(attempt.statusCode).toBeGreaterThanOrEqual(400);
    expect(attempt.cookies.some((c) => c.name.includes("session_token"))).toBe(false);
  });

  it("failed redemptions trip the per-IP budget: further attempts get 429 with Retry-After", async () => {
    const tight = buildTightApp();
    await tight.ready();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await redeem(`${ORG_A}.${"B".repeat(43)}`, tight)).statusCode);
    }
    expect(statuses.slice(0, 3)).toEqual([410, 410, 410]);
    const locked = await redeem(`${ORG_A}.${"B".repeat(43)}`, tight);
    expect(locked.statusCode).toBe(429);
    expect(locked.headers["retry-after"]).toBeDefined();
    await tight.close();
  });

  /** A server whose failed-redemption budget is 3 per IP, to prove the lockout without 30 requests. */
  function buildTightApp(): FastifyInstance {
    const resolver = createSessionContextResolver(
      createDbSessionContextStore(
        handle.db as never,
        createDbActorEnrichmentReader(handle.db as never),
      ),
    );
    const instance = buildServer({
      db: handle.db as never,
      security: { rateLimitEnabled: false },
      authenticate: createSessionAuthenticate({
        getSnapshot: (request) => getIdentitySession(auth, request.raw.headers),
        getResolver: () => resolver,
      }),
    });
    registerLinkRoutes(instance, {
      actors: createContextActorResolver(),
      sessions: createDbSessionWriter(handle.db),
      collaborators: createDbCollaboratorLinkStore(handle.db, {
        site: { siteForPatient: (o, p) => patientSiteForOrg(handle.db, o, p) },
      }),
      audit: createOrgScopedAuditExecutor(handle.db),
      linkSessions: createLinkSessionMinter(auth as never),
      linkRedeemThrottle: createCredentialThrottle(createInMemoryFailedLoginStore(), {
        keyPrefix: "link-redeem",
        policy: { perUsernameLimit: 5, perIpLimit: 3, windowMs: 600_000 },
      }),
    } as never);
    return instance;
  }
});
