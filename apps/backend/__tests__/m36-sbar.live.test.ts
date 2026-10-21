/**
 * M36 WP 3.3 - SBAR structured messages, LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * The real route stack (Authorization Contract, `channel_visibility`, the DB route service, the audit plumbing).
 *
 *   1. MIGRATION     tenant_sbar_policy: FORCE RLS, grants, bounds CHECKs (floor 1..500), hint CHECK.
 *   2. POLICY ROUTES PUT/GET/DELETE round-trip through the DB store; a value below the floor is refused before the DB.
 *   3. FLOOR ON READ a stored value below the floor (written past the CHECK by a superuser) never loosens it, and a
 *                    raised value beats an older lower one: send and GET both see the larger minimum.
 *   4. WRITE         SBAR lengths, announcement refusal, patient-channel requirement; a refusal rolls the whole send back
 *                    (no message row); the stored body is encrypted (the SBAR text is not in the row).
 *   5. EDIT          the same checks on the server edit path.
 *   6. FLAG          off => an sbar body is 422 SBAR_NOT_AVAILABLE and the policy GET is 404.
 *   7. TENANCY       as chartwarden_app org B sees none of org A's policy; an org A insert is rejected.
 *   8. AUDIT         the write-audit trigger fires on insert/update/delete and never copies a hint.
 *   9. DESTRUCTION   chartwarden_destruction can read and remove the org's own row only.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:sbar:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the chartwarden_* roles.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { type DbClient, createDbClient } from "@chartwarden/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import { registerMessagingRoutes } from "../src/modules/36-messaging/routes/messaging-routes";
import { createDbSbarPolicyStore } from "../src/modules/36-messaging/sbar/sbar-policy-store-db";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "chartwarden_destruction",
  "chartwarden_app",
  "chartwarden_admin",
  "chartwarden_readonly",
  "chartwarden_audit_writer",
];
const KEK = randomBytes(32);
const ORG_A = "11111111-1111-4111-8111-1111000d0001";
const ORG_B = "22222222-2222-4222-8222-2222000d0002";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-00000000d1d1";
const SECRET_HINT = "Zebra-Quartz-Hint";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = ["clinical_rn"];
  request.context.locationIds = [];
}

const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (value: string) => ({ type: "text", text: value });
const plainDoc = (value: string) => ({
  schemaVersion: 1,
  doc: { type: "doc", content: [para(text(value))] },
});
const sbarDoc = (sections: Partial<Record<string, string>> = {}, urgencyHint = "routine") => ({
  schemaVersion: 1,
  doc: {
    type: "doc",
    content: [
      {
        type: "sbar",
        urgencyHint,
        situation: [para(text(sections.situation ?? "Fever overnight"))],
        background: [para(text(sections.background ?? "Day 3 on service"))],
        assessment: [para(text(sections.assessment ?? "Likely infection"))],
        recommendation: [para(text(sections.recommendation ?? "Call the provider today"))],
      },
    ],
  },
});
const errorCode = (res: { json(): { error?: { code?: string }; code?: string } }) =>
  res.json().error?.code ?? res.json().code;

describe.skipIf(!DB_URL)("M36 WP 3.3 SBAR - LIVE Postgres", () => {
  let admin: Client;
  let appConn: Client;
  let destruction: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let service: ReturnType<typeof createDbMessagingRouteService>;
  let app: FastifyInstance;
  let offApp: FastifyInstance;
  let mgr: string;
  let u2: string;
  let orgBUser: string;
  let dm: string;
  let announcement: string;
  let careTeam: string;

  async function applyMigrations() {
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
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
        `wp33-${suffix}@x.test`,
        `WP33 ${suffix}`,
      ])
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
      [id, organizationId],
    );
    return id;
  };
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await admin.query(sql, params)).rows as T[];
  const count = async (sql: string, params: unknown[] = []) =>
    (await one<{ n: number }>(sql, params))[0]?.n ?? 0;
  const policyRows = (org?: string) =>
    org
      ? count(`SELECT count(*)::int AS n FROM tenant_sbar_policy WHERE organization_id=$1`, [org])
      : count("SELECT count(*)::int AS n FROM tenant_sbar_policy");
  const mkChannel = async (
    kind: string,
    retention: string,
    subject: string | null,
    title: string,
  ) => {
    const id = (
      await admin.query(
        `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [ORG_A, kind, subject, title, retention],
      )
    ).rows[0].id as string;
    for (const userId of [mgr, u2]) {
      await admin.query(
        `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
         VALUES ($1,$2,$3,'member','manual')`,
        [ORG_A, id, userId],
      );
    }
    return id;
  };

  function build(enabled: boolean): FastifyInstance {
    const server = buildServer({
      db: handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: createDbIdempotencyStore(handle.db),
    });
    registerMessagingRoutes(server, {
      service,
      announcements: createDbAnnouncementService(handle.db),
      sbar: { isEnabled: async () => enabled, store: createDbSbarPolicyStore(handle.db) },
    });
    return server;
  }

  const as = (userId: string, org = ORG_A, key?: string) => ({
    "x-test-user": userId,
    "x-test-org": org,
    ...(key ? { "idempotency-key": key } : {}),
  });
  const send = (userId: string, channel: string, bodyDoc: unknown, server = app) =>
    server.inject({
      method: "POST",
      url: `/api/v1/messaging/channels/${channel}/messages`,
      headers: as(userId, ORG_A, randomUUID()),
      payload: { bodyDoc } as object,
    });
  const edit = (userId: string, messageId: string, bodyDoc: unknown) =>
    app.inject({
      method: "PATCH",
      url: `/api/v1/messaging/messages/${messageId}`,
      headers: as(userId),
      payload: { bodyDoc } as object,
    });
  const putPolicy = (userId: string, payload: unknown, org = ORG_A) =>
    app.inject({
      method: "PUT",
      url: "/api/v1/messaging/template-admin/sbar-policy",
      headers: as(userId, org),
      payload: payload as object,
    });
  const getPolicy = (userId: string, org = ORG_A, server = app) =>
    server.inject({
      method: "GET",
      url: "/api/v1/messaging/sbar/policy",
      headers: as(userId, org),
    });
  const clearPolicy = (userId: string, org = ORG_A) =>
    app.inject({
      method: "DELETE",
      url: "/api/v1/messaging/template-admin/sbar-policy",
      headers: as(userId, org),
    });
  const messageRows = (channel: string) =>
    count("SELECT count(*)::int AS n FROM message WHERE channel_id=$1", [channel]);

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
      `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'wp33-a','A','A'),($2,'wp33-b','B','B')`,
      [ORG_A, ORG_B],
    );
    mgr = await seedUser("mgr", ORG_A);
    u2 = await seedUser("u2", ORG_A);
    orgBUser = await seedUser("b", ORG_B);
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    appConn = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await appConn.connect();
    const destructionUrl = new URL(DB_URL as string);
    destructionUrl.searchParams.set("options", "-c role=chartwarden_destruction");
    destruction = new Client({ connectionString: destructionUrl.toString() });
    await destruction.connect();

    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M36_OUTBOX_EVENTS]));
    const outbox = {
      publish: (tx: unknown, e: Record<string, unknown>) =>
        publisher.publish(tx as never, { ...e, callerModule: "m36" } as never),
    };
    service = createDbMessagingRouteService(handle.db, {
      kek: KEK,
      outbox: outbox as never,
      // Not under test: admit every manual care_team member (no SUD patient in this suite).
      part2Gate: { allowedUserIds: async ({ userIds }) => new Set(userIds) },
    });
    dm = (await service.openDm(ORG_A, mgr, u2)).channelId;
    announcement = await mkChannel("announcement", "operational", null, "Notices");
    careTeam = await mkChannel("care_team", "care_related", PATIENT, "Care team");

    const sender = ["messaging.read", "messaging.send", "messaging.announce"];
    const manager = [...sender, "messaging.template.manage"];
    const grant = (orgId: string, userId: string, permissionKeys: string[]) => ({
      orgId,
      userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
    });
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        grant(ORG_A, mgr, manager),
        grant(ORG_A, u2, sender),
        grant(ORG_B, orgBUser, manager),
      ]).store,
    );
    const registry = createPredicateRegistry();
    registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
      const channelId = typeof target.id === "string" ? target.id : null;
      if (!channelId || !ctx.organizationId || !ctx.userId) return false;
      return service.canViewChannel(ctx.organizationId, ctx.userId, channelId);
    });
    registerAbacRegistry(registry);
    app = build(true);
    offApp = build(false);
    await app.ready();
    await offApp.ready();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await offApp?.close();
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await handle?.close();
    await appConn?.end();
    await destruction?.end();
    await admin?.end();
  });

  describe("migration", () => {
    it("creates the table with FORCE RLS and least-privilege grants", async () => {
      const [rls] = await one<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='tenant_sbar_policy'",
      );
      expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const grants = async (grantee: string) =>
        (
          await one<{ privilege_type: string }>(
            `SELECT privilege_type FROM information_schema.role_table_grants
              WHERE table_name='tenant_sbar_policy' AND grantee=$1 ORDER BY 1`,
            [grantee],
          )
        ).map((g) => g.privilege_type);
      expect(await grants("chartwarden_app")).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
      expect(await grants("chartwarden_destruction")).toEqual(["DELETE", "SELECT"]);
    });

    it("pins the floor, ceiling and hint bounds in the database itself", async () => {
      const insert = (col: string, value: unknown) =>
        admin.query(
          `INSERT INTO tenant_sbar_policy (organization_id, ${col}, configured_by_user_id) VALUES ($1,$2,$3)`,
          [ORG_B, value, orgBUser],
        );
      for (const key of ["situation", "background", "assessment", "recommendation"]) {
        await expect(insert(`${key}_min_chars`, 0)).rejects.toThrow(/check constraint/);
        await expect(insert(`${key}_min_chars`, 501)).rejects.toThrow(/check constraint/);
        await expect(insert(`${key}_hint`, "   ")).rejects.toThrow(/check constraint/);
        await expect(insert(`${key}_hint`, "x".repeat(201))).rejects.toThrow(/check constraint/);
      }
      expect(await policyRows()).toBe(0);
    });
  });

  describe("policy routes", () => {
    it("round-trips PUT -> GET -> DELETE through the DB store, for the manager only", async () => {
      const body = {
        minChars: { situation: 40, recommendation: 25 },
        requirePatientChannel: false,
        hints: { assessment: "Your clinical read" },
      };
      expect((await putPolicy(u2, body)).statusCode).toBe(403);
      expect(await policyRows()).toBe(0);
      expect((await putPolicy(mgr, body)).statusCode).toBe(200);
      const read = await getPolicy(u2);
      expect(read.json()).toMatchObject({
        minChars: { situation: 40, background: 1, assessment: 1, recommendation: 25 },
        customized: true,
      });
      expect(read.json().hints.assessment).toBe("Your clinical read");
      expect((await clearPolicy(u2)).statusCode).toBe(403);
      expect((await clearPolicy(mgr)).statusCode).toBe(204);
      expect((await getPolicy(u2)).json()).toMatchObject({ customized: false });
      expect(await policyRows()).toBe(0);
    });

    it("refuses a value below the floor and a PHI-shaped hint without touching the row", async () => {
      const below = await putPolicy(mgr, { minChars: { situation: 0 } });
      expect(below.statusCode).toBe(422);
      expect(errorCode(below)).toBe("SBAR_POLICY_FLOOR_VIOLATION");
      const phi = await putPolicy(mgr, { hints: { situation: "MRN: 12345678" } });
      expect(phi.statusCode).toBe(422);
      expect(phi.body).not.toContain("12345678");
      expect(await policyRows()).toBe(0);
    });

    it("upsert replaces the single org row and records who configured it", async () => {
      await putPolicy(mgr, { minChars: { situation: 10 } });
      await putPolicy(mgr, { minChars: { situation: 20 } });
      const rows = await one<{ situation_min_chars: number; by: string }>(
        `SELECT situation_min_chars, configured_by_user_id::text AS by
           FROM tenant_sbar_policy WHERE organization_id=$1`,
        [ORG_A],
      );
      expect(rows).toEqual([{ situation_min_chars: 20, by: mgr }]);
      await clearPolicy(mgr);
    });
  });

  describe("floor re-applied on every read", () => {
    it("a stored value below the floor (written past the CHECK by a superuser) never loosens it", async () => {
      const check = "tenant_sbar_policy_situation_min";
      await admin.query(`ALTER TABLE tenant_sbar_policy DROP CONSTRAINT ${check}`);
      try {
        await admin.query(
          `INSERT INTO tenant_sbar_policy (organization_id, situation_min_chars, configured_by_user_id)
           VALUES ($1,0,$2)`,
          [ORG_A, mgr],
        );
        expect((await getPolicy(u2)).json().minChars.situation).toBe(1);
        const blank = await send(u2, dm, sbarDoc({ situation: "   " }));
        expect(blank.statusCode).toBe(422);
      } finally {
        await clearPolicy(mgr);
        await admin.query(
          `ALTER TABLE tenant_sbar_policy ADD CONSTRAINT ${check} CHECK ("situation_min_chars" BETWEEN 1 AND 500)`,
        );
      }
    });

    it("a raised minimum beats an older, lower stored value on both GET and send", async () => {
      await putPolicy(mgr, { minChars: { situation: 5 } });
      await putPolicy(mgr, { minChars: { situation: 60 } });
      const short = await send(u2, dm, sbarDoc({ situation: "six ch" }));
      expect(short.statusCode).toBe(422);
      expect(errorCode(short)).toBe("SBAR_INVALID");
      expect((await getPolicy(u2)).json().minChars.situation).toBe(60);
      await clearPolicy(mgr);
    });
  });

  describe("write path", () => {
    it("persists a valid SBAR message encrypted, and returns the node on read", async () => {
      const before = await messageRows(dm);
      const res = await send(u2, dm, sbarDoc({ situation: "Plain-Marker-Not-Stored" }, "urgent"));
      expect(res.statusCode).toBe(201);
      expect(await messageRows(dm)).toBe(before + 1);
      const [row] = await one(`SELECT * FROM message WHERE id=$1`, [res.json().messageId]);
      expect(JSON.stringify(row)).not.toContain("Plain-Marker-Not-Stored");
      const list = await app.inject({
        method: "GET",
        url: `/api/v1/messaging/channels/${dm}/messages`,
        headers: as(mgr),
      });
      expect(list.statusCode).toBe(200);
      expect(JSON.stringify(list.json())).toContain('"type":"sbar"');
    });

    it("refuses SBAR in an announcement channel and rolls the send back", async () => {
      const before = await messageRows(announcement);
      const res = await send(mgr, announcement, sbarDoc());
      expect(res.statusCode).toBe(422);
      expect(errorCode(res)).toBe("SBAR_NOT_ALLOWED_IN_CHANNEL");
      expect(await messageRows(announcement)).toBe(before);
    });

    it("enforces the tenant's patient-channel requirement against the channel kind in the database", async () => {
      await putPolicy(mgr, { requirePatientChannel: true });
      const before = await messageRows(dm);
      const refused = await send(u2, dm, sbarDoc());
      expect(refused.statusCode).toBe(422);
      expect(errorCode(refused)).toBe("SBAR_NOT_ALLOWED_IN_CHANNEL");
      expect(await messageRows(dm)).toBe(before);
      expect((await send(u2, careTeam, sbarDoc())).statusCode).toBe(201);
      await clearPolicy(mgr);
    });

    it("answers SBAR_INVALID with field details and no message text, leaving no message row", async () => {
      await putPolicy(mgr, { minChars: { assessment: 30 } });
      const before = await messageRows(dm);
      const res = await send(u2, dm, sbarDoc({ assessment: "Top-Secret-Short" }));
      expect(res.statusCode).toBe(422);
      expect(errorCode(res)).toBe("SBAR_INVALID");
      expect(JSON.stringify(res.json())).toContain("sbar.assessment");
      expect(res.body).not.toContain("Top-Secret-Short");
      expect(await messageRows(dm)).toBe(before);
      const long = await send(u2, dm, sbarDoc({ background: "x".repeat(2001) }));
      expect(JSON.stringify(long.json())).toContain("TOO_LONG");
      await clearPolicy(mgr);
    });

    it("holds the server edit path to the same rules", async () => {
      await putPolicy(mgr, { minChars: { situation: 40 } });
      const plain = await send(u2, dm, plainDoc("hi"));
      const messageId = plain.json().messageId as string;
      const bad = await edit(u2, messageId, sbarDoc({ situation: "too short" }));
      expect(bad.statusCode).toBe(422);
      expect(errorCode(bad)).toBe("SBAR_INVALID");
      const good = await edit(
        u2,
        messageId,
        sbarDoc({ situation: "A situation statement that is long enough for the policy" }),
      );
      expect(good.statusCode).toBe(200);
      await clearPolicy(mgr);
    });
  });

  describe("flag", () => {
    it("off: an sbar body is 422 SBAR_NOT_AVAILABLE with no row, plain text still sends, policy GET is 404", async () => {
      const before = await messageRows(dm);
      const res = await send(u2, dm, sbarDoc(), offApp);
      expect(res.statusCode).toBe(422);
      expect(errorCode(res)).toBe("SBAR_NOT_AVAILABLE");
      expect(await messageRows(dm)).toBe(before);
      expect((await send(u2, dm, plainDoc("hello"), offApp)).statusCode).toBe(201);
      expect((await getPolicy(u2, ORG_A, offApp)).statusCode).toBe(404);
    });
  });

  describe("tenancy, audit and destruction (as the real roles)", () => {
    it("org B cannot see or write org A's policy; each org's routes touch only its own row", async () => {
      await putPolicy(mgr, { minChars: { situation: 33 }, hints: { situation: SECRET_HINT } });
      await appConn.query("BEGIN");
      await appConn.query("SELECT set_config('app.org_id', $1, true)", [ORG_B]);
      expect(
        (await appConn.query("SELECT count(*)::int AS n FROM tenant_sbar_policy")).rows[0].n,
      ).toBe(0);
      await appConn.query("SAVEPOINT s1");
      await expect(
        appConn.query(
          "INSERT INTO tenant_sbar_policy (organization_id, configured_by_user_id) VALUES ($1,$2)",
          [ORG_A, mgr],
        ),
      ).rejects.toThrow(/row-level security|violates/);
      await appConn.query("ROLLBACK TO SAVEPOINT s1");
      const removed = await appConn.query(
        "DELETE FROM tenant_sbar_policy WHERE organization_id=$1",
        [ORG_A],
      );
      expect(removed.rowCount).toBe(0);
      await appConn.query("ROLLBACK");

      const bView = await getPolicy(orgBUser, ORG_B);
      expect(bView.json().customized).toBe(false);
      expect(bView.json().minChars.situation).toBe(1);
      await putPolicy(orgBUser, { minChars: { situation: 7 } }, ORG_B);
      expect((await getPolicy(u2)).json().minChars.situation).toBe(33);
      expect((await getPolicy(orgBUser, ORG_B)).json().minChars.situation).toBe(7);
      await clearPolicy(orgBUser, ORG_B);
      expect(await policyRows(ORG_A)).toBe(1);
    });

    it("the write-audit trigger records insert, update and delete and never copies a hint", async () => {
      await putPolicy(mgr, { hints: { situation: SECRET_HINT } });
      await clearPolicy(mgr);
      const events = await one<{ event_type: string; before: unknown; after: unknown }>(
        `SELECT event_type, before, after FROM audit_event
          WHERE resource_kind='tenant_sbar_policy' AND resource_id=$1 ORDER BY created_at, id`,
        [ORG_A],
      );
      const types = events.map((e) => e.event_type);
      expect(types).toContain("tenant_sbar_policy.insert");
      expect(types).toContain("tenant_sbar_policy.update");
      expect(types).toContain("tenant_sbar_policy.delete");
      const dump = JSON.stringify(events);
      expect(dump).not.toContain(SECRET_HINT);
      expect(dump).toContain("situation_min_chars");
    });

    it("chartwarden_destruction reads and removes only the org's own row", async () => {
      await putPolicy(mgr, { minChars: { situation: 12 } });
      await putPolicy(orgBUser, { minChars: { situation: 14 } }, ORG_B);
      await destruction.query("BEGIN");
      await destruction.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
      const seen = await destruction.query(
        "SELECT organization_id::text AS org FROM tenant_sbar_policy",
      );
      expect(seen.rows).toEqual([{ org: ORG_A }]);
      await destruction.query("SAVEPOINT s1");
      await expect(
        destruction.query("UPDATE tenant_sbar_policy SET situation_min_chars = 2"),
      ).rejects.toThrow(/permission denied/);
      await destruction.query("ROLLBACK TO SAVEPOINT s1");
      const removed = await destruction.query("DELETE FROM tenant_sbar_policy");
      expect(removed.rowCount).toBe(1);
      await destruction.query("COMMIT");
      expect(await policyRows(ORG_B)).toBe(1);
      expect(await policyRows(ORG_A)).toBe(0);
    });
  });

  describe("wiring (bound is not computing)", () => {
    it("the composition root builds the SBAR deps from the feature-flag reader and passes them to the M36 mount", () => {
      const root = readFileSync(join(__dirname, "../src/index.ts"), "utf8");
      expect(root).toContain("sbar: buildSbarDeps({ db: dbHandle.db, flags: featureFlagReader })");
      const mount = readFileSync(join(__dirname, "../src/modules/36-messaging/index.ts"), "utf8");
      expect(mount).toContain("sbar: opts.sbar");
    });
  });
});
