/**
 * M36 WP 4.5 - delivery-failure handling, LIVE Postgres as the NOBYPASSRLS `wardenx_app` role.
 *
 * The real request stack creates and acknowledges requests; the failures are driven through the REAL delivery settlement
 * (`applyDeliveryTransition`, which publishes the real `m36.notification.delivery_failed` through the catalog-validating outbox), the
 * event is read back from `outbox_event` and handed to the real consumer, route reader, service, store and database guard. Only the
 * router (M19's seam) is a stub that answers like M19 would; the deny-stub is the production default.
 *
 *   1. a simulated push+SMS outage (deny-stub): one route down is not enough; both down = ONE failed_unreachable, before the deadline,
 *      with a history row, an audit row, an id-only event, and (through the notification consumer) a supervisor-audience alert + ops notice;
 *   2. a bound router: both routes down escalates to the next tier NOW (not at the deadline), once;
 *   3. replay and 8-way concurrency: exactly one write;
 *   4. acknowledge vs failure, BOTH orders, and a concurrent race; the assignee can still acknowledge a failed_unreachable request;
 *   5. a failure for someone who is no longer the assignee, an alert from before a reassign, a reminder alert, flag off: nothing happens;
 *   6. tenant isolation as wardenx_app: another tenant's delivery is invisible, another tenant cannot touch the request;
 *   7. the database refuses a person writing failed_unreachable; the empty actor may; a human can still reassign out of it.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m36:ack-delivery-failure:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the wardenx_* roles.
 */
import { randomUUID } from "node:crypto";
import {
  createPredicateRegistry,
  registerAbacRegistry,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { AlertEmitter } from "@wardenx/messaging";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import type { EscalationRouteAnswer, EscalationRouter } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { createDeliveryRouteReader } from "../src/modules/36-messaging/ack-delivery-failure/delivery-route-reader-db";
import { buildEscalationBinding } from "../src/modules/36-messaging/ack-escalation/binding";
import { buildAckDeps } from "../src/modules/36-messaging/ack-requests/deps";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { applyDeliveryTransition } from "../src/modules/36-messaging/delivery/delivery-settlement";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import { buildM36AckDeliveryFailureConsumer } from "../src/modules/36-messaging/outbox-consumers/ack-delivery-failure";
import { buildM36AckUnreachableNotificationsConsumer } from "../src/modules/36-messaging/outbox-consumers/ack-unreachable-notifications";
import { registerMessagingRoutes } from "../src/modules/36-messaging/routes/messaging-routes";
import {
  type LiveKit,
  STAFF_KEYS,
  as,
  bootLiveKit,
  catalogOutbox,
  headerAuth,
  mkChannel,
} from "./_m36-handoff-live-kit";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-11110a450001";
const ORG_B = "22222222-2222-4222-8222-22220a450002";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a45a1";
const BASE = "/api/v1/messaging/escalations";
const FLAG_ACK = "messaging.ack_requests";
const FLAG_TIMERS = "messaging.escalation_timers";
const SEND_KEYS = [...STAFF_KEYS, "messaging.urgent.send"];
const RECEIVE_KEYS = [...STAFF_KEYS, "messaging.urgent.receive"];
const MIN = 60_000;

describe.skipIf(!DB_URL)("M36 WP 4.5 delivery-failure handling - LIVE Postgres", () => {
  let kit: LiveKit;
  let app: FastifyInstance;
  let nurse: string;
  let rn: string;
  let rn2: string;
  let tier1: string;
  let orgBUser: string;
  let channel: string;
  const keysOf = new Map<string, readonly string[]>();
  let ladder: Record<number, (asOf: string) => EscalationRouteAnswer> = {};
  const flags: Record<string, boolean> = {};

  const router: EscalationRouter = {
    async resolveTier(_org, request) {
      const answer = ladder[request.tier]?.(request.asOf);
      return (
        answer ?? {
          kind: "unavailable",
          reason: "router_not_bound",
          tier: request.tier,
          asOf: request.asOf,
          source: "deny_stub",
        }
      );
    },
  };

  let ack: ReturnType<typeof buildAckDeps>;
  let escalation: ReturnType<typeof buildEscalationBinding>;
  let consumer: ReturnType<typeof buildM36AckDeliveryFailureConsumer>;
  let routeReaderDb: ReturnType<typeof createDeliveryRouteReader>;
  const warnings: Array<Record<string, string>> = [];

  const seed = async (suffix: string, org: string, keys: string[]) => {
    const id = await kit.seedUser(suffix, org, keys);
    keysOf.set(id, keys);
    return id;
  };
  const post = (user: string, url: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url, headers: as(user, ORG_A, randomUUID()), payload });
  const postNoKey = (user: string, url: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url, headers: as(user, ORG_A), payload });

  const freshRequest = async (assignee = rn) => {
    const sent = await post(nurse, `/api/v1/messaging/channels/${channel}/messages`, {
      body: `routine note ${randomUUID().slice(0, 8)}`,
    });
    expect(sent.statusCode, sent.body).toBe(201);
    const messageId = sent.json().messageId as string;
    const res = await post(nurse, BASE, { message_id: messageId, assigned_user_id: assignee });
    expect(res.statusCode, res.body).toBe(201);
    return { messageId, id: res.json().request.id as string };
  };

  interface RequestRow {
    status: string;
    assigned_user_id: string;
    deadline_at: Date;
    window_started_at: Date;
    version: number;
    current_tier: number;
  }
  const row = async (id: string) =>
    (
      await kit.one<RequestRow>("SELECT * FROM message_acknowledgment_request WHERE id=$1", [id])
    )[0] as RequestRow;
  const eventTypes = async (id: string) =>
    (
      await kit.one<{ event_type: string }>(
        "SELECT event_type FROM message_acknowledgment_event WHERE request_id=$1 ORDER BY created_at, id",
        [id],
      )
    ).map((e) => e.event_type);
  const outboxNames = async (id: string) =>
    (
      await kit.one<{ event_type: string }>(
        "SELECT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, id",
        [id],
      )
    ).map((r) => r.event_type);

  /** One alert (as the ack consumers emit it) with a delivery row per channel for `recipient`; returns the delivery ids by channel. */
  const alertWithRoutes = async (
    messageId: string,
    recipient: string,
    channels: Record<string, string>,
    alertEventType = "m36.ack.requested",
  ): Promise<Record<string, string>> => {
    const [alert] = await kit.one<{ id: string }>(
      `INSERT INTO alert (organization_id, event_type, severity, payload, correlation_id, outcome)
       VALUES ($1, $2, 'warn', $3::jsonb, $4, 'pending') RETURNING id`,
      [
        ORG_A,
        alertEventType,
        JSON.stringify({ recipientUserId: recipient, messageId, sourceAggregateId: messageId }),
        `t:${randomUUID()}`,
      ],
    );
    const ids: Record<string, string> = {};
    for (const [channelName, status] of Object.entries(channels)) {
      const [d] = await kit.one<{ id: string }>(
        `INSERT INTO notification_delivery (alert_id, recipient_user_id, alert_category, alert_severity, channel, status)
         VALUES ($1, $2, 'clinical_urgent', 'warn', $3, $4) RETURNING id`,
        [(alert as { id: string }).id, recipient, channelName, status],
      );
      ids[channelName] = (d as { id: string }).id;
    }
    return ids;
  };

  /** Settles one delivery `failed` through the REAL settlement (which publishes the real delivery_failed event) and returns the envelope. */
  const failRoute = async (deliveryId: string) => {
    await withOrgContext(kit.handle.db, systemOrgContext(ORG_A), (tx) =>
      applyDeliveryTransition(tx, catalogOutbox() as never, {
        organizationId: ORG_A,
        deliveryId,
        transition: { status: "failed", failReason: "provider_unreachable" },
        now: new Date(),
      }),
    );
    const [ev] = await kit.one<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m36.notification.delivery_failed'",
      [deliveryId],
    );
    return {
      eventType: "m36.notification.delivery_failed",
      organizationId: ORG_A,
      payload: ev?.payload,
    } as never;
  };
  const deliver = (envelope: never) => consumer.handle(envelope);

  /** Fails push then sms (the simulated outage) for a fresh request and delivers both events. */
  const outage = async (id: string, messageId: string, recipient = rn) => {
    const ids = await alertWithRoutes(messageId, recipient, {
      in_app: "delivered",
      push: "pending",
      sms: "pending",
    });
    await deliver(await failRoute(ids.push as string));
    const midway = await row(id);
    await deliver(await failRoute(ids.sms as string));
    return { ids, midway };
  };

  const buildBinding = () =>
    buildEscalationBinding({
      flags: { forOrg: async () => ({ ...flags }) },
      store: ack.store,
      outbox: catalogOutbox() as never,
      router,
      stillQualified: ack.stillQualified,
    });
  const rebuild = () => {
    escalation = buildBinding();
    consumer = buildM36AckDeliveryFailureConsumer({
      readRoutes: routeReaderDb,
      service: escalation.deliveryFailure,
      warn: (_m, c) => warnings.push(c),
    });
  };
  const resetCase = () => {
    ladder = {};
    flags[FLAG_TIMERS] = true;
    warnings.length = 0;
    rebuild(); // the flag read is cached a few seconds per binding
  };

  const asApp = async (
    sql: string,
    params: unknown[],
    user: string | null,
  ): Promise<string | null> => {
    await kit.appConn.query("BEGIN");
    try {
      await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
      await kit.appConn.query("SELECT set_config('app.user_id', $1, true)", [user ?? ""]);
      await kit.appConn.query(sql, params);
      return null;
    } catch (err) {
      return (err as Error).message;
    } finally {
      await kit.appConn.query("ROLLBACK");
    }
  };

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "wp45");
    nurse = await seed("nurse", ORG_A, SEND_KEYS);
    rn = await seed("rn", ORG_A, RECEIVE_KEYS);
    rn2 = await seed("rn2", ORG_A, RECEIVE_KEYS);
    tier1 = await seed("tier1", ORG_A, RECEIVE_KEYS);
    orgBUser = await seed("orgb", ORG_B, [...SEND_KEYS, ...RECEIVE_KEYS]);
    channel = await mkChannel(kit, "care_team", PATIENT, [nurse, rn, rn2, tier1]);
    const registry = createPredicateRegistry();
    registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
      const channelId = typeof target.id === "string" ? target.id : null;
      if (!channelId || !ctx.organizationId || !ctx.userId) return false;
      return kit.service.canViewChannel(ctx.organizationId, ctx.userId, channelId);
    });
    registerAbacRegistry(registry);
    app = buildServer({
      db: kit.handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: createDbIdempotencyStore(kit.handle.db),
    });
    ack = buildAckDeps({
      db: kit.handle.db,
      flags: { forOrg: async () => ({ [FLAG_ACK]: true }) },
      outbox: catalogOutbox() as never,
      permissionsFor: async (_org, userId) => new Set(keysOf.get(userId) ?? []),
      part2Gate: {
        allowedUserIds: async ({ userIds }: { userIds: readonly string[] }) => new Set(userIds),
      },
      careTeamMembers: async () => [nurse, rn, rn2, tier1],
      messaging: kit.service,
    });
    registerMessagingRoutes(app, {
      service: kit.service,
      announcements: createDbAnnouncementService(kit.handle.db),
      ackRequests: { service: ack.service },
    });
    await app.ready();
    routeReaderDb = createDeliveryRouteReader(kit.handle.db);
    rebuild();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await kit?.close();
  });

  describe("1. the simulated push+SMS outage (deny-stub router)", () => {
    it("one failed route is not enough; both failing makes ONE failed_unreachable before the deadline, with history, audit and an id-only event", async () => {
      resetCase();
      const { id, messageId } = await freshRequest();
      const before = await row(id);

      const { midway } = await outage(id, messageId);

      expect(midway.status).toBe("pending"); // sms was still pending: the request keeps waiting
      expect(warnings.map((w) => w.reason)).toContain("other_routes_still_open");
      const after = await row(id);
      expect(after).toMatchObject({
        status: "failed_unreachable",
        assigned_user_id: rn,
        version: before.version + 1,
        current_tier: 0,
      });
      // Immediate: well before the request's own deadline (the point of 4.5).
      expect(Date.now()).toBeLessThan(after.deadline_at.getTime());
      expect(await eventTypes(id)).toEqual(["requested", "delivery_failed"]);
      const [history] = await kit.one<{
        actor_user_id: string | null;
        actor_kind: string;
        from_status: string;
        to_status: string;
      }>(
        "SELECT * FROM message_acknowledgment_event WHERE request_id=$1 AND event_type='delivery_failed'",
        [id],
      );
      expect(history).toMatchObject({
        actor_user_id: null,
        actor_kind: "system",
        from_status: "pending",
        to_status: "failed_unreachable",
      });
      expect(await outboxNames(id)).toEqual(["m36.ack.requested", "m36.ack.failed_unreachable"]);
      const [event] = await kit.one<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m36.ack.failed_unreachable'",
        [id],
      );
      expect(event?.payload).toMatchObject({
        requestId: id,
        actorUserId: null,
        requestVersion: after.version,
      });
      expect(JSON.stringify(event?.payload)).not.toContain(PATIENT);
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM audit_event WHERE resource_id=$1 AND event_type='message_acknowledgment_request.update' AND actor_kind='system'",
          [id],
        ),
      ).toBe(1);
    });

    it("the notification consumer then creates the supervisor-audience alert and the ops notice, and never says anyone was reached", async () => {
      resetCase();
      const { id, messageId } = await freshRequest();
      await outage(id, messageId);
      const [event] = await kit.one<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m36.ack.failed_unreachable'",
        [id],
      );
      const emitted: Array<{ org: string; alert: Record<string, any> }> = [];
      const notices: Array<Record<string, unknown>> = [];
      const notify = buildM36AckUnreachableNotificationsConsumer({
        alerts: {
          emit: async (org: string, alert: Record<string, any>) =>
            void emitted.push({ org, alert }),
        } as unknown as AlertEmitter,
        messaging: kit.service,
        readRequest: escalation.readRequest,
        opsNotice: (n) => void notices.push(n as unknown as Record<string, unknown>),
      });
      const envelope = {
        eventType: "m36.ack.failed_unreachable",
        organizationId: ORG_A,
        payload: event?.payload,
      } as never;

      await notify.handle(envelope);
      await notify.handle(envelope); // a redelivery converges on the same correlation id

      expect(emitted).toHaveLength(2);
      expect(new Set(emitted.map((e) => e.alert.correlationId)).size).toBe(1);
      expect(emitted[0]?.alert.payload.recipientUserIds.sort()).toEqual([nurse, rn].sort());
      expect(emitted[0]?.alert.payload.message).toMatch(/nobody is known to have received it/);
      expect(notices[0]).toMatchObject({
        kind: "m36.ack.failed_unreachable",
        details: { organizationId: ORG_A, requestId: id },
      });
      expect(JSON.stringify(notices[0])).not.toContain(PATIENT);
    });
  });

  describe("2. a bound router", () => {
    it("both routes failing escalates to the next tier NOW, once, with the tier's window", async () => {
      resetCase();
      ladder[1] = (asOf) => ({
        kind: "resolved",
        tier: 1,
        asOf,
        source: "m19",
        userIds: [tier1],
        nextTier: null,
        timeZone: "UTC",
      });
      const { id, messageId } = await freshRequest();

      await outage(id, messageId);

      const after = await row(id);
      expect(after).toMatchObject({
        status: "escalated",
        assigned_user_id: tier1,
        current_tier: 1,
      });
      expect(Date.now()).toBeLessThan(after.window_started_at.getTime() + MIN * 2);
      expect(after.deadline_at.getTime() - after.window_started_at.getTime()).toBe(30 * MIN); // important, tier 1
      expect(await eventTypes(id)).toEqual(["requested", "escalated", "delivery_failed"]);
      expect(await outboxNames(id)).toEqual(["m36.ack.requested", "m36.ack.escalated"]);
      // The new assignee can take responsibility; the old one cannot.
      expect((await postNoKey(rn, `${BASE}/${id}/acknowledge`)).statusCode).toBeGreaterThanOrEqual(
        400,
      );
      expect((await postNoKey(tier1, `${BASE}/${id}/acknowledge`)).statusCode).toBe(200);
    });
  });

  describe("3. replay and concurrency", () => {
    it("replaying the final event 5 times and 8 concurrent handlers write exactly once", async () => {
      resetCase();
      const { id, messageId } = await freshRequest();
      const ids = await alertWithRoutes(messageId, rn, {
        in_app: "delivered",
        push: "pending",
        sms: "pending",
      });
      await failRoute(ids.push as string);
      const last = await failRoute(ids.sms as string);

      await Promise.all(Array.from({ length: 8 }, () => deliver(last)));
      for (let i = 0; i < 5; i += 1) await deliver(last);

      expect((await row(id)).status).toBe("failed_unreachable");
      expect((await row(id)).version).toBe(1);
      expect(await eventTypes(id)).toEqual(["requested", "delivery_failed"]);
      expect(await outboxNames(id)).toEqual(["m36.ack.requested", "m36.ack.failed_unreachable"]);
    });
  });

  describe("4. acknowledge versus failure", () => {
    it("an acknowledgment that came first wins: the failure changes nothing", async () => {
      resetCase();
      const { id, messageId } = await freshRequest();
      expect((await postNoKey(rn, `${BASE}/${id}/acknowledge`)).statusCode).toBe(200);

      await outage(id, messageId);

      expect((await row(id)).status).toBe("acknowledged");
      expect(await eventTypes(id)).toEqual(["requested", "acknowledged"]);
    });

    it("the assignee can still acknowledge a failed_unreachable request (the in-app alert may have been seen)", async () => {
      resetCase();
      const { id, messageId } = await freshRequest();
      await outage(id, messageId);
      expect((await row(id)).status).toBe("failed_unreachable");

      const res = await postNoKey(rn, `${BASE}/${id}/acknowledge`);

      expect(res.statusCode, res.body).toBe(200);
      expect((await row(id)).status).toBe("acknowledged");
    });

    it("a concurrent acknowledge and failure settle on one consistent outcome, never both", async () => {
      for (let round = 0; round < 4; round += 1) {
        resetCase();
        const { id, messageId } = await freshRequest();
        const ids = await alertWithRoutes(messageId, rn, {
          in_app: "delivered",
          push: "failed",
          sms: "pending",
        });
        const last = await failRoute(ids.sms as string);

        await Promise.all([postNoKey(rn, `${BASE}/${id}/acknowledge`), deliver(last)]);

        const final = await row(id);
        const types = await eventTypes(id);
        expect(["acknowledged", "failed_unreachable"]).toContain(final.status);
        if (final.status === "acknowledged") {
          expect(types).toContain("acknowledged");
        } else {
          // The failure landed first; the acknowledge then moved failed_unreachable -> acknowledged, or lost to it (409). Either way
          // the history is a legal chain and there is exactly one failed_unreachable event.
          expect(types.filter((t) => t === "delivery_failed")).toHaveLength(1);
        }
        expect(
          (await outboxNames(id)).filter((n) => n === "m36.ack.failed_unreachable").length,
        ).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("5. what must NOT happen", () => {
    it("flag off leaves the request exactly as it is", async () => {
      resetCase();
      flags[FLAG_TIMERS] = false;
      rebuild();
      const { id, messageId } = await freshRequest();
      const before = await row(id);

      await outage(id, messageId);

      expect(await row(id)).toEqual(before);
      expect(await outboxNames(id)).toEqual(["m36.ack.requested"]);
    });

    it("a failure for someone who is not the assignee, and a reminder alert, do nothing", async () => {
      resetCase();
      const { id, messageId } = await freshRequest();
      const before = await row(id);
      const other = await alertWithRoutes(messageId, rn2, { in_app: "delivered", push: "failed" });
      const reminder = await alertWithRoutes(
        messageId,
        rn,
        { in_app: "delivered", push: "failed" },
        "m36.ack.route_unavailable",
      );

      const otherFailure = await failRoute(other.push as string);
      const reminderFailure = await failRoute(reminder.push as string);

      await deliver(otherFailure);
      await deliver(reminderFailure);

      expect(await row(id)).toEqual(before);
    });

    it("an alert from before a reassign (an earlier window) does not fail the new assignment", async () => {
      resetCase();
      const { id, messageId } = await freshRequest();
      const ids = await alertWithRoutes(messageId, rn, { in_app: "delivered", push: "pending" });
      const failed = await failRoute(ids.push as string);
      // Hand it to rn2 and back to rn: the window restarts AFTER the old alert was created.
      expect(
        (await postNoKey(nurse, `${BASE}/${id}/reassign`, { assigned_user_id: rn2 })).statusCode,
      ).toBe(200);
      expect(
        (await postNoKey(nurse, `${BASE}/${id}/reassign`, { assigned_user_id: rn })).statusCode,
      ).toBe(200);
      const before = await row(id);

      await deliver(failed);

      expect(await row(id)).toEqual(before);
    });
  });

  describe("6. tenant isolation (wardenx_app, NOBYPASSRLS)", () => {
    it("another tenant's context cannot read a delivery of this tenant, nor act on its request", async () => {
      resetCase();
      const { id, messageId } = await freshRequest();
      const ids = await alertWithRoutes(messageId, rn, { in_app: "delivered", push: "failed" });

      const crossRead = await routeReaderDb(ORG_B, ids.push as string);
      const ownRead = await routeReaderDb(ORG_A, ids.push as string);
      const crossAct = await escalation.deliveryFailure.onAllRoutesFailed(ORG_B, {
        messageId,
        recipientUserId: rn,
        alertCreatedAt: new Date(),
      });

      expect(crossRead).toBeNull();
      expect(ownRead?.recipientUserId).toBe(rn);
      expect(crossAct).toEqual({ kind: "not_waiting" });
      expect((await row(id)).status).toBe("pending");
      expect(orgBUser).toBeTruthy();
    });
  });

  describe("7. the database guard", () => {
    it("refuses a person writing failed_unreachable; the empty actor may; a human can reassign out of it", async () => {
      resetCase();
      const { id } = await freshRequest();
      const unreachable =
        "UPDATE message_acknowledgment_request SET status='failed_unreachable', version=version+1 WHERE id=$1";

      expect(await asApp(unreachable, [id], nurse)).toMatch(/only the delivery-failure handler/);
      expect(await asApp(unreachable, [id], rn)).toMatch(/only the delivery-failure handler/);
      expect(await asApp(unreachable, [id], null)).toBeNull();
    });

    it("a reassign from failed_unreachable returns the request to pending with a new window", async () => {
      resetCase();
      const { id, messageId } = await freshRequest();
      await outage(id, messageId);

      const res = await postNoKey(nurse, `${BASE}/${id}/reassign`, { assigned_user_id: rn2 });

      expect(res.statusCode, res.body).toBe(200);
      expect(await row(id)).toMatchObject({ status: "pending", assigned_user_id: rn2 });
    });
  });
});
