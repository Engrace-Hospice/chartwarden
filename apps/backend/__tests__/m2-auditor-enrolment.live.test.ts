/**
 * M2 §7.7 auditor ENROLMENT (BAA terms + second factor) — LIVE Postgres as the real NOBYPASSRLS `wardenx_app`
 * role, through a real Better Auth instance, the real authenticate hook, the real RBAC resolver and the real
 * audit writer. Proves, end to end:
 *   1. redeeming a link yields ONLY an enrolment session: it can call the enrolment routes, cannot read the
 *      engagement, cannot write, holds no role and no step-up;
 *   2. the BAA acceptance and a first-time TOTP enrolment (either order) upgrade it to the read-only active
 *      session: acceptance evidence (who/when/ip/terms version+hash/engagement), recovery codes shown once and
 *      stored HASHED, the TOTP secret sealed at rest, the role granted only now, step-up stamped;
 *   3. stale terms are refused; a wrong code never activates; five wrong codes LOCK the factor (429 +
 *      Retry-After, a correct code refused while locked), and the lock expires;
 *   4. a SECOND redemption (another engagement) cannot re-enrol — it must PRESENT the factor, a TOTP code
 *      cannot be replayed within its step, and an expired lock lets the right code through;
 *   5. a recovery code works exactly once and does not stamp a TOTP step-up;
 *   6. org isolation: the acceptance rows are invisible to another tenant, an org-B link for the same auditor
 *      starts un-accepted, and the table is append-only for the app role;
 *   7. every step lands in the M4 audit trail, with no code or secret in it;
 *   8. a cancelled engagement refuses the enrolment steps (fail closed, audited); the attempt budget answers
 *      429; an ACTIVE session cannot re-run the enrolment mutations.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m2:auditor-enrolment:live
 */
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
import { createDbAuditorMagicLinkIssuer } from "../src/modules/02-identity/auditor-magic-link-store";
import { CURRENT_AUDITOR_TERMS } from "../src/modules/02-identity/auditor-terms";
import { registerAuditorEnrolmentRoutes } from "../src/modules/02-identity/routes/auditor-enrolment";
import { registerAuditorRedeemRoutes } from "../src/modules/02-identity/routes/auditor-redeem";
import { registerIdentitySeams } from "../src/modules/02-identity/seams";
import { createDbAuditorAccessGrantor } from "../src/modules/03-authorization/index";
import { enrolFirstTime, enrolmentHttp, totpCode } from "./_auditor-enrol-helper";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "mdm_canonical_writer",
  "wardenx_report_writer",
];

const ORG_A = "11111111-1111-4111-8111-111111a30301";
const ORG_B = "11111111-1111-4111-8111-111111b30301";
const PATIENT = "33333333-3333-4333-8333-333333a30301";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const STEP_MS = 30_000;

type Eng = { id: string; start: Date; end: Date };

describe.skipIf(!DB_URL)("M2 §7.7 auditor enrolment — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let app: ReturnType<typeof buildServer>;
  let limitedApp: ReturnType<typeof buildServer>;
  let rbac: ReturnType<typeof registerDbEffectivePermissionResolver>;
  let seq = 0;

  const issuer = () => createDbAuditorMagicLinkIssuer(handle.db);
  const cookieOf = (setCookie: string | string[] | undefined): string => {
    const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const hit = list.find((c) => c.startsWith("better-auth.session_token="));
    if (!hit) throw new Error(`no session cookie in ${JSON.stringify(list)}`);
    return (hit.split(";")[0] as string).trim();
  };
  const code = (res: { json(): { error?: { code?: string }; code?: string } }) =>
    res.json().error?.code ?? res.json().code;

  async function engagement(org: string, over: { status?: string } = {}): Promise<Eng> {
    const start = new Date(Date.now() - HOUR);
    const end = new Date(Date.now() + 3 * DAY);
    const { rows } = await admin.query(
      `INSERT INTO auditor_engagement (organization_id, engagement_type, auditor_agency, scope, status, start_at, end_at, reason)
       VALUES ($1,'cms_survey','CMS',$2::jsonb,$3,$4,$5,'live test') RETURNING id`,
      [org, JSON.stringify({ patientIds: [PATIENT] }), over.status ?? "active", start, end],
    );
    return { id: rows[0].id, start, end };
  }

  async function redeemFresh(
    org: string,
    eng: Eng,
    email: string,
    server: ReturnType<typeof buildServer> = app,
  ): Promise<string> {
    const { magicLinkToken } = await issuer().issue({
      organizationId: org,
      engagementId: eng.id,
      identity: { name: "Ada Auditor", email },
      window: { start: eng.start, end: eng.end },
    });
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/auditors/redeem",
      payload: { organizationId: org, token: magicLinkToken },
    });
    expect(res.statusCode).toBe(200);
    return cookieOf(res.headers["set-cookie"]);
  }

  const read = (cookie: string, eng: Eng) =>
    app.inject({
      method: "GET",
      url: `/api/v1/auditor/portal-engagement/${eng.id}`,
      headers: { cookie },
    });

  const userId = async (email: string): Promise<string> =>
    (await admin.query('SELECT id FROM "user" WHERE email=$1', [email])).rows[0].id;

  const eventTypes = async (uid: string): Promise<string[]> =>
    (
      await admin.query(
        `SELECT event_type FROM audit_event WHERE actor_user_id=$1 AND event_type LIKE 'm2.auditor%' ORDER BY created_at, id`,
        [uid],
      )
    ).rows.map((r) => r.event_type as string);

  const wrongCode = (real: string): string => (real === "000000" ? "111111" : "000000");

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
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'enr-a','A','A','active'),($2,'enr-b','B','B','active')",
      [ORG_A, ORG_B],
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    const auth = createIdentityAuth(handle.db as never);

    registerIdentitySeams({
      sessions: createDbSessionContextStore(handle.db, createDbActorEnrichmentReader(handle.db)),
      db: handle.db,
    });
    rbac = registerDbEffectivePermissionResolver(handle.db);
    registerAbacRegistry();

    const authenticate = createSessionAuthenticate({
      getSnapshot: (request) => getIdentitySession(auth, request.raw.headers),
      getResolver: () => getSeam("SessionContextResolver"),
      sessionTimeout: createDbSessionTimeoutEnforcer(handle.db),
    });
    const mount = (budget?: number) =>
      buildServer({
        authenticate,
        db: handle.db,
        security: { rateLimitEnabled: false },
        registerModuleRoutes: (instance) => {
          let hits = 0;
          const access = createDbAuditorAccessGrantor();
          registerAuditorRedeemRoutes(instance, {
            redemption: { db: handle.db, sessions: createAuditorSessionIssuer(auth), access },
          });
          registerAuditorEnrolmentRoutes(instance, {
            enrolment: createAuditorEnrolment({
              db: handle.db,
              access,
              onActivated: (organizationId, uid) => rbac.invalidateActor(organizationId, uid),
            }),
            ...(budget
              ? {
                  ipLimiter: {
                    consume: async () => ({ allowed: ++hits <= budget, retryAfterSeconds: 60 }),
                  },
                }
              : {}),
          });
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
              engagementId: request.context.attributes?.engagementId,
              userId: request.context.userId,
            }),
          );
          instance.post("/api/v1/probe/write", async () => ({ wrote: true }));
        },
      });
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

  it("a redeemed link yields ONLY an enrolment session: no read, no write, no role, no step-up", async () => {
    const eng = await engagement(ORG_A);
    const email = `first${++seq}@survey.test`;
    const cookie = await redeemFresh(ORG_A, eng, email);
    const http = enrolmentHttp(app, cookie);

    const state = await http.state();
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({
      stage: "enrolment",
      engagementId: eng.id,
      baaAccepted: false,
      secondFactor: "enrol",
      totpPending: false,
      lockedUntil: null,
    });
    expect(state.json().terms).toMatchObject({
      version: CURRENT_AUDITOR_TERMS.version,
      sha256: CURRENT_AUDITOR_TERMS.sha256,
    });
    expect(state.headers["cache-control"]).toBe("no-store");

    // The engagement read — the thing an auditor is for — is closed, with the typed refusal.
    const view = await read(cookie, eng);
    expect(view.statusCode).toBe(403);
    expect(code(view)).toBe("AUDITOR_ENROLMENT_REQUIRED");
    // Every other route too, and every write.
    const write = await app.inject({
      method: "POST",
      url: "/api/v1/probe/write",
      headers: { cookie: `${cookie}; wardenx_csrf=x`, "x-csrf-token": "x" },
      payload: {},
    });
    expect(write.statusCode).toBe(403);
    expect(code(write)).toBe("AUDITOR_ENROLMENT_REQUIRED");

    const uid = await userId(email);
    const session = await admin.query(
      "SELECT scope, last_step_up_at, last_step_up_factor FROM session WHERE user_id=$1",
      [uid],
    );
    expect(session.rows[0].scope).toMatchObject({
      engagementId: eng.id,
      auditorStage: "enrolment",
    });
    expect(session.rows[0].last_step_up_at).toBeNull();
    const roles = await admin.query(
      `SELECT count(*)::int AS n FROM membership_role mr JOIN membership m ON m.id=mr.membership_id WHERE m.user_id=$1`,
      [uid],
    );
    expect(Number(roles.rows[0].n)).toBe(0);
    // Confirming a code before starting authenticator setup is refused, not guessed.
    const early = await http.confirmTotp("123456");
    expect(early.statusCode).toBe(409);
    expect(code(early)).toBe("AUDITOR_2FA_NOT_STARTED");
    // Presenting a factor before one exists is refused.
    const presentEarly = await http.verify({ totpCode: "123456" });
    expect(code(presentEarly)).toBe("AUDITOR_2FA_NOT_ENROLLED");
  });

  it("BAA then TOTP enrolment upgrades the session; evidence, hashed recovery codes and the role land", async () => {
    const eng = await engagement(ORG_A);
    const email = `upgrade${++seq}@survey.test`;
    const cookie = await redeemFresh(ORG_A, eng, email);
    const http = enrolmentHttp(app, cookie);
    const terms = (await http.state()).json().terms;

    // stale terms are refused (and audited), nothing is recorded
    const stale = await http.acceptTerms({ version: terms.version, sha256: "0".repeat(64) });
    expect(stale.statusCode).toBe(409);
    expect(code(stale)).toBe("AUDITOR_TERMS_STALE");
    const none = await admin.query("SELECT count(*)::int AS n FROM auditor_baa_acceptance");
    expect(Number(none.rows[0].n)).toBe(0);

    const accepted = await http.acceptTerms(terms, "Ada Auditor");
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ stage: "enrolment", baaAccepted: true });
    // idempotent: the same acceptance posted again records nothing new
    expect((await http.acceptTerms(terms, "Ada Auditor")).statusCode).toBe(200);

    const uid = await userId(email);
    const baa = await admin.query(
      `SELECT organization_id, engagement_id, user_id, terms_version, terms_sha256, accepted_name,
              accepted_at IS NOT NULL AS has_time, session_id IS NOT NULL AS has_session
         FROM auditor_baa_acceptance WHERE user_id=$1`,
      [uid],
    );
    expect(baa.rows).toHaveLength(1);
    expect(baa.rows[0]).toMatchObject({
      organization_id: ORG_A,
      engagement_id: eng.id,
      terms_version: terms.version,
      terms_sha256: terms.sha256,
      accepted_name: "Ada Auditor",
      has_time: true,
      has_session: true,
    });

    // still not active: a second factor is missing — the read stays closed
    expect((await read(cookie, eng)).statusCode).toBe(403);
    const begun = await http.beginTotp();
    expect(begun.statusCode).toBe(200);
    expect(begun.json().otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const key = begun.json().manualEntryKey as string;
    expect((await http.state()).json()).toMatchObject({ totpPending: true, secondFactor: "enrol" });

    // a wrong code does not activate
    const wrong = await http.confirmTotp(wrongCode(totpCode(key)));
    expect(wrong.statusCode).toBe(401);
    expect(code(wrong)).toBe("AUDITOR_2FA_INVALID");
    expect((await read(cookie, eng)).statusCode).toBe(403);

    const confirmed = await http.confirmTotp(totpCode(key));
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.headers["cache-control"]).toBe("no-store");
    const codes = confirmed.json().recoveryCodes as string[];
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
    expect(confirmed.json().state).toMatchObject({ stage: "active", secondFactor: "verified" });

    // recovery codes are HASHED at rest; the TOTP secret is sealed (never the raw authenticator key)
    const tf = await admin.query(
      "SELECT secret_encrypted, backup_codes_encrypted, verified FROM two_factor WHERE user_id=$1",
      [uid],
    );
    expect(tf.rows).toHaveLength(1);
    expect(tf.rows[0].verified).toBe(true);
    const stored = JSON.stringify(tf.rows[0].backup_codes_encrypted);
    for (const c of codes) expect(stored).not.toContain(c.replace(/-/g, ""));
    expect(tf.rows[0].backup_codes_encrypted).toHaveLength(10);
    expect(tf.rows[0].backup_codes_encrypted[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(tf.rows[0].backup_codes_encrypted[0].usedAt).toBeNull();
    expect(tf.rows[0].secret_encrypted).not.toContain(key);

    // the session is ACTIVE: scope upgraded, step-up stamped (totp), exactly one role, the read works
    const session = await admin.query(
      "SELECT scope, last_step_up_factor::text AS factor, last_step_up_at IS NOT NULL AS stamped FROM session WHERE user_id=$1",
      [uid],
    );
    expect(session.rows[0].scope).toMatchObject({ auditorStage: "active", factorMethod: "totp" });
    expect(session.rows[0]).toMatchObject({ factor: "totp", stamped: true });
    const roles = await admin.query(
      `SELECT r.key FROM membership_role mr JOIN role r ON r.id=mr.role_id JOIN membership m ON m.id=mr.membership_id WHERE m.user_id=$1`,
      [uid],
    );
    expect(roles.rows.map((r) => r.key)).toEqual(["external_auditor"]);
    const view = await read(cookie, eng);
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ engagementId: eng.id, userId: uid });

    // an ACTIVE session is read-only again: the enrolment mutations are closed, the state read stays open
    const again = await http.acceptTerms(terms);
    expect(again.statusCode).toBe(403);
    expect(code(again)).toBe("AUDITOR_READ_ONLY");
    expect((await http.state()).json().stage).toBe("active");

    // every step is in the audit trail, and no code or key is
    // (one transaction writes totp_enrolled and activated, so their relative order is not asserted)
    expect([...(await eventTypes(uid))].sort()).toEqual(
      [
        "m2.auditor_link.redeemed",
        "m2.auditor_enrolment.refused", // stale terms
        "m2.auditor_enrolment.baa_accepted",
        "m2.auditor_enrolment.totp_started",
        "m2.auditor_enrolment.factor_failed", // the wrong confirmation code
        "m2.auditor_enrolment.totp_enrolled",
        "m2.auditor_enrolment.activated",
      ].sort(),
    );
    const leaked = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE event_type LIKE 'm2.auditor_enrolment.%' AND (context::text LIKE $1 OR context::text LIKE $2)",
      [`%${key}%`, `%${codes[0]}%`],
    );
    expect(Number(leaked.rows[0].n)).toBe(0);
  });

  it("TOTP first then BAA activates only when the LAST requirement is met", async () => {
    const eng = await engagement(ORG_A);
    const email = `reverse${++seq}@survey.test`;
    const cookie = await redeemFresh(ORG_A, eng, email);
    const http = enrolmentHttp(app, cookie);
    const terms = (await http.state()).json().terms;
    const key = (await http.beginTotp()).json().manualEntryKey as string;
    const confirmed = await http.confirmTotp(totpCode(key));
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().state).toMatchObject({
      stage: "enrolment",
      baaAccepted: false,
      secondFactor: "verified",
    });
    expect((await read(cookie, eng)).statusCode).toBe(403);
    const accepted = await http.acceptTerms(terms);
    expect(accepted.json()).toMatchObject({ stage: "active", baaAccepted: true });
    expect((await read(cookie, eng)).statusCode).toBe(200);
  });

  it("LOCKS the factor after five wrong codes (429 + Retry-After), refuses the right code while locked, then recovers", async () => {
    const email = `lock${++seq}@survey.test`;
    const e1 = await engagement(ORG_A);
    const first = await redeemFresh(ORG_A, e1, email);
    const { manualEntryKey } = await enrolFirstTime(app, first);

    const e2 = await engagement(ORG_A);
    const cookie = await redeemFresh(ORG_A, e2, email);
    const http = enrolmentHttp(app, cookie);
    // BAA first so only the factor stands between this session and the read
    const terms = (await http.state()).json().terms;
    expect((await http.acceptTerms(terms)).statusCode).toBe(200);

    const bad = wrongCode(totpCode(manualEntryKey));
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const res = await http.verify({ totpCode: bad });
      expect(res.statusCode).toBe(401);
      expect(code(res)).toBe("AUDITOR_2FA_INVALID");
    }
    const fifth = await http.verify({ totpCode: bad });
    expect(fifth.statusCode).toBe(429);
    expect(code(fifth)).toBe("AUDITOR_2FA_LOCKED");
    expect(Number(fifth.headers["retry-after"])).toBeGreaterThan(0);

    // a CORRECT code is refused while locked, and the session stays enrolment-only
    const next = totpCode(manualEntryKey, Date.now() + STEP_MS);
    const whileLocked = await http.verify({ totpCode: next });
    expect(whileLocked.statusCode).toBe(429);
    expect((await read(cookie, e2)).statusCode).toBe(403);
    const state = (await http.state()).json();
    expect(state.stage).toBe("enrolment");
    expect(state.lockedUntil).not.toBeNull();

    const uid = await userId(email);
    const types = await eventTypes(uid);
    expect(types.filter((t) => t === "m2.auditor_enrolment.factor_failed")).toHaveLength(5);
    expect(types).toContain("m2.auditor_enrolment.locked");

    // the lock expires; the right code now works and clears the counter
    const expired = await admin.query(
      "UPDATE two_factor SET locked_until = now() - interval '1 minute' WHERE user_id=$1 RETURNING id",
      [uid],
    );
    expect(expired.rowCount).toBe(1);
    const ok = await http.verify({ totpCode: next });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ stage: "active" });
    const cleared = await admin.query(
      "SELECT failed_verification_count AS n, locked_until FROM two_factor WHERE user_id=$1",
      [uid],
    );
    expect(cleared.rows[0].n).toBe(0);
    expect(cleared.rows[0].locked_until).toBeNull();
    expect((await read(cookie, e2)).statusCode).toBe(200);
  });

  it("a SECOND redemption requires the factor: no re-enrol, no replay of a spent code step, no read until presented", async () => {
    const email = `second${++seq}@survey.test`;
    const e1 = await engagement(ORG_A);
    const { manualEntryKey } = await enrolFirstTime(app, await redeemFresh(ORG_A, e1, email));

    const e2 = await engagement(ORG_A);
    const cookie = await redeemFresh(ORG_A, e2, email);
    const http = enrolmentHttp(app, cookie);
    const state = (await http.state()).json();
    expect(state).toMatchObject({
      stage: "enrolment",
      secondFactor: "challenge",
      baaAccepted: false,
    });

    // the enrolled factor is NEVER replaced through a link
    const replace = await http.beginTotp();
    expect(replace.statusCode).toBe(409);
    expect(code(replace)).toBe("AUDITOR_2FA_ALREADY_ENROLLED");
    // possession of the link alone reads nothing
    expect((await read(cookie, e2)).statusCode).toBe(403);

    // the code that just enrolled the factor is spent for its whole step: replaying it is refused
    const replay = await http.verify({ totpCode: totpCode(manualEntryKey) });
    expect(replay.statusCode).toBe(401);
    expect(code(replay)).toBe("AUDITOR_2FA_INVALID");

    // a fresh step's code proves the factor — but the BAA for THIS engagement is still owed
    const proven = await http.verify({ totpCode: totpCode(manualEntryKey, Date.now() + STEP_MS) });
    expect(proven.statusCode).toBe(200);
    expect(proven.json()).toMatchObject({
      stage: "enrolment",
      secondFactor: "verified",
      baaAccepted: false,
    });
    expect((await read(cookie, e2)).statusCode).toBe(403);
    // presenting again never burns another code
    expect((await http.verify({ totpCode: "123456" })).statusCode).toBe(200);

    const terms = state.terms;
    const done = await http.acceptTerms(terms);
    expect(done.json()).toMatchObject({ stage: "active" });
    expect((await read(cookie, e2)).statusCode).toBe(200);
    const uid = await userId(email);
    const acceptances = await admin.query(
      "SELECT count(*)::int AS n FROM auditor_baa_acceptance WHERE user_id=$1",
      [uid],
    );
    expect(Number(acceptances.rows[0].n)).toBe(2); // one per engagement
  });

  it("a recovery code works EXACTLY ONCE, and does not claim a TOTP step-up", async () => {
    const email = `recover${++seq}@survey.test`;
    const e1 = await engagement(ORG_A);
    const { recoveryCodes } = await enrolFirstTime(app, await redeemFresh(ORG_A, e1, email));
    const uid = await userId(email);

    const e2 = await engagement(ORG_A);
    const cookie = await redeemFresh(ORG_A, e2, email);
    const http = enrolmentHttp(app, cookie);
    const terms = (await http.state()).json().terms;
    expect((await http.acceptTerms(terms)).statusCode).toBe(200);

    // typed in lower case without separators still matches (normalised)
    const typed = (recoveryCodes[0] as string).replace(/-/g, "").toLowerCase();
    const used = await http.verify({ recoveryCode: typed });
    expect(used.statusCode).toBe(200);
    expect(used.json()).toMatchObject({ stage: "active" });
    expect((await read(cookie, e2)).statusCode).toBe(200);
    const session = await admin.query(
      "SELECT last_step_up_at, scope FROM session WHERE user_id=$1",
      [uid],
    );
    expect(session.rows[0].scope).toMatchObject({ factorMethod: "recovery_code" });
    expect(session.rows[0].last_step_up_at).toBeNull();

    // the SAME code in a third engagement is refused; a different unused code works
    const e3 = await engagement(ORG_A);
    const cookie3 = await redeemFresh(ORG_A, e3, email);
    const http3 = enrolmentHttp(app, cookie3);
    expect((await http3.acceptTerms((await http3.state()).json().terms)).statusCode).toBe(200);
    const reused = await http3.verify({ recoveryCode: recoveryCodes[0] as string });
    expect(reused.statusCode).toBe(401);
    expect(code(reused)).toBe("AUDITOR_2FA_INVALID");
    expect((await read(cookie3, e3)).statusCode).toBe(403);
    const other = await http3.verify({ recoveryCode: recoveryCodes[1] as string });
    expect(other.statusCode).toBe(200);
    const tf = await admin.query(
      "SELECT backup_codes_encrypted AS b FROM two_factor WHERE user_id=$1",
      [uid],
    );
    const spent = (tf.rows[0].b as { usedAt: string | null }[]).filter((c) => c.usedAt !== null);
    expect(spent).toHaveLength(2);
    expect(await eventTypes(uid)).toContain("m2.auditor_enrolment.recovery_code_used");
  });

  it("is org-isolated: acceptances are invisible to another tenant, an org-B link starts un-accepted, the table is append-only", async () => {
    const email = `iso${++seq}@survey.test`;
    const eA = await engagement(ORG_A);
    const { manualEntryKey } = await enrolFirstTime(app, await redeemFresh(ORG_A, eA, email));
    const uid = await userId(email);

    // as the real app role under org B: org A's acceptance does not exist
    const viaApp = await new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await viaApp.connect();
    try {
      await viaApp.query("BEGIN");
      await viaApp.query("SELECT set_config('app.org_id', $1, true)", [ORG_B]);
      const visible = await viaApp.query("SELECT count(*)::int AS n FROM auditor_baa_acceptance");
      expect(Number(visible.rows[0].n)).toBe(0);
      await viaApp.query("ROLLBACK");

      // append-only: not even the owning tenant's app role may UPDATE or DELETE an acceptance
      await viaApp.query("BEGIN");
      await viaApp.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
      const own = await viaApp.query(
        "SELECT count(*)::int AS n FROM auditor_baa_acceptance WHERE user_id=$1",
        [uid],
      );
      expect(Number(own.rows[0].n)).toBe(1);
      await expect(
        viaApp.query("UPDATE auditor_baa_acceptance SET accepted_name = 'Mallory'"),
      ).rejects.toThrow(/permission denied/);
      await viaApp.query("ROLLBACK");
      await viaApp.query("BEGIN");
      await viaApp.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
      await expect(viaApp.query("DELETE FROM auditor_baa_acceptance")).rejects.toThrow(
        /permission denied/,
      );
      await viaApp.query("ROLLBACK");
    } finally {
      await viaApp.end();
    }

    // the same auditor, a link in ORG B: the factor is theirs (user-level) but the BAA is per tenant/engagement
    const eB = await engagement(ORG_B);
    const cookieB = await redeemFresh(ORG_B, eB, email);
    const httpB = enrolmentHttp(app, cookieB);
    const stateB = (await httpB.state()).json();
    expect(stateB).toMatchObject({
      stage: "enrolment",
      engagementId: eB.id,
      baaAccepted: false,
      secondFactor: "challenge",
    });
    expect((await read(cookieB, eB)).statusCode).toBe(403);
    const proven = await httpB.verify({ totpCode: totpCode(manualEntryKey, Date.now() + STEP_MS) });
    expect(proven.statusCode).toBe(200);
    expect((await httpB.acceptTerms(stateB.terms)).json()).toMatchObject({ stage: "active" });
    const rowsB = await admin.query(
      "SELECT organization_id FROM auditor_baa_acceptance WHERE user_id=$1 ORDER BY organization_id",
      [uid],
    );
    expect(rowsB.rows.map((r) => r.organization_id)).toEqual([ORG_A, ORG_B]);
    // org A's earlier session was replaced (no concurrent auditor sessions)
    const sessions = await admin.query("SELECT count(*)::int AS n FROM session WHERE user_id=$1", [
      uid,
    ]);
    expect(Number(sessions.rows[0].n)).toBe(1);
  });

  it("fails closed when the engagement is cancelled mid-enrolment: every step refused and audited, nothing recorded", async () => {
    const eng = await engagement(ORG_A);
    const email = `cancel${++seq}@survey.test`;
    const cookie = await redeemFresh(ORG_A, eng, email);
    const http = enrolmentHttp(app, cookie);
    const terms = (await http.state()).json().terms;
    const cancelled = await admin.query(
      "UPDATE auditor_engagement SET status='cancelled' WHERE id=$1 RETURNING id",
      [eng.id],
    );
    expect(cancelled.rowCount).toBe(1);

    const baa = await http.acceptTerms(terms);
    expect(baa.statusCode).toBe(403);
    expect(code(baa)).toBe("ENGAGEMENT_NOT_ACTIVE");
    expect(code(await http.beginTotp())).toBe("ENGAGEMENT_NOT_ACTIVE");
    const uid = await userId(email);
    const accepted = await admin.query(
      "SELECT count(*)::int AS n FROM auditor_baa_acceptance WHERE user_id=$1",
      [uid],
    );
    expect(Number(accepted.rows[0].n)).toBe(0);
    const factors = await admin.query(
      "SELECT count(*)::int AS n FROM two_factor WHERE user_id=$1",
      [uid],
    );
    expect(Number(factors.rows[0].n)).toBe(0);
    expect(
      (await eventTypes(uid)).filter((t) => t === "m2.auditor_enrolment.refused"),
    ).toHaveLength(2);
    expect((await read(cookie, eng)).statusCode).toBe(403);
  });

  it("validates bodies (422), needs a session (401) and answers 429 once the attempt budget is spent", async () => {
    const anon = await app.inject({ method: "GET", url: "/api/v1/auditors/enrolment/state" });
    expect(anon.statusCode).toBe(401);

    const eng = await engagement(ORG_A);
    const cookie = await redeemFresh(ORG_A, eng, `budget${++seq}@survey.test`);
    const http = enrolmentHttp(app, cookie);
    const badBody = await http.confirmTotp("12");
    expect(badBody.statusCode).toBe(422);
    const both = await http.verify({ totpCode: "123456", recoveryCode: "ABCDE-FGHJK-LMNPQ-RSTUV" });
    expect(both.statusCode).toBe(422);
    const neither = await http.verify({} as never);
    expect(neither.statusCode).toBe(422);
    const extra = await app.inject({
      method: "POST",
      url: "/api/v1/auditors/enrolment/baa",
      headers: { cookie: `${cookie}; wardenx_csrf=x`, "x-csrf-token": "x" },
      payload: {
        termsVersion: "v",
        termsSha256: "0".repeat(64),
        acceptedName: "Ada",
        stage: "active",
      },
    });
    expect(extra.statusCode).toBe(422);

    // a budgeted server: the third mutation in the window is 429 (the state read is not budgeted)
    const eng2 = await engagement(ORG_A);
    const limitedCookie = await redeemFresh(ORG_A, eng2, `budget${++seq}@survey.test`, limitedApp);
    const limited = enrolmentHttp(limitedApp, limitedCookie);
    expect((await limited.confirmTotp("123456")).statusCode).toBe(409);
    expect((await limited.confirmTotp("123456")).statusCode).toBe(409);
    const third = await limited.confirmTotp("123456");
    expect(third.statusCode).toBe(429);
    expect(third.headers["retry-after"]).toBe("60");
  });
});
