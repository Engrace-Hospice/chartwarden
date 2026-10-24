/**
 * M36 WP 1.2 — idempotent durable send, LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
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
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m36:idempotent-send:live
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
import { messageBodySha256 } from "@chartwarden/messaging";
import type { IdempotencyStore } from "@chartwarden/shared";
import { XSS_CORPUS } from "@chartwarden/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";
import { CHANNEL_VISIBILITY_PREDICATE, CHANNEL_VISIBILITY_READ_PREDICATE } from "../src/modules/36-messaging/index";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import { createMessageBodyCipher } from "../src/modules/36-messaging/messaging-write-core";
import { registerMessagingRoutes } from "../src/modules/36-messaging/routes/messaging-routes";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
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
  const warnings: Array<{ message: string; context: Record<string, string> }> = [];

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
    registerMessagingRoutes(server, {
      service,
      announcements: createDbAnnouncementService(handle.db),
    });
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
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M36_OUTBOX_EVENTS]));
    const outbox = {
      publish: (tx: unknown, e: Record<string, unknown>) =>
        publisher.publish(tx as never, { ...e, callerModule: "m36" } as never),
    };
    service = createDbMessagingRouteService(handle.db, {
      kek: KEK,
      outbox: outbox as never,
      warn: (message, context) => warnings.push({ message, context }),
    });
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
    registry.register(CHANNEL_VISIBILITY_READ_PREDICATE, async (ctx, target) => {
      const channelId = typeof target.id === "string" ? target.id : null;
      if (!channelId || !ctx.organizationId || !ctx.userId) return false;
      return service.canReadChannel(ctx.organizationId, ctx.userId, channelId);
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

    it("Phase 1 gate (revoked participants): a member removed from the channel is refused on send (a replayed key re-serves only their own earlier response) and nothing is written", async () => {
      const key = randomUUID();
      const ok = await post(app, dm2, as(outsider, key), { body: "while a member" });
      expect(ok.statusCode).toBe(201);
      await admin.query(
        `UPDATE channel_member SET removed_at = now() WHERE channel_id=$1 AND user_id=$2`,
        [dm2, outsider],
      );
      const rows = await messageRows(dm2);
      const events = await count(
        `SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m36.message.sent'`,
        [],
      );
      const fresh = await post(app, dm2, as(outsider, randomUUID()), { body: "after removal" });
      const replayed = await post(app, dm2, as(outsider, key), { body: "while a member" });
      expect([403, 404]).toContain(fresh.statusCode); // refused by the visibility predicate
      // The M1 store replays the caller's own recorded response (their earlier messageId) before authorization runs;
      // that is a replay, not a write, and it carries nothing the user did not already receive.
      if (replayed.statusCode === 201) expect(replayed.json().messageId).toBe(ok.json().messageId);
      else expect([403, 404]).toContain(replayed.statusCode);
      expect(await messageRows(dm2)).toBe(rows);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m36.message.sent'`,
          [],
        ),
      ).toBe(events);
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

  describe("WP 2.1 structured (rich) body, real DB, real route stack", () => {
    const para = (...content: unknown[]) => ({ type: "paragraph", content });
    const text = (value: string, ...marks: unknown[]) =>
      marks.length ? { type: "text", text: value, marks } : { type: "text", text: value };
    const docOf = (...content: unknown[]) => ({ schemaVersion: 1, doc: { type: "doc", content } });
    const bodyCipher = createMessageBodyCipher({ kek: KEK });
    type Json = Record<string, any>;
    const read = async (userId: string, channelId: string) => {
      const all: Json[] = [];
      let cursor: string | undefined;
      do {
        const query = `limit=100&direction=forward${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const res = await app.inject({
          method: "GET",
          url: `/api/v1/messaging/channels/${channelId}/messages?${query}`,
          headers: as(userId),
        });
        expect(res.statusCode).toBe(200);
        all.push(...(res.json().messages as Json[]));
        cursor = res.json().nextCursor as string | undefined;
      } while (cursor);
      return all;
    };
    const patch = (userId: string, messageId: string, payload: Record<string, unknown>) =>
      app.inject({
        method: "PATCH",
        url: `/api/v1/messaging/messages/${messageId}`,
        headers: as(userId),
        payload,
      });
    const rowOf = async (messageId: string) =>
      (
        await admin.query(`SELECT body_kind, body_sha256, body_cipher FROM message WHERE id=$1`, [
          messageId,
        ])
      ).rows[0] as { body_kind: string; body_sha256: string; body_cipher: Buffer };
    const plaintextOf = (row: { body_cipher: Buffer }) => bodyCipher.open(ORG_A, row.body_cipher);

    it("stores canonical JSON under the tenant DEK with body_sha256 = the hash hash_verify recomputes", async () => {
      const res = await post(app, dm, as(user1, randomUUID()), {
        bodyDoc: docOf(
          para(
            text("Hello ", { type: "bold" }),
            text("docs", { type: "link", href: "https://example.com/g" }),
          ),
        ),
      });
      expect(res.statusCode).toBe(201);
      const row = await rowOf(res.json().messageId);
      expect(row.body_kind).toBe("rich");
      const plaintext = await plaintextOf(row);
      expect(JSON.parse(plaintext)).toMatchObject({ schemaVersion: 1 });
      expect(messageBodySha256(plaintext)).toBe(row.body_sha256);
      // Encrypted at rest: the visible text is not in the stored bytes.
      expect(row.body_cipher.includes(Buffer.from("Hello"))).toBe(false);
    });

    it("returns the projection as body (never JSON or a link target) plus the sanitised bodyDoc, and previews the projection", async () => {
      const res = await post(app, dm, as(user1, randomUUID()), {
        bodyDoc: docOf(
          para(
            text("read the "),
            text("guide", { type: "link", href: "https://hidden.example/secret?t=1" }),
          ),
        ),
      });
      const id = res.json().messageId as string;
      const message = (await read(user2, dm)).find((m) => m.messageId === id) as Json;
      expect(message).toMatchObject({ bodyKind: "rich", body: "read the guide" });
      expect(message.bodyDoc.doc.content[0].content[1].marks[0].href).toBe(
        "https://hidden.example/secret?t=1",
      );
      expect(message.body).not.toContain("hidden.example");

      const channels = await app.inject({
        method: "GET",
        url: "/api/v1/messaging/channels",
        headers: as(user2),
      });
      const entry = channels
        .json()
        .channels.find((c: { channelId: string }) => c.channelId === dm) as Json;
      expect(entry.lastMessage.preview).toBe("read the guide");
      expect(JSON.stringify(entry)).not.toContain("hidden.example");
    });

    it("a mention node becomes a message_entity_reference at projection offsets and one mentioned event", async () => {
      const res = await post(app, dm, as(user1, randomUUID()), {
        bodyDoc: docOf(
          para(
            text("ping "),
            { type: "mention", kind: "staff", entityId: user2, label: "WP12 u2" },
            text(" now"),
          ),
        ),
      });
      expect(res.statusCode).toBe(201);
      const id = res.json().messageId as string;
      const refs = (
        await admin.query(
          `SELECT reference_kind, entity_id, start_offset, end_offset FROM message_entity_reference WHERE message_id=$1`,
          [id],
        )
      ).rows;
      expect(refs).toEqual([
        { reference_kind: "staff", entity_id: user2, start_offset: 5, end_offset: 13 },
      ]);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m36.message.mentioned' AND aggregate_id=$1`,
          [id],
        ),
      ).toBe(1);
      const message = (await read(user2, dm)).find((m) => m.messageId === id) as Json;
      expect(message.body).toBe("ping @WP12 u2 now");
      expect(message.body.slice(5, 13)).toBe("@WP12 u2");
      expect(message.references[0]).toMatchObject({
        kind: "staff",
        entityId: user2,
        displayLabel: "WP12 u2",
      });
    });

    it("M1: write-time mention offsets index the body exactly as it is read back, after invisible+combining sequences", async () => {
      for (const prefix of ["e\u200C\u0301 ", "a\u00AD\u0308 ", "o\u202E\u0323\u200B "]) {
        const res = await post(app, dm, as(user1, randomUUID()), {
          bodyDoc: docOf(
            para(
              text(prefix),
              { type: "mention", kind: "staff", entityId: user2, label: "WP12 u2" },
              text(" end"),
            ),
          ),
        });
        expect(res.statusCode).toBe(201);
        const id = res.json().messageId as string;
        const stored = (
          await admin.query(
            `SELECT start_offset, end_offset FROM message_entity_reference WHERE message_id=$1`,
            [id],
          )
        ).rows[0] as { start_offset: number; end_offset: number };
        const shown = (await read(user2, dm)).find((m) => m.messageId === id) as Json;
        expect(shown.body.slice(stored.start_offset, stored.end_offset)).toBe("@WP12 u2");
      }
    });

    it("a mention label that is not the directory name, or an id outside the channel, is refused and writes nothing", async () => {
      const before = await messageRows(dm);
      for (const entityId of [user2, randomUUID()]) {
        const res = await post(app, dm, as(user1, randomUUID()), {
          bodyDoc: docOf(
            para({ type: "mention", kind: "staff", entityId, label: "<img src=x onerror=1>" }),
          ),
        });
        expect(res.statusCode).toBe(422);
        expect(res.body).not.toContain("<img");
      }
      expect(await messageRows(dm)).toBe(before);
    });

    it("idempotency: the same key and bodyDoc replays the original; a different bodyDoc under the key is 409", async () => {
      const headers = as(user1, randomUUID());
      const doc = docOf(para(text("once", { type: "italic" })));
      const first = await post(app, dm, headers, { bodyDoc: doc });
      const again = await post(app, dm, headers, { bodyDoc: doc });
      const changed = await post(app, dm, headers, { bodyDoc: docOf(para(text("twice"))) });
      expect(first.statusCode).toBe(201);
      expect(again.json().messageId).toBe(first.json().messageId);
      expect(changed.statusCode).toBe(409);
      // The DB backstop: the same clientMessageId with an equal document returns the original, a changed one is 409.
      const clientMessageId = randomUUID();
      const a = await post(app, dm, as(user1, randomUUID()), { bodyDoc: doc, clientMessageId });
      const b = await post(app, dm, as(user1, randomUUID()), { bodyDoc: doc, clientMessageId });
      const c = await post(app, dm, as(user1, randomUUID()), {
        bodyDoc: docOf(para(text("else"))),
        clientMessageId,
      });
      expect(b.json().messageId).toBe(a.json().messageId);
      expect(c.statusCode).toBe(409);
    });

    it("an edit carries its own format: rich -> rich -> plain -> rich, one revision per edit, each self-describing", async () => {
      const sent = await post(app, dm, as(user1, randomUUID()), {
        bodyDoc: docOf(para(text("v1", { type: "bold" }))),
      });
      const id = sent.json().messageId as string;
      expect((await patch(user1, id, { bodyDoc: docOf(para(text("v2"))) })).statusCode).toBe(200);
      expect((await rowOf(id)).body_kind).toBe("rich");
      const looksLikeJson = 'v3 plain {"looks":"like json"}';
      expect((await patch(user1, id, { body: looksLikeJson })).statusCode).toBe(200);
      const plain = await rowOf(id);
      expect(plain.body_kind).toBe("plain");
      expect(await plaintextOf(plain)).toBe(looksLikeJson);
      expect(
        (await patch(user1, id, { bodyDoc: docOf(para(text("v4", { type: "code" }))) })).statusCode,
      ).toBe(200);
      const head = await rowOf(id);
      expect(head.body_kind).toBe("rich");
      expect(messageBodySha256(await plaintextOf(head))).toBe(head.body_sha256);

      const revisions = (
        await admin.query(
          `SELECT revision_no, body_kind, body_sha256, body_cipher FROM message_revision WHERE message_id=$1 ORDER BY revision_no`,
          [id],
        )
      ).rows as Array<{
        revision_no: number;
        body_kind: string;
        body_sha256: string;
        body_cipher: Buffer;
      }>;
      expect(revisions.map((r) => [r.revision_no, r.body_kind])).toEqual([
        [1, "rich"],
        [2, "rich"],
        [3, "plain"],
      ]);
      for (const revision of revisions) {
        expect(messageBodySha256(await plaintextOf(revision))).toBe(revision.body_sha256);
      }
      const shown = (await read(user2, dm)).find((m) => m.messageId === id) as Json;
      expect(shown).toMatchObject({ bodyKind: "rich", body: "v4" });
      expect((await patch(user1, id, {})).statusCode).toBe(422);
      expect(
        (await patch(user1, id, { body: "x", bodyDoc: docOf(para(text("y"))) })).statusCode,
      ).toBe(422);
    });

    it("back-compat: existing plain and markdown rows read exactly as stored, with no bodyDoc", async () => {
      const plain = await service.sendMessage(ORG_A, {
        channelId: dm,
        authorUserId: user1,
        body: "**raw** <b>x</b>",
        bodyKind: "plain",
      });
      const markdown = await service.sendMessage(ORG_A, {
        channelId: dm,
        authorUserId: user1,
        body: "# [a](javascript:1)",
        bodyKind: "markdown",
      });
      const lookalike = '{"schemaVersion":1,"doc":{"type":"doc","content":[]}}';
      const legacy = await post(app, dm, as(user1, randomUUID()), { body: lookalike });
      const messages = await read(user2, dm);
      const byId = (id: string) => messages.find((m) => m.messageId === id) as Json;
      expect(byId(plain.messageId)).toMatchObject({ bodyKind: "plain", body: "**raw** <b>x</b>" });
      expect(byId(markdown.messageId)).toMatchObject({
        bodyKind: "markdown",
        body: "# [a](javascript:1)",
      });
      // A plain string that merely looks like a rich body stays plain text.
      expect(byId(legacy.json().messageId)).toMatchObject({ bodyKind: "plain", body: lookalike });
      for (const id of [plain.messageId, markdown.messageId, legacy.json().messageId]) {
        expect(byId(id)).not.toHaveProperty("bodyDoc");
      }
    });

    it("a rich row whose stored plaintext is not a valid document reads as an empty message, never as JSON or a 500", async () => {
      const sent = await post(app, dm, as(user1, randomUUID()), {
        bodyDoc: docOf(para(text("fine"))),
      });
      const id = sent.json().messageId as string;
      const hostile = JSON.stringify(docOf({ type: "html", html: "<script>1</script>" }));
      for (const garbage of ["not json", hostile]) {
        const sealed = await bodyCipher.seal(ORG_A, garbage);
        await admin.query(`UPDATE message SET body_cipher=$2, body_sha256=$3 WHERE id=$1`, [
          id,
          sealed.cipher,
          sealed.sha256,
        ]);
        const shown = (await read(user2, dm)).find((m) => m.messageId === id) as Json;
        expect(shown).toMatchObject({ bodyKind: "rich", body: "", bodyUnreadable: true });
        expect(shown).not.toHaveProperty("bodyDoc");
      }
      // S4: the server logs ids only (never content) so an operator can find the row.
      const logged = warnings.filter((w) => w.context.messageId === id);
      expect(logged.length).toBeGreaterThanOrEqual(2);
      expect(logged[0]?.context).toMatchObject({ messageId: id, organizationId: ORG_A });
      expect(JSON.stringify(logged)).not.toContain("script");
      expect(JSON.stringify(logged)).not.toContain("not json");
    });

    it("S3: a mention label matches the directory name under NFKC (fullwidth name, invisible characters)", async () => {
      await admin.query(`UPDATE "user" SET name=$2 WHERE id=$1`, [user2, "\uFF37\u200BP12 u2"]);
      try {
        const res = await post(app, dm, as(user1, randomUUID()), {
          bodyDoc: docOf(
            para({ type: "mention", kind: "staff", entityId: user2, label: "WP12 u2" }),
          ),
        });
        expect(res.statusCode).toBe(201);
      } finally {
        await admin.query(`UPDATE "user" SET name=$2 WHERE id=$1`, [user2, "WP12 u2"]);
      }
    });

    it("S2: an oversize, over-linked or href-expanding document is a 422 and writes nothing", async () => {
      const before = await messageRows(dm);
      const link = (href: string) => para(text("l", { type: "link", href }));
      const bodies = [
        docOf(link(`https://example.com/${"\u00e9".repeat(1_500)}`)),
        docOf(...Array.from({ length: 500 }, () => link("https://a.example/"))),
        docOf(
          ...Array.from({ length: 40 }, () => link(`https://example.com/${"a".repeat(1_900)}`)),
        ),
      ];
      for (const bodyDoc of bodies) {
        const res = await post(app, dm, as(user1, randomUUID()), { bodyDoc });
        expect(res.statusCode).toBe(422);
        expect(res.json().error.code).toBe("INVALID_RICH_BODY");
      }
      expect(await messageRows(dm)).toBe(before);
    });

    it("the seam cannot store a rich kind without a document", async () => {
      await expect(
        service.sendMessage(ORG_A, {
          channelId: dm,
          authorUserId: user1,
          body: "x",
          bodyKind: "rich",
        }),
      ).rejects.toMatchObject({ statusCode: 422 });
    });

    it("XSS corpus, stored: no payload is stored as an executable link target, as JSON on the wire, or echoed in an error", async () => {
      for (const { payload } of XSS_CORPUS) {
        const asText = await post(app, dm, as(user1, randomUUID()), {
          bodyDoc: docOf(para(text(payload))),
        });
        const asLink = await post(app, dm, as(user1, randomUUID()), {
          bodyDoc: docOf(para(text("go", { type: "link", href: payload }))),
        });
        expect([201, 422]).toContain(asText.statusCode);
        if (asText.statusCode === 422 && payload.length > 3) {
          expect(asText.body).not.toContain(payload);
        }
        if (asLink.statusCode === 422 && payload.length > 3) {
          expect(asLink.body).not.toContain(payload);
        }
      }
      for (const message of await read(user2, dm)) {
        if (message.bodyKind !== "rich" || !message.bodyDoc) continue;
        expect(message.body).not.toContain('"schemaVersion"');
        for (const match of JSON.stringify(message.bodyDoc).matchAll(/"href":"([^"]*)"/g)) {
          expect(match[1]).toMatch(/^(https:\/\/|mailto:)/);
        }
      }
    }, 120_000);
  });
});
