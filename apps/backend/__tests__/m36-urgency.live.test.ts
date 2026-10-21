/**
 * M36 WP 4.1 - the urgency model ("Urgent clinical"), LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * The real route stack (Authorization Contract, `channel_visibility`, the DB route service, the audit plumbing, the M1
 * idempotency store) over the REAL catalog-validating outbox publisher (not NOOP_OUTBOX).
 *
 *   1. HAPPY PATH    a nurse sends an SBAR message to a qualified colleague: ONE message with urgency=urgent and that
 *                    recipient, ONE id-only outbox row, visible as urgent on the read; routine messages stay routine.
 *   2. REPLAY        same client_message_id (new key and same key) => one message, one event; a different recipient on a
 *                    reused id is the idempotency conflict.
 *   3. NEGATIVES     no patient channel, no SBAR, no/invalid recipient (author, unqualified, not a channel member, off the
 *                    care team, aide, Part 2 denied, other tenant), sender without messaging.urgent.send, flag off:
 *                    every one refuses and writes NOTHING (message and outbox row counts unchanged).
 *   4. EDIT          an urgent message cannot be edited (422); a routine one still can.
 *   5. DB BACKSTOPS  urgency and recipient are immutable even for a superuser; the shape CHECK fires both ways; the
 *                    ordinary send route cannot make an urgent message.
 *   6. ATOMIC        a publisher failure rolls the message back.
 *   7. NOTIFY        the real consumer turns the stored event into ONE generic alert for the recipient, no PHI.
 *   8. OPTIONS       only qualified care-team members of this channel are offered, never the caller.
 *   9. TENANCY       org B and an outsider get a random channel's answer and nothing is written.
 *  10. READ AUDIT    the send and the options read each land an audit row with a resource id.
 *  11. GRANTS        migration 1105 grants receive only to qualified clinical role keys.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:urgency:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the wardenx_* roles.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPredicateRegistry,
  registerAbacRegistry,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { AlertEmitter } from "@chartwarden/messaging";
import { SBAR_MAX_SECTION_CHARS } from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { createInMemoryRateLimitStore } from "../src/bootstrap/plugins/rate-limit-store";
import { buildUrgentRateLimit } from "../src/bootstrap/plugins/urgent-rate-limit";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import { buildM36UrgentNotificationsConsumer } from "../src/modules/36-messaging/outbox-consumers/urgent-notifications";
import { registerMessagingRoutes } from "../src/modules/36-messaging/routes/messaging-routes";
import { buildUrgentDeps } from "../src/modules/36-messaging/urgent/deps";
import {
  type LiveKit,
  MIGRATIONS_DIR,
  STAFF_KEYS,
  as,
  bootLiveKit,
  catalogOutbox,
  errorCode,
  headerAuth,
  mkChannel,
} from "./_m36-handoff-live-kit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-11110a410001";
const ORG_B = "22222222-2222-4222-8222-22220a410002";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a41a1";
const SEND = (channel: string) => `/api/v1/messaging/channels/${channel}/urgent-messages`;
const FLAGS = { "messaging.urgent_clinical": true, "messaging.sbar": true };
const SEND_KEYS = [...STAFF_KEYS, "messaging.urgent.send"];
const RECEIVE_KEYS = [...STAFF_KEYS, "messaging.urgent.receive"];
const SECRET = "Uncontrolled pain nine of ten";

const para = (value: string) => ({ type: "paragraph", content: [{ type: "text", text: value }] });
const sbarDoc = (situation = SECRET) => ({
  schemaVersion: 1,
  doc: {
    type: "doc",
    content: [
      {
        type: "sbar",
        urgencyHint: "routine",
        situation: [para(situation)],
        background: [para("Day three on service, on morphine")],
        assessment: [para("Pain is not controlled by the current plan")],
        recommendation: [para("Please review the plan within the hour")],
      },
    ],
  },
});
const plainDoc = { schemaVersion: 1, doc: { type: "doc", content: [para("hello there")] } };

describe.skipIf(!DB_URL)("M36 WP 4.1 urgency model - LIVE Postgres", () => {
  let kit: LiveKit;
  let app: FastifyInstance;
  let offApp: FastifyInstance;
  let failingApp: FastifyInstance;
  let nurse: string;
  let aide: string;
  let plainSender: string;
  let rn: string;
  let rn2: string;
  let unqualified: string;
  let notInChannel: string;
  let part2Blocked: string;
  let orgBUser: string;
  let channel: string;
  let locationChannel: string;
  const keysOf = new Map<string, readonly string[]>();
  let careTeam: string[] = [];

  const seed = async (suffix: string, org: string, keys: string[]) => {
    const id = await kit.seedUser(suffix, org, keys);
    keysOf.set(id, keys);
    return id;
  };
  const permissionsFor = async (_org: string, userId: string) => new Set(keysOf.get(userId) ?? []);

  const makeServer = (
    flags: Record<string, boolean>,
    outbox: {
      publish: (tx: unknown, e: Record<string, unknown>) => Promise<void>;
    } = catalogOutbox(),
    limited = false,
  ) => {
    const server = buildServer({
      db: kit.handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: createDbIdempotencyStore(kit.handle.db),
    });
    registerMessagingRoutes(server, {
      service: kit.service,
      announcements: createDbAnnouncementService(kit.handle.db),
      urgent: (() => {
        const deps = buildUrgentDeps({
          db: kit.handle.db,
          flags: { forOrg: async () => flags },
          outbox: outbox as never,
          messaging: kit.service,
          permissionsFor,
          part2Gate: {
            allowedUserIds: async ({ userIds }) =>
              new Set(userIds.filter((u) => u !== part2Blocked)),
          },
          careTeamMembers: async () => careTeam,
        });
        return limited
          ? {
              ...deps,
              rateLimit: buildUrgentRateLimit(createInMemoryRateLimitStore(), {
                isReplay: deps.isReplay,
              }),
            }
          : deps;
      })(),
    });
    return server;
  };

  const send = (
    server: FastifyInstance,
    user: string,
    body: Record<string, unknown>,
    opts: { org?: string; key?: string; channelId?: string } = {},
  ) =>
    server.inject({
      method: "POST",
      url: SEND(opts.channelId ?? channel),
      headers: as(user, opts.org ?? ORG_A, opts.key ?? randomUUID()),
      payload: {
        client_message_id: randomUUID(),
        body_doc: sbarDoc(),
        recipient_user_id: rn,
        ...body,
      },
    });
  const getJson = (server: FastifyInstance, user: string, url: string, org = ORG_A) =>
    server.inject({ method: "GET", url, headers: as(user, org) });

  const messageCount = () =>
    kit.count("SELECT count(*)::int AS n FROM message WHERE organization_id=$1", [ORG_A]);
  const urgentOutboxCount = (aggregateId?: string) =>
    kit.count(
      `SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m36.message.urgent_sent' ${
        aggregateId ? "AND aggregate_id=$1" : ""
      }`,
      aggregateId ? [aggregateId] : [],
    );
  const snapshot = async () => [await messageCount(), await urgentOutboxCount()];
  const row = async (id: string) =>
    (
      await kit.one<{ urgency: string; urgent_recipient_user_id: string | null }>(
        "SELECT urgency::text, urgent_recipient_user_id::text FROM message WHERE id=$1",
        [id],
      )
    )[0];

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "wp41");
    nurse = await seed("nurse", ORG_A, SEND_KEYS);
    aide = await seed("aide", ORG_A, SEND_KEYS);
    plainSender = await seed("plain", ORG_A, STAFF_KEYS);
    rn = await seed("rn", ORG_A, RECEIVE_KEYS);
    rn2 = await seed("rn2", ORG_A, RECEIVE_KEYS);
    unqualified = await seed("unqualified", ORG_A, STAFF_KEYS);
    notInChannel = await seed("notmember", ORG_A, RECEIVE_KEYS);
    part2Blocked = await seed("part2", ORG_A, RECEIVE_KEYS);
    orgBUser = await seed("orgb", ORG_B, [...SEND_KEYS, ...RECEIVE_KEYS]);
    channel = await mkChannel(kit, "care_team", PATIENT, [
      nurse,
      aide,
      plainSender,
      rn,
      rn2,
      unqualified,
      part2Blocked,
    ]);
    locationChannel = await mkChannel(kit, "location", randomUUID(), [nurse, rn]);
    careTeam = [nurse, aide, plainSender, rn, rn2, unqualified, notInChannel, part2Blocked];

    const registry = createPredicateRegistry();
    registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
      const channelId = typeof target.id === "string" ? target.id : null;
      if (!channelId || !ctx.organizationId || !ctx.userId) return false;
      return kit.service.canViewChannel(ctx.organizationId, ctx.userId, channelId);
    });
    registerAbacRegistry(registry);

    app = makeServer(FLAGS);
    offApp = makeServer({ "messaging.urgent_clinical": false, "messaging.sbar": true });
    // A publisher that fails on the urgent event: proves the event shares the send transaction.
    const real = catalogOutbox();
    failingApp = makeServer(FLAGS, {
      publish: async (tx, e) => {
        if (e.eventName === "m36.message.urgent_sent")
          throw new Error("injected publisher failure");
        return real.publish(tx, e);
      },
    });
    await Promise.all([app.ready(), offApp.ready(), failingApp.ready()]);
  }, 240_000);

  afterAll(async () => {
    await Promise.all([app?.close(), offApp?.close(), failingApp?.close()]);
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await kit?.close();
  });

  describe("happy path", () => {
    it("stores ONE urgent message to the recipient, ONE id-only event, and marks it on the read", async () => {
      const before = await snapshot();
      const res = await send(app, nurse, {});
      expect(res.statusCode, res.body).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        created: true,
        patient_id: PATIENT,
        channel_id: channel,
        recipient_user_id: rn,
      });
      expect(await row(body.message_id)).toEqual({
        urgency: "urgent",
        urgent_recipient_user_id: rn,
      });
      expect(await snapshot()).toEqual([before[0]! + 1, before[1]! + 1]);

      const [event] = await kit.one<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM outbox_event WHERE event_type='m36.message.urgent_sent' AND aggregate_id=$1",
        [body.message_id],
      );
      expect(Object.keys(event!.payload).sort()).toEqual(
        [
          "at",
          "authorUserId",
          "channelId",
          "messageId",
          "organizationId",
          "recipientUserId",
        ].sort(),
      );
      expect(JSON.stringify(event!.payload)).not.toContain("pain");

      const list = await getJson(app, rn, `/api/v1/messaging/channels/${channel}/messages`);
      expect(list.statusCode).toBe(200);
      const found = list
        .json()
        .messages.find((m: { messageId: string }) => m.messageId === body.message_id);
      expect(found).toMatchObject({ urgency: "urgent" });
    });

    it("an aide holding messaging.urgent.send may raise one (05 matrix), and routine messages stay unmarked", async () => {
      const res = await send(app, aide, { recipient_user_id: rn2 });
      expect(res.statusCode, res.body).toBe(201);
      const routine = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${channel}/messages`,
        headers: as(nurse, ORG_A, randomUUID()),
        payload: { body: "see you at 3", urgency: "urgent", urgent_recipient_user_id: rn },
      });
      expect(routine.statusCode).toBeLessThan(500);
      const id = routine.json().messageId as string | undefined;
      if (routine.statusCode === 201 && id) {
        expect(await row(id)).toEqual({ urgency: "routine", urgent_recipient_user_id: null });
      }
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM message WHERE urgency='urgent' AND urgent_recipient_user_id IS NULL",
        ),
      ).toBe(0);
    });
  });

  describe("replay", () => {
    it("the same client_message_id (new key and same key) is one message and one event", async () => {
      const clientId = randomUUID();
      const first = await send(app, nurse, { client_message_id: clientId });
      expect(first.statusCode).toBe(201);
      const before = await snapshot();
      const again = await send(app, nurse, { client_message_id: clientId });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ created: false, message_id: first.json().message_id });
      expect(await snapshot()).toEqual(before);
      expect(await urgentOutboxCount(first.json().message_id)).toBe(1);
    });

    it("a retry after the recipient left the channel still replays the original (200), writes nothing and notifies nobody again", async () => {
      const clientId = randomUUID();
      const first = await send(app, nurse, { client_message_id: clientId, recipient_user_id: rn2 });
      expect(first.statusCode).toBe(201);
      await kit.admin.query(
        "UPDATE channel_member SET removed_at = now() WHERE channel_id=$1 AND user_id=$2",
        [channel, rn2],
      );
      const before = await snapshot();
      const again = await send(app, nurse, { client_message_id: clientId, recipient_user_id: rn2 });
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toMatchObject({ created: false, message_id: first.json().message_id });
      expect(await snapshot()).toEqual(before);
      await kit.admin.query(
        "UPDATE channel_member SET removed_at = NULL WHERE channel_id=$1 AND user_id=$2",
        [channel, rn2],
      );
    });

    it("a retry after the recipient's ORGANIZATION membership lapsed still replays (200), not a trigger error", async () => {
      const clientId = randomUUID();
      const first = await send(app, nurse, { client_message_id: clientId, recipient_user_id: rn2 });
      expect(first.statusCode).toBe(201);
      await kit.admin.query(
        "UPDATE membership SET status='suspended' WHERE user_id=$1 AND organization_id=$2",
        [rn2, ORG_A],
      );
      try {
        const before = await snapshot();
        const again = await send(app, nurse, {
          client_message_id: clientId,
          recipient_user_id: rn2,
        });
        expect(again.statusCode, again.body).toBe(200);
        expect(again.json()).toMatchObject({ created: false, message_id: first.json().message_id });
        expect(await snapshot()).toEqual(before);
        // a NEW urgent message to the lapsed member is still refused (the trigger and the app both say no)
        const fresh = await send(app, nurse, { recipient_user_id: rn2 });
        expect(fresh.statusCode).toBe(422);
      } finally {
        await kit.admin.query(
          "UPDATE membership SET status='active' WHERE user_id=$1 AND organization_id=$2",
          [rn2, ORG_A],
        );
      }
    });

    it("a reused client_message_id naming a different recipient is the idempotency conflict, never a silent replay", async () => {
      const clientId = randomUUID();
      expect((await send(app, nurse, { client_message_id: clientId })).statusCode).toBe(201);
      const before = await snapshot();
      const res = await send(app, nurse, { client_message_id: clientId, recipient_user_id: rn2 });
      expect(res.statusCode).toBe(409);
      expect(await snapshot()).toEqual(before);
    });
  });

  describe("rate limit against the real database", () => {
    it("a refused request is never a replay: resending the refused id stays refused and creates nothing; a real replay is free", async () => {
      const limitedApp = makeServer(FLAGS, catalogOutbox(), true);
      await limitedApp.ready();
      try {
        const admitted = randomUUID();
        expect((await send(limitedApp, aide, { client_message_id: admitted })).statusCode).toBe(
          201,
        );
        for (let i = 0; i < 4; i++) {
          expect((await send(limitedApp, aide, {})).statusCode).toBe(201); // pair budget (5) now spent
        }
        const before = await snapshot();
        const refusedId = randomUUID();
        for (let i = 0; i < 3; i++) {
          expect((await send(limitedApp, aide, { client_message_id: refusedId })).statusCode).toBe(
            429,
          );
        }
        expect(await snapshot()).toEqual(before);
        expect(
          await kit.count("SELECT count(*)::int AS n FROM message WHERE client_message_id=$1", [
            refusedId,
          ]),
        ).toBe(0);
        // a retry of the ADMITTED message is a real replay: 200, nothing written, not counted against the cap
        for (let i = 0; i < 3; i++) {
          const again = await send(limitedApp, aide, { client_message_id: admitted });
          expect(again.statusCode, again.body).toBe(200);
          expect(again.json().created).toBe(false);
        }
        expect(await snapshot()).toEqual(before);
        // the same admitted id naming a different recipient is not a replay: it pays (and here the DB refuses it too)
        const other = await send(limitedApp, aide, {
          client_message_id: admitted,
          recipient_user_id: rn2,
        });
        expect(other.statusCode).toBeGreaterThanOrEqual(400);
        expect(await snapshot()).toEqual(before);
      } finally {
        await limitedApp.close();
      }
    });
  });

  describe("negatives write nothing", () => {
    const refusals: Array<
      [string, () => Promise<{ statusCode: number; json(): never }>, number, string?]
    > = [];
    const want = (
      name: string,
      run: () => Promise<{ statusCode: number; json(): never }>,
      status: number,
      code?: string,
    ) => refusals.push([name, run, status, code]);

    want(
      "urgent without a patient (location channel)",
      () => send(app, nurse, { recipient_user_id: rn }, { channelId: locationChannel }),
      422,
      "URGENT_NOT_PATIENT_CHANNEL",
    );
    want(
      "urgent without SBAR",
      () => send(app, nurse, { body_doc: plainDoc }),
      422,
      "URGENT_SBAR_REQUIRED",
    );
    want(
      "urgent without a recipient",
      () => send(app, nurse, { recipient_user_id: undefined }),
      422,
    );
    want(
      "recipient is the author",
      () => send(app, nurse, { recipient_user_id: nurse }),
      422,
      "URGENT_RECIPIENT_INVALID",
    );
    want(
      "recipient is not qualified (no urgent.receive)",
      () => send(app, nurse, { recipient_user_id: unqualified }),
      422,
      "URGENT_RECIPIENT_INVALID",
    );
    want(
      "recipient is an aide",
      () => send(app, nurse, { recipient_user_id: aide }),
      422,
      "URGENT_RECIPIENT_INVALID",
    );
    want(
      "recipient is qualified and on the care team but not a channel member",
      () => send(app, nurse, { recipient_user_id: notInChannel }),
      422,
      "URGENT_RECIPIENT_INVALID",
    );
    want(
      "recipient is blocked by the Part 2 gate",
      () => send(app, nurse, { recipient_user_id: part2Blocked }),
      422,
      "URGENT_RECIPIENT_INVALID",
    );
    want(
      "recipient does not exist",
      () => send(app, nurse, { recipient_user_id: randomUUID() }),
      422,
      "URGENT_RECIPIENT_INVALID",
    );
    want(
      "recipient is in another tenant",
      () => send(app, nurse, { recipient_user_id: orgBUser }),
      422,
      "URGENT_RECIPIENT_INVALID",
    );
    want("sender lacks messaging.urgent.send", () => send(app, plainSender, {}), 403);
    want("flag off", () => send(offApp, nurse, {}), 404);
    want(
      "an SBAR section over the length ceiling",
      () => send(app, nurse, { body_doc: sbarDoc("x".repeat(SBAR_MAX_SECTION_CHARS + 1)) }),
      422,
      "SBAR_INVALID",
    );
    want("body carries an urgency field", () => send(app, nurse, { urgency: "urgent" }), 422);
    want("body carries a recipient role", () => send(app, nurse, { recipient_role: "rn" }), 422);

    it("every refusal leaves message and outbox counts unchanged", async () => {
      for (const [name, run, status, code] of refusals) {
        const before = await snapshot();
        const res = await run();
        expect(res.statusCode, name).toBe(status);
        if (code) expect(errorCode(res as never), name).toBe(code);
        expect(await snapshot(), name).toEqual(before);
      }
    });

    it("the recipient refusal is byte-identical whatever the reason (no oracle)", async () => {
      const strip = (b: string) => b.replace(/"(requestId|correlationId)":"[^"]*"/g, "");
      const bodies = new Set<string>();
      for (const recipient of [nurse, unqualified, notInChannel, randomUUID(), orgBUser]) {
        bodies.add(strip((await send(app, nurse, { recipient_user_id: recipient })).body));
      }
      expect(bodies.size).toBe(1);
    });
  });

  describe("edit", () => {
    it("an urgent message cannot be edited; a routine one can", async () => {
      const made = (await send(app, nurse, {})).json();
      const edit = await app.inject({
        method: "PATCH",
        url: `/api/v1/messaging/messages/${made.message_id}`,
        headers: as(nurse, ORG_A),
        payload: { body: "changed my mind" },
      });
      expect(edit.statusCode).toBe(422);
      expect(errorCode(edit)).toBe("URGENT_MESSAGE_NOT_EDITABLE");

      const routine = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${channel}/messages`,
        headers: as(nurse, ORG_A, randomUUID()),
        payload: { body: "ordinary note" },
      });
      expect(routine.statusCode).toBe(201);
      const ok = await app.inject({
        method: "PATCH",
        url: `/api/v1/messaging/messages/${routine.json().messageId}`,
        headers: as(nurse, ORG_A),
        payload: { body: "ordinary note, edited" },
      });
      expect(ok.statusCode, ok.body).toBe(200);
    });
  });

  describe("database backstops", () => {
    it("urgency and recipient are immutable, even for the superuser", async () => {
      const made = (await send(app, nurse, {})).json();
      await expect(
        kit.admin.query(
          "UPDATE message SET urgency='routine', urgent_recipient_user_id=NULL WHERE id=$1",
          [made.message_id],
        ),
      ).rejects.toThrow(/fixed at send/);
      await expect(
        kit.admin.query("UPDATE message SET urgent_recipient_user_id=$2 WHERE id=$1", [
          made.message_id,
          rn2,
        ]),
      ).rejects.toThrow(/fixed at send/);
      const plain = (
        await app.inject({
          method: "POST",
          url: `/api/v1/messaging/channels/${channel}/messages`,
          headers: as(nurse, ORG_A, randomUUID()),
          payload: { body: "plain" },
        })
      ).json();
      await expect(
        kit.admin.query("UPDATE message SET urgency='urgent' WHERE id=$1", [plain.messageId]),
      ).rejects.toThrow();
    });

    it("the shape CHECK refuses urgent without a recipient and a recipient without urgent", async () => {
      const insert = (urgency: string, recipient: string | null) =>
        kit.admin.query(
          `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256, urgency, urgent_recipient_user_id)
           VALUES ($1,$2,$3,'user','\\x00',$4,$5::message_urgency,$6)`,
          [channel, ORG_A, nurse, "a".repeat(64), urgency, recipient],
        );
      await expect(insert("urgent", null)).rejects.toThrow(/message_urgency_shape/);
      await expect(insert("routine", rn)).rejects.toThrow(/message_urgency_shape/);
      await expect(insert("important", null)).resolves.toBeDefined();
    });

    it("refuses an urgent recipient who is not an active member of the message's organization (cross-tenant)", async () => {
      const insert = (recipient: string) =>
        kit.admin.query(
          `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256, urgency, urgent_recipient_user_id)
           VALUES ($1,$2,$3,'user','\\x00',$4,'urgent',$5)`,
          [channel, ORG_A, nurse, "b".repeat(64), recipient],
        );
      await expect(insert(orgBUser)).rejects.toThrow(/not an active member/);
      await expect(insert(randomUUID())).rejects.toThrow();
      await expect(insert(rn)).resolves.toBeDefined();
    });

    it("chartwarden_app cannot see another tenant's urgent message (RLS)", async () => {
      const made = (await send(app, nurse, {})).json();
      await kit.appConn.query("SELECT set_config('app.org_id', $1, false)", [ORG_B]);
      const seen = await kit.appConn.query("SELECT 1 FROM message WHERE id=$1", [made.message_id]);
      expect(seen.rowCount).toBe(0);
      await kit.appConn.query("SELECT set_config('app.org_id', '', false)");
    });
  });

  describe("atomicity", () => {
    it("a publisher failure rolls the message back", async () => {
      const before = await snapshot();
      const res = await send(failingApp, nurse, {});
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(await snapshot()).toEqual(before);
    });
  });

  describe("notification", () => {
    it("the real consumer turns the stored event into ONE generic alert for the recipient, no PHI", async () => {
      const made = (await send(app, nurse, { body_doc: sbarDoc(SECRET) })).json();
      const [stored] = await kit.one<{
        id: string;
        organization_id: string;
        payload: Record<string, unknown>;
      }>(
        "SELECT id::text, organization_id::text, payload FROM outbox_event WHERE event_type='m36.message.urgent_sent' AND aggregate_id=$1",
        [made.message_id],
      );
      const emitted: Array<{ org: string; alert: Record<string, unknown> }> = [];
      const consumer = buildM36UrgentNotificationsConsumer({
        alerts: {
          emit: async (org: string, alert: Record<string, unknown>) =>
            void emitted.push({ org, alert }),
        } as unknown as AlertEmitter,
        messaging: kit.service,
      });
      const event = {
        id: stored!.id,
        eventType: "m36.message.urgent_sent",
        organizationId: stored!.organization_id,
        payload: stored!.payload,
      } as never;
      await consumer.handle(event);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.org).toBe(ORG_A);
      expect(emitted[0]!.alert.payload).toMatchObject({ recipientUserId: rn, channelId: channel });
      const text = JSON.stringify(emitted[0]);
      for (const leak of [SECRET, "morphine", PATIENT, "Pain"]) expect(text).not.toContain(leak);
    });
  });

  describe("options", () => {
    it("offers only qualified care-team members of this channel, never the caller", async () => {
      const res = await getJson(app, nurse, `${SEND(channel)}/options`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ enabled: true, patient_linked: true, patient_id: PATIENT });
      expect(body.recipients.map((r: { user_id: string }) => r.user_id).sort()).toEqual(
        [rn, rn2].sort(),
      );
    });

    it("a non-patient channel offers nobody, and flag off answers disabled", async () => {
      const loc = await getJson(app, nurse, `${SEND(locationChannel)}/options`);
      expect(loc.json()).toMatchObject({ enabled: true, patient_linked: false, recipients: [] });
      const off = await getJson(offApp, nurse, `${SEND(channel)}/options`);
      expect(off.statusCode).toBe(200);
      expect(off.json()).toEqual({ enabled: false });
    });
  });

  describe("tenancy", () => {
    it("org B and an outsider get a random channel's answer and nothing is written", async () => {
      const outsider = await seed("outsider", ORG_A, SEND_KEYS);
      const before = await snapshot();
      const random = randomUUID();
      for (const [user, org] of [
        [orgBUser, ORG_B],
        [outsider, ORG_A],
      ] as const) {
        const real = await send(app, user, {}, { org });
        const control = await send(app, user, {}, { org, channelId: random });
        expect(real.statusCode).toBeGreaterThanOrEqual(400);
        expect(real.statusCode).toBeLessThan(500);
        expect(real.statusCode).toBe(control.statusCode);
        const opts = await getJson(app, user, `${SEND(channel)}/options`, org);
        const optsControl = await getJson(app, user, `${SEND(random)}/options`, org);
        expect(opts.statusCode).toBe(optsControl.statusCode);
        expect(opts.body).not.toContain(PATIENT);
      }
      expect(await snapshot()).toEqual(before);
    });
  });

  describe("read audit", () => {
    it("the send and the options read each land an audit row with a resource id", async () => {
      const made = (await send(app, nurse, {})).json();
      expect((await getJson(app, nurse, `${SEND(channel)}/options`)).statusCode).toBe(200);
      const q =
        "SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND resource_id=$2 AND actor_user_id=$3 AND event_type LIKE '%.viewed'";
      expect(await kit.count(q, [ORG_A, made.message_id, nurse])).toBeGreaterThanOrEqual(1);
      expect(await kit.count(q, [ORG_A, channel, nurse])).toBeGreaterThanOrEqual(1);
    });
  });

  describe("migration grants", () => {
    it("grants urgent.receive only to qualified clinical role keys and send never to admins or compliance", async () => {
      const keys = [
        "rn",
        "md",
        "clinical_supervisor",
        "lpn",
        "msw",
        "chaplain",
        "chha",
        "volunteer",
        "org_admin",
        "compliance",
      ];
      for (const key of keys) {
        await kit.admin.query(
          "INSERT INTO role (organization_id, key, name, category) VALUES ($1,$2,$2,'admin_executive') ON CONFLICT DO NOTHING",
          [ORG_A, key],
        );
      }
      const sql = readFileSync(join(MIGRATIONS_DIR, "1105_m36_message_urgency.sql"), "utf8");
      const grants = sql.slice(sql.indexOf('INSERT INTO "permission"'));
      await kit.admin.query(grants);
      const rows = await kit.one<{ key: string; permission_key: string }>(
        `SELECT r.key, rp.permission_key FROM role_permission rp JOIN role r ON r.id=rp.role_id
          WHERE r.organization_id=$1 AND rp.permission_key LIKE 'messaging.urgent.%'`,
        [ORG_A],
      );
      const has = (perm: string) =>
        rows
          .filter((r) => r.permission_key === perm)
          .map((r) => r.key)
          .sort();
      expect(has("messaging.urgent.receive")).toEqual(["clinical_supervisor", "md", "rn"]);
      expect(has("messaging.urgent.send")).toEqual([
        "chaplain",
        "chha",
        "clinical_supervisor",
        "lpn",
        "md",
        "msw",
        "rn",
      ]);
    });
  });
});
