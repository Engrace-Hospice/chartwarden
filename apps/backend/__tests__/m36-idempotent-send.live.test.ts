/**
 * M36 WP 1.2 — idempotent durable send, LIVE Postgres as the NOBYPASSRLS `wardenx_app` role.
 *
 * Two layers, both proven against the real route stack (real Authorization Contract + `channel_visibility`
 * ABAC + the Postgres IdempotencyStore + the catalog-validating transactional outbox publisher):
 *   1. the `Idempotency-Key` HTTP middleware — required on the send routes; a replay returns the ORIGINAL
 *      response; a reused key with a different body or a different user is 409; a concurrent duplicate is
 *      one 201 and 409s, never two rows;
 *   2. the `client_message_id` DB backstop (unique per organization + author) — a retry that arrives under a
 *      FRESH Idempotency-Key (e.g. the first key was left `pending` because the response bookkeeping failed
 *      after the commit) still returns the original message and writes no second row, audit row or event.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m36:idempotent-send:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
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
} from "@wardenx/auth";
import { type DbClient, createDbClient } from "@wardenx/db";
import type { IdempotencyStore } from "@wardenx/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import { registerMessagingRoutes } from "../src/modules/36-messaging/routes/messaging-routes";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const KEK = randomBytes(32);
const ORG_A = "11111111-1111-4111-8111-1111000f0001";
const ORG_B = "22222222-2222-4222-8222-2222000f0002";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = ["clinical_rn"];
  request.context.locationIds = [];
}

describe.skipIf(!DB_URL)("M36 WP 1.2 idempotent send — LIVE Postgres", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let dbStore: IdempotencyStore;
  let service: ReturnType<typeof createDbMessagingRouteService>;
  let app: FastifyInstance;
  let user1: string;
  let user2: string;
  let outsider: string;
  let dm: string;
  let dm2: string;

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
        `wp12-${suffix}@x.test`,
        `WP12 ${suffix}`,
      ])
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
      [id, organizationId],
    );
    return id;
  };

  function serverWith(store: IdempotencyStore): FastifyInstance {
    const server = buildServer({
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: store,
    });
    registerMessagingRoutes(server, { service });
    return server;
  }

  const as = (userId: string, key?: string) => ({
    "x-test-user": userId,
    "x-test-org": ORG_A,
    ...(key ? { "idempotency-key": key } : {}),
  });
  const post = (
    server: FastifyInstance,
    channelId: string,
    headers: Record<string, string>,
    payload: Record<string, unknown>,
  ) =>
    server.inject({
      method: "POST",
      url: `/api/v1/messaging/channels/${channelId}/messages`,
      headers,
      payload,
    });
  const count = async (sql: string, params: unknown[]) =>
    (await admin.query(sql, params)).rows[0].n as number;
  const messageRows = (channelId: string) =>
    count(`SELECT count(*)::int AS n FROM message WHERE channel_id=$1`, [channelId]);
  const auditRows = (messageId: string) =>
    count(
      `SELECT count(*)::int AS n FROM audit_event WHERE resource_kind='message' AND resource_id=$1`,
      [messageId],
    );
  const sentEvents = (messageId: string) =>
    count(
      `SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m36.message.sent' AND aggregate_id=$1`,
      [messageId],
    );

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
      `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'wp12-a','A','A'),($2,'wp12-b','B','B')`,
      [ORG_A, ORG_B],
    );
    user1 = await seedUser("u1", ORG_A);
    user2 = await seedUser("u2", ORG_A);
    outsider = await seedUser("out", ORG_A);
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M36_OUTBOX_EVENTS]));
    const outbox = {
      publish: (tx: unknown, e: Record<string, unknown>) =>
        publisher.publish(tx as never, { ...e, callerModule: "m36" } as never),
    };
    service = createDbMessagingRouteService(handle.db, { kek: KEK, outbox: outbox as never });
    dm = (await service.openDm(ORG_A, user1, user2)).channelId;
    dm2 = (await service.openDm(ORG_A, user1, outsider)).channelId;
    dbStore = createDbIdempotencyStore(handle.db);

    const grants = createInMemoryEffectivePermissionStore(
      [user1, user2, outsider].map((userId) => ({
        orgId: ORG_A,
        userId,
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["messaging.read", "messaging.send"],
          },
        ],
      })),
    );
    registerEffectivePermissionResolver(grants.store);
    const registry = createPredicateRegistry();
    registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
      const channelId = typeof target.id === "string" ? target.id : null;
      if (!channelId || !ctx.organizationId || !ctx.userId) return false;
      return service.canViewChannel(ctx.organizationId, ctx.userId, channelId);
    });
    registerAbacRegistry(registry);
    app = serverWith(dbStore);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await handle?.close();
    await admin?.end();
  });

  describe("Idempotency-Key middleware on the send route", () => {
    it("rejects a send with no Idempotency-Key and writes nothing", async () => {
      const before = await messageRows(dm);
      const res = await post(app, dm, as(user1), { body: "no key" });
      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.json())).toContain("IDEMPOTENCY_KEY_REQUIRED");
      expect(await messageRows(dm)).toBe(before);
    });

    it("same key twice: one row, the original messageId, one audit row, one outbox event", async () => {
      const headers = as(user1, randomUUID());
      const first = await post(app, dm, headers, { body: "replay me" });
      const second = await post(app, dm, headers, { body: "replay me" });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      const id = first.json().messageId as string;
      expect(second.json().messageId).toBe(id);
      expect(
        await count(`SELECT count(*)::int AS n FROM message WHERE body_kind='plain' AND id=$1`, [
          id,
        ]),
      ).toBe(1);
      expect(await auditRows(id)).toBe(1);
      expect(await sentEvents(id)).toBe(1);
    });

    it("same key with a different body is rejected (409) and writes nothing", async () => {
      const headers = as(user1, randomUUID());
      const first = await post(app, dm, headers, { body: "original" });
      const before = await messageRows(dm);
      const changed = await post(app, dm, headers, { body: "changed" });
      expect(first.statusCode).toBe(201);
      expect(changed.statusCode).toBe(409);
      expect(await messageRows(dm)).toBe(before);
    });

    it("another user reusing the key is a 409, never a replay of the first user's response", async () => {
      const key = randomUUID();
      const mine = await post(app, dm, as(user1, key), { body: "mine" });
      const theirs = await post(app, dm, as(user2, key), { body: "mine" });
      expect(mine.statusCode).toBe(201);
      expect(theirs.statusCode).toBe(409);
      expect(JSON.stringify(theirs.json())).not.toContain(mine.json().messageId);
    });

    it("N concurrent sends under one key: exactly one 201, one row, the rest 409", async () => {
      const headers = as(user1, randomUUID());
      const body = `race ${randomUUID()}`;
      const before = await messageRows(dm);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => post(app, dm, headers, { body })),
      );
      const created = results.filter((r) => r.statusCode === 201);
      expect(created.length).toBeGreaterThanOrEqual(1);
      expect(new Set(created.map((r) => r.json().messageId)).size).toBe(1);
      expect(results.every((r) => r.statusCode === 201 || r.statusCode === 409)).toBe(true);
      expect(await messageRows(dm)).toBe(before + 1);
    });
  });

  describe("client_message_id DB backstop", () => {
    it("a retry under a FRESH key after the first response was never recorded returns the original", async () => {
      // Failure injection: the write COMMITS but the idempotency record is never completed (the store
      // errors in onSend), so the first key stays `pending` and a retry under it is a 409 forever.
      const brokenStore: IdempotencyStore = {
        ...dbStore,
        complete: async () => {
          throw new Error("injected: store unavailable after commit");
        },
      };
      const broken = serverWith(brokenStore);
      const clientMessageId = randomUUID();
      const payload = { body: "durable", clientMessageId };
      const k1 = randomUUID();
      const first = await post(broken, dm, as(user1, k1), payload);
      await broken.close();
      expect(first.statusCode).toBe(201);
      const id = first.json().messageId as string;

      const stuck = await post(app, dm, as(user1, k1), payload);
      expect(stuck.statusCode).toBe(409);

      const recovered = await post(app, dm, as(user1, randomUUID()), payload);
      expect(recovered.statusCode).toBe(201);
      expect(recovered.json().messageId).toBe(id);
      expect(recovered.json().createdAt).toBe(first.json().createdAt);
      expect(
        await count(`SELECT count(*)::int AS n FROM message WHERE client_message_id=$1`, [
          clientMessageId,
        ]),
      ).toBe(1);
      expect(await auditRows(id)).toBe(1);
      expect(await sentEvents(id)).toBe(1);
    });

    it("concurrent service sends with one clientMessageId collapse to one row and one event", async () => {
      const clientMessageId = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          service.sendMessage(ORG_A, {
            channelId: dm,
            authorUserId: user1,
            body: "concurrent",
            clientMessageId,
          }),
        ),
      );
      const id = results[0]!.messageId;
      expect(results.every((r) => r.messageId === id)).toBe(true);
      expect(
        await count(`SELECT count(*)::int AS n FROM message WHERE client_message_id=$1`, [
          clientMessageId,
        ]),
      ).toBe(1);
      expect(await auditRows(id)).toBe(1);
      expect(await sentEvents(id)).toBe(1);
    });

    it("the same clientMessageId from different authors does not collide", async () => {
      const clientMessageId = randomUUID();
      const a = await service.sendMessage(ORG_A, {
        channelId: dm,
        authorUserId: user1,
        body: "from one",
        clientMessageId,
      });
      const b = await service.sendMessage(ORG_A, {
        channelId: dm,
        authorUserId: user2,
        body: "from two",
        clientMessageId,
      });
      expect(a.messageId).not.toBe(b.messageId);
    });

    it("a reused clientMessageId with a different body or channel is a 409, not a silent replay", async () => {
      const clientMessageId = randomUUID();
      await service.sendMessage(ORG_A, {
        channelId: dm,
        authorUserId: user1,
        body: "first",
        clientMessageId,
      });
      await expect(
        service.sendMessage(ORG_A, {
          channelId: dm,
          authorUserId: user1,
          body: "second",
          clientMessageId,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        service.sendMessage(ORG_A, {
          channelId: dm2,
          authorUserId: user1,
          body: "first",
          clientMessageId,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("sends without a clientMessageId are never deduplicated against each other", async () => {
      const before = await messageRows(dm);
      await service.sendMessage(ORG_A, { channelId: dm, authorUserId: user1, body: "same" });
      await service.sendMessage(ORG_A, { channelId: dm, authorUserId: user1, body: "same" });
      expect(await messageRows(dm)).toBe(before + 2);
    });
  });
});
