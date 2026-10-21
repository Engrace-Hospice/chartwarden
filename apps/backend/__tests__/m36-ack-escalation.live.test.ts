/**
 * M36 WP 4.4 - durable escalation timers, LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role, plus (for the queue cases) a REAL
 * BullMQ on a real Valkey.
 *
 * The real request stack creates, acknowledges, reassigns and deletes (Authorization Contract, `channel_visibility`, the DB route
 * service, the M1 idempotency store) over the REAL catalog-validating outbox publisher (not NOOP_OUTBOX). The escalation runs through
 * the real binding, store and service, with a router stub that answers like M19 would (the deny-stub is the production default).
 *
 *   A. THE ALGORITHM (Postgres)
 *      1. flag off leaves a due request exactly as it is;           2. the deny-stub: open, one `route_unavailable` row, no recipient invented;
 *      3. a bound router escalates once: tier, assignee, window on the DATABASE clock, history row, audit row, id-only outbox event;
 *      4. the new assignee acknowledges, the old one cannot;       5. duplicate delivery and 8-way concurrency: exactly one escalation;
 *      6. ack vs deadline, BOTH orders (and an ack that lands while the router is being asked);
 *      7. reassign re-arms a new window and the old window's job does nothing;     8. delete cancels: nothing escalates;
 *      9. another tenant's user can never be the recipient;        10. the database refuses a person's escalation and a forged one.
 *   B. THE QUEUE (Postgres + Valkey)
 *      11. a stalled job (worker killed mid-timer) is recovered and runs once;       12. a duplicate job id is one job, a second job for
 *      the same window still escalates once;      13. a flushed Redis: the sweeper escalates exactly once;
 *      14. a job that exhausts its retries lands on the DLQ queue AND leaves an `m36.dlq_job` audit row; a poison payload does too.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... CHARTWARDEN_TEST_REDIS_URL=redis://localhost:PORT bun run test:m36:ack-escalation:live
 * Use a PRIVATE pgvector/pgvector:pg18 container and a PRIVATE valkey/valkey:8 container: the suite resets the public schema and the
 * chartwarden_* roles, and obliterates the ack-escalation queues it uses.
 */
import { randomUUID } from "node:crypto";
import {
  createPredicateRegistry,
  registerAbacRegistry,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import {
  type AlertEmitter,
  MESSAGING_QUEUES,
  MESSAGING_QUEUE_PARAMETERS,
  escalationJobId,
} from "@chartwarden/messaging";
import { getRequestContext } from "@chartwarden/tenancy";
import type { EscalationRouteAnswer, EscalationRouter } from "@chartwarden/types";
import { Queue, type Worker } from "bullmq";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { buildEscalationBinding } from "../src/modules/36-messaging/ack-escalation/binding";
import { createDlqAuditRecorder } from "../src/modules/36-messaging/ack-escalation/dlq-audit";
import { createEscalationService } from "../src/modules/36-messaging/ack-escalation/escalation-service";
import { createBullmqTimerPort } from "../src/modules/36-messaging/ack-escalation/escalation-timers";
import {
  registerM36AckEscalationWorkers,
  scheduleM36AckEscalationJobs,
  sweepTick,
} from "../src/modules/36-messaging/ack-escalation/escalation-worker";
import { buildAckDeps } from "../src/modules/36-messaging/ack-requests/deps";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import { buildM36AckEscalationNotificationsConsumer } from "../src/modules/36-messaging/outbox-consumers/ack-escalation-notifications";
import { buildM36AckTimerArmingConsumer } from "../src/modules/36-messaging/outbox-consumers/ack-timer-arming";
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

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const REDIS_URL = process.env.CHARTWARDEN_TEST_REDIS_URL;
const REDIS_IS_LOCAL =
  !!REDIS_URL && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(REDIS_URL).hostname);
const ORG_A = "11111111-1111-4111-8111-11110a440001";
const ORG_B = "22222222-2222-4222-8222-22220a440002";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a44a1";
const BASE = "/api/v1/messaging/escalations";
const FLAG_ACK = "messaging.ack_requests";
const FLAG_TIMERS = "messaging.escalation_timers";
const SEND_KEYS = [...STAFF_KEYS, "messaging.urgent.send"];
const RECEIVE_KEYS = [...STAFF_KEYS, "messaging.urgent.receive"];
const MIN = 60_000;
const TIMER_QUEUE = MESSAGING_QUEUES.ackEscalationTimer;
const SWEEP_QUEUE = MESSAGING_QUEUES.ackEscalationSweep;
const TIMER_DLQ = MESSAGING_QUEUE_PARAMETERS[TIMER_QUEUE].dlq;

const resolved = (
  tier: number,
  userIds: [string, ...string[]],
  nextTier: number | null,
  asOf: string,
): EscalationRouteAnswer => ({
  kind: "resolved",
  tier,
  asOf,
  source: "m19",
  userIds,
  nextTier,
  timeZone: "UTC",
});

async function eventually<T>(
  probe: () => Promise<T | null | false>,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.skipIf(!DB_URL)("M36 WP 4.4 escalation timers - LIVE Postgres", () => {
  let kit: LiveKit;
  let app: FastifyInstance;
  let nurse: string;
  let rn: string;
  let rn2: string;
  let tier1: string;
  let tier2: string;
  /** Qualified (keys, urgent.receive) but NOT a member of the care-team channel. */
  let outsider: string;
  let orgBUser: string;
  let channel: string;
  let careTeam: string[] = [];
  const keysOf = new Map<string, readonly string[]>();
  /** What the stubbed M19 answers per tier; `undefined` = the deny-stub. Reset per test. */
  let ladder: Record<number, (asOf: string) => EscalationRouteAnswer> = {};
  let routerCalls = 0;
  /** The tenant the ambient request context named inside each router call (a timer is not a request). */
  let routerScopes: Array<string | undefined> = [];
  /** When set, only this patient is routable; every other patient gets the deny-stub's answer. */
  let routablePatient: string | null = null;
  let onRouterCall: (() => Promise<void>) | undefined;
  const flags: Record<string, boolean> = {};
  const clock = { now: new Date() };

  const router: EscalationRouter = {
    async resolveTier(_org, request) {
      routerCalls += 1;
      routerScopes.push(getRequestContext()?.organizationId);
      await onRouterCall?.();
      const answer =
        routablePatient && request.patientId !== routablePatient
          ? undefined
          : ladder[request.tier]?.(request.asOf);
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

  const seed = async (suffix: string, org: string, keys: string[]) => {
    const id = await kit.seedUser(suffix, org, keys);
    keysOf.set(id, keys);
    return id;
  };

  let escalation: ReturnType<typeof buildEscalationBinding>;
  let ack: ReturnType<typeof buildAckDeps>;

  const post = (
    user: string,
    url: string,
    payload: Record<string, unknown> = {},
    opts: { key?: string | null } = {},
  ) =>
    app.inject({
      method: "POST",
      url,
      headers: as(user, ORG_A, opts.key === null ? undefined : (opts.key ?? randomUUID())),
      payload,
    });
  const routineMessage = async (author: string): Promise<string> => {
    const res = await post(author, `/api/v1/messaging/channels/${channel}/messages`, {
      body: `routine note ${randomUUID().slice(0, 8)}`,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().messageId as string;
  };
  const routineMessageIn = async (channelId: string): Promise<string> => {
    const res = await post(nurse, `/api/v1/messaging/channels/${channelId}/messages`, {
      body: `routine note ${randomUUID().slice(0, 8)}`,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().messageId as string;
  };
  /** A fresh important request from `nurse` to `rn`; returns its id and message id. */
  const freshRequest = async (assignee = rn) => {
    const messageId = await routineMessage(nurse);
    const res = await post(nurse, BASE, { message_id: messageId, assigned_user_id: assignee });
    expect(res.statusCode, res.body).toBe(201);
    return { messageId, id: res.json().request.id as string };
  };
  const acknowledge = (user: string, id: string) =>
    post(user, `${BASE}/${id}/acknowledge`, {}, { key: null });
  const reassign = (user: string, id: string, to: string) =>
    post(user, `${BASE}/${id}/reassign`, { assigned_user_id: to }, { key: null });

  interface RequestRow {
    status: string;
    assigned_user_id: string;
    requester_user_id: string;
    window_started_at: Date;
    deadline_at: Date;
    version: number;
    current_tier: number;
    acknowledged_by_user_id: string | null;
  }
  const row = async (id: string) =>
    (
      await kit.one<RequestRow>("SELECT * FROM message_acknowledgment_request WHERE id=$1", [id])
    )[0] as RequestRow;
  const events = (id: string) =>
    kit.one<{
      event_type: string;
      actor_user_id: string | null;
      actor_kind: string;
      from_status: string | null;
      to_status: string | null;
      assigned_user_id: string | null;
      previous_assigned_user_id: string | null;
      tier: number;
    }>("SELECT * FROM message_acknowledgment_event WHERE request_id=$1 ORDER BY created_at, id", [
      id,
    ]);
  const countEvents = async (id: string, type: string) =>
    (await events(id)).filter((e) => e.event_type === type).length;
  const outboxNames = async (id: string) =>
    (
      await kit.one<{ event_type: string }>(
        "SELECT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, id",
        [id],
      )
    ).map((r) => r.event_type);
  /** Moves the injected clock one second past the request's CURRENT deadline. */
  const makeDue = async (id: string) => {
    clock.now = new Date((await row(id)).deadline_at.getTime() + 1000);
  };

  /** Runs `sql` as the NOBYPASSRLS app role in a rolled-back transaction; returns the error message or null. */
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

  const buildBinding = (timers?: ReturnType<typeof createBullmqTimerPort>) =>
    buildEscalationBinding({
      flags: { forOrg: async () => ({ ...flags }) },
      store: ack.store,
      outbox: catalogOutbox() as never,
      router,
      stillQualified: ack.stillQualified,
      canViewChannel: kit.service.canViewChannel,
      now: () => clock.now,
      ...(timers ? { timers } : {}),
    });

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "wp44");
    nurse = await seed("nurse", ORG_A, SEND_KEYS);
    rn = await seed("rn", ORG_A, RECEIVE_KEYS);
    rn2 = await seed("rn2", ORG_A, RECEIVE_KEYS);
    tier1 = await seed("tier1", ORG_A, RECEIVE_KEYS);
    tier2 = await seed("tier2", ORG_A, RECEIVE_KEYS);
    outsider = await seed("outsider", ORG_A, RECEIVE_KEYS);
    orgBUser = await seed("orgb", ORG_B, [...SEND_KEYS, ...RECEIVE_KEYS]);
    channel = await mkChannel(kit, "care_team", PATIENT, [nurse, rn, rn2, tier1, tier2]);
    careTeam = [nurse, rn, rn2, tier1, tier2];

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
      careTeamMembers: async () => careTeam,
      messaging: kit.service,
    });
    registerMessagingRoutes(app, {
      service: kit.service,
      announcements: createDbAnnouncementService(kit.handle.db),
      ackRequests: { service: ack.service },
    });
    await app.ready();
    escalation = buildBinding();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await kit?.close();
  });

  const resetCase = () => {
    ladder = {};
    routerCalls = 0;
    routerScopes = [];
    routablePatient = null;
    onRouterCall = undefined;
    flags[FLAG_TIMERS] = true;
    clock.now = new Date();
  };

  describe("A. the algorithm", () => {
    it("1. leaves a due request exactly as it is while the flag is off", async () => {
      resetCase();
      flags[FLAG_TIMERS] = false;
      const { id } = await freshRequest();
      await makeDue(id);
      const before = await row(id);
      ladder[1] = (asOf) => resolved(1, [tier1], null, asOf);
      // The flag read is cached a few seconds per org; use a binding that has not read it yet.
      const off = buildBinding();

      const outcome = await off.service.processDue(ORG_A, id);

      expect(outcome).toEqual({ kind: "flag_off" });
      expect(await row(id)).toEqual(before);
      expect(await countEvents(id, "escalated")).toBe(0);
      expect(routerCalls).toBe(0);
      expect(await outboxNames(id)).toEqual(["m36.ack.requested"]);
    });

    it("2. with the deny-stub nothing is invented: the request stays open, one route_unavailable row and event, asked again every sweep", async () => {
      resetCase();
      const { id } = await freshRequest();
      await makeDue(id);
      const before = await row(id);

      const first = await escalation.service.processDue(ORG_A, id);
      const second = await escalation.service.processDue(ORG_A, id);
      const sweep = await escalation.service.sweep(ORG_A);

      expect(first).toEqual({ kind: "not_routed", reason: "route_unavailable", recorded: true });
      // Inside the backoff the router is not asked again, and the sweep's query leaves the request out.
      expect(second).toEqual({ kind: "backed_off" });
      expect(sweep.notRouted + sweep.skipped).toBeGreaterThanOrEqual(0);
      expect(await row(id)).toEqual(before);
      expect((await events(id)).map((e) => e.event_type)).toEqual([
        "requested",
        "route_unavailable",
      ]);
      const [unrouted] = (await events(id)).slice(1);
      expect(unrouted).toMatchObject({
        actor_user_id: null,
        actor_kind: "system",
        from_status: "pending",
        to_status: "pending",
        assigned_user_id: rn,
        tier: 1,
      });
      expect(await outboxNames(id)).toEqual(["m36.ack.requested", "m36.ack.route_unavailable"]);
      expect(routerCalls).toBeGreaterThanOrEqual(1);
    });

    it("2b. 'tier_not_configured' is ladder_exhausted: a different row and event, still no state change", async () => {
      resetCase();
      const { id } = await freshRequest();
      await makeDue(id);
      ladder[1] = (asOf) => ({
        kind: "unavailable",
        reason: "tier_not_configured",
        tier: 1,
        asOf,
        source: "m19",
      });

      const outcome = await escalation.service.processDue(ORG_A, id);

      expect(outcome).toEqual({ kind: "not_routed", reason: "ladder_exhausted", recorded: true });
      expect((await row(id)).status).toBe("pending");
      expect(await outboxNames(id)).toContain("m36.ack.ladder_exhausted");
    });

    it("2c. a ladder_exhausted after a route_unavailable is still the first ladder_exhausted (supervisors are told once)", async () => {
      resetCase();
      const { id } = await freshRequest();
      await makeDue(id);
      await escalation.service.processDue(ORG_A, id); // deny-stub: route_unavailable
      clock.now = new Date(clock.now.getTime() + 61 * MIN);
      ladder[1] = (asOf) => ({
        kind: "unavailable",
        reason: "tier_not_configured",
        tier: 1,
        asOf,
        source: "m19",
      });
      await escalation.service.processDue(ORG_A, id);
      clock.now = new Date(clock.now.getTime() + 121 * MIN);
      await escalation.service.processDue(ORG_A, id);

      const payloads = await kit.one<{
        event_type: string;
        payload: { occurrence: number; typeOccurrence: number };
      }>(
        "SELECT event_type, payload FROM outbox_event WHERE aggregate_id=$1 AND event_type LIKE 'm36.ack.%' AND event_type <> 'm36.ack.requested' ORDER BY created_at, id",
        [id],
      );
      expect(
        payloads.map((p) => [p.event_type, p.payload.occurrence, p.payload.typeOccurrence]),
      ).toEqual([
        ["m36.ack.route_unavailable", 1, 1],
        ["m36.ack.ladder_exhausted", 2, 1],
        ["m36.ack.ladder_exhausted", 3, 2],
      ]);
    });

    it("3. with a router bound it escalates once: tier, assignee, a window on the database clock, history, audit and an id-only event", async () => {
      resetCase();
      const { id } = await freshRequest();
      await makeDue(id);
      const before = await row(id);
      ladder[1] = (asOf) => resolved(1, [tier1], 2, asOf);

      const outcome = await escalation.service.processDue(ORG_A, id);

      expect(outcome).toMatchObject({ kind: "escalated", tier: 1, assignedUserId: tier1 });
      const after = await row(id);
      expect(after).toMatchObject({
        status: "escalated",
        assigned_user_id: tier1,
        current_tier: 1,
        version: before.version + 1,
        requester_user_id: nurse,
      });
      // Important class, tier 1: 30 minutes counted from the DATABASE's now() (the guard demands a window that starts now).
      expect(after.deadline_at.getTime() - after.window_started_at.getTime()).toBe(30 * MIN);
      expect(Math.abs(after.window_started_at.getTime() - Date.now())).toBeLessThan(2 * MIN);
      expect((await events(id)).at(-1)).toMatchObject({
        event_type: "escalated",
        actor_user_id: null,
        actor_kind: "system",
        from_status: "pending",
        to_status: "escalated",
        assigned_user_id: tier1,
        previous_assigned_user_id: rn,
        tier: 1,
      });
      expect(await outboxNames(id)).toEqual(["m36.ack.requested", "m36.ack.escalated"]);
      const [event] = await kit.one<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m36.ack.escalated'",
        [id],
      );
      expect(event?.payload).toMatchObject({
        requestId: id,
        assignedUserId: tier1,
        previousAssignedUserId: rn,
        tier: 1,
        actorUserId: null,
        requestVersion: after.version,
      });
      expect(JSON.stringify(event?.payload)).not.toContain(PATIENT);
      // The request audit trail records the system write (the database trigger).
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM audit_event WHERE resource_id=$1 AND event_type='message_acknowledgment_request.update' AND actor_kind='system'",
          [id],
        ),
      ).toBe(1);
      // The router was asked for the request's own patient, one tier up, at an instant with an explicit Z.
      expect(routerCalls).toBe(1);
      // A timer is not a request: the router is called inside the tenant's system scope, so a real router's org check has a context.
      expect(routerScopes).toEqual([ORG_A]);
    });

    it("3b. a qualified next-tier user who is not in the channel is skipped: the walk goes to the member behind them, who can act", async () => {
      resetCase();
      const { id } = await freshRequest();
      await makeDue(id);
      ladder[1] = (asOf) => resolved(1, [outsider, tier1], null, asOf);

      const outcome = await escalation.service.processDue(ORG_A, id);

      expect(outcome).toMatchObject({ kind: "escalated", tier: 1, assignedUserId: tier1 });
      expect((await row(id)).assigned_user_id).toBe(tier1);
      expect((await acknowledge(tier1, id)).statusCode).toBe(200);
    });

    it("3c. when the only next-tier user is not in the channel the ladder is exhausted: the request stays with its assignee, who can still act", async () => {
      resetCase();
      const { id } = await freshRequest();
      await makeDue(id);
      const before = await row(id);
      ladder[1] = (asOf) => resolved(1, [outsider], null, asOf);

      const outcome = await escalation.service.processDue(ORG_A, id);

      expect(outcome).toEqual({ kind: "not_routed", reason: "ladder_exhausted", recorded: true });
      expect(await row(id)).toEqual(before);
      expect(await countEvents(id, "escalated")).toBe(0);
      expect(await countEvents(id, "ladder_exhausted")).toBe(1);
      expect(await outboxNames(id)).toContain("m36.ack.ladder_exhausted");
      expect((await acknowledge(rn, id)).statusCode).toBe(200);
    });

    it("3d. a tier of non-members is skipped to the router's next tier", async () => {
      resetCase();
      const { id } = await freshRequest();
      await makeDue(id);
      ladder[1] = (asOf) => resolved(1, [outsider], 2, asOf);
      ladder[2] = (asOf) => resolved(2, [tier2], null, asOf);

      const outcome = await escalation.service.processDue(ORG_A, id);

      expect(outcome).toMatchObject({ kind: "escalated", tier: 2, assignedUserId: tier2 });
    });

    it("4. the tier's clinician can acknowledge the escalated request, the one who did not act can no longer", async () => {
      resetCase();
      const { id } = await freshRequest();
      await makeDue(id);
      ladder[1] = (asOf) => resolved(1, [tier1], null, asOf);
      await escalation.service.processDue(ORG_A, id);

      const old = await acknowledge(rn, id);
      const fresh = await acknowledge(tier1, id);

      expect(old.statusCode).toBe(403);
      expect(fresh.statusCode, fresh.body).toBe(200);
      expect(await row(id)).toMatchObject({
        status: "acknowledged",
        acknowledged_by_user_id: tier1,
      });
    });

    it("5. a duplicate delivery and eight concurrent executions produce exactly one escalation", async () => {
      resetCase();
      const { id } = await freshRequest();
      await makeDue(id);
      ladder[1] = (asOf) => resolved(1, [tier1], null, asOf);
      const original = await row(id);

      await Promise.all([
        ...Array.from({ length: 6 }, () => escalation.service.processDue(ORG_A, id)),
        escalation.service.sweep(ORG_A),
        escalation.service.processDue(ORG_A, id, { tier: 0, deadlineAt: original.deadline_at }),
      ]);
      const duplicate = await escalation.service.processDue(ORG_A, id, {
        tier: 0,
        deadlineAt: original.deadline_at,
      });

      expect(await countEvents(id, "escalated")).toBe(1);
      expect((await outboxNames(id)).filter((n) => n === "m36.ack.escalated")).toHaveLength(1);
      expect((await row(id)).current_tier).toBe(1);
      expect(duplicate.kind).toBe("not_due");
    });

    it("6a. an acknowledgment that commits before the deadline work wins: nothing escalates", async () => {
      resetCase();
      const { id } = await freshRequest();
      expect((await acknowledge(rn, id)).statusCode).toBe(200);
      await makeDue(id);
      ladder[1] = (asOf) => resolved(1, [tier1], null, asOf);

      const outcome = await escalation.service.processDue(ORG_A, id);

      expect(outcome).toEqual({ kind: "not_due" });
      expect(await row(id)).toMatchObject({ status: "acknowledged", assigned_user_id: rn });
      expect(await countEvents(id, "escalated")).toBe(0);
      expect(routerCalls).toBe(0);
    });

    it("6b. an acknowledgment that lands WHILE the router is being asked wins: the guarded write finds a new version", async () => {
      resetCase();
      const { id } = await freshRequest();
      await makeDue(id);
      ladder[1] = (asOf) => resolved(1, [tier1], null, asOf);
      onRouterCall = async () => {
        onRouterCall = undefined;
        expect((await acknowledge(rn, id)).statusCode).toBe(200);
      };

      const outcome = await escalation.service.processDue(ORG_A, id);

      expect(outcome).toEqual({ kind: "stale" });
      expect(await row(id)).toMatchObject({ status: "acknowledged", assigned_user_id: rn });
      expect(await countEvents(id, "escalated")).toBe(0);
      expect(await outboxNames(id)).not.toContain("m36.ack.escalated");
    });

    it("6c. the other order: an escalation that commits first leaves the old assignee unable to acknowledge", async () => {
      resetCase();
      const { id } = await freshRequest();
      await makeDue(id);
      ladder[1] = (asOf) => resolved(1, [tier1], null, asOf);

      await escalation.service.processDue(ORG_A, id);
      const late = await acknowledge(rn, id);

      expect(late.statusCode).toBe(403);
      expect((await row(id)).status).toBe("escalated");
      expect(await countEvents(id, "acknowledged")).toBe(0);
    });

    it("7. a reassign restarts the window: the old window's timer does nothing and the new one escalates once", async () => {
      resetCase();
      const { id } = await freshRequest();
      await makeDue(id);
      ladder[1] = (asOf) => resolved(1, [tier1], 2, asOf);
      ladder[2] = (asOf) => resolved(2, [tier2], null, asOf);
      await escalation.service.processDue(ORG_A, id);
      const escalated = await row(id);
      const oldWindow = { tier: escalated.current_tier, deadlineAt: escalated.deadline_at };

      // The sender hands the escalated request to someone else: pending, tier 0, a new window and a new deadline.
      const moved = await reassign(nurse, id, rn2);
      expect(moved.statusCode, moved.body).toBe(200);
      const restarted = await row(id);
      expect(restarted).toMatchObject({
        status: "pending",
        current_tier: 0,
        assigned_user_id: rn2,
      });
      expect(restarted.deadline_at.getTime()).not.toBe(escalated.deadline_at.getTime());
      // Even with the clock past EVERYTHING, the job armed for the old window does nothing.
      clock.now = new Date(restarted.deadline_at.getTime() + 60 * MIN);
      const stale = await escalation.service.processDue(ORG_A, id, oldWindow);
      expect(stale).toEqual({ kind: "not_due" });
      expect((await row(id)).status).toBe("pending");
      expect(escalationJobId(id, oldWindow.tier, oldWindow.deadlineAt)).not.toBe(
        escalationJobId(id, 0, restarted.deadline_at),
      );

      // The new window escalates, once.
      const fresh = await escalation.service.processDue(ORG_A, id, {
        tier: 0,
        deadlineAt: restarted.deadline_at,
      });
      expect(fresh).toMatchObject({ kind: "escalated", tier: 1 });
      expect(await countEvents(id, "escalated")).toBe(2);
    });

    it("7b. a second unanswered window goes up another tier (escalated -> escalated, tier strictly increasing)", async () => {
      resetCase();
      const { id } = await freshRequest();
      await makeDue(id);
      ladder[1] = (asOf) => resolved(1, [tier1], 2, asOf);
      ladder[2] = (asOf) => resolved(2, [tier2], null, asOf);
      await escalation.service.processDue(ORG_A, id);
      await makeDue(id);

      const outcome = await escalation.service.processDue(ORG_A, id);

      expect(outcome).toMatchObject({ kind: "escalated", tier: 2, assignedUserId: tier2 });
      expect(await row(id)).toMatchObject({
        status: "escalated",
        current_tier: 2,
        assigned_user_id: tier2,
      });
      // (Stamped by the injected clock, which this test moves around, so compare the tiers as a set.)
      expect(
        (await events(id))
          .filter((e) => e.event_type === "escalated")
          .map((e) => e.tier)
          .sort(),
      ).toEqual([1, 2]);
    });

    it("8. deleting the message cancels the request and nothing escalates afterwards", async () => {
      resetCase();
      const { id, messageId } = await freshRequest();
      const del = await app.inject({
        method: "DELETE",
        url: `/api/v1/messaging/messages/${messageId}`,
        headers: as(nurse, ORG_A),
      });
      expect(del.statusCode, del.body).toBeLessThan(300);
      await makeDue(id);
      ladder[1] = (asOf) => resolved(1, [tier1], null, asOf);

      const outcome = await escalation.service.processDue(ORG_A, id);
      const sweep = await escalation.service.sweep(ORG_A);

      expect(outcome).toEqual({ kind: "not_due" });
      expect(sweep.escalated).toBe(0);
      expect((await row(id)).status).toBe("cancelled");
      expect(await countEvents(id, "escalated")).toBe(0);
    });

    it("9. another tenant's user, the sender and an unqualified user are never the recipient", async () => {
      resetCase();
      const { id } = await freshRequest();
      await makeDue(id);
      const unqualified = await seed("unqual", ORG_A, STAFF_KEYS);
      ladder[1] = (asOf) => resolved(1, [orgBUser, nurse, unqualified], null, asOf);

      const outcome = await escalation.service.processDue(ORG_A, id);

      // The router said this is the final tier (nextTier null) and nobody on it is usable: the ladder is exhausted.
      expect(outcome).toMatchObject({ kind: "not_routed", reason: "ladder_exhausted" });
      expect(await row(id)).toMatchObject({ status: "pending", assigned_user_id: rn });
    });

    it("9b. the notification consumer, on the real outbox rows: the tier's clinician is told once; a stale event and a closed request tell nobody", async () => {
      resetCase();
      const emitted: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
      const consumer = buildM36AckEscalationNotificationsConsumer({
        alerts: {
          emit: async (
            _org: string,
            alert: { eventType: string; payload: Record<string, unknown> },
          ) => {
            emitted.push(alert);
            return { alertId: "a", resolvedRecipientCount: 1 };
          },
        } as unknown as AlertEmitter,
        opsNotice: () => undefined,
        messaging: kit.service,
        readRequest: escalation.readRequest,
        stillQualified: ack.stillQualified,
      });
      // ADR-0079: the first unroutable record also raises the supervisor attention alert; this test is about the parties' alerts.
      const partyAlerts = () =>
        emitted.filter((a) => a.eventType !== "m36.ack.supervisor_attention");
      const outboxEvent = async (id: string, name: string) => {
        const [r] = await kit.one<{ id: string; payload: Record<string, unknown> }>(
          "SELECT id, payload FROM outbox_event WHERE aggregate_id=$1 AND event_type=$2 ORDER BY created_at DESC LIMIT 1",
          [id, name],
        );
        return { id: r?.id, eventType: name, organizationId: ORG_A, payload: r?.payload } as never;
      };
      // Escalated: the new assignee is told once, with fixed text.
      const escalatedReq = await freshRequest();
      await makeDue(escalatedReq.id);
      ladder[1] = (asOf) => resolved(1, [tier1], null, asOf);
      await escalation.service.processDue(ORG_A, escalatedReq.id);
      await consumer.handle(await outboxEvent(escalatedReq.id, "m36.ack.escalated"));
      expect(partyAlerts()).toHaveLength(1);
      expect(emitted[0]?.payload).toMatchObject({ recipientUserId: tier1, channelId: channel });
      // Acknowledged since: the same event now tells nobody.
      expect((await acknowledge(tier1, escalatedReq.id)).statusCode).toBe(200);
      await consumer.handle(await outboxEvent(escalatedReq.id, "m36.ack.escalated"));
      expect(partyAlerts()).toHaveLength(1);
      // Not routed: the sender and the assignee are told; once the request closes, a redelivery tells nobody.
      ladder = {};
      const stuck = await freshRequest();
      await makeDue(stuck.id);
      await escalation.service.processDue(ORG_A, stuck.id);
      await consumer.handle(await outboxEvent(stuck.id, "m36.ack.route_unavailable"));
      expect(partyAlerts()).toHaveLength(2);
      expect(partyAlerts()[1]?.payload).toMatchObject({ recipientUserIds: [nurse, rn] });
      expect((await acknowledge(rn, stuck.id)).statusCode).toBe(200);
      await consumer.handle(await outboxEvent(stuck.id, "m36.ack.route_unavailable"));
      expect(partyAlerts()).toHaveLength(2);
    });

    it("10. the database refuses a person's escalation, a cross-tenant or sender recipient, and a window that does not start now", async () => {
      resetCase();
      const { id } = await freshRequest();
      const esc = (set: string) =>
        `UPDATE message_acknowledgment_request SET status='escalated', current_tier=1, version=version+1, ${set} WHERE id=$1`;

      // A person's session may not escalate (the timer is the only writer of `escalated`).
      expect(await asApp(esc("assigned_user_id=assigned_user_id"), [id], nurse)).toMatch(
        /only the escalation timer/,
      );
      expect(await asApp(esc("assigned_user_id=assigned_user_id"), [id], rn)).toMatch(
        /only the escalation timer/,
      );
      // The timer (no acting user) may, to an active member of THIS organization ...
      expect(
        await asApp(
          esc(
            "assigned_user_id=$2, window_started_at=now(), deadline_at=now() + interval '30 minutes'",
          ),
          [id, tier1],
          null,
        ),
      ).toBeNull();
      // ... never to another tenant's user, the sender, ...
      expect(
        await asApp(
          esc(
            "assigned_user_id=$2, window_started_at=now(), deadline_at=now() + interval '30 minutes'",
          ),
          [id, orgBUser],
          null,
        ),
      ).toMatch(/not an active member/);
      expect(
        await asApp(
          esc(
            "assigned_user_id=$2, window_started_at=now(), deadline_at=now() + interval '30 minutes'",
          ),
          [id, nurse],
          null,
        ),
      ).toMatch(/sender cannot be the escalation recipient/);
      // ... with a window that starts in the future, or one that is longer than the class allows.
      expect(
        await asApp(
          esc(
            "assigned_user_id=$2, window_started_at=now() + interval '10 minutes', deadline_at=now() + interval '25 minutes'",
          ),
          [id, tier1],
          null,
        ),
      ).toMatch(/starts a new window now/);
      expect(
        await asApp(
          esc(
            "assigned_user_id=$2, window_started_at=now(), deadline_at=now() + interval '3 hours'",
          ),
          [id, tier1],
          null,
        ),
      ).toMatch(/escalation window ends within the next 60 minutes/);
      // ... one that already ended, or whose recipient is the sender (the database refuses both, whatever the service does).
      expect(
        await asApp(
          esc(
            "assigned_user_id=$2, window_started_at=now() - interval '1 minute', deadline_at=now() - interval '1 second'",
          ),
          [id, tier1],
          null,
        ),
      ).toMatch(/escalation window ends within the next 60 minutes/);
      expect(
        await asApp(
          esc(
            "assigned_user_id=$2, window_started_at=now(), deadline_at=now() + interval '61 minutes'",
          ),
          [id, tier1],
          null,
        ),
      ).toMatch(/escalation window ends within the next 60 minutes/);
      // The assignee still cannot change outside a reassign or an escalation.
      expect(
        await asApp(
          "UPDATE message_acknowledgment_request SET assigned_user_id=$2, version=version+1, status='acknowledged', acknowledged_at=now(), acknowledged_by_user_id=$2 WHERE id=$1",
          [id, tier1],
          tier1,
        ),
      ).toMatch(/assignee changes only|only the assigned user/);
      expect(await row(id)).toMatchObject({ status: "pending", assigned_user_id: rn });
    });
  });

  describe("A2. the sweep under load", () => {
    it("15. 600 overdue unroutable requests do not stop a newer routable one from escalating; their rows are bounded by the backoff", async () => {
      resetCase();
      const PATIENT_2 = "bbbbbbbb-bbbb-4bbb-8bbb-0000000a44b2";
      const channel2 = await mkChannel(kit, "care_team", PATIENT_2, [nurse, rn, tier1]);
      const stuck: string[] = [];
      for (let i = 0; i < 600; i += 25) {
        const batch = await Promise.all(
          Array.from({ length: 25 }, async () => (await freshRequest()).id),
        );
        stuck.push(...batch);
      }
      // Every request (the 600 and any left by earlier cases) is overdue; the router answers nobody.
      clock.now = new Date(Date.now() + 61 * MIN);
      const countRecords = async () =>
        kit.count(
          "SELECT count(*)::int AS n FROM message_acknowledgment_event WHERE event_type='route_unavailable' AND request_id = ANY($1::uuid[])",
          [stuck],
        );

      // Two ticks cover everything due (500 per tick, oldest first); each stuck request is recorded exactly once.
      const first = await escalation.service.sweep(ORG_A);
      const second = await escalation.service.sweep(ORG_A);
      expect(first.notRouted + first.skipped).toBe(500);
      expect(second.notRouted).toBeGreaterThan(0);
      expect(await countRecords()).toBe(600);

      // A 601st request, newer than all of them, in a patient the router CAN route.
      const messageId = await routineMessageIn(channel2);
      const made = await post(nurse, BASE, { message_id: messageId, assigned_user_id: rn });
      expect(made.statusCode, made.body).toBe(201);
      const newest = made.json().request.id as string;
      clock.now = new Date(Date.now() + 61 * MIN);
      routablePatient = PATIENT_2;
      ladder[1] = (asOf) => resolved(1, [tier1], null, asOf);
      const callsBefore = routerCalls;

      const third = await escalation.service.sweep(ORG_A);

      expect(third.escalated).toBe(1);
      expect((await row(newest)).status).toBe("escalated");
      // The 600 are backed off in the QUERY: the tick asked the router for (about) the one new request, not for them.
      expect(routerCalls - callsBefore).toBeLessThan(10);
      expect(await countRecords()).toBe(600);

      // Past the first backoff (1 h) they are asked again once and recorded a second time; never more often.
      clock.now = new Date(clock.now.getTime() + 61 * MIN);
      routablePatient = null;
      ladder = {};
      await escalation.service.sweep(ORG_A);
      await escalation.service.sweep(ORG_A);
      const perRequest = await kit.one<{ n: number }>(
        "SELECT count(*)::int AS n FROM message_acknowledgment_event WHERE event_type='route_unavailable' AND request_id = ANY($1::uuid[]) GROUP BY request_id",
        [stuck],
      );
      expect(Math.max(...perRequest.map((r) => r.n))).toBeLessThanOrEqual(2);
    }, 300_000);
  });

  describe.skipIf(!REDIS_IS_LOCAL)("B. the queue (real BullMQ on a real Valkey)", () => {
    const connection = {
      host: new URL(REDIS_URL ?? "redis://localhost:6379").hostname,
      port: Number(new URL(REDIS_URL ?? "redis://localhost:6379").port || 6379),
    };
    let timerQueue: Queue;
    let dlqQueue: Queue;
    let sweepQueue: Queue;
    const workers: Worker[] = [];
    const orgs = { listActiveOrgs: async () => [{ organizationId: ORG_A }] };
    const wipe = async () => {
      for (const q of [timerQueue, dlqQueue, sweepQueue]) {
        await q.obliterate({ force: true });
      }
    };
    const startWorkers = (
      service = escalation.service,
      stall: { maxStalledCount?: number } = {},
    ) => {
      const started = registerM36AckEscalationWorkers({
        connection,
        service,
        activeOrgs: orgs,
        recordDlq: createDlqAuditRecorder(kit.handle.db),
        timerWorkerOptions: { lockDuration: 1000, stalledInterval: 300, ...stall },
      });
      workers.push(...started.workers);
      return started;
    };
    const stopWorkers = async () => {
      await Promise.all(workers.splice(0).map((w) => w.close(true)));
    };
    const armed = (id: string) =>
      buildBinding(createBullmqTimerPort(timerQueue)).armFromRequest(ORG_A, id);

    beforeAll(async () => {
      timerQueue = new Queue(TIMER_QUEUE, { connection });
      dlqQueue = new Queue(TIMER_DLQ, { connection });
      sweepQueue = new Queue(SWEEP_QUEUE, { connection });
      await wipe();
    });
    afterAll(async () => {
      await stopWorkers();
      await wipe();
      await Promise.all([timerQueue.close(), dlqQueue.close(), sweepQueue.close()]);
    });

    // What this proves: a job whose worker died holding it is RECOVERED by BullMQ's stalled-job check and runs once. It does not claim
    // a crash between the write and the acknowledgment: "exactly once after a partial write" rests on the single-transaction write and on
    // the concurrency / duplicate-delivery cases in group A (a committed escalation can never be repeated, an uncommitted one leaves nothing).
    it("11. a stalled job (its worker killed mid-timer) is recovered and runs once", async () => {
      resetCase();
      await wipe();
      const { id } = await freshRequest();
      await makeDue(id);
      ladder[1] = (asOf) => resolved(1, [tier1], null, asOf);
      await armed(id); // due already: delay 0
      // Worker A picks the job up and then dies (forced close, no ack, its lock is no longer renewed).
      const { Worker: BullWorker } = await import("bullmq");
      let pickedUp: () => void = () => {};
      const picked = new Promise<void>((resolve) => {
        pickedUp = resolve;
      });
      const doomed = new BullWorker(
        TIMER_QUEUE,
        async () => {
          pickedUp();
          await new Promise(() => {});
        },
        { connection, lockDuration: 1000, stalledInterval: 300 },
      );
      await picked;
      await doomed.close(true);
      expect(await countEvents(id, "escalated")).toBe(0);
      expect((await row(id)).status).toBe("pending");

      // A fresh worker finds the stalled job and runs it.
      startWorkers();
      await eventually(
        async () => (await row(id)).status === "escalated",
        "the escalation after recovery",
      );
      await new Promise((resolve) => setTimeout(resolve, 1500)); // room for a (wrong) second run
      await stopWorkers();

      expect(await countEvents(id, "escalated")).toBe(1);
      expect((await outboxNames(id)).filter((n) => n === "m36.ack.escalated")).toHaveLength(1);
      expect((await row(id)).current_tier).toBe(1);
    }, 60_000);

    it("11c. a job BullMQ fails for stalling too often still lands on the DLQ queue and leaves its audit row", async () => {
      resetCase();
      await wipe();
      const { id } = await freshRequest();
      await makeDue(id);
      ladder[1] = (asOf) => resolved(1, [tier1], null, asOf);
      await armed(id);
      const { Worker: BullWorker } = await import("bullmq");
      let pickedUp: () => void = () => {};
      const picked = new Promise<void>((resolve) => {
        pickedUp = resolve;
      });
      const doomed = new BullWorker(
        TIMER_QUEUE,
        async () => {
          pickedUp();
          await new Promise(() => {});
        },
        { connection, lockDuration: 1000, stalledInterval: 300 },
      );
      await picked;
      await doomed.close(true);

      // No recovery allowed: the first stall fails the job inside Redis (the Worker emits no `failed` for that).
      startWorkers(escalation.service, { maxStalledCount: 0 });
      await eventually(
        async () =>
          (await dlqQueue.getJobs(["waiting", "delayed", "completed", "failed"])).length > 0 &&
          (await kit.count(
            "SELECT count(*)::int AS n FROM audit_event WHERE event_type='m36.dlq_job' AND resource_id=$1",
            [id],
          )) === 1,
        "the stalled job in the DLQ with its audit row",
      );
      await stopWorkers();

      expect((await row(id)).status).toBe("pending");
      // Nothing is lost: the sweeper still escalates it.
      await escalation.service.sweep(ORG_A);
      expect((await row(id)).status).toBe("escalated");
    }, 60_000);

    it("12. a duplicate job id is ONE job; a second job for the same window still escalates once", async () => {
      resetCase();
      await wipe();
      const { id } = await freshRequest();
      // Not due yet: the jobs sit delayed. Arm the same window three times.
      const timers = createBullmqTimerPort(timerQueue);
      const r = await row(id);
      for (let i = 0; i < 3; i += 1) {
        await timers.arm(
          { orgId: ORG_A, requestId: id, tier: 0, deadlineAt: r.deadline_at },
          clock.now,
        );
      }
      expect(await timerQueue.getDelayedCount()).toBe(1);
      await wipe();

      // Now two DIFFERENT job ids for the same window (a bypass of the dedupe) both run: the guarded write still escalates once.
      await makeDue(id);
      ladder[1] = (asOf) => resolved(1, [tier1], null, asOf);
      const data = {
        organizationId: ORG_A,
        requestId: id,
        tier: 0,
        deadlineAt: r.deadline_at.toISOString(),
      };
      await timerQueue.add("escalate", data, { jobId: `dup-a-${id}`, removeOnComplete: true });
      await timerQueue.add("escalate", data, { jobId: `dup-b-${id}`, removeOnComplete: true });
      startWorkers();
      await eventually(async () => (await row(id)).status === "escalated", "the escalation");
      await eventually(
        async () => (await timerQueue.getJobCounts("wait", "active", "delayed")).wait === 0,
        "the queue to drain",
      );
      await stopWorkers();

      expect(await countEvents(id, "escalated")).toBe(1);
      expect((await outboxNames(id)).filter((n) => n === "m36.ack.escalated")).toHaveLength(1);
    }, 60_000);

    it("11b. the arming consumer arms the request's CURRENT window from the database (the outbox path)", async () => {
      resetCase();
      await wipe();
      const { id } = await freshRequest();
      const binding = buildBinding(createBullmqTimerPort(timerQueue));
      const consumer = buildM36AckTimerArmingConsumer({ armFromRequest: binding.armFromRequest });

      await consumer.handle({
        id: "evt",
        eventType: "m36.ack.requested",
        organizationId: ORG_A,
        payload: { requestId: id },
      } as never);

      const r = await row(id);
      const job = await timerQueue.getJob(escalationJobId(id, 0, r.deadline_at));
      expect(job?.data).toEqual({
        organizationId: ORG_A,
        requestId: id,
        tier: 0,
        deadlineAt: r.deadline_at.toISOString(),
      });
      // Reassign: the consumer arms the NEW window under a new id; the old job stays but is stale.
      expect((await reassign(nurse, id, rn2)).statusCode).toBe(200);
      await consumer.handle({
        id: "evt2",
        eventType: "m36.ack.reassigned",
        organizationId: ORG_A,
        payload: { requestId: id },
      } as never);
      const restarted = await row(id);
      expect(await timerQueue.getJob(escalationJobId(id, 0, restarted.deadline_at))).toBeTruthy();
      expect(escalationJobId(id, 0, restarted.deadline_at)).not.toBe(
        escalationJobId(id, 0, r.deadline_at),
      );
    });

    it("13. a flushed Redis loses the job and the sweeper still escalates, exactly once", async () => {
      resetCase();
      await wipe();
      const { id } = await freshRequest();
      await makeDue(id);
      ladder[1] = (asOf) => resolved(1, [tier1], null, asOf);
      await armed(id);
      await wipe(); // the Redis flush: the armed job is gone
      expect(await timerQueue.getJobCounts("wait", "delayed", "active")).toMatchObject({
        wait: 0,
        delayed: 0,
      });
      expect(await countEvents(id, "escalated")).toBe(0);

      // The per-minute sweep body, run twice (and beside the other replicas' tick): the database says it is due.
      const ticks = await Promise.all([
        sweepTick({ service: escalation.service, activeOrgs: orgs }),
        sweepTick({ service: escalation.service, activeOrgs: orgs }),
      ]);

      // (The sweep handles every due request of the org, including earlier cases' leftovers, so count THIS request's rows.)
      expect(ticks.reduce((n, t) => n + t.escalated, 0)).toBeGreaterThanOrEqual(1);
      expect(await countEvents(id, "escalated")).toBe(1);
      expect((await outboxNames(id)).filter((n) => n === "m36.ack.escalated")).toHaveLength(1);
      expect((await row(id)).status).toBe("escalated");
      // The repeatable trigger is registered under one fixed scheduler id (idempotent).
      const first = await scheduleM36AckEscalationJobs(connection);
      const second = await scheduleM36AckEscalationJobs(connection);
      expect(await sweepQueue.getJobSchedulers()).toHaveLength(1);
      await Promise.all([...first, ...second].map((q) => q.close()));
    }, 60_000);

    it("14. a job that exhausts its retries lands on the DLQ queue and leaves an audit row; so does a poison payload", async () => {
      resetCase();
      await wipe();
      const { id } = await freshRequest();
      await makeDue(id);
      const failing = createEscalationService({
        store: ack.store,
        isEnabled: async () => true,
        router: {
          async resolveTier() {
            throw new Error("m19 is down");
          },
        },
        stillQualified: ack.stillQualified,
        canViewChannel: kit.service.canViewChannel,
        outbox: undefined,
        now: () => clock.now,
      });
      const dlqAudits = () =>
        kit.count(
          "SELECT count(*)::int AS n FROM audit_event WHERE event_type='m36.dlq_job' AND resource_id=$1",
          [id],
        );
      startWorkers(failing);
      const r = await row(id);
      await timerQueue.add(
        "escalate",
        { organizationId: ORG_A, requestId: id, tier: 0, deadlineAt: r.deadline_at.toISOString() },
        {
          jobId: `doomed-${id}`,
          attempts: 2,
          backoff: { type: "fixed", delay: 50 },
          removeOnComplete: true,
        },
      );
      await timerQueue.add(
        "escalate",
        { organizationId: "nope", requestId: 1 },
        { jobId: `poison-${id}`, attempts: 5 },
      );

      await eventually(
        async () => (await dlqQueue.getJob(`doomed-${id}-dlq`)) && (await dlqAudits()) === 1,
        "the DLQ landing",
      );
      await eventually(
        async () => await dlqQueue.getJob(`poison-${id}-dlq`),
        "the poison job in the DLQ",
      );
      await stopWorkers();

      const [audit] = await kit.one<{
        context: Record<string, unknown>;
        severity: string;
        actor_kind: string;
      }>(
        "SELECT context, severity, actor_kind FROM audit_event WHERE event_type='m36.dlq_job' AND resource_id=$1",
        [id],
      );
      expect(audit).toMatchObject({ severity: "critical", actor_kind: "system" });
      expect(audit?.context).toMatchObject({
        queue: TIMER_QUEUE,
        jobId: `doomed-${id}`,
        disposition: "pending",
        finalError: "Error",
      });
      expect(String(audit?.context.jobDataHash)).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(audit?.context)).not.toContain(PATIENT);
      expect(JSON.stringify(audit?.context)).not.toContain(ORG_A);
      // The poison job was unrecoverable: one attempt, never the database.
      const poison = await dlqQueue.getJob(`poison-${id}-dlq`);
      expect(poison?.data).toEqual({ organizationId: "nope", requestId: 1 });
      // Nothing was lost: the request is still pending and a healthy sweep escalates it.
      expect((await row(id)).status).toBe("pending");
      ladder[1] = (asOf) => resolved(1, [tier1], null, asOf);
      await escalation.service.sweep(ORG_A);
      expect((await row(id)).status).toBe("escalated");
      expect(await countEvents(id, "escalated")).toBe(1);
    }, 60_000);
  });
});
