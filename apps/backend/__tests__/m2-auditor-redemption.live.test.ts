/**
 * M2/M3 auditor magic-link REDEMPTION (the batch-11 GAP-011 deferral) — LIVE Postgres as the real
 * NOBYPASSRLS `chartwarden_app` role, through a real Better Auth instance and the real authenticate hook.
 * Proves, end to end:
 *   1. a link is redeemed once into a signed `auditor`-class ENROLMENT session scoped to ONE engagement and
 *      bounded by the engagement window; it holds NO role and cannot read until the BAA is accepted and a
 *      second factor enrolled (the full ceremony is proven in m2-auditor-enrolment.live.test.ts), after
 *      which it carries exactly one least-privilege role (the cookie is resolved by the ordinary Better Auth
 *      path, the session store and `requirePermission`);
 *   2. the token is stored only as a sha-256 digest and never reaches the audit log;
 *   3. replay, expiry, revocation, a not-yet-open window and a cancelled engagement are REFUSED, the refusal
 *      of a real link is audited, and an unknown token is not (no audit flooding);
 *   4. org isolation — another tenant's id cannot redeem (or even reveal) a link;
 *   5. concurrent redemptions yield exactly one session; a second engagement replaces the first session
 *      (no concurrent auditor sessions);
 *   6. the session is read-only (a write is AUDITOR_READ_ONLY 403), holds only the one read permission, the
 *      use of the session is audited, and the session dies with its engagement window;
 *   7. an existing staff member's email is refused (an auditor must not inherit staff permissions);
 *   8. the attempt budget answers 429.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m2:auditor-redemption:live
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createAuditorSessionIssuer,
  createDbActorEnrichmentReader,
  createDbSessionContextStore,
  createDbSessionTimeoutEnforcer,
  createIdentityAuth,
  getIdentitySession,
  registerAbacRegistry,
  registerDbEffectivePermissionResolver,
  requirePermission,
  resetAbacRegistry,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, createSessionAuthenticate, getSeam } from "../src/bootstrap/index";
import { createAuditorEnrolment } from "../src/modules/02-identity/auditor-enrolment";
import {
  createDbAuditorMagicLinkIssuer,
  generateAuditorToken,
  hashAuditorToken,
} from "../src/modules/02-identity/auditor-magic-link-store";
import { registerAuditorEnrolmentRoutes } from "../src/modules/02-identity/routes/auditor-enrolment";
import { registerAuditorRedeemRoutes } from "../src/modules/02-identity/routes/auditor-redeem";
import { registerIdentitySeams } from "../src/modules/02-identity/seams";
import {
  EXTERNAL_AUDITOR_PERMISSIONS,
  createDbAuditorAccessGrantor,
  createDbAuditorEngagementReader,
} from "../src/modules/03-authorization/index";
import { enrolFirstTime } from "./_auditor-enrol-helper";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "chartwarden_app",
  "chartwarden_admin",
  "chartwarden_readonly",
  "chartwarden_audit_writer",
  "mdm_canonical_writer",
  "wardenx_report_writer",
];

const ORG_A = "11111111-1111-4111-8111-111111a20201";
const ORG_B = "11111111-1111-4111-8111-111111b20201";
const STAFF = "22222222-2222-4222-8222-222222a20201";
const PATIENT = "33333333-3333-4333-8333-333333a20201";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe.skipIf(!DB_URL)("M2/M3 auditor magic-link redemption — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let app: ReturnType<typeof buildServer>;
  let limitedApp: ReturnType<typeof buildServer>;
  let seq = 0;
  let rbac: ReturnType<typeof registerDbEffectivePermissionResolver>;

  const issuer = () => createDbAuditorMagicLinkIssuer(handle.db);
  const cookieOf = (setCookie: string | string[] | undefined): string => {
    const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const hit = list.find((c) => c.startsWith("better-auth.session_token="));
    if (!hit) throw new Error(`no session cookie in ${JSON.stringify(list)}`);
    return (hit.split(";")[0] as string).trim();
  };

  async function engagement(
    org: string,
    over: { start?: Date; end?: Date; status?: string } = {},
  ): Promise<{ id: string; start: Date; end: Date }> {
    const start = over.start ?? new Date(Date.now() - HOUR);
    const end = over.end ?? new Date(Date.now() + 3 * DAY);
    const { rows } = await admin.query(
      `INSERT INTO auditor_engagement (organization_id, engagement_type, auditor_agency, scope, status, start_at, end_at, reason)
       VALUES ($1,'cms_survey','CMS',$2::jsonb,$3,$4,$5,'live test') RETURNING id`,
      [org, JSON.stringify({ patientIds: [PATIENT] }), over.status ?? "active", start, end],
    );
    return { id: rows[0].id, start, end };
  }

  /** Mint a real link through the production issuer; returns the raw token and the auditor's email. */
  async function link(
    org: string,
    eng: { id: string; start: Date; end: Date },
    email = `auditor${++seq}@survey.test`,
  ) {
    const { magicLinkToken } = await issuer().issue({
      organizationId: org,
      engagementId: eng.id,
      identity: { name: "Ada Auditor", email },
      window: { start: eng.start, end: eng.end },
    });
    return { token: magicLinkToken, email };
  }

  const redeem = (
    organizationId: string,
    token: string,
    server: ReturnType<typeof buildServer> = app,
  ) =>
    server.inject({
      method: "POST",
      url: "/api/v1/auditors/redeem",
      payload: { organizationId, token },
    });

  /** Redeem a fresh link and take the enrolment session to ACTIVE (BAA + first-time TOTP). */
  async function activeSession(
    org: string,
    eng: { id: string; start: Date; end: Date },
    email = `auditor${++seq}@survey.test`,
  ): Promise<{ cookie: string; email: string; token: string }> {
    const { token } = await link(org, eng, email);
    const res = await redeem(org, token);
    expect(res.statusCode).toBe(200);
    const cookie = cookieOf(res.headers["set-cookie"]);
    await enrolFirstTime(app, cookie);
    return { cookie, email, token };
  }

  const auditCount = async (eventType: string, org: string) =>
    Number(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM audit_event WHERE event_type=$1 AND organization_id=$2",
          [eventType, org],
        )
      ).rows[0].n,
    );

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET ??= "test-secret-at-least-32-characters-long-xx";
    process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
    process.env.TWO_FACTOR_ENCRYPTION_KEY ??= "Y2ktMmZhLXRlc3Qta2V5LTAxMjM0NTY3ODlhYmNkZWY=";
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'aud-a','A','A','active'),($2,'aud-b','B','B','active')",
      [ORG_A, ORG_B],
    );
    // A staff member of org A (a role-holding member) — the "identity is a member" case.
    await admin.query(
      `INSERT INTO "user" (id,email,name,email_verified) VALUES ($1,'staff@a.test','Sam Staff',true)`,
      [STAFF],
    );
    const { rows: m } = await admin.query(
      "INSERT INTO membership (user_id, organization_id, status, accepted_at) VALUES ($1,$2,'active',now()) RETURNING id",
      [STAFF, ORG_A],
    );
    const { rows: r } = await admin.query(
      `INSERT INTO role (organization_id, key, name, category, scope_level) VALUES ($1,'clinical_rn','RN','clinical_staff','organization') RETURNING id`,
      [ORG_A],
    );
    await admin.query(
      "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
      [ORG_A, m[0].id, r[0].id],
    );

    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    const auth = createIdentityAuth(handle.db as never);

    registerIdentitySeams({
      sessions: createDbSessionContextStore(handle.db, createDbActorEnrichmentReader(handle.db)),
      db: handle.db,
    });
    rbac = registerDbEffectivePermissionResolver(handle.db);
    registerAbacRegistry(); // the shared registry: `auditor_enrolment_session` registers on route mount

    const authenticate = createSessionAuthenticate({
      getSnapshot: (request) => getIdentitySession(auth, request.raw.headers),
      getResolver: () => getSeam("SessionContextResolver"),
      sessionTimeout: createDbSessionTimeoutEnforcer(handle.db),
    });
    const mount = (ipLimit?: number) => {
      const server = buildServer({
        authenticate,
        db: handle.db,
        security: { rateLimitEnabled: false },
        registerModuleRoutes: (instance) => {
          let hits = 0;
          const access = createDbAuditorAccessGrantor();
          registerAuditorEnrolmentRoutes(instance, {
            enrolment: createAuditorEnrolment({
              db: handle.db,
              access,
              onActivated: (organizationId, userId) =>
                rbac?.invalidateActor(organizationId, userId),
            }),
          });
          registerAuditorRedeemRoutes(instance, {
            redemption: {
              db: handle.db,
              sessions: createAuditorSessionIssuer(auth),
              access,
            },
            ...(ipLimit
              ? {
                  ipLimiter: {
                    consume: async () => ({ allowed: ++hits <= ipLimit, retryAfterSeconds: 900 }),
                  },
                }
              : {}),
          });
          // Probes: the one permission an auditor holds, a staff-only permission, and a write.
          instance.get(
            "/api/v1/auditor/portal-engagement/:engagementId",
            {
              preHandler: [
                requirePermission("portal.engagement.read_auditor") as (
                  request: FastifyRequest,
                  reply: FastifyReply,
                ) => Promise<void>,
              ],
              config: {
                auditRead: {
                  resourceKind: "portal_engagement",
                  resourceIdParam: "engagementId",
                  list: false,
                },
              },
            },
            async (request) => ({
              sessionClass: request.context.attributes?.sessionClass,
              engagementId: request.context.attributes?.engagementId,
              userId: request.context.userId,
            }),
          );
          instance.get(
            "/api/v1/probe/staff-only",
            {
              preHandler: [
                requirePermission("patient.read") as (
                  request: FastifyRequest,
                  reply: FastifyReply,
                ) => Promise<void>,
              ],
            },
            async () => ({ ok: true }),
          );
          instance.post("/api/v1/probe/write", async () => ({ wrote: true }));
        },
      });
      return server;
    };
    app = mount();
    limitedApp = mount(2);
  }, 240_000);

  afterAll(async () => {
    resetAbacRegistry();
    await app?.close();
    await limitedApp?.close();
    await handle?.close();
    await admin?.end();
  });

  it("redeems a link ONCE into a signed, engagement-scoped, window-bounded auditor session", async () => {
    const eng = await engagement(ORG_A);
    const { token, email } = await link(ORG_A, eng);

    const res = await redeem(ORG_A, token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      sessionClass: "auditor",
      stage: "enrolment",
      organizationId: ORG_A,
      engagementId: eng.id,
    });
    expect(res.headers["cache-control"]).toBe("no-store");
    const cookie = cookieOf(res.headers["set-cookie"]);

    // BEFORE enrolment: the possession of the link alone reads NOTHING and holds NO role.
    const early = await app.inject({
      method: "GET",
      url: `/api/v1/auditor/portal-engagement/${eng.id}`,
      headers: { cookie },
    });
    expect(early.statusCode).toBe(403);
    expect(early.json().error?.code ?? early.json().code).toBe("AUDITOR_ENROLMENT_REQUIRED");
    const noRole = await admin.query(
      `SELECT count(*)::int AS n FROM membership_role mr JOIN membership m ON m.id = mr.membership_id
         JOIN "user" u ON u.id = m.user_id WHERE u.email = $1`,
      [email],
    );
    expect(Number(noRole.rows[0].n)).toBe(0);
    await enrolFirstTime(app, cookie);

    // The session row: auditor class, bound to ONE engagement and its window; never outlives it.
    const { rows } = await admin.query(
      `SELECT s.session_class::text AS cls, s.active_organization_id, s.scope, s.engagement_start, s.engagement_end,
              s.expires_at, s.last_step_up_at, u.id AS user_id, u.email_verified
         FROM session s JOIN "user" u ON u.id = s.user_id WHERE u.email = $1`,
      [email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].cls).toBe("auditor");
    expect(rows[0].active_organization_id).toBe(ORG_A);
    expect(rows[0].scope).toMatchObject({ engagementId: eng.id, auditorStage: "active" });
    expect(new Date(rows[0].engagement_end).getTime()).toBe(eng.end.getTime());
    expect(new Date(rows[0].expires_at).getTime()).toBe(eng.end.getTime());
    expect(rows[0].last_step_up_at).not.toBeNull(); // TOTP proven during enrolment stamps the step-up
    expect(rows[0].email_verified).toBe(true);

    // Least privilege: one role, one permission, expiring with the window.
    const grants = await admin.query(
      `SELECT r.key, mr.expires_at, mr.scope,
              (SELECT array_agg(rp.permission_key) FROM role_permission rp WHERE rp.role_id = r.id) AS perms
         FROM membership_role mr JOIN role r ON r.id = mr.role_id
         JOIN membership m ON m.id = mr.membership_id WHERE m.user_id = $1`,
      [rows[0].user_id],
    );
    expect(grants.rows).toHaveLength(1);
    expect(grants.rows[0].key).toBe("external_auditor");
    expect(grants.rows[0].perms).toEqual([...EXTERNAL_AUDITOR_PERMISSIONS]);
    expect(new Date(grants.rows[0].expires_at).getTime()).toBe(eng.end.getTime());
    expect(grants.rows[0].scope).toEqual({ engagementId: eng.id });

    // The link is consumed; only its digest is at rest, and the raw token is nowhere in the audit log.
    const stored = await admin.query(
      "SELECT token_hash, consumed_at FROM auditor_magic_link WHERE auditor_email = $1",
      [email],
    );
    expect(stored.rows[0].consumed_at).not.toBeNull();
    expect(stored.rows[0].token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(stored.rows[0].token_hash).not.toContain(token);
    expect(
      Number(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM audit_event WHERE context::text LIKE $1 OR after::text LIKE $1 OR before::text LIKE $1",
            [`%${token}%`],
          )
        ).rows[0].n,
      ),
    ).toBe(0);

    // Redemption is audited under the AUDITOR's own identity.
    const ev = await admin.query(
      `SELECT actor_user_id, outcome::text AS outcome, context FROM audit_event
        WHERE event_type='m2.auditor_link.redeemed' AND organization_id=$1 AND actor_user_id=$2`,
      [ORG_A, rows[0].user_id],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].context).toMatchObject({ engagementId: eng.id });

    // The cookie resolves through the ORDINARY path; the one read works, its use is audited.
    const view = await app.inject({
      method: "GET",
      url: `/api/v1/auditor/portal-engagement/${eng.id}`,
      headers: { cookie },
    });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({
      sessionClass: "auditor",
      engagementId: eng.id,
      userId: rows[0].user_id,
    });
    const used = await admin.query(
      `SELECT count(*)::int AS n FROM audit_event WHERE actor_user_id=$1 AND event_type LIKE 'portal_engagement.%'`,
      [rows[0].user_id],
    );
    expect(Number(used.rows[0].n)).toBeGreaterThanOrEqual(1);

    // M3's reader confirms the engagement is live for this auditor and what it covers.
    const reader = createDbAuditorEngagementReader(handle.db);
    await expect(
      reader.engagementScope({
        organizationId: ORG_A,
        engagementId: eng.id,
        auditorUserId: rows[0].user_id,
        at: new Date().toISOString(),
      }),
    ).resolves.toMatchObject({ patientIds: [PATIENT] });

    // Minimum permissions: a staff-only read is denied, and any write is refused outright.
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/probe/staff-only", headers: { cookie } }))
        .statusCode,
    ).toBe(403);
    const write = await app.inject({
      method: "POST",
      url: "/api/v1/probe/write",
      headers: { cookie },
      payload: {},
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().error?.code ?? write.json().code).toBe("AUDITOR_READ_ONLY");
  });

  it("REFUSES a replay (409), audits the refusal, and mints no second session", async () => {
    const eng = await engagement(ORG_A);
    const { token, email } = await link(ORG_A, eng);
    expect((await redeem(ORG_A, token)).statusCode).toBe(200);
    const before = await auditCount("m2.auditor_link.refused", ORG_A);

    const replay = await redeem(ORG_A, token);
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error?.code ?? replay.json().code).toBe("LINK_ALREADY_USED");
    expect(replay.headers["set-cookie"] ?? "").not.toContain("better-auth.session_token");
    expect(await auditCount("m2.auditor_link.refused", ORG_A)).toBe(before + 1);
    const n = await admin.query(
      `SELECT count(*)::int AS n FROM session s JOIN "user" u ON u.id=s.user_id WHERE u.email=$1`,
      [email],
    );
    expect(Number(n.rows[0].n)).toBe(1);
  });

  it("REFUSES expired, not-yet-open, revoked and cancelled-engagement links without consuming them", async () => {
    const past = await engagement(ORG_A, {
      start: new Date(Date.now() - 3 * DAY),
      end: new Date(Date.now() - 2 * DAY),
    });
    // issue() accepts any window; the redemption must refuse it as expired.
    const expired = await link(ORG_A, past);
    const r1 = await redeem(ORG_A, expired.token);
    expect(r1.statusCode).toBe(410);
    expect(r1.json().error?.code ?? r1.json().code).toBe("LINK_EXPIRED");

    const future = await engagement(ORG_A, {
      start: new Date(Date.now() + DAY),
      end: new Date(Date.now() + 4 * DAY),
      status: "scheduled",
    });
    const early = await link(ORG_A, future);
    const r2 = await redeem(ORG_A, early.token);
    expect(r2.statusCode).toBe(403);
    expect(r2.json().error?.code ?? r2.json().code).toBe("ENGAGEMENT_NOT_OPEN");

    const live = await engagement(ORG_A);
    const revoked = await link(ORG_A, live);
    await admin.query("UPDATE auditor_magic_link SET revoked_at = now() WHERE token_hash = $1", [
      hashAuditorToken(revoked.token),
    ]);
    const r3 = await redeem(ORG_A, revoked.token);
    expect(r3.statusCode).toBe(410);
    expect(r3.json().error?.code ?? r3.json().code).toBe("LINK_INVALID");

    const cancelled = await engagement(ORG_A);
    const cancelledLink = await link(ORG_A, cancelled);
    await admin.query("UPDATE auditor_engagement SET status='cancelled' WHERE id=$1", [
      cancelled.id,
    ]);
    const r4 = await redeem(ORG_A, cancelledLink.token);
    expect(r4.statusCode).toBe(403);
    expect(r4.json().error?.code ?? r4.json().code).toBe("ENGAGEMENT_NOT_ACTIVE");
    const unconsumed = await admin.query(
      "SELECT consumed_at FROM auditor_magic_link WHERE token_hash = $1",
      [hashAuditorToken(cancelledLink.token)],
    );
    expect(unconsumed.rows[0].consumed_at).toBeNull();
    // none of the four produced a session
    const sessions = await admin.query(
      `SELECT count(*)::int AS n FROM session s JOIN "user" u ON u.id=s.user_id WHERE u.email = ANY($1)`,
      [[expired.email, early.email, revoked.email, cancelledLink.email]],
    );
    expect(Number(sessions.rows[0].n)).toBe(0);
  });

  it("is tenant-scoped: another org cannot redeem or reveal a link; an unknown token is not audited", async () => {
    const eng = await engagement(ORG_A);
    const { token } = await link(ORG_A, eng);
    const beforeB = await auditCount("m2.auditor_link.refused", ORG_B);
    const cross = await redeem(ORG_B, token);
    expect(cross.statusCode).toBe(410);
    expect(cross.json().error?.code ?? cross.json().code).toBe("LINK_INVALID");
    const stillLive = await admin.query(
      "SELECT consumed_at FROM auditor_magic_link WHERE token_hash=$1",
      [hashAuditorToken(token)],
    );
    expect(stillLive.rows[0].consumed_at).toBeNull();
    expect(await auditCount("m2.auditor_link.refused", ORG_B)).toBe(beforeB);

    const beforeA = await auditCount("m2.auditor_link.refused", ORG_A);
    const unknown = await redeem(ORG_A, generateAuditorToken());
    expect(unknown.statusCode).toBe(410);
    expect(await auditCount("m2.auditor_link.refused", ORG_A)).toBe(beforeA); // anonymous noise is not audited
    // and the legitimate holder can still redeem it in the right org
    expect((await redeem(ORG_A, token)).statusCode).toBe(200);
  });

  it("validates the body (422) and never accepts extra fields", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/auditors/redeem",
      payload: { organizationId: ORG_A, token: "short" },
    });
    expect(bad.statusCode).toBe(422);
    const extra = await app.inject({
      method: "POST",
      url: "/api/v1/auditors/redeem",
      payload: { organizationId: ORG_A, token: generateAuditorToken(), sessionClass: "staff" },
    });
    expect(extra.statusCode).toBe(422);
  });

  it("serializes concurrent redemptions: exactly ONE session", async () => {
    const eng = await engagement(ORG_A);
    const { token, email } = await link(ORG_A, eng);
    const results = await Promise.all(Array.from({ length: 6 }, () => redeem(ORG_A, token)));
    const ok = results.filter((r) => r.statusCode === 200);
    expect(ok).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409).length).toBe(5);
    const n = await admin.query(
      `SELECT count(*)::int AS n FROM session s JOIN "user" u ON u.id=s.user_id WHERE u.email=$1`,
      [email],
    );
    expect(Number(n.rows[0].n)).toBe(1);
  });

  it("allows no concurrent auditor sessions: a second engagement link replaces the first session", async () => {
    const email = `repeat${++seq}@survey.test`;
    const e1 = await engagement(ORG_A);
    const e2 = await engagement(ORG_A);
    const first = await redeem(ORG_A, (await link(ORG_A, e1, email)).token);
    const firstCookie = cookieOf(first.headers["set-cookie"]);
    const second = await redeem(ORG_A, (await link(ORG_A, e2, email)).token);
    expect(second.statusCode).toBe(200);
    const secondCookie = cookieOf(second.headers["set-cookie"]);
    await enrolFirstTime(app, secondCookie);
    const n = await admin.query(
      `SELECT count(*)::int AS n FROM session s JOIN "user" u ON u.id=s.user_id WHERE u.email=$1`,
      [email],
    );
    expect(Number(n.rows[0].n)).toBe(1);
    // the old cookie no longer authenticates; the new one is scoped to the NEW engagement
    const old = await app.inject({
      method: "GET",
      url: `/api/v1/auditor/portal-engagement/${e1.id}`,
      headers: { cookie: firstCookie },
    });
    expect(old.statusCode).toBe(401);
    const fresh = await app.inject({
      method: "GET",
      url: `/api/v1/auditor/portal-engagement/${e2.id}`,
      headers: { cookie: secondCookie },
    });
    expect(fresh.json().engagementId).toBe(e2.id);
    // one membership, one grant (reused), expiry extended to the later window — never duplicated
    const roles = await admin.query(
      `SELECT count(*)::int AS n FROM membership_role mr JOIN membership m ON m.id = mr.membership_id
         JOIN "user" u ON u.id = m.user_id WHERE u.email = $1`,
      [email],
    );
    expect(Number(roles.rows[0].n)).toBe(1);
  });

  it("refuses an email that belongs to a staff member (an auditor must not inherit staff access)", async () => {
    const eng = await engagement(ORG_A);
    const { token } = await link(ORG_A, eng, "staff@a.test");
    const before = await auditCount("m2.auditor_link.refused", ORG_A);
    const res = await redeem(ORG_A, token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe("AUDITOR_IDENTITY_IS_MEMBER");
    expect(await auditCount("m2.auditor_link.refused", ORG_A)).toBe(before + 1);
    const consumed = await admin.query(
      "SELECT consumed_at FROM auditor_magic_link WHERE token_hash=$1",
      [hashAuditorToken(token)],
    );
    expect(consumed.rows[0].consumed_at).toBeNull();
    const sessions = await admin.query("SELECT count(*)::int AS n FROM session WHERE user_id=$1", [
      STAFF,
    ]);
    expect(Number(sessions.rows[0].n)).toBe(0);
  });

  it("refuses to grant when the org widened the auditor role beyond the minimum (fail closed)", async () => {
    const eng = await engagement(ORG_A);
    const { token } = await link(ORG_A, eng);
    await admin.query(
      `INSERT INTO permission (key, resource, action, category, default_abac, description)
       VALUES ('engagement.read', 'engagement', 'read', 'compliance', 'inOrg', '') ON CONFLICT (key) DO NOTHING`,
    );
    await admin.query(
      `INSERT INTO role_permission (organization_id, role_id, permission_key)
       SELECT $1, id, 'engagement.read' FROM role WHERE organization_id=$1 AND key='external_auditor'`,
      [ORG_A],
    );
    try {
      const res = await redeem(ORG_A, token);
      expect(res.statusCode).toBe(403);
      expect(res.json().error?.code ?? res.json().code).toBe("AUDITOR_ROLE_MISCONFIGURED");
    } finally {
      await admin.query(
        `DELETE FROM role_permission WHERE organization_id=$1 AND permission_key='engagement.read'
           AND role_id IN (SELECT id FROM role WHERE organization_id=$1 AND key='external_auditor')`,
        [ORG_A],
      );
    }
    expect((await redeem(ORG_A, token)).statusCode).toBe(200); // corrected ⇒ the SAME link still works
  });

  it("the session dies with the engagement window (server-side enforcement)", async () => {
    const eng = await engagement(ORG_A);
    const { cookie } = await activeSession(ORG_A, eng);
    const url = `/api/v1/auditor/portal-engagement/${eng.id}`;
    expect((await app.inject({ method: "GET", url, headers: { cookie } })).statusCode).toBe(200);
    const upd = await admin.query(
      `UPDATE session SET engagement_end = now() - interval '1 minute'
        WHERE scope->>'engagementId' = $1 RETURNING id`,
      [eng.id],
    );
    expect(upd.rowCount).toBe(1);
    expect((await app.inject({ method: "GET", url, headers: { cookie } })).statusCode).toBe(401);
  });

  it("the role grant itself expires with the window (defence in depth beneath the session bound)", async () => {
    const eng = await engagement(ORG_A);
    const { cookie, email } = await activeSession(ORG_A, eng);
    const url = `/api/v1/auditor/portal-engagement/${eng.id}`;
    expect((await app.inject({ method: "GET", url, headers: { cookie } })).statusCode).toBe(200);
    const expired = await admin.query(
      `UPDATE membership_role SET expires_at = now() - interval '1 minute'
        WHERE membership_id IN (SELECT m.id FROM membership m JOIN "user" u ON u.id = m.user_id WHERE u.email = $1)
        RETURNING id, organization_id`,
      [email],
    );
    expect(expired.rowCount).toBe(1);
    const userId = (await admin.query('SELECT id FROM "user" WHERE email = $1', [email])).rows[0]
      .id;
    rbac.invalidateActor(ORG_A, userId);
    expect((await app.inject({ method: "GET", url, headers: { cookie } })).statusCode).toBe(403);
  });

  it("answers 429 once the attempt budget is spent", async () => {
    const eng = await engagement(ORG_A);
    const { token } = await link(ORG_A, eng);
    const r1 = await redeem(ORG_A, generateAuditorToken(), limitedApp);
    const r2 = await redeem(ORG_A, generateAuditorToken(), limitedApp);
    const r3 = await redeem(ORG_A, token, limitedApp);
    expect([r1.statusCode, r2.statusCode]).toEqual([410, 410]);
    expect(r3.statusCode).toBe(429);
    expect(r3.headers["retry-after"]).toBe("900");
    const untouched = await admin.query(
      "SELECT consumed_at FROM auditor_magic_link WHERE token_hash=$1",
      [hashAuditorToken(token)],
    );
    expect(untouched.rows[0].consumed_at).toBeNull();
  });
});
