/**
 * M36 WP 2.12 - ephemeral presence + typing, LIVE Postgres (as the NOBYPASSRLS `wardenx_app` role) + a throwaway Valkey.
 *
 * Proves: flag off (the default) => a member gets the typed PRESENCE_DISABLED and NOTHING is stored (Valkey keyspace empty,
 * no presence relation in Postgres, no audit/outbox rows); flag on => a heartbeat is visible to another member and expires
 * (TTL on the server clock); typing expires faster than presence; the stored keys/members are ids only; a removed member and
 * another tenant get exactly what a random channel id gets and write nothing; a tenant row / kill switch is honoured per
 * tenant; a Part 2 denied member of a patient-linked care_team channel is refused exactly like the message read.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... WARDENX_TEST_REDIS_URL=redis://... bun run test:m36:presence:live
 * Valkey, NOT Redis: a private `valkey/valkey:8` container (the keyspace assertions FLUSHDB it). For a local PG without
 * pgvector also set WARDENX_TEST_NO_PGVECTOR=1.
 *
 * STATUS: written against the repo's live-suite conventions and type-checked; NOT YET RUN (no Docker available on the
 * authoring host). The first CI run is its first execution.
 */
import { randomUUID } from "node:crypto";
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
import { Redis } from "ioredis";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDrizzleFeatureFlagReader } from "../src/bootstrap/feature-flag-store";
import { buildServer } from "../src/bootstrap/index";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import type { Part2ChannelGate } from "../src/modules/36-messaging/part2-channel-gate";
import { createValkeyPresenceStore } from "../src/modules/36-messaging/presence/valkey-presence-store";
import {
  CHANNEL_VISIBILITY_PREDICATE,
  registerMessagingRoutes,
} from "../src/modules/36-messaging/routes/messaging-routes";
import { PRESENCE_FLAG_KEY } from "../src/modules/36-messaging/routes/presence-routes";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const REDIS_URL = process.env.WARDENX_TEST_REDIS_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const KEK = Buffer.alloc(32, 7);
const TIMINGS = { presenceTtlMs: 2_500, typingTtlMs: 800, throttleMs: 200 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Who {
  readonly userId: string;
  readonly org: string;
}

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = ["clinical_rn"];
  request.context.locationIds = [];
}

describe.skipIf(!DB_URL || !REDIS_URL)(
  "M36 presence/typing (WP 2.12) - LIVE Postgres + Valkey",
  () => {
    let admin: Client;
    let appUrl: string;
    let handle: { db: DbClient; close: () => Promise<void> };
    let redis: Redis;
    let app: FastifyInstance;
    let orgA: string;
    let orgB: string;
    let u1: Who;
    let u2: Who;
    let removed: Who;
    let bUser: Who;
    let part2Denied: Who;
    let chA: string;
    let chB: string;
    let careTeam: string;
    let patientId: string;

    const headers = (who: Who) => ({ "x-test-user": who.userId, "x-test-org": who.org });
    const url = (channel: string) => `/api/v1/messaging/channels/${channel}/presence`;
    const post = (who: Who, channel: string, payload: object = {}) =>
      app.inject({
        method: "POST",
        url: url(channel),
        // the shared web client sends a key on every mutation; presence must not be captured by the idempotency table
        headers: { ...headers(who), "idempotency-key": randomUUID() },
        payload,
      });
    const get = (who: Who, channel: string) =>
      app.inject({ method: "GET", url: url(channel), headers: headers(who) });
    const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows;
    const presenceKeys = () => redis.keys("presence:*");
    const sideEffects = async () => ({
      audit: (await q("SELECT count(*)::int AS n FROM audit_event"))[0].n as number,
      outbox: (await q("SELECT count(*)::int AS n FROM outbox_event"))[0].n as number,
      messages: (await q("SELECT count(*)::int AS n FROM message"))[0].n as number,
      idempotency: (await q("SELECT count(*)::int AS n FROM idempotency_key"))[0].n as number,
    });
    const setFlag = async (org: string, value: boolean, killSwitch = false) => {
      await admin.query("DELETE FROM feature_flag WHERE flag_key=$1 AND organization_id=$2", [
        PRESENCE_FLAG_KEY,
        org,
      ]);
      await admin.query(
        `INSERT INTO feature_flag (organization_id, flag_key, flag_kind, value_type, value, kill_switch_active)
       VALUES ($1,$2,'product','bool',$3::jsonb,$4)`,
        [org, PRESENCE_FLAG_KEY, JSON.stringify(value), killSwitch],
      );
    };
    const clearFlags = () =>
      admin.query("DELETE FROM feature_flag WHERE flag_key=$1", [PRESENCE_FLAG_KEY]);

    const seedUser = async (name: string, org: string): Promise<Who> => {
      const id = (
        await admin.query(`INSERT INTO "user" (email, name) VALUES ($1,$2) RETURNING id`, [
          `pr-${name}@x.test`,
          `PR ${name}`,
        ])
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
        [id, org],
      );
      return { userId: id, org };
    };
    const mkChannel = async (org: string, kind: string, subject: string | null) =>
      (
        await admin.query(
          `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class)
         VALUES ($1,$2,$3,$4,'care_related') RETURNING id`,
          [org, kind, subject, `PR ${kind}`],
        )
      ).rows[0].id as string;
    const addMember = (org: string, channel: string, who: Who) =>
      admin.query(
        `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
       VALUES ($1,$2,$3,'member','manual')`,
        [org, channel, who.userId],
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
      orgA = (
        await admin.query(
          "INSERT INTO organization (slug,legal_name,display_name) VALUES ('pr-a','A','A') RETURNING id",
        )
      ).rows[0].id as string;
      orgB = (
        await admin.query(
          "INSERT INTO organization (slug,legal_name,display_name) VALUES ('pr-b','B','B') RETURNING id",
        )
      ).rows[0].id as string;
      u1 = await seedUser("u1", orgA);
      u2 = await seedUser("u2", orgA);
      removed = await seedUser("removed", orgA);
      part2Denied = await seedUser("part2", orgA);
      bUser = await seedUser("bUser", orgB);

      chA = await mkChannel(orgA, "location", randomUUID());
      chB = await mkChannel(orgB, "location", randomUUID());
      for (const w of [u1, u2, removed]) await addMember(orgA, chA, w);
      await addMember(orgB, chB, bUser);
      await admin.query(
        "UPDATE channel_member SET removed_at = now() WHERE channel_id=$1 AND user_id=$2",
        [chA, removed.userId],
      );
      patientId = (
        await admin.query(
          `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
         VALUES ($1,'MRN-PR','Pres','Ence','1990-01-01','F','active') RETURNING id`,
          [orgA],
        )
      ).rows[0].id as string;
      careTeam = await mkChannel(orgA, "care_team", patientId);
      for (const w of [u1, u2, part2Denied]) await addMember(orgA, careTeam, w);

      appUrl = await appRoleConnectionString(admin, DB_URL as string);
      handle = createDbClient({ connectionString: appUrl });
      // The Part 2 gate is the same port `canViewChannel` reads for message reads; deny exactly one member.
      const part2Gate: Part2ChannelGate = {
        allowedUserIds: async ({ userIds }) =>
          new Set(userIds.filter((id) => id !== part2Denied.userId)),
      };
      const service = createDbMessagingRouteService(handle.db, {
        kek: KEK,
        part2Gate,
        sendEndpointVerificationCode: async () => undefined,
      });
      registerEffectivePermissionResolver(
        createInMemoryEffectivePermissionStore(
          [u1, u2, removed, part2Denied, bUser].map((w) => ({
            orgId: w.org,
            userId: w.userId,
            grants: [
              {
                roleKey: "seed",
                enabled: true,
                expiresAt: null,
                permissionKeys: ["messaging.read", "messaging.send"],
              },
            ],
          })),
        ).store,
      );
      const registry = createPredicateRegistry();
      registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
        const id = typeof target.id === "string" ? target.id : null;
        return !!id && !!ctx.organizationId && !!ctx.userId
          ? service.canViewChannel(ctx.organizationId, ctx.userId, id)
          : false;
      });
      registerAbacRegistry(registry);

      redis = new Redis(REDIS_URL as string);
      await redis.flushdb();
      const flags = createDrizzleFeatureFlagReader(handle.db);
      app = buildServer({
        db: handle.db,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
        idempotencyStore: createDbIdempotencyStore(handle.db),
      });
      registerMessagingRoutes(app, {
        service,
        announcements: createDbAnnouncementService(handle.db),
        presence: {
          store: createValkeyPresenceStore(redis, TIMINGS),
          isEnabled: async (org) => (await flags.forOrg(org))[PRESENCE_FLAG_KEY] === true,
        },
      });
      await app.ready();
    }, 240_000);

    afterAll(async () => {
      await app?.close();
      await handle?.close();
      await redis?.flushdb();
      redis?.disconnect();
      await admin?.end();
      resetAuthorizationContract();
      resetRbacEngine();
      resetAbacRegistry();
    });

    it("runs as a non-superuser, non-BYPASSRLS role", async () => {
      const c = new Client({ connectionString: appUrl });
      await c.connect();
      const r = await c.query(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      await c.end();
      expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    });

    it("adds no presence persistence: the only presence relations are M36's original, unused `presence` table (migration 0016) and its indexes, and it stays empty", async () => {
      expect(
        (
          await q(
            `SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname ILIKE '%presence%' ORDER BY relname`,
          )
        ).map((r: { relname: string }) => r.relname),
      ).toEqual(["presence", "presence_pkey", "presence_status_idx"]);
      expect(await q(`SELECT 1 FROM presence LIMIT 1`)).toEqual([]);
    });

    describe("flag off (the default)", () => {
      it("a member gets the typed disabled answer and NOTHING is stored", async () => {
        await clearFlags();
        const before = await sideEffects();
        const p = await post(u1, chA, { typing: true });
        const g = await get(u2, chA);
        expect([p.statusCode, g.statusCode]).toEqual([403, 403]);
        expect(p.json().error.code).toBe("PRESENCE_DISABLED");
        expect(g.json().error.code).toBe("PRESENCE_DISABLED");
        expect(await presenceKeys()).toEqual([]);
        expect(await sideEffects()).toEqual(before);
      });

      it("an explicit false row and an active kill switch behave the same", async () => {
        await setFlag(orgA, false);
        expect((await post(u1, chA)).json().error.code).toBe("PRESENCE_DISABLED");
        await setFlag(orgA, true, true); // value true, but the kill switch wins
        expect((await post(u1, chA)).json().error.code).toBe("PRESENCE_DISABLED");
        expect(await presenceKeys()).toEqual([]);
      });
    });

    describe("flag on for org A", () => {
      it("a heartbeat is visible to another member, typing is faster to expire, then presence expires", async () => {
        await setFlag(orgA, true);
        const before = await sideEffects();
        expect((await post(u1, chA, { typing: true })).statusCode).toBe(204);
        const seen = await get(u2, chA);
        expect(seen.statusCode).toBe(200);
        expect(seen.json()).toEqual({ present: [u1.userId], typing: [u1.userId] });

        await sleep(TIMINGS.typingTtlMs + 400);
        const typingGone = (await get(u2, chA)).json();
        expect(typingGone.typing).toEqual([]);
        expect(typingGone.present).toEqual([u1.userId]);

        await sleep(TIMINGS.presenceTtlMs - TIMINGS.typingTtlMs);
        expect((await get(u2, chA)).json()).toEqual({ present: [], typing: [] });
        expect(await sideEffects()).toEqual(before); // ephemeral: no audit, outbox, message or idempotency row
      });

      it("throttles repeats (still 204) and stores ids only", async () => {
        await redis.flushdb();
        for (let i = 0; i < 5; i++) expect((await post(u2, chA)).statusCode).toBe(204);
        const keys = await presenceKeys();
        const setKeys = keys.filter((k) => !k.includes(":throttle:"));
        expect(setKeys).toHaveLength(1);
        expect(await redis.zcard(setKeys[0] as string)).toBe(1);
        expect(await redis.zrange(setKeys[0] as string, 0, -1)).toEqual([u2.userId]);
        const everything = JSON.stringify([keys, await redis.zrange(setKeys[0] as string, 0, -1)]);
        const idPattern = /^[0-9a-f-]{36}$/;
        expect(idPattern.test(u2.userId)).toBe(true);
        expect(everything).not.toMatch(/hello|PR u2|@x\.test/);
      });

      it("a removed member and another tenant get a random id's answer, and write nothing", async () => {
        await redis.flushdb();
        await setFlag(orgB, true);
        const control = await get(u1, randomUUID()); // a channel that does not exist
        for (const attacker of [removed, bUser]) {
          const g = await get(attacker, chA);
          const p = await post(attacker, chA, { typing: true });
          expect([g.statusCode, p.statusCode]).toEqual([control.statusCode, control.statusCode]);
          expect(g.json().error.code).toBe(control.json().error.code);
          expect(g.body).not.toContain(u1.userId);
        }
        expect(await presenceKeys()).toEqual([]);
        // and they see nothing of a live heartbeat
        await post(u1, chA);
        expect((await get(removed, chA)).statusCode).toBe(control.statusCode);
        expect((await get(bUser, chA)).statusCode).toBe(control.statusCode);
      });

      it("the flag is per tenant: org B's own member is disabled while org A is on, and enabled once B is on", async () => {
        await setFlag(orgB, false);
        expect((await post(bUser, chB)).json().error.code).toBe("PRESENCE_DISABLED");
        await setFlag(orgB, true);
        expect((await post(bUser, chB)).statusCode).toBe(204);
        const g = await get(bUser, chB);
        expect(g.json().present).toEqual([bUser.userId]);
        // org A's channel never sees org B's user
        expect((await get(u1, chA)).json().present).not.toContain(bUser.userId);
      });

      it("a Part 2 denied member of a patient-linked channel is refused exactly like the message read", async () => {
        await redis.flushdb();
        const messages = (who: Who) =>
          app.inject({
            method: "GET",
            url: `/api/v1/messaging/channels/${careTeam}/messages`,
            headers: headers(who),
          });
        const control = await get(u1, randomUUID());
        const deniedRead = await messages(part2Denied);
        expect(deniedRead.statusCode).toBe(control.statusCode);
        const deniedPost = await post(part2Denied, careTeam, { typing: true });
        const deniedGet = await get(part2Denied, careTeam);
        expect([deniedPost.statusCode, deniedGet.statusCode]).toEqual([
          deniedRead.statusCode,
          deniedRead.statusCode,
        ]);
        expect(await presenceKeys()).toEqual([]);

        expect((await messages(u1)).statusCode).toBe(200);
        expect((await post(u1, careTeam, { typing: true })).statusCode).toBe(204);
        const ok = await get(u2, careTeam);
        expect(ok.statusCode).toBe(200);
        expect(ok.json()).toEqual({ present: [u1.userId], typing: [u1.userId] });
        expect(ok.body).not.toContain(patientId); // ids of staff only; the patient never appears
      });
    });
  },
);
