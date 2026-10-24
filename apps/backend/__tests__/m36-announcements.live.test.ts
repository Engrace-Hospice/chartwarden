/**
 * M36 WP 2.9 — announcements & department channels, LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * Proves on the real route stack (Authorization Contract + `channel_visibility` ABAC + Postgres idempotency store):
 *   - announcement SEND stays messaging.announce-only on both the announce route and the generic channel send route;
 *   - a read of an announcement writes exactly one `read` receipt per reader (never the author, never twice), single
 *     and up-to, and the sender-side receipt view reports readers and the unread list;
 *   - the receipt view is org-scoped (another org's admin gets the 404 a random id gets), audited as a read, and RLS
 *     (as chartwarden_app) denies reading or writing another org's receipts;
 *   - department channels: org-scoped subject check, find-or-create on the unique subject index (a race is one row),
 *     the creator is the owner, and a foreign / unknown subject is a 404 that writes nothing.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m36:announcements:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
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
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import {
  CHANNEL_MEMBER_ADMIN_PREDICATE,
  CHANNEL_VISIBILITY_PREDICATE,
  CHANNEL_VISIBILITY_READ_PREDICATE,
} from "../src/modules/36-messaging/index";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import {
  channelMemberAdminPredicate,
  registerMessagingRoutes,
} from "../src/modules/36-messaging/routes/messaging-routes";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "chartwarden_app",
  "chartwarden_admin",
  "chartwarden_readonly",
  "chartwarden_audit_writer",
];
const KEK = randomBytes(32);
const ORG_A = "11111111-1111-4111-8111-1111000f0029";
const ORG_B = "22222222-2222-4222-8222-2222000f0029";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  request.context.locationIds = [];
}

describe.skipIf(!DB_URL)("M36 WP 2.9 announcements & departments — LIVE Postgres", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let app: FastifyInstance;
  let adminA: string;
  let adminB: string;
  let nurse1: string;
  let nurse2: string;
  let nurse3: string;
  let locationA: string;
  let locationB: string;
  let roleId: string;

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
        `wp29-${suffix}@x.test`,
        `WP29 ${suffix}`,
      ])
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
      [id, organizationId],
    );
    return id;
  };
  const seedLocation = async (organizationId: string, name: string) => {
    const provider = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'\\x00','12-31') RETURNING id`,
        [
          organizationId,
          `CCN-${organizationId.slice(0, 4)}`,
          name,
          `NPI-${organizationId.slice(0, 4)}`,
        ],
      )
    ).rows[0].id as string;
    return (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone, status)
           VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles','active') RETURNING id`,
        [provider, name],
      )
    ).rows[0].id as string;
  };

  const as = (userId: string, org = ORG_A, key?: string) => ({
    "x-test-user": userId,
    "x-test-org": org,
    "x-test-roles": userId === adminA || userId === adminB ? "org_admin" : "clinical_rn",
    ...(key ? { "idempotency-key": key } : {}),
  });
  const count = async (sql: string, params: unknown[]) =>
    (await admin.query(sql, params)).rows[0].n as number;
  const announce = async (userId: string, body: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/messaging/announce",
      headers: as(userId, ORG_A, randomUUID()),
      payload: { body },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { messageId: string; channelId: string };
  };
  const read = (userId: string, messageId: string, upTo?: boolean) =>
    app.inject({
      method: "POST",
      url: `/api/v1/messaging/messages/${messageId}/read`,
      headers: as(userId),
      payload: upTo ? { upTo: true } : {},
    });
  const receipts = (userId: string, messageId: string, org = ORG_A) =>
    app.inject({
      method: "GET",
      url: `/api/v1/messaging/announcements/${messageId}/receipts`,
      headers: as(userId, org),
    });
  const createDepartment = (userId: string, payload: Record<string, unknown>, org = ORG_A) =>
    app.inject({
      method: "POST",
      url: "/api/v1/messaging/department-channels",
      headers: as(userId, org),
      payload,
    });
  const receiptRows = (messageId: string) =>
    count(`SELECT count(*)::int AS n FROM message_receipt WHERE message_id=$1`, [messageId]);

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
      `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'wp29-a','A','A'),($2,'wp29-b','B','B')`,
      [ORG_A, ORG_B],
    );
    adminA = await seedUser("admin-a", ORG_A);
    adminB = await seedUser("admin-b", ORG_B);
    nurse1 = await seedUser("n1", ORG_A);
    nurse2 = await seedUser("n2", ORG_A);
    nurse3 = await seedUser("n3", ORG_A);
    locationA = await seedLocation(ORG_A, "North Campus");
    locationB = await seedLocation(ORG_B, "South Campus");
    roleId = (
      await admin.query(
        `INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'wp29-sw','Social Work','clinical_staff',true) RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    const service = createDbMessagingRouteService(handle.db, { kek: KEK });
    const grant = (userId: string, org: string, permissionKeys: string[]) => ({
      orgId: org,
      userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
    });
    const nurse = ["messaging.read", "messaging.send"];
    const adminKeys = [...nurse, "messaging.manage_members", "messaging.announce"];
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        grant(adminA, ORG_A, adminKeys),
        grant(adminB, ORG_B, adminKeys),
        grant(nurse1, ORG_A, nurse),
        grant(nurse2, ORG_A, nurse),
        grant(nurse3, ORG_A, nurse),
      ]).store,
    );
    const registry = createPredicateRegistry();
    registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
      const channelId = typeof target.id === "string" ? target.id : null;
      if (!channelId || !ctx.organizationId || !ctx.userId) return false;
      return service.canViewChannel(ctx.organizationId, ctx.userId, channelId);
    });
    registry.register(CHANNEL_VISIBILITY_READ_PREDICATE, async (ctx, target) => {
      const channelId = typeof target.id === "string" ? target.id : null;
      if (!channelId || !ctx.organizationId || !ctx.userId) return false;
      return service.canReadChannel(ctx.organizationId, ctx.userId, channelId);
    });
    registry.register(CHANNEL_MEMBER_ADMIN_PREDICATE, channelMemberAdminPredicate(service));
    registerAbacRegistry(registry);
    app = buildServer({
      db: handle.db, // enables the read-audit emitter
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: createDbIdempotencyStore(handle.db),
    });
    registerMessagingRoutes(app, {
      service,
      announcements: createDbAnnouncementService(handle.db),
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await handle?.close();
    await admin?.end();
  });

  describe("announcement send stays org_admin-only", () => {
    it("a member is refused on the announce route and on the generic channel send route; nothing is written", async () => {
      const { channelId } = await announce(adminA, "welcome");
      const before = await count(`SELECT count(*)::int AS n FROM message WHERE channel_id=$1`, [
        channelId,
      ]);
      const viaAnnounce = await app.inject({
        method: "POST",
        url: "/api/v1/messaging/announce",
        headers: as(nurse1, ORG_A, randomUUID()),
        payload: { body: "fake" },
      });
      const viaChannel = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${channelId}/messages`,
        headers: as(nurse1, ORG_A, randomUUID()),
        payload: { body: "fake" },
      });
      expect(viaAnnounce.statusCode).toBe(403);
      expect(viaChannel.statusCode).toBe(403);
      expect(
        await count(`SELECT count(*)::int AS n FROM message WHERE channel_id=$1`, [channelId]),
      ).toBe(before);
      const ok = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${channelId}/messages`,
        headers: as(adminA, ORG_A, randomUUID()),
        payload: { body: "from the admin through the channel route" },
      });
      expect(ok.statusCode).toBe(201);
    });
  });

  describe("announcement read receipts", () => {
    it("a read writes one `read` receipt per reader, never for the author, and a repeat changes nothing", async () => {
      const { messageId } = await announce(adminA, "all hands");
      expect(await receiptRows(messageId)).toBe(0); // no members => no delivered fan-out
      expect((await read(nurse1, messageId)).statusCode).toBe(204);
      const first = (
        await admin.query(
          `SELECT status, read_at, user_id FROM message_receipt WHERE message_id=$1`,
          [messageId],
        )
      ).rows;
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ status: "read", user_id: nurse1 });
      expect(first[0].read_at).toBeInstanceOf(Date);
      expect((await read(nurse1, messageId)).statusCode).toBe(204);
      const again = (
        await admin.query(`SELECT read_at FROM message_receipt WHERE message_id=$1`, [messageId])
      ).rows;
      expect(again).toHaveLength(1);
      expect(again[0].read_at).toEqual(first[0].read_at);
      expect((await read(adminA, messageId)).statusCode).toBe(204);
      expect(await receiptRows(messageId)).toBe(1);
    });

    it("`upTo` covers every earlier announcement but not later ones", async () => {
      const m1 = await announce(adminA, "first");
      const m2 = await announce(adminA, "second");
      const m3 = await announce(adminA, "third");
      expect((await read(nurse2, m2.messageId, true)).statusCode).toBe(204);
      expect(await receiptRows(m1.messageId)).toBe(1);
      expect(await receiptRows(m2.messageId)).toBe(1);
      expect(await receiptRows(m3.messageId)).toBe(0);
    });

    it("the sender sees readers and the unread list; a member cannot", async () => {
      const { messageId } = await announce(adminA, "who read this");
      await read(nurse1, messageId);
      await read(nurse3, messageId);
      const view = (await receipts(adminA, messageId)).json();
      expect(view).toMatchObject({ messageId, recipientCount: 3, readCount: 2, truncated: false });
      expect(view.readers.map((r: { userId: string }) => r.userId).sort()).toEqual(
        [nurse1, nurse3].sort(),
      );
      expect(view.unread.map((r: { userId: string }) => r.userId)).toEqual([nurse2]);
      expect(view.readers[0].displayName).toMatch(/^WP29/);
      expect((await receipts(nurse1, messageId)).statusCode).toBe(403);
    });

    it("the receipt view is itself a recorded read of the message", async () => {
      const { messageId } = await announce(adminA, "audited");
      const before = await count(
        `SELECT count(*)::int AS n FROM audit_event WHERE resource_kind='message' AND resource_id=$1 AND event_type='message.viewed'`,
        [messageId],
      );
      expect((await receipts(adminA, messageId)).statusCode).toBe(200);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM audit_event WHERE resource_kind='message' AND resource_id=$1 AND event_type='message.viewed'`,
          [messageId],
        ),
      ).toBe(before + 1);
    });

    it("another organization's admin gets the 404 a random id gets; their read writes nothing in org A", async () => {
      const { messageId } = await announce(adminA, "org A only");
      const foreign = await receipts(adminB, messageId, ORG_B);
      const random = await receipts(adminB, randomUUID(), ORG_B);
      expect(foreign.statusCode).toBe(404);
      expect(random.statusCode).toBe(404);
      expect(foreign.json().error?.code ?? foreign.json().code).toBe(
        random.json().error?.code ?? random.json().code,
      );
      const crossRead = await read(adminB, messageId);
      expect(crossRead.statusCode).toBeGreaterThanOrEqual(400);
      expect(await receiptRows(messageId)).toBe(0);
    });

    it("a message outside the announcement channel is not an announcement (404)", async () => {
      const dmService = createDbMessagingRouteService(handle.db, { kek: KEK });
      const dm = await dmService.openDm(ORG_A, nurse1, nurse2);
      const sent = await dmService.sendMessage(ORG_A, {
        channelId: dm.channelId,
        authorUserId: nurse1,
        body: "private",
        correlationId: randomUUID(),
      } as never);
      expect((await receipts(adminA, sent.messageId)).statusCode).toBe(404);
    });

    it("RLS as chartwarden_app: org B's context cannot read or write org A's receipts", async () => {
      const { messageId } = await announce(adminA, "rls");
      await read(nurse1, messageId);
      const app_ = new Client({ connectionString: appRoleUrl(DB_URL as string) });
      await app_.connect();
      try {
        await app_.query("BEGIN");
        await app_.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_B]);
        const seen = await app_.query(
          `SELECT count(*)::int AS n FROM message_receipt WHERE organization_id=$1`,
          [ORG_A],
        );
        expect(seen.rows[0].n).toBe(0);
        await expect(
          app_.query(
            `INSERT INTO message_receipt (organization_id, message_id, user_id, status) VALUES ($1,$2,$3,'read')`,
            [ORG_A, messageId, nurse2],
          ),
        ).rejects.toThrow();
        await app_.query("ROLLBACK");
      } finally {
        await app_.end();
      }
      expect(await receiptRows(messageId)).toBe(1);
    });
  });

  describe("department channels", () => {
    it("org_admin creates a location channel owned by the creator; the title defaults to the location name", async () => {
      const res = await createDepartment(adminA, { kind: "location", subjectId: locationA });
      expect(res.statusCode).toBe(201);
      const { channelId } = res.json();
      const channel = (
        await admin.query(
          `SELECT channel_kind, subject_id, title, retention_class FROM channel WHERE id=$1`,
          [channelId],
        )
      ).rows[0];
      expect(channel).toMatchObject({
        channel_kind: "location",
        subject_id: locationA,
        title: "North Campus",
        retention_class: "care_related",
      });
      const members = (
        await admin.query(`SELECT user_id, role, source FROM channel_member WHERE channel_id=$1`, [
          channelId,
        ])
      ).rows;
      expect(members).toEqual([{ user_id: adminA, role: "owner", source: "manual" }]);
    });

    it("a repeat, and a concurrent race, resolve to the one channel", async () => {
      const results = await Promise.all(
        [1, 2, 3, 4].map(() =>
          createDepartment(adminA, { kind: "discipline", subjectId: roleId, title: "SW huddle" }),
        ),
      );
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 201]);
      expect(new Set(results.map((r) => r.json().channelId)).size).toBe(1);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM channel WHERE organization_id=$1 AND channel_kind='discipline' AND subject_id=$2`,
          [ORG_A, roleId],
        ),
      ).toBe(1);
    });

    it("membership goes through the existing member-admin routes; only members see the channel", async () => {
      const { channelId } = (
        await createDepartment(adminA, { kind: "location", subjectId: locationA })
      ).json();
      const hidden = await app.inject({
        method: "GET",
        url: `/api/v1/messaging/channels/${channelId}`,
        headers: as(nurse1),
      });
      expect(hidden.statusCode).toBe(403);
      const add = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${channelId}/members`,
        headers: as(adminA),
        payload: { userId: nurse1 },
      });
      expect(add.statusCode).toBe(204);
      const visible = await app.inject({
        method: "GET",
        url: `/api/v1/messaging/channels/${channelId}`,
        headers: as(nurse1),
      });
      expect(visible.statusCode).toBe(200);
    });

    it("a non-admin is refused; a foreign or unknown subject is a 404 that writes nothing", async () => {
      const before = await count(`SELECT count(*)::int AS n FROM channel`, []);
      expect(
        (await createDepartment(nurse1, { kind: "location", subjectId: locationA })).statusCode,
      ).toBe(403);
      const foreign = await createDepartment(adminA, { kind: "location", subjectId: locationB });
      const unknown = await createDepartment(adminA, {
        kind: "location",
        subjectId: randomUUID(),
      });
      const foreignRole = await createDepartment(
        adminB,
        {
          kind: "discipline",
          subjectId: roleId,
        },
        ORG_B,
      );
      expect([foreign.statusCode, unknown.statusCode, foreignRole.statusCode]).toEqual([
        404, 404, 404,
      ]);
      expect(await count(`SELECT count(*)::int AS n FROM channel`, [])).toBe(before);
    });
  });
});
