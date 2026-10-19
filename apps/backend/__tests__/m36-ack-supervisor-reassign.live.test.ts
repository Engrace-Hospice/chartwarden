/**
 * M36 ADR-0078 - the reassign picker (G-6) and the supervisor reassign (G-2), LIVE Postgres as the NOBYPASSRLS `wardenx_app` role.
 *
 * The real route stack (Authorization Contract, DB ack store, the migration-1126 update guard, the audit triggers, the M1 idempotency
 * store, the real catalog-validating outbox publisher, the real notification consumer) over a supervisor who is NOT a channel member.
 *
 *   1. PICKER      the card's candidate list holds only eligible colleagues (ids and names); party and visibility rules hold.
 *   2. SUPERVISOR  moves pending / escalated / failed_unreachable requests back to pending (tier 0, new window), actor and reason recorded,
 *                  no channel / message / patient id in the answer; refuses acknowledged, resolved, cancelled; ineligible targets are one 422.
 *   3. ACCESS      401 / 403 / 404 (other tenant) / 400 (no key) / 422 (bad or free-text reason); a supervisor can acknowledge nothing.
 *   4. DB GUARD    the marker allows only the reassign of a waiting request by a non-party; everything else stays refused; the reason CHECK.
 *   5. NOTIFY      the real consumer tells the new assignee, the previous assignee and the sender (not the supervisor), generically.
 *   6. QUEUE       the unacknowledged queue carries the sender's name and `request_ref` on a restricted row, and the handle works.
 *   7. LIMITS      replay with a new key is a no-op success; the pair limiter answers 429.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m36:ack-supervisor-reassign:live
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
import {
  type AlertEmitter,
  PLATFORM_DEFAULT_ALERT_RULES,
  createAlertEmitter,
  toNewAlertRuleRows,
} from "@wardenx/messaging";
import type { AckQueueResponse } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDrizzleFeatureFlagReader } from "../src/bootstrap/feature-flag-store";
import { buildServer } from "../src/bootstrap/index";
import { buildAckRateLimit } from "../src/bootstrap/plugins/ack-rate-limit";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { createInMemoryRateLimitStore } from "../src/bootstrap/plugins/rate-limit-store";
import { buildAckDeps } from "../src/modules/36-messaging/ack-requests/deps";
import { createDbUnacknowledgedReader } from "../src/modules/36-messaging/ack-requests/unacknowledged-reader-db";
import { createUnacknowledgedService } from "../src/modules/36-messaging/ack-requests/unacknowledged-service";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import {
  CHANNEL_VISIBILITY_PREDICATE,
  createDrizzleAlertEmitterPorts,
} from "../src/modules/36-messaging/index";
import { createMentionActorNameResolver } from "../src/modules/36-messaging/mention-non-member-service-db";
import { buildM36AckNotificationsConsumer } from "../src/modules/36-messaging/outbox-consumers/ack-notifications";
import { createPart2ChannelGate } from "../src/modules/36-messaging/part2-channel-gate";
import { registerMessagingRoutes } from "../src/modules/36-messaging/routes/messaging-routes";
import {
  type LiveKit,
  STAFF_KEYS,
  as,
  bootLiveKit,
  catalogOutbox,
  errorCode,
  headerAuth,
  mkChannel,
} from "./_m36-handoff-live-kit";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-11110a780001";
const ORG_B = "22222222-2222-4222-8222-22220a780002";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a78a1";
const PATIENT_2 = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a78a2";
const BASE = "/api/v1/messaging/escalations";
const SEND_KEYS = [...STAFF_KEYS, "messaging.urgent.send"];
const RECEIVE_KEYS = [...STAFF_KEYS, "messaging.urgent.receive"];
const SUPERVISOR_KEYS = [...STAFF_KEYS, "messaging.review"];
const REASONS = [
  "assignee_unreachable",
  "assignee_unable_to_sign_in",
  "assignee_off_shift",
  "coverage_change",
  "workload",
  "other_operational",
];

describe.skipIf(!DB_URL)("M36 ADR-0078 supervisor reassign - LIVE Postgres", () => {
  let kit: LiveKit;
  let app: FastifyInstance;
  let limitedApp: FastifyInstance;
  let realGateApp: FastifyInstance;
  let ack: ReturnType<typeof buildAckDeps>;
  let nurse: string;
  let rn: string;
  let rn2: string;
  let rn3: string;
  let unqualified: string;
  let outsider: string;
  let part2Blocked: string;
  let walled: string;
  let supervisor: string;
  let plain: string;
  let reviewOnly: string;
  let supervisorB: string;
  let rnB: string;
  let channel: string;
  let channel2: string;
  let careTeam: string[] = [];
  const keysOf = new Map<string, readonly string[]>();

  const seed = async (suffix: string, org: string, keys: string[]) => {
    const id = await kit.seedUser(suffix, org, keys);
    keysOf.set(id, keys);
    return id;
  };

  const makeServer = (limited: boolean, realGate?: ReturnType<typeof createPart2ChannelGate>) => {
    const server = buildServer({
      db: kit.handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: createDbIdempotencyStore(kit.handle.db),
    });
    const binding = buildAckDeps({
      db: kit.handle.db,
      flags: { forOrg: async () => ({ "messaging.ack_requests": true }) },
      outbox: catalogOutbox() as never,
      messaging: kit.service,
      permissionsFor: async (_org, userId) => new Set(keysOf.get(userId) ?? []),
      part2Gate: realGate ?? {
        allowedUserIds: async ({ userIds }: { userIds: readonly string[] }) =>
          new Set(userIds.filter((u) => u !== part2Blocked && u !== walled)),
      },
      careTeamMembers: async () => careTeam,
    });
    if (!limited) ack = binding;
    registerMessagingRoutes(server, {
      service: kit.service,
      announcements: createDbAnnouncementService(kit.handle.db),
      ackRequests: {
        service: binding.service,
        ...(limited ? { rateLimit: buildAckRateLimit(createInMemoryRateLimitStore()) } : {}),
      },
      unacknowledged: {
        service: createUnacknowledgedService({
          read: createDbUnacknowledgedReader(kit.handle.db),
          canViewChannel: kit.service.canViewChannel,
          displayName: createMentionActorNameResolver(kit.handle.db),
        }),
      },
    });
    return server;
  };

  const post = (
    server: FastifyInstance,
    user: string,
    url: string,
    payload: Record<string, unknown> = {},
    opts: { org?: string; key?: string | null } = {},
  ) =>
    server.inject({
      method: "POST",
      url,
      headers: as(
        user,
        opts.org ?? ORG_A,
        opts.key === null ? undefined : (opts.key ?? randomUUID()),
      ),
      payload,
    });
  const get = (server: FastifyInstance, user: string, url: string, org = ORG_A) =>
    server.inject({ method: "GET", url, headers: as(user, org) });

  const message = async (author: string, ch = channel) => {
    const res = await post(app, author, `/api/v1/messaging/channels/${ch}/messages`, {
      body: `routine note ${randomUUID().slice(0, 8)}`,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().messageId as string;
  };
  const fresh = async (assignee = rn, ch = channel) => {
    const res = await post(app, nurse, BASE, {
      message_id: await message(nurse, ch),
      assigned_user_id: assignee,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().request.id as string;
  };
  const supervise = (
    id: string,
    to: string,
    reason = "assignee_unreachable",
    user = supervisor,
    server = app,
    org = ORG_A,
  ) =>
    post(
      server,
      user,
      `${BASE}/${id}/supervisor-reassign`,
      { assigned_user_id: to, reason_code: reason },
      { org },
    );

  const row = async (id: string) =>
    (
      await kit.one<{
        status: string;
        assigned_user_id: string;
        current_tier: number;
        version: number;
        deadline_at: Date;
        acknowledged_by_user_id: string | null;
      }>("SELECT * FROM message_acknowledgment_request WHERE id=$1", [id])
    )[0];
  const events = (id: string) =>
    kit.one<{ event_type: string; actor_user_id: string | null; reason_code: string | null }>(
      "SELECT * FROM message_acknowledgment_event WHERE request_id=$1 ORDER BY created_at, id",
      [id],
    );
  const totals = async () => [
    await kit.count("SELECT count(*)::int AS n FROM message_acknowledgment_request"),
    await kit.count("SELECT count(*)::int AS n FROM message_acknowledgment_event"),
    await kit.count(
      "SELECT count(*)::int AS n FROM outbox_event WHERE event_type LIKE 'm36.ack.%'",
    ),
  ];
  const adminTransition = (id: string, set: string) =>
    kit.admin.query(
      `UPDATE message_acknowledgment_request SET ${set}, version=version+1 WHERE id=$1`,
      [id],
    );

  /** Statements run in order as the app role in a rolled-back transaction; returns the LAST one's error or null. */
  const asAppSeq = async (
    user: string,
    statements: Array<[string, unknown[]]>,
  ): Promise<string | null> => {
    await kit.appConn.query("BEGIN");
    try {
      await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
      await kit.appConn.query("SELECT set_config('app.user_id', $1, true)", [user]);
      for (const [i, [sql, params]] of statements.entries()) {
        try {
          await kit.appConn.query(sql, params);
        } catch (err) {
          if (i === statements.length - 1) return (err as Error).message;
          throw err;
        }
      }
      return null;
    } finally {
      await kit.appConn.query("ROLLBACK");
    }
  };
  const MARK: [string, unknown[]] = [
    "SELECT set_config('app.ack_supervisor_reassign', 'on', true)",
    [],
  ];
  const reassignSql = (set: string): [string, unknown[]] => [
    `UPDATE message_acknowledgment_request SET ${set}, version=version+1 WHERE id=$1`,
    [],
  ];

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "adr78");
    nurse = await seed("nurse", ORG_A, SEND_KEYS);
    rn = await seed("rn", ORG_A, RECEIVE_KEYS);
    rn2 = await seed("rn2", ORG_A, RECEIVE_KEYS);
    rn3 = await seed("rn3", ORG_A, RECEIVE_KEYS);
    unqualified = await seed("unqualified", ORG_A, STAFF_KEYS);
    outsider = await seed("outsider", ORG_A, RECEIVE_KEYS);
    part2Blocked = await seed("part2", ORG_A, RECEIVE_KEYS);
    supervisor = await seed("supervisor", ORG_A, SUPERVISOR_KEYS);
    plain = await seed("plain", ORG_A, RECEIVE_KEYS);
    reviewOnly = await seed("reviewonly", ORG_A, ["messaging.review"]);
    walled = await seed("walled", ORG_A, SUPERVISOR_KEYS);
    supervisorB = await seed("supervisorb", ORG_B, SUPERVISOR_KEYS);
    rnB = await seed("rnb", ORG_B, RECEIVE_KEYS);
    // The supervisor is deliberately in NO channel. channel2 has only nurse and rn (a restricted row for everyone else).
    channel = await mkChannel(kit, "care_team", PATIENT, [
      nurse,
      rn,
      rn2,
      rn3,
      unqualified,
      part2Blocked,
    ]);
    channel2 = await mkChannel(kit, "care_team", PATIENT_2, [nurse, rn, rn2]);
    careTeam = [nurse, rn, rn2, rn3, unqualified, part2Blocked, outsider];
    const registry = createPredicateRegistry();
    registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
      const channelId = typeof target.id === "string" ? target.id : null;
      if (!channelId || !ctx.organizationId || !ctx.userId) return false;
      return kit.service.canViewChannel(ctx.organizationId, ctx.userId, channelId);
    });
    registerAbacRegistry(registry);
    for (const r of toNewAlertRuleRows(PLATFORM_DEFAULT_ALERT_RULES)) {
      await kit.admin.query(
        `INSERT INTO alert_rule (organization_id,event_type,category,severity_floor,recipient_resolver,resolver_args,channels_override,system_locked,enabled)
         VALUES (NULL,$1,$2,$3,$4,$5::jsonb,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [
          r.eventType,
          r.category,
          r.severityFloor,
          r.recipientResolver,
          JSON.stringify(r.resolverArgs),
          r.channelsOverride,
          r.systemLocked,
          r.enabled,
        ],
      );
    }
    app = makeServer(false);
    limitedApp = makeServer(true);
    // The REAL Part 2 gate logic (createPart2ChannelGate) over a SUD-flagged patient, real membership ids from the database and a
    // consent evaluator that releases everyone except `walled`: only the M5/M39 lookups are injected.
    realGateApp = makeServer(
      false,
      createPart2ChannelGate({
        privacyFlags: async () => ["sud"],
        membershipIds: async (_org, userIds) =>
          new Map(
            (
              await kit.one<{ id: string; user_id: string }>(
                "SELECT id, user_id FROM membership WHERE user_id = ANY($1::uuid[])",
                [userIds],
              )
            ).map((r) => [r.user_id, r.id] as const),
          ),
        evaluateInternalAccess: async ({ membershipId }) => ({
          redactSubstanceUseDisorderFields:
            membershipId ===
            (
              await kit.one<{ id: string }>("SELECT id FROM membership WHERE user_id=$1", [walled])
            )[0]?.id,
        }),
      }),
    );
    await Promise.all([app.ready(), limitedApp.ready(), realGateApp.ready()]);
  }, 240_000);

  afterAll(async () => {
    await Promise.all([app?.close(), limitedApp?.close(), realGateApp?.close()]);
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await kit?.close();
  });

  describe("the card's picker", () => {
    it("lists only eligible colleagues by id and name; never the sender, the assignee, an unqualified, Part 2 blocked or outside person", async () => {
      const id = await fresh();
      const before = await totals();

      const res = await get(app, rn, `${BASE}/${id}/reassign-candidates`);

      expect(res.statusCode, res.body).toBe(200);
      const ids = (res.json().candidates as Array<{ user_id: string }>)
        .map((c) => c.user_id)
        .sort();
      expect(ids).toEqual([rn2, rn3].sort());
      expect(res.json().candidates[0].display_name).toContain("adr78");
      expect(Object.keys(res.json().candidates[0]).sort()).toEqual(["display_name", "user_id"]);
      expect(await totals()).toEqual(before);
    });

    it("follows the reassign party rules and the uniform 404", async () => {
      const id = await fresh();

      expect((await get(app, rn2, `${BASE}/${id}/reassign-candidates`)).statusCode).toBe(403);
      expect((await get(app, outsider, `${BASE}/${id}/reassign-candidates`)).statusCode).toBe(404);
      expect((await get(app, rn, `${BASE}/not-a-uuid/reassign-candidates`)).statusCode).toBe(404);
      expect((await post(app, rn, `${BASE}/${id}/acknowledge`, {}, { key: null })).statusCode).toBe(
        200,
      );
      const taken = await get(app, nurse, `${BASE}/${id}/reassign-candidates`);
      expect(taken.statusCode).toBe(403);
      expect(errorCode(taken)).toBe("ACK_NOT_ASSIGNEE");
      expect((await get(app, rn, `${BASE}/${id}/reassign-candidates`)).statusCode).toBe(200);
    });

    it("lets the assignee hand on through the existing route using a listed candidate", async () => {
      const id = await fresh();
      const list = await get(app, rn, `${BASE}/${id}/reassign-candidates`);
      const target = list.json().candidates[0].user_id as string;

      const res = await post(
        app,
        rn,
        `${BASE}/${id}/reassign`,
        { assigned_user_id: target },
        { key: null },
      );

      expect(res.statusCode, res.body).toBe(200);
      expect((await row(id))?.assigned_user_id).toBe(target);
    });
  });

  describe("supervisor reassign", () => {
    it("moves a pending request for a supervisor who is in no channel: actor, reason, new window, no ids in the answer", async () => {
      const id = await fresh();
      const before = await row(id);

      const res = await supervise(id, rn2, "assignee_unable_to_sign_in");

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        request_ref: id,
        status: "pending",
        assigned_user_id: rn2,
        changed: true,
      });
      for (const forbidden of [channel, PATIENT]) expect(res.body).not.toContain(forbidden);
      const after = await row(id);
      expect(after).toMatchObject({ status: "pending", assigned_user_id: rn2, current_tier: 0 });
      expect(after!.version).toBe(before!.version + 1);
      expect(after!.acknowledged_by_user_id).toBeNull();
      const history = await events(id);
      expect(history.at(-1)).toMatchObject({
        event_type: "reassigned",
        actor_user_id: supervisor,
        reason_code: "assignee_unable_to_sign_in",
      });
      const audit = await kit.count(
        "SELECT count(*)::int AS n FROM audit_event WHERE actor_user_id=$1 AND resource_id=$2 AND event_type LIKE 'message_acknowledgment_request.%'",
        [supervisor, id],
      );
      expect(audit).toBeGreaterThanOrEqual(1);
      const [evt] = await kit.one<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m36.ack.reassigned' ORDER BY created_at DESC LIMIT 1",
        [id],
      );
      expect(evt!.payload).toMatchObject({
        supervisorReassign: true,
        actorUserId: supervisor,
        requesterUserId: nurse,
      });
      expect(JSON.stringify(evt!.payload)).not.toContain("unable_to_sign_in");
    });

    it.each(REASONS)("accepts the fixed reason %s", async (reason) => {
      const id = await fresh();
      expect((await supervise(id, rn2, reason)).statusCode).toBe(200);
      expect((await events(id)).at(-1)?.reason_code).toBe(reason);
    });

    it("re-arms an escalated and a failed_unreachable request (pending, tier 0, a deadline in the future)", async () => {
      const esc = await fresh(rn, channel2);
      await adminTransition(
        esc,
        "status='escalated', current_tier=1, window_started_at=now(), deadline_at=now() + interval '10 minutes'",
      );
      const dead = await fresh(rn, channel2);
      await adminTransition(dead, "status='failed_unreachable'");

      for (const id of [esc, dead]) {
        const res = await supervise(id, rn2);
        expect(res.statusCode, res.body).toBe(200);
        const r = await row(id);
        expect(r).toMatchObject({ status: "pending", current_tier: 0, assigned_user_id: rn2 });
        expect(r!.deadline_at.getTime()).toBeGreaterThan(Date.now());
      }
    });

    it("refuses acknowledged, resolved and cancelled requests and changes nothing", async () => {
      const taken = await fresh();
      await post(app, rn, `${BASE}/${taken}/acknowledge`, {}, { key: null });
      const closed = await fresh();
      await post(app, rn, `${BASE}/${closed}/acknowledge`, {}, { key: null });
      await post(app, rn, `${BASE}/${closed}/resolve`, {}, { key: null });
      const before = await totals();

      for (const id of [taken, closed]) {
        const res = await supervise(id, rn2);
        expect(res.statusCode).toBe(409);
        expect(errorCode(res)).toBe("ACK_STATE_INVALID");
        expect(
          (await get(app, supervisor, `${BASE}/${id}/supervisor-reassign-candidates`)).statusCode,
        ).toBe(409);
      }
      expect(await totals()).toEqual(before);
      expect((await row(taken))?.assigned_user_id).toBe(rn);
    });

    it("answers one 422 for every ineligible new assignee and writes nothing", async () => {
      const id = await fresh();
      const before = await totals();

      for (const target of [nurse, rn, unqualified, outsider, part2Blocked, rnB, randomUUID()]) {
        const res = await supervise(id, target);
        expect(res.statusCode, `${target} ${res.body}`).toBe(422);
        expect(errorCode(res)).toBe("ACK_ASSIGNEE_INVALID");
      }
      expect(await totals()).toEqual(before);
    });

    it("lists eligible candidates for a supervisor without disclosing channel, message or patient", async () => {
      const id = await fresh();

      const res = await get(app, supervisor, `${BASE}/${id}/supervisor-reassign-candidates`);

      expect(res.statusCode, res.body).toBe(200);
      expect(
        (res.json().candidates as Array<{ user_id: string }>).map((c) => c.user_id).sort(),
      ).toEqual([rn2, rn3].sort());
      for (const forbidden of [channel, PATIENT]) expect(res.body).not.toContain(forbidden);
    });

    it("cannot reach the conversation: the request, thread and channel list stay 404 for the supervisor", async () => {
      const id = await fresh();

      expect((await get(app, supervisor, `${BASE}/${id}`)).statusCode).toBe(404);
      expect(
        (await get(app, supervisor, `/api/v1/messaging/channels/${channel}/escalations`))
          .statusCode,
      ).toBe(403);
    });
  });

  describe("fix round 1", () => {
    it("shows a Part 2 walled-off supervisor an empty list and lets them move nothing", async () => {
      const id = await fresh();
      const before = await totals();

      const list = await get(app, walled, `${BASE}/${id}/supervisor-reassign-candidates`);

      expect(list.statusCode, list.body).toBe(200);
      expect(list.json()).toEqual({ candidates: [] });
      const res = await supervise(id, rn2, "workload", walled);
      expect(res.statusCode).toBe(422);
      expect(errorCode(res)).toBe("ACK_ASSIGNEE_INVALID");
      expect(await totals()).toEqual(before);
    });

    it("stops the sixth supervisor move of one request within a day with a generic 409 (a database-clock window)", async () => {
      const id = await fresh();
      const to = [rn2, rn3];
      for (let i = 0; i < 5; i += 1) {
        const res = await supervise(id, to[i % 2] as string, "workload");
        expect(res.statusCode, res.body).toBe(200);
      }

      const sixth = await supervise(id, to[1] as string, "workload");

      expect(sixth.statusCode).toBe(409);
      expect(errorCode(sixth)).toBe("ACK_SUPERVISOR_REASSIGN_LIMIT");
    });

    it("names the supervisor and the reason in the history the thread reads, and refuses self-assignment", async () => {
      const id = await fresh();
      await supervise(id, rn2, "assignee_off_shift");

      const detail = await get(app, nurse, `${BASE}/${id}`);

      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json().events.at(-1)).toMatchObject({
        event_type: "reassigned",
        actor_user_id: supervisor,
        reason_code: "assignee_off_shift",
      });
      const self = await supervise(await fresh(), supervisor, "workload");
      expect(self.statusCode).toBe(422);
    });
  });

  describe("real collaborators (no stubs for the gate logic or the emitter)", () => {
    it("the REAL Part 2 gate logic walls a SUD-patient supervisor off (empty list, uniform 422, whatever the state) and admits a released one", async () => {
      const id = await fresh();
      const taken = await fresh();
      await post(app, rn, `${BASE}/${taken}/acknowledge`, {}, { key: null });

      for (const rid of [id, taken]) {
        const list = await get(
          realGateApp,
          walled,
          `${BASE}/${rid}/supervisor-reassign-candidates`,
        );
        expect(list.statusCode, list.body).toBe(200);
        expect(list.json()).toEqual({ candidates: [] });
        const res = await supervise(rid, rn2, "workload", walled, realGateApp);
        expect(res.statusCode).toBe(422);
        expect(errorCode(res)).toBe("ACK_ASSIGNEE_INVALID");
      }
      const released = await get(
        realGateApp,
        supervisor,
        `${BASE}/${id}/supervisor-reassign-candidates`,
      );
      expect((released.json().candidates as unknown[]).length).toBeGreaterThan(0);
    });

    it("the REAL Drizzle emitter turns the stored supervisor reassign into real alerts: new assignee, previous assignee and sender, never the supervisor", async () => {
      const id = await fresh();
      expect((await supervise(id, rn2, "workload")).statusCode).toBe(200);
      const [e] = await kit.one<{ id: string; payload: Record<string, unknown> }>(
        "SELECT id, payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m36.ack.reassigned' ORDER BY created_at DESC LIMIT 1",
        [id],
      );
      const emitter = createAlertEmitter({
        ...createDrizzleAlertEmitterPorts(kit.handle.db, {
          flags: createDrizzleFeatureFlagReader(kit.handle.db),
        }),
        now: () => new Date(),
      });
      const consumer = buildM36AckNotificationsConsumer({
        alerts: emitter,
        messaging: kit.service,
        isWaitingForAssignee: ack.isWaitingForAssignee,
        stillQualified: ack.stillQualified,
      });

      await consumer.handle({
        id: e!.id,
        eventType: "m36.ack.reassigned",
        organizationId: ORG_A,
        payload: e!.payload,
      } as never);

      const recipients = async (eventType: string) =>
        await kit.one<{ recipient_user_id: string; channel: string }>(
          `SELECT d.recipient_user_id, d.channel::text FROM notification_delivery d JOIN alert a ON a.id=d.alert_id
              WHERE a.organization_id=$1 AND a.event_type=$2 AND a.correlation_id LIKE $3`,
          [ORG_A, eventType, `ack%:${id}:%`],
        );
      const notice = await recipients("m36.ack.supervisor_reassigned");
      expect(notice.map((r) => r.recipient_user_id).sort()).toEqual([nurse, rn].sort());
      expect(notice.every((r) => r.channel === "in_app")).toBe(true);
      expect((await recipients("m36.ack.reassigned")).map((r) => r.recipient_user_id)).toEqual([
        rn2,
      ]);
      const all = [...notice, ...(await recipients("m36.ack.reassigned"))];
      expect(all.some((r) => r.recipient_user_id === supervisor)).toBe(false);
    });
  });

  describe("access", () => {
    it("refuses a clinician without messaging.review, a reviewer without messaging.read, and no session", async () => {
      const id = await fresh();
      const before = await totals();

      expect((await supervise(id, rn2, "workload", plain)).statusCode).toBe(403);
      expect((await supervise(id, rn2, "workload", reviewOnly)).statusCode).toBe(403);
      expect(
        (await get(app, plain, `${BASE}/${id}/supervisor-reassign-candidates`)).statusCode,
      ).toBe(403);
      const anon = await app.inject({
        method: "POST",
        url: `${BASE}/${id}/supervisor-reassign`,
        headers: { "idempotency-key": randomUUID() },
        payload: { assigned_user_id: rn2, reason_code: "workload" },
      });
      expect(anon.statusCode).toBe(401);
      expect(await totals()).toEqual(before);
    });

    it("answers 404 to another tenant's supervisor, on both routes, and changes nothing", async () => {
      const id = await fresh();
      const before = await totals();

      expect((await supervise(id, rnB, "workload", supervisorB, app, ORG_B)).statusCode).toBe(404);
      const list = await app.inject({
        method: "GET",
        url: `${BASE}/${id}/supervisor-reassign-candidates`,
        headers: as(supervisorB, ORG_B),
      });
      expect(list.statusCode).toBe(404);
      expect(await totals()).toEqual(before);
    });

    it("requires an Idempotency-Key and a reason from the fixed set, with no free text", async () => {
      const id = await fresh();
      const before = await totals();

      const noKey = await post(
        app,
        supervisor,
        `${BASE}/${id}/supervisor-reassign`,
        { assigned_user_id: rn2, reason_code: "workload" },
        { key: null },
      );
      expect(noKey.statusCode).toBe(400);
      for (const bad of [
        { assigned_user_id: rn2 },
        { assigned_user_id: rn2, reason_code: "the patient is dying" },
        { assigned_user_id: rn2, reason_code: "workload", note: "free text" },
        { assigned_user_id: rn2, reason_code: "workload", status: "acknowledged" },
      ]) {
        expect(
          (await post(app, supervisor, `${BASE}/${id}/supervisor-reassign`, bad)).statusCode,
        ).toBe(422);
      }
      expect(await totals()).toEqual(before);
    });

    it("never lets a supervisor acknowledge or resolve (not the assignee, no urgent.receive)", async () => {
      const id = await fresh();

      expect(
        (await post(app, supervisor, `${BASE}/${id}/acknowledge`, {}, { key: null })).statusCode,
      ).toBe(403);
      expect(
        (await post(app, supervisor, `${BASE}/${id}/resolve`, {}, { key: null })).statusCode,
      ).toBe(403);
      expect((await row(id))?.status).toBe("pending");
    });
  });

  describe("database backstops (migration 1126)", () => {
    it("refuses a non-party reassign without the marker, allows it with the marker", async () => {
      const id = await fresh();
      const set = `status='pending', assigned_user_id='${rn2}', window_started_at=now(), deadline_at=now() + interval '60 minutes'`;
      const [sql] = reassignSql(set);

      expect(await asAppSeq(supervisor, [[sql, [id]]])).toMatch(
        /only the sender or the assignee reassigns/,
      );
      expect(await asAppSeq(supervisor, [MARK, [sql, [id]]])).toBeNull();
    });

    it("with the marker still refuses acknowledging, cancelling, and handing on an acknowledged request", async () => {
      const waiting = await fresh();
      const taken = await fresh();
      await post(app, rn, `${BASE}/${taken}/acknowledge`, {}, { key: null });
      const [ack] = reassignSql(
        "status='acknowledged', acknowledged_at=now(), acknowledged_by_user_id=assigned_user_id",
      );
      const [cancel] = reassignSql("status='cancelled', cancelled_at=now()");
      const handOn = `status='pending', assigned_user_id='${rn2}', acknowledged_at=NULL, acknowledged_by_user_id=NULL, window_started_at=now(), deadline_at=now() + interval '60 minutes'`;

      expect(await asAppSeq(supervisor, [MARK, [ack, [waiting]]])).toMatch(
        /only the assigned user/,
      );
      expect(await asAppSeq(supervisor, [MARK, [cancel, [waiting]]])).toMatch(
        /only the sender withdraws|supervisor reassigns only/,
      );
      expect(await asAppSeq(supervisor, [MARK, [reassignSql(handOn)[0], [taken]]])).toMatch(
        /supervisor reassigns only a request that still waits/,
      );
    });

    it("keeps the reason column to a fixed set on a user's reassigned event", async () => {
      const id = await fresh();
      const insert = (type: string, reason: string, actor: string | null): [string, unknown[]] => [
        `INSERT INTO message_acknowledgment_event (organization_id, request_id, event_type, actor_user_id, actor_kind, to_status, reason_code)
         VALUES ($1,$2,$3,$4,$5,'pending',$6)`,
        [ORG_A, id, type, actor, actor ? "user" : "system", reason],
      ];

      expect(await asAppSeq(supervisor, [insert("reassigned", "workload", supervisor)])).toBeNull();
      expect(
        await asAppSeq(supervisor, [insert("reassigned", "free text here", supervisor)]),
      ).toMatch(/message_ack_event_reason_code/);
      expect(await asAppSeq(supervisor, [insert("acknowledged", "workload", supervisor)])).toMatch(
        /message_ack_event_reason_code/,
      );
      expect(await asAppSeq("", [insert("reassigned", "workload", null)])).toMatch(
        /message_ack_event_reason_code/,
      );
    });
  });

  describe("notifications", () => {
    const emitted: Array<{ alert: Record<string, unknown> }> = [];
    const consumer = () =>
      buildM36AckNotificationsConsumer({
        alerts: {
          emit: async (_org: string, alert: Record<string, unknown>) => {
            emitted.push({ alert });
            return { alertId: "a", resolvedRecipientCount: 1 };
          },
        } as unknown as AlertEmitter,
        messaging: kit.service,
        isWaitingForAssignee: ack.isWaitingForAssignee,
        stillQualified: ack.stillQualified,
      });

    it("tells the new assignee, the previous assignee and the sender, never the supervisor, with fixed generic text", async () => {
      const id = await fresh();
      await supervise(id, rn2, "workload");
      const [e] = await kit.one<{ id: string; payload: Record<string, unknown> }>(
        "SELECT id, payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m36.ack.reassigned' ORDER BY created_at DESC LIMIT 1",
        [id],
      );
      emitted.length = 0;

      await consumer().handle({
        id: e!.id,
        eventType: "m36.ack.reassigned",
        organizationId: ORG_A,
        payload: e!.payload,
      } as never);

      const alerts = emitted.map((x) => x.alert);
      expect(alerts.map((a) => a.eventType).sort()).toEqual([
        "m36.ack.reassigned",
        "m36.ack.supervisor_reassigned",
      ]);
      const notice = alerts.find((a) => a.eventType === "m36.ack.supervisor_reassigned");
      expect((notice?.payload as { recipientUserIds: string[] }).recipientUserIds.sort()).toEqual(
        [nurse, rn].sort(),
      );
      const text = JSON.stringify(alerts);
      for (const forbidden of [supervisor, PATIENT, "workload", "routine note"]) {
        expect(text).not.toContain(forbidden);
      }
    });
  });

  describe("the queue (G-7) and the handle", () => {
    it("shows the sender's name and request_ref on a restricted row, and the handle drives the reassign", async () => {
      const id = await fresh(rn, channel2);

      const res = await get(
        app,
        supervisor,
        "/api/v1/messaging/escalations/unacknowledged?limit=100",
      );

      expect(res.statusCode, res.body).toBe(200);
      const item = (res.json() as AckQueueResponse).items.find((i) => i.request_ref === id);
      expect(item).toMatchObject({
        restricted: true,
        id: null,
        channel_id: null,
        patient_id: null,
      });
      expect(item?.requester_display_name).toContain("adr78 nurse");
      expect(res.body).not.toContain(channel2);
      expect(res.body).not.toContain("requester_user_id");

      const moved = await supervise(item!.request_ref, rn2, "coverage_change");
      expect(moved.statusCode, moved.body).toBe(200);
      expect((await row(id))?.assigned_user_id).toBe(rn2);
    });
  });

  describe("limits", () => {
    it("treats a repeat of the supervisor's own reassign (new key) as a no-op success", async () => {
      const id = await fresh();
      expect((await supervise(id, rn2, "workload")).json().changed).toBe(true);
      const before = await totals();

      const again = await supervise(id, rn2, "workload");

      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().changed).toBe(false);
      expect(await totals()).toEqual(before);
    });

    it("replays the same Idempotency-Key with the stored answer", async () => {
      const id = await fresh();
      const key = randomUUID();
      const body = { assigned_user_id: rn2, reason_code: "workload" };
      const first = await post(app, supervisor, `${BASE}/${id}/supervisor-reassign`, body, { key });
      const second = await post(app, supervisor, `${BASE}/${id}/supervisor-reassign`, body, {
        key,
      });

      expect(second.statusCode).toBe(first.statusCode);
      expect(second.json()).toEqual(first.json());
    });

    it("answers 429 once one supervisor names the same colleague more than 5 times in the window", async () => {
      const id = await fresh();
      const codes: number[] = [];
      for (let i = 0; i < 7; i += 1)
        codes.push((await supervise(id, rn2, "workload", supervisor, limitedApp)).statusCode);

      expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
      expect(codes.slice(5)).toEqual([429, 429]);
    });
  });
});
