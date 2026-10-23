/**
 * M36 WP 6.1 (ADR-0100) - the smart work inbox, LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * The real route stack (Authorization Contract, `messaging.read`, the DB unacknowledged reader narrowed to the assignee, the DB task
 * service, the DB channel list, read-audit) over rows seeded through the real insert guards.
 *
 *   1. MINE ONLY      the caller sees only the acknowledgment requests assigned to them, their own tasks and their own unread
 *                     conversations; a colleague's items and another tenant's never appear, by id or by count.
 *   2. RANKED         urgent first (unreachable, then overdue, then waiting), then tasks, then unread care-team; every row says why.
 *   3. URGENT KEPT    `limit=1` never drops an urgent row; band counts cover the whole list.
 *   4. FLAG           off => 200 `{enabled:false}`, no row, and no source read.
 *   5. ACCESS         401 without a session, 403 without messaging.read.
 *   6. NO BODY        no message text; read-only (no ack, task or receipt row changes).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:smart-inbox:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the chartwarden_* roles.
 */
import type { SmartInboxResponse } from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createDbUnacknowledgedReader } from "../src/modules/36-messaging/ack-requests/unacknowledged-reader-db";
import { createUnacknowledgedService } from "../src/modules/36-messaging/ack-requests/unacknowledged-service";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { buildSmartInboxService } from "../src/modules/36-messaging/inbox/binding";
import { createMentionActorNameResolver } from "../src/modules/36-messaging/mention-non-member-service-db";
import { registerMessagingRoutes } from "../src/modules/36-messaging/routes/messaging-routes";
import {
  type LiveKit,
  STAFF_KEYS,
  as,
  bootLiveKit,
  headerAuth,
  mkChannel,
} from "./_m36-handoff-live-kit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-11110a610001";
const ORG_B = "22222222-2222-4222-8222-22220a610002";
const PATIENT_1 = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a61a1";
const PATIENT_2 = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a61a2";
const SECRET = "Okafor MRN 88421 morphine";
const URL_OF = "/api/v1/messaging/inbox";

describe.skipIf(!DB_URL)("M36 WP 6.1 smart work inbox - LIVE Postgres", () => {
  let kit: LiveKit;
  let app: FastifyInstance;
  let sender: string;
  let me: string;
  let colleague: string;
  let userB: string;
  let noRead: string;
  let channelMine: string;
  let channelQuiet: string;
  let flagOn = true;
  const ids: Record<string, string> = {};

  const get = (user: string, org: string, qs = "") =>
    app.inject({ method: "GET", url: `${URL_OF}${qs}`, headers: as(user, org) });
  const body = (res: { body: string }) => JSON.parse(res.body) as SmartInboxResponse;

  const send = async (channel: string, author = sender) =>
    (await kit.service.sendMessage(ORG_A, { channelId: channel, authorUserId: author, body: SECRET }))
      .messageId;

  const ackFor = async (name: string, assignee: string, minutes: number, patient = PATIENT_1) => {
    const messageId = await send(channelMine);
    ids[name] = (
      await kit.admin.query(
        `INSERT INTO message_acknowledgment_request
           (organization_id, message_id, channel_id, patient_id, ack_class, requester_user_id, assigned_user_id, requested_at, window_started_at, deadline_at)
         VALUES ($1,$2,$3,$4,'important',$5,$6,now(),now(), now() + make_interval(mins => $7)) RETURNING id`,
        [ORG_A, messageId, channelMine, patient, sender, assignee, minutes],
      )
    ).rows[0].id as string;
    return ids[name] as string;
  };

  const mutationFingerprint = async () =>
    JSON.stringify(
      await kit.one(
        `SELECT (SELECT count(*) FROM message_acknowledgment_request) AS acks,
                (SELECT count(*) FROM communication_task) AS tasks,
                (SELECT count(*) FROM message_receipt WHERE status='read') AS reads,
                (SELECT count(*) FROM outbox_event) AS outbox`,
      ),
    );

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "wp61");
    sender = await kit.seedUser("sender", ORG_A, STAFF_KEYS);
    me = await kit.seedUser("me", ORG_A, STAFF_KEYS);
    colleague = await kit.seedUser("colleague", ORG_A, STAFF_KEYS);
    noRead = await kit.seedUser("noread", ORG_A, []);
    userB = await kit.seedUser("userb", ORG_B, STAFF_KEYS);

    channelMine = await mkChannel(kit, "care_team", PATIENT_1, [sender, me, colleague]);
    channelQuiet = await mkChannel(kit, "care_team", PATIENT_2, [sender, colleague]);

    // me: one overdue-by-clock urgent request (deadline in the past through the insert), one waiting, one task, unread messages.
    // The service clock runs 30 minutes ahead of the database: the 10 minute deadline is overdue, the 120 minute one is not.
    await ackFor("ack_late", me, 10);
    await ackFor("ack_waiting", me, 120);
    // a colleague's request and a colleague-only channel's: must never show for me.
    await ackFor("ack_colleague", colleague, 5);
    await send(channelQuiet);

    const taskMessage = await send(channelMine);
    const task = await kit.build(true).tasks.service.convert(
      { orgId: ORG_A, userId: sender },
      { channelId: channelMine, messageId: taskMessage, assigneeUserId: me },
    );
    ids.task = task.task.id;

    app = buildServer({
      db: kit.handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
    });
    const { tasks, handoffs } = kit.build(true);
    const unacknowledged = createUnacknowledgedService({
      read: createDbUnacknowledgedReader(kit.handle.db),
      canViewChannel: kit.service.canViewChannel,
      displayName: createMentionActorNameResolver(kit.handle.db),
      now: () => new Date(Date.now() + 30 * 60_000),
    });
    registerMessagingRoutes(app, {
      service: kit.service,
      announcements: createDbAnnouncementService(kit.handle.db),
      tasks,
      handoffs,
      unacknowledged: { service: unacknowledged },
      inbox: {
        service: buildSmartInboxService({
          isEnabled: async (org) => flagOn && org === ORG_A,
          unacknowledged,
          tasks,
          handoffs,
          listChannels: kit.service.listChannels,
        }),
      },
    });
    await app.ready();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await kit?.close();
  });

  describe("mine only, ranked, explained", () => {
    it("lists my urgent requests (late first), my task and my unread conversation, in band order, each with a reason", async () => {
      const res = await get(me, ORG_A);
      expect(res.statusCode, res.body).toBe(200);
      const out = body(res);
      expect(out.enabled).toBe(true);
      const keys = out.items.map((i) => i.key);
      expect(keys.slice(0, 2)).toEqual([`ack:${ids.ack_late}`, `ack:${ids.ack_waiting}`]);
      expect(out.items[0]?.reasons[0]?.code).toBe("ack_overdue");
      expect(out.items[1]?.reasons[0]?.code).toBe("ack_waiting");
      expect(keys).toContain(`task:${ids.task}`);
      expect(out.items.map((i) => i.band)).toEqual(
        [...out.items.map((i) => i.band)].sort(
          (a, b) =>
            ["urgent_ack", "handoff_awaiting", "task_assigned", "mention", "care_team_unread"].indexOf(a) -
            ["urgent_ack", "handoff_awaiting", "task_assigned", "mention", "care_team_unread"].indexOf(b),
        ),
      );
      expect(out.items.every((i) => i.reasons.length > 0)).toBe(true);
      expect(out.items.map((i) => i.rank)).toEqual(out.items.map((_, i) => i + 1));
      expect(out.band_counts.urgent_ack).toBe(2);
      expect(out.band_counts.task_assigned).toBe(1);
      expect(out.band_counts.care_team_unread).toBe(1);
      expect(out.unavailable_sources).toEqual([]);
    });

    it("never shows a colleague's request, task or conversation (by id or by count)", async () => {
      const mine = JSON.stringify(body(await get(me, ORG_A)));
      expect(mine).not.toContain(ids.ack_colleague as string);
      expect(mine).not.toContain(channelQuiet);
      const theirs = body(await get(colleague, ORG_A));
      expect(JSON.stringify(theirs)).not.toContain(ids.ack_late as string);
      expect(JSON.stringify(theirs)).not.toContain(ids.task as string);
      expect(theirs.band_counts.urgent_ack).toBe(1);
    });

    it("is empty for another tenant's user, and org A's ids never leak into it", async () => {
      const res = await get(userB, ORG_B);
      expect(res.statusCode, res.body).toBe(200);
      const out = body(res);
      // the flag stub is enabled only for org A: another tenant reads as off, and carries nothing
      expect(out.enabled).toBe(false);
      expect(out.items).toEqual([]);
      for (const id of Object.values(ids)) expect(res.body).not.toContain(id);
    });

    it("keeps every urgent row when limit=1 and reports the whole list's band counts", async () => {
      const out = body(await get(me, ORG_A, "?limit=1"));
      expect(out.items.filter((i) => i.band === "urgent_ack")).toHaveLength(2);
      expect(out.band_counts.task_assigned).toBe(1);
      expect(out.complete).toBe(false);
    });

    it("carries no message text and changes nothing", async () => {
      const before = await mutationFingerprint();
      const res = await get(me, ORG_A);
      expect(res.body).not.toContain("Okafor");
      expect(res.body).not.toContain("88421");
      expect(await mutationFingerprint()).toBe(before);
    });
  });

  describe("flag and access", () => {
    it("flag off => 200 enabled:false with no rows", async () => {
      flagOn = false;
      try {
        const out = body(await get(me, ORG_A));
        expect(out).toMatchObject({ enabled: false, items: [], complete: true });
      } finally {
        flagOn = true;
      }
    });

    it("is 401 without a session and 403 without messaging.read; a bad limit or an unknown key is a 422", async () => {
      expect((await app.inject({ method: "GET", url: URL_OF })).statusCode).toBe(401);
      expect((await get(noRead, ORG_A)).statusCode).toBe(403);
      expect((await get(me, ORG_A, "?limit=0")).statusCode).toBe(422);
      expect((await get(me, ORG_A, "?assigned_user_id=x")).statusCode).toBe(422);
    });
  });
});
