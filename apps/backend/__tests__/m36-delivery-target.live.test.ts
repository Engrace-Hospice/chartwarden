/**
 * M36 WP 4.8 (ADR-0075) - the deep-link resolver, LIVE Postgres as the NOBYPASSRLS `wardenx_app` role.
 *
 * The real route stack (Authorization Contract, `messaging.read`, the DB reader, the DB channel check, read-audit) over alert and
 * delivery rows whose payloads come from the REAL consumer (`buildM36AckNotificationsConsumer`), so the payload keys the reader
 * depends on are the ones production writes.
 *
 *   1. RESOLVES     the recipient's own delivery -> three ids; the open acknowledgment request is named; nothing is written.
 *   2. ONE 404      random, malformed, someone else's, another tenant's, a crafted cross-tenant payload, a payload with no target,
 *                   a deleted message, a user who left the channel, an alert in another org: the identical status and body.
 *   3. AUDIT        a successful resolve lands exactly one `notification_delivery.viewed` row carrying the delivery id; a refusal
 *                   lands no audit row of any kind for the actor.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m36:delivery-target:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the wardenx_* roles.
 */
import { randomUUID } from "node:crypto";
import type { AlertEmitter } from "@chartwarden/messaging";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createDbAckStore } from "../src/modules/36-messaging/ack-requests/ack-store-db";
import { createOpenRequestLookup } from "../src/modules/36-messaging/ack-requests/open-request-lookup";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { createDbDeliveryTargetReader } from "../src/modules/36-messaging/delivery-target/delivery-target-reader-db";
import { createDeliveryTargetService } from "../src/modules/36-messaging/delivery-target/delivery-target-service";
import { buildM36AckNotificationsConsumer } from "../src/modules/36-messaging/outbox-consumers/ack-notifications";
import { registerMessagingRoutes } from "../src/modules/36-messaging/routes/messaging-routes";
import {
  type LiveKit,
  STAFF_KEYS,
  as,
  bootLiveKit,
  headerAuth,
  mkChannel,
} from "./_m36-handoff-live-kit";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-11110a480001";
const ORG_B = "22222222-2222-4222-8222-22220a480002";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a48a1";
const SECRET = "Okafor MRN 88421 morphine";
const URL_OF = (id: string) => `/api/v1/messaging/deliveries/${id}/target`;

describe.skipIf(!DB_URL)("M36 WP 4.8 deep-link resolver - LIVE Postgres", () => {
  let kit: LiveKit;
  let app: FastifyInstance;
  let nurse: string;
  let rn: string;
  let leaver: string;
  let outsider: string;
  let orgBUser: string;
  let channel: string;

  const captured: Record<string, unknown>[] = [];
  const consumer = () =>
    buildM36AckNotificationsConsumer({
      alerts: {
        emit: async (_org: string, alert: Record<string, unknown>) => {
          captured.push(alert);
          return { alertId: "a", resolvedRecipientCount: 1 };
        },
      } as unknown as AlertEmitter,
      messaging: { canViewChannel: async () => true },
      isWaitingForAssignee: async () => true,
      stillQualified: async () => true,
    });

  /** The payload the REAL ack consumer writes for this request, so the reader is tested against production's keys. */
  const realPayload = async (
    channelId: string,
    messageId: string,
    assignee: string,
    requestId: string = randomUUID(),
  ): Promise<Record<string, unknown>> => {
    captured.length = 0;
    await consumer().handle({
      eventType: "m36.ack.requested",
      organizationId: ORG_A,
      payload: {
        requestId,
        channelId,
        messageId,
        assignedUserId: assignee,
        ackClass: "important",
        requestVersion: 0,
      },
    } as never);
    return (captured[0] as { payload: Record<string, unknown> }).payload;
  };

  const seedDelivery = async (
    org: string,
    recipient: string,
    payload: Record<string, unknown>,
    channelKind = "push",
  ): Promise<string> => {
    const alert = (
      await kit.admin.query(
        `INSERT INTO alert (organization_id, event_type, severity, payload, correlation_id, outcome)
         VALUES ($1,'m36.ack.requested','warn',$2,$3,'pending') RETURNING id`,
        [org, JSON.stringify(payload), `wp48-${randomUUID()}`],
      )
    ).rows[0].id as string;
    return (
      await kit.admin.query(
        `INSERT INTO notification_delivery (alert_id, recipient_user_id, alert_category, alert_severity, channel, status)
         VALUES ($1,$2,'clinical_urgent','warn',$3,'pending') RETURNING id`,
        [alert, recipient, channelKind],
      )
    ).rows[0].id as string;
  };

  /** Every audit row written for this actor, whatever the resource kind: a refusal must leave this unchanged. */
  const auditRows = (user: string) =>
    kit.count("SELECT count(*)::int AS n FROM audit_event WHERE actor_user_id=$1", [user]);

  const resolve = (user: string, org: string, id: string) =>
    app.inject({ method: "GET", url: URL_OF(id), headers: as(user, org) });
  /** Status and body with the per-request correlation fields removed: what an observer can tell apart. */
  const shape = (res: { statusCode: number; json(): unknown }) =>
    JSON.stringify([
      res.statusCode,
      JSON.parse(
        JSON.stringify(res.json(), (k, v) =>
          /correlation|requestId|timestamp/i.test(k) ? undefined : v,
        ),
      ),
    ]);
  const message = (author = nurse, ch = channel) =>
    kit.service
      .sendMessage(ORG_A, { channelId: ch, authorUserId: author, body: SECRET })
      .then((m) => m.messageId);

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "wp48");
    nurse = await kit.seedUser("nurse", ORG_A, STAFF_KEYS);
    rn = await kit.seedUser("rn", ORG_A, STAFF_KEYS);
    leaver = await kit.seedUser("leaver", ORG_A, STAFF_KEYS);
    outsider = await kit.seedUser("outsider", ORG_A, STAFF_KEYS);
    orgBUser = await kit.seedUser("orgb", ORG_B, STAFF_KEYS);
    channel = await mkChannel(kit, "care_team", PATIENT, [nurse, rn, leaver]);

    app = buildServer({
      db: kit.handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
    });
    registerMessagingRoutes(app, {
      service: kit.service,
      announcements: createDbAnnouncementService(kit.handle.db),
      deliveryTarget: {
        service: createDeliveryTargetService({
          read: createDbDeliveryTargetReader(kit.handle.db),
          messaging: kit.service,
          openRequestId: createOpenRequestLookup(createDbAckStore(kit.handle.db)),
        }),
      },
    });
    await app.ready();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await kit?.close();
  });

  describe("resolves", () => {
    it("the recipient's own delivery -> channel, message and no request; writes nothing", async () => {
      const messageId = await message();
      const delivery = await seedDelivery(ORG_A, rn, await realPayload(channel, messageId, rn));
      const before = [
        await kit.count("SELECT count(*)::int AS n FROM outbox_event"),
        await kit.count("SELECT count(*)::int AS n FROM message_acknowledgment_event"),
        await kit.count(
          "SELECT count(*)::int AS n FROM notification_delivery WHERE status='pending'",
        ),
      ];

      const res = await resolve(rn, ORG_A, delivery);

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({
        channel_id: channel,
        message_id: messageId,
        ack_request_id: null,
      });
      expect(res.body).not.toContain(SECRET);
      expect(res.body).not.toContain(PATIENT);
      expect([
        await kit.count("SELECT count(*)::int AS n FROM outbox_event"),
        await kit.count("SELECT count(*)::int AS n FROM message_acknowledgment_event"),
        await kit.count(
          "SELECT count(*)::int AS n FROM notification_delivery WHERE status='pending'",
        ),
      ]).toEqual(before);
    });

    it("names the open acknowledgment request on the message and never changes it", async () => {
      const messageId = await message();
      const request = (
        await kit.admin.query(
          `INSERT INTO message_acknowledgment_request
             (organization_id, message_id, channel_id, patient_id, ack_class, requester_user_id, assigned_user_id, requested_at, window_started_at, deadline_at)
           VALUES ($1,$2,$3,$4,'important',$5,$6,now(),now(), now() + interval '60 minutes') RETURNING id`,
          [ORG_A, messageId, channel, PATIENT, nurse, rn],
        )
      ).rows[0].id as string;
      const delivery = await seedDelivery(
        ORG_A,
        rn,
        await realPayload(channel, messageId, rn, request),
      );

      const res = await resolve(rn, ORG_A, delivery);

      expect(res.json()).toEqual({
        channel_id: channel,
        message_id: messageId,
        ack_request_id: request,
      });
      const [after] = await kit.one<{ status: string; version: number }>(
        "SELECT status, version FROM message_acknowledgment_request WHERE id=$1",
        [request],
      );
      expect(after).toMatchObject({ status: "pending", version: 0 });
    });

    it("lands exactly one read-audit row with the exact event type, kind and delivery id", async () => {
      const messageId = await message();
      const delivery = await seedDelivery(ORG_A, rn, await realPayload(channel, messageId, rn));
      const before = await auditRows(rn);

      const res = await resolve(rn, ORG_A, delivery);

      expect(res.statusCode, res.body).toBe(200);
      const rows = await kit.one<{
        event_type: string;
        resource_kind: string;
        resource_id: string;
      }>(
        "SELECT event_type, resource_kind, resource_id FROM audit_event WHERE organization_id=$1 AND actor_user_id=$2 AND resource_id=$3",
        [ORG_A, rn, delivery],
      );
      expect(rows).toEqual([
        {
          event_type: "notification_delivery.viewed",
          resource_kind: "notification_delivery",
          resource_id: delivery,
        },
      ]);
      expect(await auditRows(rn)).toBe(before + 1);
    });

    it.each([
      [
        "resolved",
        "UPDATE message_acknowledgment_request SET status='resolved', resolved_at=now(), resolved_by_user_id=assigned_user_id, version=2 WHERE id='{request}';",
      ],
      [
        "cancelled",
        "SELECT set_config('app.user_id', '{nurse}', true); UPDATE message_acknowledgment_request SET status='cancelled', cancelled_at=now(), version=2 WHERE id='{request}';",
      ],
    ])("names no request once it is %s", async (_status, closeSet) => {
      const messageId = await message();
      const request = (
        await kit.admin.query(
          `INSERT INTO message_acknowledgment_request
             (organization_id, message_id, channel_id, patient_id, ack_class, requester_user_id, assigned_user_id, requested_at, window_started_at, deadline_at)
           VALUES ($1,$2,$3,$4,'important',$5,$6,now(),now(), now() + interval '60 minutes') RETURNING id`,
          [ORG_A, messageId, channel, PATIENT, nurse, rn],
        )
      ).rows[0].id as string;
      // The aggregate's trigger lets only the assignee acknowledge/resolve and only the sender (or a system write) cancel.
      await kit.admin.query(`BEGIN;
        SELECT set_config('app.user_id', '${rn}', true);
        UPDATE message_acknowledgment_request SET status='acknowledged', acknowledged_at=now(), acknowledged_by_user_id=assigned_user_id, version=1 WHERE id='${request}';
        ${closeSet.replace("{request}", request).replace("{nurse}", nurse)}
        COMMIT;`);
      const delivery = await seedDelivery(
        ORG_A,
        rn,
        await realPayload(channel, messageId, rn, request),
      );

      const res = await resolve(rn, ORG_A, delivery);

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({
        channel_id: channel,
        message_id: messageId,
        ack_request_id: null,
      });
    });
  });

  describe("one 404", () => {
    it("is identical for every way the link can fail, and leaks nothing", async () => {
      const messageId = await message();
      const good = await realPayload(channel, messageId, rn);
      const control = await resolve(rn, ORG_A, randomUUID());
      expect(control.statusCode).toBe(404);

      const deletedMessage = await message();
      const deletedDelivery = await seedDelivery(
        ORG_A,
        rn,
        await realPayload(channel, deletedMessage, rn),
      );
      await kit.service.deleteMessage(ORG_A, { userId: nurse, messageId: deletedMessage });

      const otherChannel = await mkChannel(kit, "care_team", randomUUID(), [nurse]);
      const crossChannelDelivery = await seedDelivery(ORG_A, rn, {
        ...good,
        channelId: otherChannel,
      });

      const orgBChannel = (
        await kit.admin.query(
          `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class)
           VALUES ($1,'care_team',$2,'b','care_related') RETURNING id`,
          [ORG_B, PATIENT],
        )
      ).rows[0].id as string;

      const leaverDelivery = await seedDelivery(ORG_A, leaver, good);
      // the same link works until the membership ends, so the 404 below is the membership and not the fixture
      expect((await resolve(leaver, ORG_A, leaverDelivery)).statusCode).toBe(200);
      await kit.admin.query("DELETE FROM channel_member WHERE channel_id=$1 AND user_id=$2", [
        channel,
        leaver,
      ]);

      const actors = [rn, nurse, outsider, leaver, orgBUser];
      const auditBefore = await Promise.all(actors.map(auditRows));
      // (the promises below start as the array is built, so the baseline is taken first)
      const cases: Array<[string, Promise<{ statusCode: number; json(): unknown; body: string }>]> =
        [
          ["a random uuid", resolve(rn, ORG_A, randomUUID())],
          ["a malformed id", resolve(rn, ORG_A, "not-a-uuid")],
          ["an id with a SQL fragment", resolve(rn, ORG_A, "1' OR '1'='1")],
          [
            "someone else's delivery (same org)",
            resolve(nurse, ORG_A, await seedDelivery(ORG_A, rn, good)),
          ],
          [
            "a non-member recipient",
            resolve(outsider, ORG_A, await seedDelivery(ORG_A, outsider, good)),
          ],
          [
            "another tenant's user on A's delivery",
            resolve(orgBUser, ORG_B, await seedDelivery(ORG_A, rn, good)),
          ],
          [
            "a crafted payload naming A's ids from org B",
            resolve(orgBUser, ORG_B, await seedDelivery(ORG_B, orgBUser, good)),
          ],
          [
            "a payload naming a channel the message is not in",
            resolve(rn, ORG_A, crossChannelDelivery),
          ],
          [
            "an org B channel id with A's message",
            resolve(rn, ORG_A, await seedDelivery(ORG_A, rn, { ...good, channelId: orgBChannel })),
          ],
          [
            "a payload with no target",
            resolve(rn, ORG_A, await seedDelivery(ORG_A, rn, { message: "hello" })),
          ],
          [
            "a payload with non-uuid ids",
            resolve(rn, ORG_A, await seedDelivery(ORG_A, rn, { channelId: "x", messageId: "y" })),
          ],
          ["a deleted message", resolve(rn, ORG_A, deletedDelivery)],
          ["a user who has left the channel", resolve(leaver, ORG_A, leaverDelivery)],
        ];
      for (const [name, pending] of cases) {
        const res = await pending;
        expect(res.statusCode, name).toBe(404);
        expect(shape(res), `${name} differs from a random id`).toBe(shape(control));
        expect(res.body, name).not.toContain(channel);
        expect(res.body, name).not.toContain(messageId);
        expect(res.body, name).not.toContain(SECRET);
      }
      // no refusal wrote an audit row of any kind for anyone who asked
      expect(await Promise.all(actors.map(auditRows))).toEqual(auditBefore);
    });

    it("lands no audit row of any kind for a refusal", async () => {
      const before = await auditRows(outsider);
      const res = await resolve(outsider, ORG_A, randomUUID());
      expect(res.statusCode).toBe(404);
      expect(await auditRows(outsider)).toBe(before);
    });
  });
});
