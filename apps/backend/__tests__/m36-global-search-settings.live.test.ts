/**
 * M36 WP 2.7b chunk C4 (ADR-0058, Proposed) - the tenant global search switch, LIVE Postgres as the NOBYPASSRLS `wardenx_app`
 * role: the REAL route stack (`mountMessagingRoutes`), the real `requirePermission` / `requireStepUp` chain over a real session
 * seam, the go-live checklist (platform flag, legacy bodies, escrow and leakage attestations, rate limit), OFF-always-accepted, `changed_at`
 * on every flip, the write-audit rows, the FOR SHARE interlock with the index writer, and tenancy. Nothing here enables search
 * anywhere: flags are set per test on a private database.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m36:global-search-settings:live
 * Use a PRIVATE pgvector/pgvector:pg18 container (the suite DROPs the public schema and the app role). For a local PG
 * without pgvector, also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  createInMemorySessionContextStore,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { wireModuleSeams } from "../src/index";
import { NOTICE_VERSION } from "../src/modules/36-messaging/global-search/notice";
import { GLOBAL_SEARCH_PLATFORM_FLAG_KEY } from "../src/modules/36-messaging/global-search/platform-flag";
import {
  GLOBAL_SEARCH_ESCROW_FLAG_KEY,
  GLOBAL_SEARCH_LEAKAGE_FLAG_KEY,
} from "../src/modules/36-messaging/global-search/prerequisites";
import { mountMessagingRoutes } from "../src/modules/36-messaging/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-4111-8111-1111000f0c04";
const ORG_B = "22222222-2222-4222-8222-2222000f0c04";
const URL_PATH = "/api/v1/messaging/global-search/settings";
const LEGACY_CIPHER = Buffer.from([1, 0, 0, 0, 0]);
const RING_CIPHER = Buffer.from([2, 0, 0, 0, 0]);
const STALE_STEP_UP_MS = 3_600_000;

describe.skipIf(!DB_URL)("M36 WP 2.7b C4 global search settings - LIVE Postgres", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let appDefault: FastifyInstance; // default wiring: the rate limit is NOT active
  let appLimited: FastifyInstance; // the composition root says the P2 limit is active
  let adminA: string;
  let plainA: string;
  let adminB: string;
  let channelA: string;

  const sessions = {
    adminA: "sess-admin-a-fresh",
    adminAStale: "sess-admin-a-stale",
    plainA: "sess-plain-a",
    adminB: "sess-admin-b",
  } as const;

  const headerAuth = (request: FastifyRequest): void => {
    const user = request.headers["x-test-user"];
    if (typeof user !== "string" || user.length === 0) return;
    request.context.userId = user;
    const org = request.headers["x-test-org"];
    request.context.organizationId = typeof org === "string" ? org : "";
    request.context.roles = [];
    request.context.locationIds = [];
    request.context.attributes = { sessionId: request.headers["x-test-session"] };
  };

  const as = (user: string, session: string, org = ORG_A) => ({
    "x-test-user": user,
    "x-test-org": org,
    "x-test-session": session,
  });
  const put = (
    app: FastifyInstance,
    enabled: boolean,
    user = adminA,
    session: string = sessions.adminA,
    org = ORG_A,
    ack: string | null = NOTICE_VERSION,
  ) =>
    app.inject({
      method: "PUT",
      url: URL_PATH,
      headers: as(user, session, org),
      payload: ack === null ? { enabled } : { enabled, acknowledgedNoticeVersion: ack },
    });
  const get = (
    app: FastifyInstance,
    user = adminA,
    session: string = sessions.adminA,
    org = ORG_A,
  ) => app.inject({ method: "GET", url: URL_PATH, headers: as(user, session, org) });
  const codes = (res: { json(): { error?: { details?: Array<{ code: string }> } } }) =>
    (res.json().error?.details ?? []).map((d) => d.code).sort();

  const setting = async (org: string) =>
    (
      await admin.query(`SELECT * FROM tenant_messaging_search_setting WHERE organization_id=$1`, [
        org,
      ])
    ).rows[0] as
      | {
          enabled: boolean;
          changed_at: Date;
          changed_by_user_id: string | null;
          purge_requested_at: Date | null;
          purge_completed_at: Date | null;
        }
      | undefined;

  async function setPlatformFlag(key: string, value: boolean | null, org: string | null = null) {
    await admin.query(
      `DELETE FROM feature_flag WHERE flag_key=$1 AND organization_id IS NOT DISTINCT FROM $2`,
      [key, org],
    );
    if (value === null) return;
    await admin.query(
      `INSERT INTO feature_flag (organization_id, flag_key, flag_kind, value_type, value)
       VALUES ($1,$2,'product','bool',$3::jsonb)`,
      [org, key, JSON.stringify(value)],
    );
  }
  const completePurge = () =>
    admin.query(
      `UPDATE tenant_messaging_search_setting SET purge_completed_at=now() WHERE organization_id=$1 AND purge_requested_at IS NOT NULL`,
      [ORG_A],
    );
  const allAttested = async () => {
    await setPlatformFlag(GLOBAL_SEARCH_PLATFORM_FLAG_KEY, true);
    await setPlatformFlag(GLOBAL_SEARCH_ESCROW_FLAG_KEY, true);
    await setPlatformFlag(GLOBAL_SEARCH_LEAKAGE_FLAG_KEY, true);
  };

  async function seedMessage(cipher: Buffer): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256, body_kind)
         VALUES ($1,$2,$3,'user',$4,$5,'plain') RETURNING id`,
        [channelA, ORG_A, adminA, cipher, "a".repeat(64)],
      )
    ).rows[0].id as string;
  }
  const seedRevision = (messageId: string, cipher: Buffer) =>
    admin.query(
      `INSERT INTO message_revision (organization_id, message_id, revision_no, body_cipher, body_sha256, body_kind, body_written_at, edited_by)
       VALUES ($1,$2,1,$3,$4,'plain',now(),$5)`,
      [ORG_A, messageId, cipher, "a".repeat(64), adminA],
    );

  async function applyMigrations() {
    const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }
  const seedUser = async (suffix: string, organizationId: string) => {
    const id = (
      await admin.query(`INSERT INTO "user" (email, name) VALUES ($1,$2) RETURNING id`, [
        `wp27b-c4-${suffix}@x.test`,
        `WP27b C4 ${suffix}`,
      ])
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
      [id, organizationId],
    );
    return id;
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    await applyMigrations();
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'wp27b-c4-a','A','A'),($2,'wp27b-c4-b','B','B')`,
      [ORG_A, ORG_B],
    );
    adminA = await seedUser("admin-a", ORG_A);
    plainA = await seedUser("plain-a", ORG_A);
    adminB = await seedUser("admin-b", ORG_B);
    channelA = (
      await admin.query(
        `INSERT INTO channel (organization_id, channel_kind, dm_participant_key, title, retention_class)
         VALUES ($1,'dm',$2,'DM','care_related') RETURNING id`,
        [ORG_A, `${adminA}:peer`],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    const grant = (orgId: string, userId: string, permissionKeys: string[]) => ({
      orgId,
      userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
    });
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        grant(ORG_A, adminA, ["messaging.global_search.manage"]),
        grant(ORG_A, plainA, ["messaging.send", "messaging.read"]),
        grant(ORG_B, adminB, ["messaging.global_search.manage"]),
      ]).store,
    );
    const session = (sessionId: string, userId: string, organizationId: string, ageMs: number) => ({
      sessionClass: "staff" as const,
      portalAccountId: null,
      sessionPatientId: null,
      sessionId,
      userId,
      membershipId: null,
      organizationId,
      roles: [],
      providerEntityIds: [],
      locationIds: [],
      lastStepUpAt: new Date(Date.now() - ageMs),
      lastStepUpFactor: "totp" as const,
    });
    const { store: sessionStore } = createInMemorySessionContextStore([
      session(sessions.adminA, adminA, ORG_A, 0),
      session(sessions.adminAStale, adminA, ORG_A, STALE_STEP_UP_MS),
      session(sessions.plainA, plainA, ORG_A, 0),
      session(sessions.adminB, adminB, ORG_B, 0),
    ]);
    wireModuleSeams({ sessionContextStore: sessionStore });
    // wireModuleSeams installs the ABAC evaluator over its own registry.

    const build = (globalSearchRateLimitActive: boolean) => {
      const app = buildServer({
        db: handle.db,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
      });
      mountMessagingRoutes(app, handle.db, { globalSearchRateLimitActive });
      return app;
    };
    appDefault = build(false);
    appLimited = build(true);
    await Promise.all([appDefault.ready(), appLimited.ready()]);
  }, 240_000);

  afterAll(async () => {
    await appDefault?.close();
    await appLimited?.close();
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await handle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query(`DELETE FROM tenant_messaging_search_setting`);
    await admin.query(`DELETE FROM message_search_index_state`);
    await admin.query(`DELETE FROM feature_flag WHERE flag_key LIKE 'messaging.global_search%'`);
    await admin.query(`DELETE FROM message_revision WHERE organization_id=$1`, [ORG_A]);
    await admin.query(`DELETE FROM message WHERE organization_id=$1`, [ORG_A]);
    await admin.query(
      `DELETE FROM audit_event WHERE event_type LIKE 'tenant_messaging_search_setting.%'`,
    );
  });

  describe("who may change it", () => {
    it("a user without messaging.global_search.manage is refused on GET and PUT and nothing is written", async () => {
      await allAttested();
      expect((await get(appLimited, plainA, sessions.plainA)).statusCode).toBe(403);
      expect((await put(appLimited, true, plainA, sessions.plainA)).statusCode).toBe(403);
      expect(await setting(ORG_A)).toBeUndefined();
    });

    it("a stale step-up is refused on PUT (STEP_UP_REQUIRED) but the read still works", async () => {
      await allAttested();
      const refused = await put(appLimited, true, adminA, sessions.adminAStale);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe("STEP_UP_REQUIRED");
      expect(await setting(ORG_A)).toBeUndefined();
      expect((await get(appLimited, adminA, sessions.adminAStale)).statusCode).toBe(200);
    });

    it("a missing session id (no step-up evidence) is refused", async () => {
      await allAttested();
      const res = await appLimited.inject({
        method: "PUT",
        url: URL_PATH,
        headers: { "x-test-user": adminA, "x-test-org": ORG_A },
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(403);
      expect(await setting(ORG_A)).toBeUndefined();
    });

    it("rejects a body with extra fields or a non-boolean", async () => {
      expect(
        (
          await appLimited.inject({
            method: "PUT",
            url: URL_PATH,
            headers: as(adminA, sessions.adminA),
            payload: { enabled: "yes" } as never,
          })
        ).statusCode,
      ).toBeGreaterThanOrEqual(400);
    });
  });

  describe("turning ON needs the go-live checklist", () => {
    it("default wiring: the rate limit is inactive so ON is refused even with everything else attested", async () => {
      await allAttested();
      const res = await put(appDefault, true);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("GLOBAL_SEARCH_PREREQUISITES_UNMET");
      expect(codes(res)).toEqual(["RATE_LIMIT_INACTIVE"]);
      expect(await setting(ORG_A)).toBeUndefined();
    });

    it("with nothing attested every platform-side check is named", async () => {
      const res = await put(appDefault, true);
      expect(res.statusCode).toBe(409);
      expect(codes(res)).toEqual([
        "ESCROW_NOT_ATTESTED",
        "LEAKAGE_NOT_ATTESTED",
        "PLATFORM_FLAG_OFF",
        "RATE_LIMIT_INACTIVE",
      ]);
    });

    it("platform flag off alone refuses", async () => {
      await setPlatformFlag(GLOBAL_SEARCH_ESCROW_FLAG_KEY, true);
      await setPlatformFlag(GLOBAL_SEARCH_LEAKAGE_FLAG_KEY, true);
      const res = await put(appLimited, true);
      expect(res.statusCode).toBe(409);
      expect(codes(res)).toEqual(["PLATFORM_FLAG_OFF"]);
    });

    it("escrow not attested alone refuses", async () => {
      await setPlatformFlag(GLOBAL_SEARCH_PLATFORM_FLAG_KEY, true);
      await setPlatformFlag(GLOBAL_SEARCH_LEAKAGE_FLAG_KEY, true);
      const res = await put(appLimited, true);
      expect(res.statusCode).toBe(409);
      expect(codes(res)).toEqual(["ESCROW_NOT_ATTESTED"]);
    });

    it("leakage not attested alone refuses (the kill switch being on does not stand in for the experiment)", async () => {
      await setPlatformFlag(GLOBAL_SEARCH_PLATFORM_FLAG_KEY, true);
      await setPlatformFlag(GLOBAL_SEARCH_ESCROW_FLAG_KEY, true);
      const res = await put(appLimited, true);
      expect(res.statusCode).toBe(409);
      expect(codes(res)).toEqual(["LEAKAGE_NOT_ATTESTED"]);
    });

    it("a legacy-envelope message body alone refuses; a ring body does not", async () => {
      await allAttested();
      await seedMessage(RING_CIPHER);
      expect((await put(appLimited, true)).statusCode).toBe(200);
      await admin.query(`DELETE FROM tenant_messaging_search_setting`);
      await seedMessage(LEGACY_CIPHER);
      const res = await put(appLimited, true);
      expect(res.statusCode).toBe(409);
      expect(codes(res)).toEqual(["LEGACY_BODIES_PRESENT"]);
    });

    it("a legacy-envelope message_revision alone refuses", async () => {
      await allAttested();
      const message = await seedMessage(RING_CIPHER);
      await seedRevision(message, LEGACY_CIPHER);
      const res = await put(appLimited, true);
      expect(res.statusCode).toBe(409);
      expect(codes(res)).toEqual(["LEGACY_BODIES_PRESENT"]);
    });

    it("succeeds only when every check holds: row written with changed_at, changed_by, no purge request", async () => {
      await allAttested();
      await seedMessage(RING_CIPHER);
      const res = await put(appLimited, true);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        enabled: true,
        checklist: {
          platformEnabled: true,
          legacyBodiesMigrated: true,
          escrowAttested: true,
          leakageAttested: true,
          rateLimitActive: true,
          excludedMembersCleared: true,
        },
      });
      const row = await setting(ORG_A);
      expect(row?.enabled).toBe(true);
      expect(row?.changed_by_user_id).toBe(adminA);
      expect(row?.purge_requested_at).toBeNull();
    });

    it("a tenant-scoped feature_flag row for either platform key never satisfies the check", async () => {
      await setPlatformFlag(GLOBAL_SEARCH_PLATFORM_FLAG_KEY, true, ORG_A);
      await setPlatformFlag(GLOBAL_SEARCH_ESCROW_FLAG_KEY, true, ORG_A);
      await setPlatformFlag(GLOBAL_SEARCH_LEAKAGE_FLAG_KEY, true, ORG_A);
      const res = await put(appLimited, true);
      expect(res.statusCode).toBe(409);
      expect(codes(res)).toEqual([
        "ESCROW_NOT_ATTESTED",
        "LEAKAGE_NOT_ATTESTED",
        "PLATFORM_FLAG_OFF",
      ]);
      // an explicit platform false with a tenant true still refuses
      await setPlatformFlag(GLOBAL_SEARCH_PLATFORM_FLAG_KEY, false);
      expect(codes(await put(appLimited, true))).toContain("PLATFORM_FLAG_OFF");
      expect(await setting(ORG_A)).toBeUndefined();
    });

    it("the platform kill switch on the flag row also fails the check", async () => {
      await allAttested();
      await admin.query(
        `UPDATE feature_flag SET kill_switch_active=true WHERE flag_key=$1 AND organization_id IS NULL`,
        [GLOBAL_SEARCH_PLATFORM_FLAG_KEY],
      );
      expect(codes(await put(appLimited, true))).toEqual(["PLATFORM_FLAG_OFF"]);
    });
  });

  describe("turning OFF", () => {
    it("is always accepted, even with every check failing, and requests the purge", async () => {
      await admin.query(
        `INSERT INTO tenant_messaging_search_setting (organization_id, enabled) VALUES ($1,true)`,
        [ORG_A],
      );
      await seedMessage(LEGACY_CIPHER); // every check fails
      const res = await put(appDefault, false);
      expect(res.statusCode).toBe(200);
      expect(res.json().enabled).toBe(false);
      const row = await setting(ORG_A);
      expect(row?.enabled).toBe(false);
      expect(row?.purge_requested_at).not.toBeNull();
      expect(row?.purge_completed_at).toBeNull();
      expect(row?.changed_by_user_id).toBe(adminA);
    });

    it("with no row yet still records the OFF and the purge request", async () => {
      const res = await put(appDefault, false);
      expect(res.statusCode).toBe(200);
      expect((await setting(ORG_A))?.purge_requested_at).not.toBeNull();
    });

    it("a repeated OFF re-opens a completed purge", async () => {
      await put(appDefault, false);
      await admin.query(
        `UPDATE tenant_messaging_search_setting SET purge_completed_at=now() WHERE organization_id=$1`,
        [ORG_A],
      );
      await put(appDefault, false);
      expect((await setting(ORG_A))?.purge_completed_at).toBeNull();
    });
  });

  describe("every flip is audited and bumps changed_at", () => {
    it("OFF->ON and ON->OFF each advance changed_at and write who/when/old/new; a repeated ON writes nothing", async () => {
      await allAttested();
      await put(appLimited, false);
      await completePurge();
      const t0 = (await setting(ORG_A))?.changed_at as Date;
      expect((await put(appLimited, true)).statusCode).toBe(200);
      const t1 = (await setting(ORG_A))?.changed_at as Date;
      expect(t1.getTime()).toBeGreaterThan(t0.getTime());

      expect((await put(appLimited, true)).statusCode).toBe(200); // not a flip
      expect(((await setting(ORG_A))?.changed_at as Date).getTime()).toBe(t1.getTime());

      expect((await put(appLimited, false)).statusCode).toBe(200);
      const t2 = (await setting(ORG_A))?.changed_at as Date;
      expect(t2.getTime()).toBeGreaterThan(t1.getTime());

      const audit = await admin.query(
        `SELECT actor_user_id, before->>'enabled' AS old_enabled, after->>'enabled' AS new_enabled
           FROM audit_event
          WHERE organization_id=$1 AND event_type='tenant_messaging_search_setting.update'
            AND before->>'enabled' IS DISTINCT FROM after->>'enabled'
          ORDER BY created_at, id`,
        [ORG_A],
      );
      expect(audit.rows.map((r) => [r.old_enabled, r.new_enabled])).toEqual([
        ["false", "true"],
        ["true", "false"],
      ]);
      for (const r of audit.rows) expect(r.actor_user_id).toBe(adminA);
    });
  });

  describe("tenant notice acknowledgement (F5)", () => {
    it("is refused without an acknowledgement and nothing is written", async () => {
      await allAttested();
      const res = await put(appLimited, true, adminA, sessions.adminA, ORG_A, null);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("GLOBAL_SEARCH_NOTICE_NOT_ACKNOWLEDGED");
      expect(codes(res)).toEqual(["NOTICE_ACK_REQUIRED"]);
      expect(await setting(ORG_A)).toBeUndefined();
    });

    it("is refused with a stale version", async () => {
      await allAttested();
      const res = await put(appLimited, true, adminA, sessions.adminA, ORG_A, "2000-01-01.0");
      expect(res.statusCode).toBe(409);
      expect(codes(res)).toEqual(["NOTICE_ACK_STALE"]);
      expect(await setting(ORG_A)).toBeUndefined();
    });

    it("is accepted with the current version, and who, when and version are persisted and audited", async () => {
      await allAttested();
      const res = await put(appLimited, true);
      expect(res.statusCode).toBe(200);
      const row = (
        await admin.query(
          `SELECT notice_ack_version, notice_ack_by_user_id, notice_ack_at FROM tenant_messaging_search_setting WHERE organization_id=$1`,
          [ORG_A],
        )
      ).rows[0];
      expect(row.notice_ack_version).toBe(NOTICE_VERSION);
      expect(row.notice_ack_by_user_id).toBe(adminA);
      expect(row.notice_ack_at).toBeInstanceOf(Date);
      expect(res.json().noticeAcknowledgement).toMatchObject({
        version: NOTICE_VERSION,
        byUserId: adminA,
      });
      const audit = await admin.query(
        `SELECT after FROM audit_event WHERE event_type='tenant_messaging_search_setting.insert' AND resource_id=$1`,
        [ORG_A],
      );
      expect(audit.rows[0].after.notice_ack_version).toBe(NOTICE_VERSION);
    });

    it("a repeated ON re-acknowledges a newer notice version without counting as a flip (L4)", async () => {
      await allAttested();
      await put(appLimited, true);
      const changedAt = ((await setting(ORG_A))?.changed_at as Date).getTime();
      await admin.query(
        `UPDATE tenant_messaging_search_setting SET notice_ack_version='2026-01-01.0', notice_ack_at = now() - interval '1 day' WHERE organization_id=$1`,
        [ORG_A],
      );
      const res = await put(appLimited, true); // already ON, current version
      expect(res.statusCode).toBe(200);
      const row = (
        await admin.query(
          `SELECT notice_ack_version, notice_ack_by_user_id, changed_at FROM tenant_messaging_search_setting WHERE organization_id=$1`,
          [ORG_A],
        )
      ).rows[0];
      expect(row.notice_ack_version).toBe(NOTICE_VERSION);
      expect(row.notice_ack_by_user_id).toBe(adminA);
      expect((row.changed_at as Date).getTime()).toBe(changedAt);
      expect(res.json().noticeAcknowledgement).toMatchObject({ version: NOTICE_VERSION });
    });

    it("OFF needs no acknowledgement and keeps the last one on record", async () => {
      await allAttested();
      await put(appLimited, true);
      const off = await put(appLimited, false, adminA, sessions.adminA, ORG_A, null);
      expect(off.statusCode).toBe(200);
      expect((await setting(ORG_A))?.enabled).toBe(false);
      expect(off.json().noticeAcknowledgement?.version).toBe(NOTICE_VERSION);
    });

    it("GET exposes the current notice version and text", async () => {
      const body = (await get(appLimited)).json();
      expect(body.notice.version).toBe(NOTICE_VERSION);
      expect(body.notice.text.length).toBeGreaterThan(50);
      expect(body.noticeAcknowledgement).toBeNull();
    });
  });

  describe("excluded-category channel members (F6)", () => {
    const EXCLUDED_CATEGORIES = ["patient_family", "external_auditor", "platform_staff"];
    async function addExcludedMember(
      category: string,
      opts: { removed?: boolean; expired?: boolean; disabled?: boolean; revoked?: boolean } = {},
    ) {
      const userId = await seedUser(`excl-${category}-${Math.random()}`, ORG_A);
      const orgForRole = category === "platform_staff" ? null : ORG_A;
      const role = (
        await admin.query(
          `INSERT INTO role (organization_id, key, name, category, enabled)
         VALUES ($1,$2,$2,$3::role_category,$4) RETURNING id`,
          [orgForRole, `f6-${category}-${Math.random()}`, category, !opts.disabled],
        )
      ).rows[0].id as string;
      const mem = (await admin.query(`SELECT id FROM membership WHERE user_id=$1`, [userId]))
        .rows[0].id as string;
      await admin.query(
        `INSERT INTO membership_role (organization_id, membership_id, role_id, expires_at) VALUES ($1,$2,$3,$4)`,
        [ORG_A, mem, role, opts.expired ? new Date(Date.now() - 60_000) : null],
      );
      if (opts.revoked)
        await admin.query(`UPDATE membership SET status='revoked' WHERE id=$1`, [mem]);
      await admin.query(
        `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source, removed_at)
         VALUES ($1,$2,$3,'member','manual',$4)`,
        [ORG_A, channelA, userId, opts.removed ? new Date() : null],
      );
    }
    const cleared = async () => (await get(appLimited)).json().checklist.excludedMembersCleared;
    afterEach(async () => {
      await admin.query(
        `DELETE FROM channel_member WHERE organization_id=$1 AND user_id NOT IN ($2)`,
        [ORG_A, adminA],
      );
    });

    it.each(EXCLUDED_CATEGORIES)(
      "a live %s member fails the check and refuses ON",
      async (category) => {
        await allAttested();
        await addExcludedMember(category);
        expect(await cleared()).toBe(false);
        const res = await put(appLimited, true);
        expect(res.statusCode).toBe(409);
        expect(codes(res)).toEqual(["EXCLUDED_MEMBERS_PRESENT"]);
        expect(await setting(ORG_A)).toBeUndefined();
      },
    );

    it("a disabled excluded role still counts (deny wins)", async () => {
      await addExcludedMember("patient_family", { disabled: true });
      expect(await cleared()).toBe(false);
    });

    it("removed members, expired grants and revoked memberships do not count", async () => {
      await addExcludedMember("external_auditor", { removed: true });
      await addExcludedMember("patient_family", { expired: true });
      await addExcludedMember("patient_family", { revoked: true });
      expect(await cleared()).toBe(true);
    });

    it("a member holding BOTH an allowed and an excluded role still fails the check (L5)", async () => {
      await allAttested();
      const userId = await seedUser(`both-${Math.random()}`, ORG_A);
      const mem = (await admin.query(`SELECT id FROM membership WHERE user_id=$1`, [userId]))
        .rows[0].id as string;
      for (const category of ["clinical_staff", "patient_family"]) {
        const role = (
          await admin.query(
            `INSERT INTO role (organization_id, key, name, category, enabled)
             VALUES ($1,$2,$2,$3::role_category,true) RETURNING id`,
            [ORG_A, `l5-${category}-${Math.random()}`, category],
          )
        ).rows[0].id as string;
        await admin.query(
          `INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)`,
          [ORG_A, mem, role],
        );
      }
      await admin.query(
        `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
         VALUES ($1,$2,$3,'member','manual')`,
        [ORG_A, channelA, userId],
      );
      expect(await cleared()).toBe(false);
      expect(codes(await put(appLimited, true))).toEqual(["EXCLUDED_MEMBERS_PRESENT"]);
    });

    it("passes when none is present and ON succeeds", async () => {
      await allAttested();
      expect(await cleared()).toBe(true);
      expect((await put(appLimited, true)).statusCode).toBe(200);
    });
  });

  describe("GET", () => {
    it("returns the switch, the checklist and the rebuild progress", async () => {
      const empty = await get(appLimited);
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toMatchObject({
        enabled: false,
        changedAt: null,
        rebuild: null,
        checklist: {
          platformEnabled: false,
          legacyBodiesMigrated: true,
          escrowAttested: false,
          leakageAttested: false,
          rateLimitActive: true,
        },
      });
      await allAttested();
      await seedMessage(LEGACY_CIPHER);
      await admin.query(
        `INSERT INTO message_search_index_state (organization_id, key_version, status) VALUES ($1,'v1','building')`,
        [ORG_A],
      );
      const body = (await get(appDefault)).json();
      expect(body.checklist).toEqual({
        platformEnabled: true,
        legacyBodiesMigrated: false,
        escrowAttested: true,
        leakageAttested: true,
        rateLimitActive: false,
        excludedMembersCleared: true,
      });
      expect(body.rebuild).toMatchObject({
        keyVersion: "v1",
        status: "building",
        reconciledAt: null,
      });
    });
  });

  describe("tenancy", () => {
    it("an admin of org A cannot read or change org B, and org B's state is untouched by org A's flip", async () => {
      await allAttested();
      await admin.query(
        `INSERT INTO tenant_messaging_search_setting (organization_id, enabled) VALUES ($1,false)`,
        [ORG_B],
      );
      // claiming org B with org A's admin: no grant there
      expect((await get(appLimited, adminA, sessions.adminA, ORG_B)).statusCode).toBe(403);
      expect((await put(appLimited, true, adminA, sessions.adminA, ORG_B)).statusCode).toBe(403);
      expect((await put(appLimited, true)).statusCode).toBe(200);
      expect((await setting(ORG_B))?.enabled).toBe(false);
      // org B's admin sees B, not A
      expect((await get(appLimited, adminB, sessions.adminB, ORG_B)).json().enabled).toBe(false);
      expect((await get(appLimited)).json().enabled).toBe(true);
    });

    it("as wardenx_app a tenant cannot see another tenant's setting row (RLS)", async () => {
      await admin.query(
        `INSERT INTO tenant_messaging_search_setting (organization_id, enabled) VALUES ($1,true),($2,false)`,
        [ORG_A, ORG_B],
      );
      const rows = await handle.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.org_id', ${ORG_A}, true)`);
        const result = await tx.execute<{ organization_id: string }>(
          sql`SELECT organization_id FROM tenant_messaging_search_setting`,
        );
        return result.rows;
      });
      expect(rows.map((r) => r.organization_id)).toEqual([ORG_A]);
    });
  });

  describe("fix round: effectiveReady, body hardening, erased bodies, purge columns", () => {
    const seedReadyState = () =>
      admin.query(
        `INSERT INTO message_search_index_state (organization_id, key_version, status, reconciled_at)
         VALUES ($1,'v1','ready', now())
         ON CONFLICT (organization_id, key_version) DO UPDATE SET status='ready', reconciled_at=now()`,
        [ORG_A],
      );

    it("a ready index is not effectiveReady after a re-ON or a later platform flag change", async () => {
      await allAttested();
      expect((await put(appLimited, true)).statusCode).toBe(200);
      await seedReadyState();
      const first = (await get(appLimited)).json().rebuild;
      expect(first).toMatchObject({ status: "ready", effectiveReady: true });
      expect(first.reconciledAt).not.toBeNull();
      expect(first.changedAt).not.toBeNull();

      // OFF then ON again: the old `ready` row survives (no purge ran) but predates the new changed_at.
      await put(appLimited, false);
      await completePurge();
      expect((await put(appLimited, true)).statusCode).toBe(200);
      const reOn = (await get(appLimited)).json().rebuild;
      expect(reOn.status).toBe("ready");
      expect(reOn.effectiveReady).toBe(false);

      // reconciled again after the flip: effective; a later platform flag change makes it stale again
      await seedReadyState();
      expect((await get(appLimited)).json().rebuild.effectiveReady).toBe(true);
      await admin.query(
        `UPDATE feature_flag SET updated_at = now() + interval '1 minute'
          WHERE flag_key=$1 AND organization_id IS NULL`,
        [GLOBAL_SEARCH_PLATFORM_FLAG_KEY],
      );
      expect((await get(appLimited)).json().rebuild.effectiveReady).toBe(false);
    });

    it("a body naming another organization is refused and writes nothing for either org", async () => {
      await allAttested();
      const res = await appLimited.inject({
        method: "PUT",
        url: URL_PATH,
        headers: as(adminA, sessions.adminA),
        payload: {
          enabled: true,
          acknowledgedNoticeVersion: NOTICE_VERSION,
          organizationId: ORG_B,
        } as never,
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(await setting(ORG_B)).toBeUndefined();
      expect(await setting(ORG_A)).toBeUndefined();
    });

    it("erased (zero-length) bodies neither crash nor count as legacy", async () => {
      await allAttested();
      const message = await seedMessage(Buffer.alloc(0));
      await seedRevision(message, Buffer.alloc(0));
      const res = await put(appLimited, true);
      expect(res.statusCode).toBe(200);
      expect(res.json().checklist.legacyBodiesMigrated).toBe(true);
    });

    it("ON while the purge is incomplete is 409 PURGE_IN_PROGRESS and writes nothing; after the purge completes it succeeds and bumps changed_at", async () => {
      await allAttested();
      await put(appLimited, false);
      const before = await setting(ORG_A);
      expect(before?.purge_requested_at).not.toBeNull();
      expect(before?.purge_completed_at).toBeNull();

      const refused = await put(appLimited, true);
      expect(refused.statusCode).toBe(409);
      expect(codes(refused)).toEqual(["PURGE_IN_PROGRESS"]);
      expect(await setting(ORG_A)).toEqual(before);

      await completePurge();
      const completed = await setting(ORG_A);
      expect((await put(appLimited, true)).statusCode).toBe(200);
      const after = await setting(ORG_A);
      expect(after?.enabled).toBe(true);
      expect((after?.changed_at as Date).getTime()).toBeGreaterThan(
        (completed?.changed_at as Date).getTime(),
      );
      expect(after?.purge_completed_at).not.toBeNull();
    });

    it("a repeated ON after OFF preserves changed_at", async () => {
      await allAttested();
      await put(appLimited, false);
      await completePurge();
      await put(appLimited, true);
      const changed = (await setting(ORG_A))?.changed_at as Date;
      await put(appLimited, true);
      expect(((await setting(ORG_A))?.changed_at as Date).getTime()).toBe(changed.getTime());
    });
  });

  describe("interlock with the index writer", () => {
    it("an ON flip waits for a writer holding the setting row FOR SHARE", async () => {
      await allAttested();
      await admin.query(
        `INSERT INTO tenant_messaging_search_setting (organization_id, enabled) VALUES ($1,false)`,
        [ORG_A],
      );
      const writer = new Client({ connectionString: DB_URL });
      await writer.connect();
      try {
        await writer.query("BEGIN");
        await writer.query(
          `SELECT 1 FROM tenant_messaging_search_setting WHERE organization_id=$1 FOR SHARE`,
          [ORG_A],
        );
        const flip = put(appLimited, true);
        const raced = await Promise.race([
          flip.then(() => "done"),
          new Promise((resolve) => setTimeout(() => resolve("blocked"), 500)),
        ]);
        expect(raced).toBe("blocked");
        await writer.query("COMMIT");
        expect((await flip).statusCode).toBe(200);
      } finally {
        await writer.end();
      }
    });
  });
});
