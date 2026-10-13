/**
 * M36 Phase 2 Tranche B review fixes (WP 2.4 / 2.5 / 2.8 / 2.9 together), LIVE Postgres as the NOBYPASSRLS `wardenx_app`
 * role, through the real route stack (Authorization Contract + `channel_visibility` + Postgres idempotency store):
 *   - a send deletes the sender's own draft for that slot (channel / reply) in the same transaction, replay-safe and
 *     never touching a colleague's draft;
 *   - deleting a message frees its pin (the 20-pin cap counts live pins);
 *   - pin / unpin in an announcement channel need messaging.announce; reactions stay open to every member;
 *   - a non-uuid id on a reaction / pin / draft route is a clean 404/422, never a 500;
 *   - template caps hold under concurrent creates; the emergency template cannot be switched off;
 *   - drafts: a thread draft needs a live ROOT, a blank save from a stale device is a 409 (explicit DELETE discards),
 *     a per-user cap, and a user who lost the channel can still delete their own draft.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m36:review:live
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
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { createDbDraftService } from "../src/modules/36-messaging/drafts/draft-service-db";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import { createMessageBodyCipher } from "../src/modules/36-messaging/messaging-write-core";
import { registerDraftRoutes } from "../src/modules/36-messaging/routes/draft-routes";
import { registerMessagingRoutes } from "../src/modules/36-messaging/routes/messaging-routes";
import { registerTemplateRoutes } from "../src/modules/36-messaging/routes/template-routes";
import { createDbTemplateService } from "../src/modules/36-messaging/templates/template-service-db";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const KEK = randomBytes(32);
const ORG = "11111111-1111-4111-8111-1111000f0036";
const DRAFT_CAP = 3;
const PERSONAL_CAP = 50;

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

describe.skipIf(!DB_URL)("M36 Tranche B review fixes - LIVE Postgres", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let app: FastifyInstance;
  let boss: string;
  let n1: string;
  let n2: string;
  let loc: string;
  let loc2: string;
  let ann: string;

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

  const seedUser = async (suffix: string) => {
    const id = (
      await admin.query(`INSERT INTO "user" (email, name) VALUES ($1,$2) RETURNING id`, [
        `tb-${suffix}@x.test`,
        `TB ${suffix}`,
      ])
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
      [id, ORG],
    );
    return id;
  };
  const seedLocationChannel = async (title: string, members: string[]) => {
    const id = (
      await admin.query(
        `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class)
         VALUES ($1,'location',$2,$3,'care_related') RETURNING id`,
        [ORG, randomUUID(), title],
      )
    ).rows[0].id as string;
    for (const userId of members) {
      await admin.query(
        `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
         VALUES ($1,$2,$3,'member','manual')`,
        [ORG, id, userId],
      );
    }
    return id;
  };

  const as = (userId: string, key?: string) => ({
    "x-test-user": userId,
    "x-test-org": ORG,
    "x-test-roles": userId === boss ? "org_admin" : "clinical_rn",
    ...(key ? { "idempotency-key": key } : {}),
  });
  const rows = async (sql: string, params: unknown[] = []) =>
    (await admin.query(sql, params)).rows as Array<Record<string, any>>;
  const wipeDrafts = () => admin.query("DELETE FROM message_draft");

  const send = async (
    userId: string,
    channelId: string,
    body: string,
    opts: { parent?: string; key?: string } = {},
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/messaging/channels/${channelId}/messages`,
      headers: as(userId, opts.key ?? randomUUID()),
      payload: { body, ...(opts.parent ? { parentMessageId: opts.parent } : {}) },
    });
  const sendOk = async (userId: string, channelId: string, body: string, parent?: string) => {
    const res = await send(userId, channelId, body, { parent });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { messageId: string }).messageId;
  };
  const putDraft = (userId: string, channelId: string, over: Record<string, unknown> = {}) =>
    app.inject({
      method: "PUT",
      url: `/api/v1/messaging/channels/${channelId}/draft`,
      headers: as(userId),
      payload: { body: "my draft text", deviceId: "dev-1", baseRevision: 0, ...over },
    });
  const getDraft = async (userId: string, channelId: string, parent?: string) =>
    app.inject({
      method: "GET",
      url: `/api/v1/messaging/channels/${channelId}/draft${parent ? `?parentMessageId=${parent}` : ""}`,
      headers: as(userId),
    });
  const delDraft = (userId: string, channelId: string, parent?: string) =>
    app.inject({
      method: "DELETE",
      url: `/api/v1/messaging/channels/${channelId}/draft${parent ? `?parentMessageId=${parent}` : ""}`,
      headers: as(userId),
    });
  const pin = (userId: string, channelId: string, messageId: string, method: "PUT" | "DELETE") =>
    app.inject({
      method,
      url: `/api/v1/messaging/channels/${channelId}/messages/${messageId}/pin`,
      headers: as(userId),
    });
  const react = (userId: string, channelId: string, messageId: string, method: "PUT" | "DELETE") =>
    app.inject({
      method,
      url: `/api/v1/messaging/channels/${channelId}/messages/${messageId}/reactions/heart`,
      headers: as(userId),
    });

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
      `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'tb-a','A','A')`,
      [ORG],
    );
    boss = await seedUser("boss");
    n1 = await seedUser("n1");
    n2 = await seedUser("n2");
    loc = await seedLocationChannel("TB room one", [boss, n1, n2]);
    loc2 = await seedLocationChannel("TB room two", [boss, n1, n2]);
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    const service = createDbMessagingRouteService(handle.db, { kek: KEK });
    const grant = (userId: string, permissionKeys: string[]) => ({
      orgId: ORG,
      userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
    });
    const nurse = ["messaging.read", "messaging.send"];
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        grant(boss, [...nurse, "messaging.announce", "messaging.template.manage"]),
        grant(n1, nurse),
        grant(n2, nurse),
      ]).store,
    );
    const registry = createPredicateRegistry();
    registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
      const channelId = typeof target.id === "string" ? target.id : null;
      if (!channelId || !ctx.organizationId || !ctx.userId) return false;
      return service.canViewChannel(ctx.organizationId, ctx.userId, channelId);
    });
    registerAbacRegistry(registry);
    app = buildServer({
      db: handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: createDbIdempotencyStore(handle.db),
    });
    registerMessagingRoutes(app, {
      service,
      announcements: createDbAnnouncementService(handle.db),
    });
    registerDraftRoutes(app, {
      service: createDbDraftService({
        db: handle.db,
        cipher: createMessageBodyCipher({ kek: KEK }),
        maxPerUser: DRAFT_CAP,
      }),
    });
    registerTemplateRoutes(app, { service: createDbTemplateService(handle.db) });
    const announced = await app.inject({
      method: "POST",
      url: "/api/v1/messaging/announce",
      headers: as(boss, randomUUID()),
      payload: { body: "welcome to the tranche b review" },
    });
    expect(announced.statusCode, announced.body).toBe(201);
    ann = (announced.json() as { channelId: string }).channelId;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await handle?.close();
    await admin?.end();
  });

  describe("H3: a send removes the sender's own draft in the same transaction", () => {
    it("clears the channel draft on a send, leaves a colleague's draft alone", async () => {
      await wipeDrafts();
      expect((await putDraft(n1, loc, { body: "n1 channel draft" })).statusCode).toBe(200);
      expect((await putDraft(n2, loc, { body: "n2 channel draft" })).statusCode).toBe(200);
      await sendOk(n1, loc, "hello team");
      expect(((await getDraft(n1, loc)).json() as { draft: unknown }).draft).toBeNull();
      expect(await rows("SELECT user_id FROM message_draft")).toEqual([{ user_id: n2 }]);
    });

    it("clears the reply-slot draft on a reply, and only that slot", async () => {
      await wipeDrafts();
      const root = await sendOk(n2, loc, "root for the reply slot");
      await putDraft(n1, loc, { body: "channel composer text" });
      await putDraft(n1, loc, { body: "reply text", parentMessageId: root });
      await sendOk(n1, loc, "the reply", root);
      expect(((await getDraft(n1, loc, root)).json() as { draft: unknown }).draft).toBeNull();
      expect(((await getDraft(n1, loc)).json() as { draft: { body: string } }).draft.body).toBe(
        "channel composer text",
      );
    });

    it("an Idempotency-Key replay does not delete a newer draft", async () => {
      await wipeDrafts();
      const key = randomUUID();
      const first = await send(n1, loc, "idempotent hello", { key });
      expect(first.statusCode).toBe(201);
      await putDraft(n1, loc, { body: "typed after the send" });
      const replay = await send(n1, loc, "idempotent hello", { key });
      expect(replay.statusCode).toBe(201);
      expect(((await getDraft(n1, loc)).json() as { draft: { body: string } }).draft.body).toBe(
        "typed after the send",
      );
    });
  });

  describe("B1: deleting a message frees its pin", () => {
    it("pin 20, delete them, pin again succeeds and the list is consistent", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 21; i++) ids.push(await sendOk(n1, loc2, `pin candidate ${i}`));
      for (const id of ids.slice(0, 20)) {
        expect((await pin(n2, loc2, id, "PUT")).statusCode).toBe(200);
      }
      const over = await pin(n2, loc2, ids[20] as string, "PUT");
      expect(over.statusCode).toBe(409);
      for (const id of ids.slice(0, 20)) {
        const del = await app.inject({
          method: "DELETE",
          url: `/api/v1/messaging/messages/${id}`,
          headers: as(n1),
        });
        expect(del.statusCode).toBe(204);
      }
      expect((await rows("SELECT 1 FROM message_pin WHERE channel_id=$1", [loc2])).length).toBe(0);
      expect((await pin(n2, loc2, ids[20] as string, "PUT")).statusCode).toBe(200);
      const list = await app.inject({
        method: "GET",
        url: `/api/v1/messaging/channels/${loc2}/pins`,
        headers: as(n2),
      });
      expect((list.json() as { pins: unknown[] }).pins).toHaveLength(1);
    });
  });

  describe("round 2, item 7: a message delete takes the channel's pin lock", () => {
    it("a delete waits while another transaction holds the per-channel lock a pin takes", async () => {
      const messageId = await sendOk(n1, loc2, "deleted while the pin lock is held");
      const holder = new Client({ connectionString: DB_URL });
      await holder.connect();
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 36))", [loc2]);
      let finished = false;
      const deletion = app
        .inject({
          method: "DELETE",
          url: `/api/v1/messaging/messages/${messageId}`,
          headers: as(n1),
        })
        .then((res) => {
          finished = true;
          return res;
        });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(finished).toBe(false);
      await holder.query("COMMIT");
      await holder.end();
      expect((await deletion).statusCode).toBe(204);
    });
  });

  describe("B2: pins in an announcement channel need messaging.announce", () => {
    it("a member may react but not pin or unpin; the announcer may pin and unpin", async () => {
      const posted = await app.inject({
        method: "POST",
        url: "/api/v1/messaging/announce",
        headers: as(boss, randomUUID()),
        payload: { body: "a second announcement to pin" },
      });
      const messageId = (posted.json() as { messageId: string }).messageId;
      expect((await react(n1, ann, messageId, "PUT")).statusCode).toBe(200);
      expect((await react(n1, ann, messageId, "DELETE")).statusCode).toBe(200);
      expect((await pin(n1, ann, messageId, "PUT")).statusCode).toBe(403);
      expect((await pin(boss, ann, messageId, "PUT")).statusCode).toBe(200);
      expect((await pin(n1, ann, messageId, "DELETE")).statusCode).toBe(403);
      expect((await pin(boss, ann, messageId, "DELETE")).statusCode).toBe(204);
    });
  });

  describe("B3: malformed ids are a clean 404/422, never a 500", () => {
    const BAD = "not-a-uuid";
    it("reaction and pin routes answer 404 for a non-uuid channel or message id", async () => {
      const real = await sendOk(n1, loc, "a real message");
      for (const [channelId, messageId] of [
        [BAD, real],
        [loc, BAD],
        [BAD, BAD],
      ] as const) {
        for (const method of ["PUT", "DELETE"] as const) {
          const r = await react(n1, channelId, messageId, method);
          const p = await pin(n1, channelId, messageId, method);
          expect([r.statusCode, p.statusCode], `${method} ${channelId} ${messageId}`).toEqual([
            404, 404,
          ]);
        }
      }
    });

    it("the palette key stays a 422 and the pin list on a bad channel id is a 404", async () => {
      const real = await sendOk(n1, loc, "another real message");
      const badEmoji = await app.inject({
        method: "PUT",
        url: `/api/v1/messaging/channels/${loc}/messages/${real}/reactions/skull`,
        headers: as(n1),
      });
      expect(badEmoji.statusCode).toBe(422);
      const pins = await app.inject({
        method: "GET",
        url: `/api/v1/messaging/channels/${BAD}/pins`,
        headers: as(n1),
      });
      expect(pins.statusCode).toBe(404);
    });

    it("draft routes: a non-uuid channel id is a 404, a non-uuid parentMessageId a 422", async () => {
      expect((await getDraft(n1, BAD)).statusCode).toBe(404);
      expect((await putDraft(n1, BAD)).statusCode).toBe(404);
      expect((await delDraft(n1, BAD)).statusCode).toBe(404);
      expect((await getDraft(n1, loc, BAD)).statusCode).toBe(422);
      expect((await putDraft(n1, loc, { parentMessageId: BAD })).statusCode).toBe(422);
      expect((await delDraft(n1, loc, BAD)).statusCode).toBe(422);
    });
  });

  describe("B4: template caps hold under concurrent creates", () => {
    it("60 parallel personal creates leave exactly the cap, the rest answer 409", async () => {
      const results = await Promise.all(
        Array.from({ length: PERSONAL_CAP + 10 }, (_, i) =>
          app.inject({
            method: "POST",
            url: "/api/v1/messaging/templates/personal",
            headers: as(n1, randomUUID()),
            payload: { title: `Cap reply ${i}`, body: "Thanks, received.", category: "general" },
          }),
        ),
      );
      const created = results.filter((r) => r.statusCode === 201).length;
      const refused = results.filter((r) => r.statusCode === 409).length;
      expect(created).toBe(PERSONAL_CAP);
      expect(refused).toBe(10);
      expect(
        (await rows("SELECT 1 FROM message_template WHERE owner_user_id=$1", [n1])).length,
      ).toBe(PERSONAL_CAP);
    });
  });

  describe("B7: the emergency template cannot be switched off", () => {
    it("PUT overlay isEnabled:false on a template with required wording is a 422 and writes nothing", async () => {
      const [emergency] = await rows(
        "SELECT id FROM message_template WHERE scope='platform' AND cardinality(required_phrases) > 0 LIMIT 1",
      );
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/messaging/template-admin/platform/${emergency?.id}/overlay`,
        headers: as(boss),
        payload: { title: null, body: null, isEnabled: false },
      });
      expect(res.statusCode).toBe(422);
      expect(await rows("SELECT 1 FROM tenant_message_template_overlay")).toHaveLength(0);
    });
  });

  describe("drafts: slot rules, cap and deleting after losing the channel", () => {
    it("B5: a thread draft needs a live root; a reply is not a root", async () => {
      await wipeDrafts();
      const root = await sendOk(n2, loc, "soon-to-be-deleted root");
      const reply = await sendOk(n1, loc, "a reply, not a root", root);
      expect((await putDraft(n1, loc, { parentMessageId: reply })).statusCode).toBe(404);
      const del = await app.inject({
        method: "DELETE",
        url: `/api/v1/messaging/messages/${root}`,
        headers: as(n2),
      });
      expect(del.statusCode).toBe(204);
      expect((await putDraft(n1, loc, { parentMessageId: root })).statusCode).toBe(404);
    });

    it("B5: a blank save from a stale device is a 409 and keeps the newer draft; DELETE discards", async () => {
      await wipeDrafts();
      const a1 = await putDraft(n1, loc, { body: "from device A", deviceId: "dev-A" });
      expect(a1.statusCode).toBe(200);
      const b = await putDraft(n1, loc, {
        body: "from device B",
        deviceId: "dev-B",
        baseRevision: 1,
      });
      expect(b.statusCode).toBe(200);
      const staleBlank = await putDraft(n1, loc, {
        body: "   ",
        deviceId: "dev-A",
        baseRevision: 1,
      });
      expect(staleBlank.statusCode).toBe(409);
      expect(((await getDraft(n1, loc)).json() as { draft: { body: string } }).draft.body).toBe(
        "from device B",
      );
      expect((await delDraft(n1, loc)).statusCode).toBe(204);
      expect(((await getDraft(n1, loc)).json() as { draft: unknown }).draft).toBeNull();
    });

    it("B9: a user holds at most DRAFT_CAP drafts; updating an existing one at the cap still works", async () => {
      await wipeDrafts();
      const root = await sendOk(n2, loc, "root for the cap test");
      expect((await putDraft(n1, loc)).statusCode).toBe(200);
      expect((await putDraft(n1, loc2)).statusCode).toBe(200);
      expect((await putDraft(n1, loc, { parentMessageId: root })).statusCode).toBe(200);
      const fourth = await putDraft(n1, ann);
      expect(fourth.statusCode).toBe(409);
      expect((fourth.json() as { error: { code: string } }).error.code).toBe("DRAFT_LIMIT_REACHED");
      const update = await putDraft(n1, loc2, { body: "edited at the cap", baseRevision: 1 });
      expect(update.statusCode).toBe(200);
    });

    it("B12: a user who lost the channel can still delete their own draft there, but not read or write", async () => {
      await wipeDrafts();
      const gone = await seedLocationChannel("TB room three", [boss, n1]);
      expect((await putDraft(n1, gone)).statusCode).toBe(200);
      await admin.query(
        "UPDATE channel_member SET removed_at=now() WHERE channel_id=$1 AND user_id=$2",
        [gone, n1],
      );
      expect([403, 404]).toContain((await getDraft(n1, gone)).statusCode);
      expect([403, 404]).toContain((await putDraft(n1, gone, { baseRevision: 1 })).statusCode);
      expect((await delDraft(n1, gone)).statusCode).toBe(204);
      expect(await rows("SELECT 1 FROM message_draft WHERE channel_id=$1", [gone])).toHaveLength(0);
    });
  });
});
