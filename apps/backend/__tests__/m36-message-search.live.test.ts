/**
 * M36 WP 2.7a in-conversation search (option A, decrypt-and-filter), LIVE Postgres as the NOBYPASSRLS `wardenx_app`
 * role through the real route stack:
 *   - returns only live, currently viewable messages of ONE channel (never a tombstone, an old edit body, another
 *     channel, another tenant, or a removed member's view);
 *   - sender / date / attachment filters, scan-gated attachment visibility, paging;
 *   - each search is read-audited with the channel and filter SHAPE but never the query text;
 *   - PERFORMANCE: p95 on a seeded history, bounded by SEARCH_MAX_SCAN_PER_REQUEST bodies per request (the measured
 *     numbers are printed as `[search-perf]` lines).
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m36:search:live
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
import { SEARCH_MAX_SCAN_PER_REQUEST } from "@wardenx/messaging";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import { createMessageBodyCipher } from "../src/modules/36-messaging/messaging-write-core";
import { registerMessagingRoutes } from "../src/modules/36-messaging/routes/messaging-routes";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const KEK = randomBytes(32);
const ORG = "11111111-1111-4111-8111-1111000f0277";
const ORG_B = "22222222-2222-4222-8222-2222000f0277";
const BIG = 20_000;
const MID = 5_000;
const PERF_RUNS = 30;
const P95_BUDGET_MS = 1000;
const POOL = 300;

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = ["clinical_rn"];
  request.context.locationIds = [];
}

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
};

describe.skipIf(!DB_URL)("M36 WP 2.7a in-conversation search - LIVE Postgres", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let app: FastifyInstance;
  let service: ReturnType<typeof createDbMessagingRouteService>;
  const cipher = createMessageBodyCipher({ kek: KEK });
  let u1: string;
  let u2: string;
  let u3: string;
  let userB: string;
  let room: string;
  let other: string;
  let foreign: string;

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

  const seedUser = async (org: string, suffix: string) => {
    const id = (
      await admin.query(`INSERT INTO "user" (email, name) VALUES ($1,$2) RETURNING id`, [
        `srch-${suffix}@x.test`,
        `Search ${suffix}`,
      ])
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
      [id, org],
    );
    return id;
  };
  const seedChannel = async (org: string, title: string, members: string[]) => {
    const id = (
      await admin.query(
        `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class)
         VALUES ($1,'location',$2,$3,'care_related') RETURNING id`,
        [org, randomUUID(), title],
      )
    ).rows[0].id as string;
    for (const userId of members) {
      await admin.query(
        `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
         VALUES ($1,$2,$3,'member','manual')`,
        [org, id, userId],
      );
    }
    return id;
  };
  /** One sealed message at an explicit time (newer ones sort first). */
  const seedMessage = async (
    org: string,
    channelId: string,
    author: string,
    body: string,
    createdAt: string,
  ) => {
    const sealed = cipher.seal(org, body);
    return (
      await admin.query(
        `INSERT INTO message (organization_id, channel_id, author_user_id, author_kind, body_cipher, body_sha256, created_at)
         VALUES ($1,$2,$3,'user',$4,$5,$6) RETURNING id`,
        [org, channelId, author, sealed.cipher, sealed.sha256, createdAt],
      )
    ).rows[0].id as string;
  };
  /** Bulk history: POOL distinct sealed bodies reused across `count` rows, oldest at `count` minutes back. */
  const seedHistory = async (channelId: string, author: string, count: number) => {
    await admin.query(
      "CREATE TEMP TABLE IF NOT EXISTS body_pool (idx int, cipher bytea, sha text)",
    );
    await admin.query("TRUNCATE body_pool");
    for (let i = 0; i < POOL; i += 1) {
      const text = `visit note ${i} patient comfortable pain managed ${i % 50 === 0 ? "morphine adjusted" : "repositioned"} family present`;
      const sealed = cipher.seal(ORG, text);
      await admin.query("INSERT INTO body_pool VALUES ($1,$2,$3)", [
        i,
        sealed.cipher,
        sealed.sha256,
      ]);
    }
    await admin.query(
      `INSERT INTO message (organization_id, channel_id, author_user_id, author_kind, body_cipher, body_sha256, created_at)
       SELECT $1,$2,$3,'user',p.cipher,p.sha, now() - interval '2 days' - (g * interval '1 second')
         FROM generate_series(1,$4::int) g JOIN body_pool p ON p.idx = g % ${POOL}`,
      [ORG, channelId, author, count],
    );
  };

  const headers = (userId: string, org = ORG) => ({ "x-test-user": userId, "x-test-org": org });
  const search = (userId: string, channelId: string, query: string) =>
    app.inject({
      method: "GET",
      url: `/api/v1/messaging/channels/${channelId}/search?${query}`,
      headers: headers(userId),
    });
  const ids = (res: { json: () => unknown }) =>
    (res.json() as { results: Array<{ messageId: string }> }).results.map((m) => m.messageId);
  const rows = async (sql: string, params: unknown[] = []) =>
    (await admin.query(sql, params)).rows as Array<Record<string, any>>;

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
      `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'srch-a','A','A'),($2,'srch-b','B','B')`,
      [ORG, ORG_B],
    );
    u1 = await seedUser(ORG, "u1");
    u2 = await seedUser(ORG, "u2");
    u3 = await seedUser(ORG, "u3");
    userB = await seedUser(ORG_B, "b");
    room = await seedChannel(ORG, "Search room", [u1, u2]);
    other = await seedChannel(ORG, "Search other", [u1, u2]);
    foreign = await seedChannel(ORG_B, "Foreign room", [userB]);
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    service = createDbMessagingRouteService(handle.db, { kek: KEK });

    const grant = (userId: string, orgId: string) => ({
      orgId,
      userId,
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: ["messaging.read", "messaging.send"],
        },
      ],
    });
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        grant(u1, ORG),
        grant(u2, ORG),
        grant(u3, ORG),
        grant(userB, ORG_B),
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
    });
    registerMessagingRoutes(app, {
      service,
      announcements: createDbAnnouncementService(handle.db),
    });
    await app.ready();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await handle?.close();
    await admin?.end();
  });

  describe("what a search may return", () => {
    it("returns matches of this channel newest first, case-insensitively, and nothing from another channel or tenant", async () => {
      const a = await seedMessage(
        ORG,
        room,
        u1,
        "Hospice aide visit: Quokka noted",
        "2026-01-01T10:00:00Z",
      );
      const b = await seedMessage(ORG, room, u2, "second quokka sighting", "2026-01-02T10:00:00Z");
      await seedMessage(ORG, room, u1, "unrelated chatter", "2026-01-03T10:00:00Z");
      await seedMessage(ORG, other, u1, "quokka in the other room", "2026-01-04T10:00:00Z");
      await seedMessage(ORG_B, foreign, userB, "quokka in another tenant", "2026-01-05T10:00:00Z");
      const res = await search(u1, room, "q=QUOKKA");
      expect(res.statusCode, res.body).toBe(200);
      expect(ids(res)).toEqual([b, a]);
      expect(res.json().scanCapped).toBe(false);
      expect(res.json().nextCursor).toBeUndefined();
    });

    it("never matches a deleted message and searches only the current body of an edited one", async () => {
      const gone = await seedMessage(ORG, room, u1, "walrus plan alpha", "2026-02-01T10:00:00Z");
      const edited = await seedMessage(
        ORG,
        room,
        u1,
        "narwhal original wording",
        new Date().toISOString(),
      );
      const del = await app.inject({
        method: "DELETE",
        url: `/api/v1/messaging/messages/${gone}`,
        headers: headers(u1),
      });
      expect(del.statusCode, del.body).toBeLessThan(300);
      const edit = await app.inject({
        method: "PATCH",
        url: `/api/v1/messaging/messages/${edited}`,
        headers: headers(u1),
        payload: { body: "narwhal revised wording" },
      });
      expect(edit.statusCode, edit.body).toBeLessThan(300);
      expect(ids(await search(u1, room, "q=walrus"))).toEqual([]);
      expect(ids(await search(u1, room, "q=original"))).toEqual([]);
      expect(ids(await search(u1, room, "q=revised"))).toEqual([edited]);
    });

    it("filters by sender and by date window", async () => {
      const mine = await seedMessage(ORG, room, u1, "platypus by u1", "2026-03-01T10:00:00Z");
      const theirs = await seedMessage(ORG, room, u2, "platypus by u2", "2026-03-10T10:00:00Z");
      expect(ids(await search(u1, room, `q=platypus&senderUserId=${u2}`))).toEqual([theirs]);
      expect(
        ids(await search(u1, room, "q=platypus&from=2026-03-05T00:00:00Z&to=2026-03-20T00:00:00Z")),
      ).toEqual([theirs]);
      expect(ids(await search(u1, room, "q=platypus&to=2026-03-05T00:00:00Z"))).toEqual([mine]);
      expect((await search(u1, room, `q=platypus&senderUserId=not-a-uuid`)).statusCode).toBe(422);
      expect((await search(u1, room, "q=platypus&from=garbage")).statusCode).toBe(422);
    });

    it("hasAttachment matches only attachments the viewer may see (clean, or their own pending)", async () => {
      const clean = await seedMessage(ORG, room, u2, "ocelot scan clean", "2026-04-01T10:00:00Z");
      const quarantined = await seedMessage(
        ORG,
        room,
        u2,
        "ocelot scan quarantined",
        "2026-04-02T10:00:00Z",
      );
      const pendingOther = await seedMessage(
        ORG,
        room,
        u2,
        "ocelot scan pending by u2",
        "2026-04-03T10:00:00Z",
      );
      const none = await seedMessage(ORG, room, u2, "ocelot no file", "2026-04-04T10:00:00Z");
      const attach = (messageId: string, state: string, by: string) =>
        admin.query(
          `INSERT INTO message_attachment (organization_id, channel_id, message_id, uploaded_by, mime_type, byte_size, filename, scan_state, object_key, sha256_hex, completed_at, scanned_at)
           VALUES ($1,$2,$3,$4,'application/pdf',10,'a.pdf',$5,'k/'||gen_random_uuid()::text, repeat('a',64), now(),
                   CASE WHEN $5 = 'pending' THEN NULL ELSE now() END)`,
          [ORG, room, messageId, by, state],
        );
      await attach(clean, "clean", u2);
      await attach(quarantined, "quarantined", u2);
      await attach(pendingOther, "pending", u2);
      const asU1 = await search(u1, room, "q=ocelot&hasAttachment=true");
      expect(ids(asU1)).toEqual([clean]);
      const asUploader = await search(u2, room, "q=ocelot&hasAttachment=true");
      expect(new Set(ids(asUploader))).toEqual(new Set([clean, pendingOther]));
      expect(ids(await search(u1, room, "q=ocelot"))).toContain(none);
      expect(ids(await search(u1, room, "q=ocelot"))).toContain(quarantined);
    });

    it("pages with a keyset cursor without repeating or skipping a match", async () => {
      const made: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        made.push(await seedMessage(ORG, room, u1, `capybara ${i}`, `2026-05-0${i + 1}T10:00:00Z`));
      }
      const first = await search(u1, room, "q=capybara&limit=2");
      expect(ids(first)).toEqual([made[4], made[3]]);
      const cursor = first.json().nextCursor as string;
      expect(cursor).toBeTruthy();
      const second = await search(
        u1,
        room,
        `q=capybara&limit=10&cursor=${encodeURIComponent(cursor)}`,
      );
      expect(ids(second)).toEqual([made[2], made[1], made[0]]);
      expect(second.json().nextCursor).toBeUndefined();
      expect((await search(u1, room, "q=capybara&cursor=garbage")).statusCode).toBe(400);
    });
  });

  describe("who may search", () => {
    it("refuses a non-member, an unknown channel and a foreign tenant's channel; the service answers the one 404", async () => {
      expect((await search(u3, room, "q=quokka")).statusCode).toBe(403);
      expect((await search(u1, randomUUID(), "q=quokka")).statusCode).toBe(403);
      expect((await search(u1, foreign, "q=quokka")).statusCode).toBe(403);
      for (const [user, channel] of [
        [u3, room],
        [u1, foreign],
        [u1, randomUUID()],
      ] as const) {
        await expect(
          service.searchMessages(ORG, { userId: user, channelId: channel, query: "quokka" }),
        ).rejects.toMatchObject({ statusCode: 404 });
      }
      expect((await search(u1, room, "q=a")).statusCode).toBe(422);
      expect((await search(u1, room, "")).statusCode).toBe(422);
    });

    it("stops returning anything the moment a member is removed, and refuses an archived channel with 410", async () => {
      const ephemeral = await seedChannel(ORG, "Ephemeral", [u1, u2]);
      const m = await seedMessage(ORG, ephemeral, u2, "gazelle sighting", "2026-06-01T10:00:00Z");
      expect(ids(await search(u1, ephemeral, "q=gazelle"))).toEqual([m]);
      await admin.query(
        "UPDATE channel_member SET removed_at = now() WHERE channel_id=$1 AND user_id=$2",
        [ephemeral, u1],
      );
      expect((await search(u1, ephemeral, "q=gazelle")).statusCode).toBe(403);
      await expect(
        service.searchMessages(ORG, { userId: u1, channelId: ephemeral, query: "gazelle" }),
      ).rejects.toMatchObject({ statusCode: 404 });
      await admin.query("UPDATE channel SET is_archived = true WHERE id=$1", [ephemeral]);
      await expect(
        service.searchMessages(ORG, { userId: u2, channelId: ephemeral, query: "gazelle" }),
      ).rejects.toMatchObject({ statusCode: 410 });
    });
  });

  describe("read audit", () => {
    it("lands one list read for the channel with the filter shape and WITHOUT the query text", async () => {
      const term = "audittermxyz";
      await seedMessage(ORG, room, u1, `body with ${term}`, "2026-07-01T10:00:00Z");
      await admin.query("DELETE FROM audit_event WHERE event_type='message.list_viewed'");
      const res = await search(u1, room, `q=${term}&limit=5`);
      expect(res.statusCode).toBe(200);
      const events = await rows(
        `SELECT context::text AS context, actor_user_id, resource_id FROM audit_event WHERE organization_id=$1 AND event_type='message.list_viewed'`,
        [ORG],
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.actor_user_id).toBe(u1);
      expect(events[0]!.context).not.toContain(term);
      expect(events[0]!.resource_id).toBe(room); // the channel is the resource; the query text still is not
      const context = JSON.parse(events[0]!.context as string);
      expect(context.count).toBe(1);
      expect(context.filter).toMatchObject({ q: "[omitted]", id: room });
    });
  });

  describe("performance (option A ceiling)", () => {
    interface Measured {
      p50: number;
      p95: number;
      last: Awaited<ReturnType<typeof service.searchMessages>>;
    }
    async function measure(channelId: string, query: string): Promise<Measured> {
      const times: number[] = [];
      let last: Awaited<ReturnType<typeof service.searchMessages>> | undefined;
      await service.searchMessages(ORG, { userId: u1, channelId, query }); // warm the plan and the DEK
      for (let i = 0; i < PERF_RUNS; i += 1) {
        const started = performance.now();
        last = await service.searchMessages(ORG, { userId: u1, channelId, query });
        times.push(performance.now() - started);
      }
      return { p50: percentile(times, 50), p95: percentile(times, 95), last: last! };
    }

    it(`p95 < ${P95_BUDGET_MS} ms when a request opens ${SEARCH_MAX_SCAN_PER_REQUEST} bodies (worst case: no match)`, async () => {
      const mid = await seedChannel(ORG, "Perf mid", [u1]);
      await seedHistory(mid, u1, MID);
      const big = await seedChannel(ORG, "Perf big", [u1]);
      await seedHistory(big, u1, BIG);
      const planted = await seedMessage(
        ORG,
        big,
        u1,
        "the rare token xylophonix lives here",
        "2020-01-01T00:00:00Z",
      );

      const midNoMatch = await measure(mid, "zzzabsent");
      const bigNoMatch = await measure(big, "zzzabsent");
      const bigCommon = await measure(big, "morphine");
      const ms = (value: number): string => `${value.toFixed(0)}ms`;
      const report = (label: string, run: Measured): void => {
        process.stderr.write(
          `\n[search-perf] ${label}: scanned=${run.last.scanned} capped=${run.last.scanCapped} p50=${ms(run.p50)} p95=${ms(run.p95)}\n`,
        );
      };
      report(`${MID} msgs, no match`, midNoMatch);
      report(`${BIG} msgs, no match (scan cap)`, bigNoMatch);
      report(`${BIG} msgs, common term, page of 20`, bigCommon);

      expect(midNoMatch.last.scanned).toBe(MID);
      expect(midNoMatch.last.scanCapped).toBe(false);
      expect(bigNoMatch.last.scanned).toBe(SEARCH_MAX_SCAN_PER_REQUEST);
      expect(bigNoMatch.last.scanCapped).toBe(true);
      expect(bigNoMatch.last.nextCursor).toBeTruthy();
      for (const run of [midNoMatch, bigNoMatch, bigCommon])
        expect(run.p95).toBeLessThan(P95_BUDGET_MS);

      // Following the continuation cursor reaches the oldest match beyond the cap, in a bounded number of requests.
      let cursor = bigNoMatch.last.nextCursor;
      let found: string[] = [];
      let requests = 1;
      while (cursor && found.length === 0) {
        const page = await service.searchMessages(ORG, {
          userId: u1,
          channelId: big,
          query: "xylophonix",
          cursor,
        });
        requests += 1;
        found = page.results.map((m) => m.messageId);
        cursor = page.nextCursor;
      }
      expect(found).toEqual([planted]);
      expect(requests).toBeLessThanOrEqual(Math.ceil(BIG / SEARCH_MAX_SCAN_PER_REQUEST) + 1);
    }, 300_000);
  });
});
