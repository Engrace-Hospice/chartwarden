/**
 * M36 ADR-0106 (PROPOSED) - emergency message SERVICE + CONSUMER + SWEEP, LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 * The data-model guards are m36-message-emergency.live.test.ts; this drives what sits on top of them.
 *
 *   1. DECLARE   author only; the audience is the channel's active members minus the author; one `m36.emergency.sent` per recipient, validated
 *                against the boot outbox catalog; a repeat creates nothing and publishes nothing; nobody to alarm is a typed 422.
 *   2. ACK       self only, idempotent, the first instant is kept; the author and strangers get the uniform 404.
 *   3. STATUS    only the author reads who has not acknowledged.
 *   4. CONSUMER  the first alarm (tick 0) is ONE critical alert per recipient with the fixed text; it names no channel or sender.
 *   5. SWEEP     tick n alarms only the unacknowledged; the same minute twice raises one id; flag off = nothing; past the deadline ONE escalation.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:emergency:live
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { createEmergencyService } from "../src/modules/36-messaging/emergency/emergency-service";
import { sweepEmergenciesForOrg } from "../src/modules/36-messaging/emergency/emergency-sweep";
import { buildM36EmergencyNotificationsConsumer } from "../src/modules/36-messaging/outbox-consumers/emergency-notifications";
import { registerMessagingRoutes } from "../src/modules/36-messaging/routes/messaging-routes";
import { type LiveKit, as, bootLiveKit, catalogOutbox, headerAuth } from "./_m36-handoff-live-kit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-11110a690101";
const ORG_B = "22222222-2222-4222-8222-22220a690102";
const KEYS = ["messaging.read", "messaging.send"];
const MINUTE_MS = 60_000;

interface Emitted {
  readonly orgId: string;
  readonly eventType: string;
  readonly severity: string;
  readonly correlationId: string;
  readonly payload: Record<string, unknown>;
}

describe.skipIf(!DB_URL)(
  "M36 ADR-0106 emergency service, consumer and sweep - LIVE Postgres",
  () => {
    let kit: LiveKit;
    let app: FastifyInstance;
    let author: string;
    let alice: string;
    let bob: string;
    let carol: string; // active user, NOT a channel member
    let channel: string;
    let messageId: string;
    let emergencyId: string;
    let createdAt: Date;
    let flagOn = true;
    let minutesLater = 0;
    const emitted: Emitted[] = [];

    const alerts = {
      emit: async (orgId: string, input: Omit<Emitted, "orgId">) => {
        emitted.push({ orgId, ...input });
        return { alertId: "00000000-0000-4000-8000-000000000000", recipientCount: 1 };
      },
    };

    const member = (user: string) =>
      kit.admin.query(
        `INSERT INTO channel_member (organization_id, channel_id, user_id, source) VALUES ($1,$2,$3,'manual')`,
        [ORG_A, channel, user],
      );

    const build = () =>
      createEmergencyService({
        db: kit.handle.db,
        flags: { forOrg: async () => ({ "messaging.emergency": flagOn }) },
        outbox: catalogOutbox() as never,
      });
    const sweepDeps = () => ({
      db: kit.handle.db,
      isEnabled: async () => flagOn,
      alerts: alerts as never,
      now: () => new Date(createdAt.getTime() + minutesLater * MINUTE_MS),
    });

    /** Moves the emergency back in time (superuser, triggers off for the statement) so the DB clock sees it as older. */
    const ageEmergency = async (minutes: number) => {
      await kit.admin.query("BEGIN");
      try {
        await kit.admin.query("SET LOCAL session_replication_role = replica");
        await kit.admin.query(
          `UPDATE message_emergency SET created_at = created_at - make_interval(mins => $2),
                deadline_at = deadline_at - make_interval(mins => $2) WHERE id = $1`,
          [emergencyId, minutes],
        );
        await kit.admin.query("COMMIT");
      } catch (error) {
        await kit.admin.query("ROLLBACK");
        throw error;
      }
      createdAt = new Date(createdAt.getTime() - minutes * MINUTE_MS);
    };

    beforeAll(async () => {
      kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "em2");
      author = await kit.seedUser("author", ORG_A, KEYS);
      alice = await kit.seedUser("alice", ORG_A, KEYS);
      bob = await kit.seedUser("bob", ORG_A, KEYS);
      carol = await kit.seedUser("carol", ORG_A, KEYS);
      channel = (
        await kit.one<{ id: string }>(
          `INSERT INTO channel (organization_id, channel_kind, title, retention_class)
         VALUES ($1,'announcement','Care team','operational') RETURNING id`,
          [ORG_A],
        )
      )[0]!.id;
      for (const user of [author, alice, bob]) await member(user);
      messageId = (
        await kit.service.sendMessage(ORG_A, {
          channelId: channel,
          authorUserId: author,
          body: "Patient fall, need help in room 4",
        })
      ).messageId;
      app = buildServer({
        db: kit.handle.db,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
        idempotencyStore: createDbIdempotencyStore(kit.handle.db),
      });
      const { tasks, handoffs } = kit.build(true);
      registerMessagingRoutes(app, {
        service: kit.service,
        announcements: createDbAnnouncementService(kit.handle.db),
        tasks,
        handoffs,
        emergency: { service: build() },
      });
      await app.ready();
    }, 240_000);

    afterAll(async () => {
      await app?.close();
      await kit?.close();
    });

    it("declares an emergency for the channel's other members and publishes one catalogued event per recipient", async () => {
      const out = await build().declare(ORG_A, { userId: author, messageId });
      emergencyId = out.emergencyId;
      createdAt = new Date(out.createdAt);
      expect(out.created).toBe(true);
      expect(out.counts).toEqual({ audience: 2, acknowledged: 0, pending: 2 });
      expect(Date.parse(out.deadlineAt) - Date.parse(out.createdAt)).toBe(15 * MINUTE_MS);
      const recipients = await kit.one<{ user_id: string }>(
        `SELECT user_id FROM message_emergency_recipient WHERE emergency_id = $1 ORDER BY user_id`,
        [emergencyId],
      );
      expect(recipients.map((r) => r.user_id).sort()).toEqual([alice, bob].sort());
      expect(
        await kit.count(
          `SELECT count(*)::int AS n FROM outbox_event WHERE event_type = 'm36.emergency.sent' AND aggregate_id = $1`,
          [messageId],
        ),
      ).toBe(2);
    });

    it("is idempotent, author-only, and refuses a channel with nobody to alarm", async () => {
      const again = await build().declare(ORG_A, { userId: author, messageId });
      expect(again.created).toBe(false);
      expect(again.emergencyId).toBe(emergencyId);
      expect(
        await kit.count(
          `SELECT count(*)::int AS n FROM outbox_event WHERE event_type = 'm36.emergency.sent' AND aggregate_id = $1`,
          [messageId],
        ),
      ).toBe(2);
      await expect(build().declare(ORG_A, { userId: alice, messageId })).rejects.toThrow(
        /Not found/,
      );

      const solo = (
        await kit.one<{ id: string }>(
          `INSERT INTO channel (organization_id, channel_kind, title, retention_class)
         VALUES ($1,'announcement','Solo','operational') RETURNING id`,
          [ORG_A],
        )
      )[0]!.id;
      await kit.admin.query(
        `INSERT INTO channel_member (organization_id, channel_id, user_id, source) VALUES ($1,$2,$3,'manual')`,
        [ORG_A, solo, author],
      );
      const lonely = (
        await kit.service.sendMessage(ORG_A, {
          channelId: solo,
          authorUserId: author,
          body: "anyone?",
        })
      ).messageId;
      await expect(
        build().declare(ORG_A, { userId: author, messageId: lonely }),
      ).rejects.toMatchObject({ code: "EMERGENCY_NO_RECIPIENTS" });
    });

    it("sends the first alarm as ONE critical, fixed-text alert per recipient that names nothing", async () => {
      emitted.length = 0;
      const consumer = buildM36EmergencyNotificationsConsumer({
        alerts: alerts as never,
        messaging: { canViewChannel: async (_o: string, user: string) => user !== bob },
      });
      for (const recipient of [alice, bob]) {
        await consumer.handle({
          eventType: "m36.emergency.sent",
          organizationId: ORG_A,
          payload: {
            emergencyId,
            channelId: channel,
            messageId,
            authorUserId: author,
            recipientUserId: recipient,
          },
        } as never);
      }
      // bob lost access to the channel: a stale event does not alarm him.
      expect(emitted).toHaveLength(1);
      const alert = emitted[0]!;
      expect(alert).toMatchObject({
        eventType: "m36.emergency.sent",
        severity: "critical",
        correlationId: `emergency:${emergencyId}:${alice}:0`,
      });
      expect(alert.payload.message).toBe("Emergency message. Open ChartWarden now.");
      expect(JSON.stringify(alert.payload)).not.toMatch(/Care team|Patient fall|room 4/);
    });

    it("lets only the recipient acknowledge, once, keeping the first instant", async () => {
      const svc = build();
      const first = await svc.acknowledge(ORG_A, { userId: alice, emergencyId });
      expect(first.already).toBe(false);
      const second = await svc.acknowledge(ORG_A, { userId: alice, emergencyId });
      expect(second).toEqual({ ...first, already: true });
      await expect(svc.acknowledge(ORG_A, { userId: author, emergencyId })).rejects.toThrow(
        /Not found/,
      );
      await expect(svc.acknowledge(ORG_A, { userId: carol, emergencyId })).rejects.toThrow(
        /Not found/,
      );
    });

    it("shows who has not acknowledged to the author only, and each recipient their own waiting alarm", async () => {
      const svc = build();
      const detail = await svc.detail(ORG_A, { userId: author, messageId });
      expect(detail.counts).toEqual({ audience: 2, acknowledged: 1, pending: 1 });
      expect(detail.people.find((p) => p.userId === bob)?.acknowledgedAt).toBeNull();
      expect(detail.people.find((p) => p.userId === alice)?.acknowledgedAt).not.toBeNull();
      await expect(svc.detail(ORG_A, { userId: alice, messageId })).rejects.toThrow(/Not found/);
      const mineBob = await svc.mine(ORG_A, { userId: bob });
      expect(mineBob[0]).toMatchObject({ emergencyId, acknowledgedAt: null });
      expect((await svc.list(ORG_A, { userId: author }))[0]?.emergencyId).toBe(emergencyId);
    });

    it("re-alarms only the unacknowledged on each minute tick, once per tick", async () => {
      await ageEmergency(3);
      minutesLater = 3;
      emitted.length = 0;
      const first = await sweepEmergenciesForOrg(sweepDeps(), ORG_A);
      expect(first).toMatchObject({ alarms: 1, escalations: 0, failed: 0 });
      expect(emitted.map((e) => e.correlationId)).toEqual([`emergency:${emergencyId}:${bob}:3`]);
      // The same minute again carries the SAME id (the emitter absorbs it): the id is the dedupe key.
      emitted.length = 0;
      await sweepEmergenciesForOrg(sweepDeps(), ORG_A);
      expect(emitted.map((e) => e.correlationId)).toEqual([`emergency:${emergencyId}:${bob}:3`]);
    });

    it("does nothing while the tenant flag is off", async () => {
      flagOn = false;
      emitted.length = 0;
      expect(await sweepEmergenciesForOrg(sweepDeps(), ORG_A)).toEqual({
        alarms: 0,
        escalations: 0,
        failed: 0,
      });
      expect(emitted).toHaveLength(0);
      flagOn = true;
    });

    it("raises ONE escalation to the sender and supervisors once the 15-minute deadline passes unanswered", async () => {
      await ageEmergency(14); // now 17 minutes old
      minutesLater = 17;
      emitted.length = 0;
      const out = await sweepEmergenciesForOrg(sweepDeps(), ORG_A);
      expect(out).toMatchObject({ alarms: 1, escalations: 1, failed: 0 });
      const escalation = emitted.find((e) => e.eventType === "m36.emergency.escalated");
      expect(escalation).toMatchObject({
        severity: "critical",
        correlationId: `emergency-escalated:${emergencyId}`,
      });
      expect(escalation?.payload).toMatchObject({ authorUserId: author, pending: 1 });
    });

    it("stops entirely once everyone has acknowledged", async () => {
      await build().acknowledge(ORG_A, { userId: bob, emergencyId });
      emitted.length = 0;
      expect(await sweepEmergenciesForOrg(sweepDeps(), ORG_A)).toEqual({
        alarms: 0,
        escalations: 0,
        failed: 0,
      });
      expect(emitted).toHaveLength(0);
    });

    // ---- the HTTP surface ------------------------------------------------------------------------------------------------------
    const call = (method: "GET" | "POST", url: string, user: string, payload?: unknown) =>
      app.inject({ method, url, headers: as(user, ORG_A), ...(payload ? { payload } : {}) });
    let routeMessage: string;
    let routeEmergency: string;

    it("answers a uniform 404 while the flag is off, even for a malformed request, and writes nothing", async () => {
      routeMessage = (
        await kit.service.sendMessage(ORG_A, {
          channelId: channel,
          authorUserId: author,
          body: "Second incident",
        })
      ).messageId;
      flagOn = false;
      try {
        const before = await kit.count(`SELECT count(*)::int AS n FROM message_emergency`);
        const responses = [
          await call("POST", `/api/v1/messaging/messages/${routeMessage}/emergency`, author),
          await call("POST", "/api/v1/messaging/messages/not-a-uuid/emergency", author),
          await call("GET", "/api/v1/messaging/emergencies/mine", alice),
          await call("POST", `/api/v1/messaging/emergencies/not-a-uuid/ack`, alice),
        ];
        for (const res of responses) expect(res.statusCode).toBe(404);
        expect(await kit.count(`SELECT count(*)::int AS n FROM message_emergency`)).toBe(before);
      } finally {
        flagOn = true;
      }
    });

    it("declares over HTTP, repeats as 200, refuses a non-author and ignores a user id in the acknowledgment", async () => {
      const url = `/api/v1/messaging/messages/${routeMessage}/emergency`;
      const first = await call("POST", url, author);
      expect(first.statusCode).toBe(201);
      routeEmergency = first.json().emergencyId;
      expect(first.json().counts).toEqual({ audience: 2, acknowledged: 0, pending: 2 });
      expect(first.headers["cache-control"]).toBe("no-store");
      expect((await call("POST", url, author)).statusCode).toBe(200);
      expect((await call("POST", url, alice)).statusCode).toBe(404);

      const ackUrl = `/api/v1/messaging/emergencies/${routeEmergency}/ack`;
      // A user id in the body is ignored: bob acknowledges for bob, never for the author or anyone else.
      const bobAck = await call("POST", ackUrl, bob, { userId: alice });
      expect(bobAck.statusCode).toBe(200);
      expect(bobAck.json().already).toBe(false);
      expect((await call("POST", ackUrl, author)).statusCode).toBe(404);
      const waiting = await kit.one<{ user_id: string }>(
        `SELECT user_id FROM message_emergency_recipient WHERE emergency_id = $1 AND acknowledged_at IS NULL`,
        [routeEmergency],
      );
      expect(waiting.map((r) => r.user_id)).toEqual([alice]);
    });

    it("lists the caller's own alarms waiting first and shows the roster to the author only", async () => {
      const mine = await call("GET", "/api/v1/messaging/emergencies/mine", alice);
      expect(mine.statusCode).toBe(200);
      expect(mine.json().items[0]).toMatchObject({
        emergencyId: routeEmergency,
        acknowledgedAt: null,
      });
      const roster = await call(
        "GET",
        `/api/v1/messaging/messages/${routeMessage}/emergency`,
        author,
      );
      expect(roster.statusCode).toBe(200);
      expect(roster.json().people).toHaveLength(2);
      expect(
        (await call("GET", `/api/v1/messaging/messages/${routeMessage}/emergency`, alice))
          .statusCode,
      ).toBe(404);
      expect(
        (await call("GET", "/api/v1/messaging/emergencies", author)).json().emergencies.length,
      ).toBeGreaterThan(0);
    });

    it("gives another organisation's user nothing: the same 404 a random id gets, an empty list, no rows touched", async () => {
      const outsider = await kit.seedUser("outsider", ORG_B, KEYS);
      const asB = (method: "GET" | "POST", url: string) =>
        app.inject({ method, url, headers: as(outsider, ORG_B) });
      const stripCorrelation = (body: string) => body.replace(/"correlationId":"[^"]*"/, "");
      const random = "00000000-0000-4000-8000-0000000000aa";
      const declare = `/api/v1/messaging/messages/${routeMessage}/emergency`;
      const foreign = [
        await asB("POST", declare),
        await asB("GET", declare),
        await asB("POST", `/api/v1/messaging/emergencies/${routeEmergency}/ack`),
      ];
      const unknown = [
        await asB("POST", `/api/v1/messaging/messages/${random}/emergency`),
        await asB("GET", `/api/v1/messaging/messages/${random}/emergency`),
        await asB("POST", `/api/v1/messaging/emergencies/${random}/ack`),
      ];
      for (const [i, res] of foreign.entries()) {
        expect(res.statusCode).toBe(404);
        expect(stripCorrelation(res.body)).toBe(stripCorrelation(unknown[i]?.body ?? ""));
      }
      expect((await asB("GET", "/api/v1/messaging/emergencies/mine")).json().items).toEqual([]);
      expect((await asB("GET", "/api/v1/messaging/emergencies")).json().emergencies).toEqual([]);
      const still = await kit.one<{ user_id: string }>(
        `SELECT user_id FROM message_emergency_recipient WHERE emergency_id = $1 AND acknowledged_at IS NULL`,
        [routeEmergency],
      );
      expect(still.map((r) => r.user_id)).toEqual([alice]);
    });
  },
);
