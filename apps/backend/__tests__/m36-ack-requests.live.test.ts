/**
 * M36 WP 4.2 - the acknowledgment-request aggregate, LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * The real route stack (Authorization Contract, `channel_visibility`, the DB route service, the audit plumbing, the M1 idempotency
 * store) over the REAL catalog-validating outbox publisher (not NOOP_OUTBOX).
 *
 *   1. CREATE        an important request on a message the author wrote; an urgent send creates its request in the same
 *                    transaction; replay; conflict; flag off writes nothing; a failing publisher rolls the urgent message back.
 *   2. READS         opening, listing, reading and fetching never acknowledge: no event, no status change.
 *   3. ACKNOWLEDGE   only the assigned, still-qualified user; aide, author, other recipient, outsider, other tenant, Part 2
 *                    blocked refuse and write nothing; a double acknowledge is idempotent.
 *   4. RESOLVE       refused before acknowledging; once; repeat idempotent; not after.
 *   5. REASSIGN      new window for the new assignee, original requested_at kept; ineligible targets and non-parties refused.
 *   6. DB BACKSTOPS  illegal transitions, immutable columns, version skips, the deadline maximum, the critical class, the history
 *                    table (no UPDATE, no DELETE) - refused by the database whatever the service does.
 *   7. DELETE        deleting the message cancels the request in the same transaction (and the database refuses otherwise);
 *                    a message with a request cannot be edited.
 *   8. AUDIT         every transition has an actor-attributed audit row and an event row; reads land read-audit rows.
 *   9. NOTIFY        the real consumer: one generic alert, urgent class silent, stale events silent.
 *  10. TENANCY       another tenant sees and changes nothing; grants carry no DELETE.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:ack-requests:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the wardenx_* roles.
 */
import { randomUUID } from "node:crypto";
import {
  createPredicateRegistry,
  registerAbacRegistry,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { AlertEmitter } from "@chartwarden/messaging";
import { ACK_DEADLINE_POLICY } from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildAckRateLimit } from "../src/bootstrap/plugins/ack-rate-limit";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { createInMemoryRateLimitStore } from "../src/bootstrap/plugins/rate-limit-store";
import { createDbAckStore } from "../src/modules/36-messaging/ack-requests/ack-store-db";
import { buildAckDeps } from "../src/modules/36-messaging/ack-requests/deps";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import { buildM36AckNotificationsConsumer } from "../src/modules/36-messaging/outbox-consumers/ack-notifications";
import { registerMessagingRoutes } from "../src/modules/36-messaging/routes/messaging-routes";
import { buildUrgentDeps } from "../src/modules/36-messaging/urgent/deps";
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

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-11110a420001";
const ORG_B = "22222222-2222-4222-8222-22220a420002";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a42a1";
const BASE = "/api/v1/messaging/escalations";
const FLAGS_ON = {
  "messaging.ack_requests": true,
  "messaging.urgent_clinical": true,
  "messaging.sbar": true,
};
const FLAGS_ACK_OFF = { ...FLAGS_ON, "messaging.ack_requests": false };
const SEND_KEYS = [...STAFF_KEYS, "messaging.urgent.send"];
const RECEIVE_KEYS = [...STAFF_KEYS, "messaging.urgent.receive"];
const MIN = 60_000;

const para = (value: string) => ({ type: "paragraph", content: [{ type: "text", text: value }] });
const sbarDoc = () => ({
  schemaVersion: 1,
  doc: {
    type: "doc",
    content: [
      {
        type: "sbar",
        urgencyHint: "routine",
        situation: [para("Uncontrolled pain nine of ten")],
        background: [para("Day three on service, on morphine")],
        assessment: [para("Pain is not controlled by the current plan")],
        recommendation: [para("Please review the plan within the hour")],
      },
    ],
  },
});

describe.skipIf(!DB_URL)("M36 WP 4.2 acknowledgment requests - LIVE Postgres", () => {
  let kit: LiveKit;
  let app: FastifyInstance;
  let offApp: FastifyInstance;
  let failingApp: FastifyInstance;
  let limitedApp: FastifyInstance;
  let ack: ReturnType<typeof buildAckDeps>;
  let nurse: string;
  let aide: string;
  let rn: string;
  let rn2: string;
  let unqualified: string;
  let outsider: string;
  let outsiderSender: string;
  let part2Blocked: string;
  let orgBUser: string;
  let channel: string;
  let careTeam: string[] = [];
  const keysOf = new Map<string, readonly string[]>();

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
    const shared = {
      db: kit.handle.db,
      flags: { forOrg: async () => flags },
      outbox: outbox as never,
      permissionsFor,
      part2Gate: {
        allowedUserIds: async ({ userIds }: { userIds: readonly string[] }) =>
          new Set(userIds.filter((u) => u !== part2Blocked)),
      },
      careTeamMembers: async () => careTeam,
    };
    const ackBinding = buildAckDeps({ ...shared, messaging: kit.service });
    if (flags === FLAGS_ON) ack = ackBinding;
    const urgent = buildUrgentDeps({
      ...shared,
      messaging: kit.service,
      responseTracker: ackBinding.responseTracker,
    });
    registerMessagingRoutes(server, {
      service: kit.service,
      announcements: createDbAnnouncementService(kit.handle.db),
      urgent,
      ackRequests: {
        service: ackBinding.service,
        ...(limited ? { rateLimit: buildAckRateLimit(createInMemoryRateLimitStore()) } : {}),
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
  const getJson = (server: FastifyInstance, user: string, url: string, org = ORG_A) =>
    server.inject({ method: "GET", url, headers: as(user, org) });

  const routineMessage = async (author: string, ch = channel): Promise<string> => {
    const res = await post(app, author, `/api/v1/messaging/channels/${ch}/messages`, {
      body: `routine note ${randomUUID().slice(0, 8)}`,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().messageId as string;
  };
  const create = (user: string, messageId: string, assignee: string, server = app) =>
    post(server, user, BASE, { message_id: messageId, assigned_user_id: assignee });
  /** A fresh important request from `nurse` to `rn`; returns its id and message id. */
  const freshRequest = async (assignee = rn) => {
    const messageId = await routineMessage(nurse);
    const res = await create(nurse, messageId, assignee);
    expect(res.statusCode, res.body).toBe(201);
    return { messageId, id: res.json().request.id as string };
  };
  const acknowledge = (user: string, id: string, server = app) =>
    post(server, user, `${BASE}/${id}/acknowledge`, {}, { key: null });
  const resolve = (user: string, id: string, server = app) =>
    post(server, user, `${BASE}/${id}/resolve`, {}, { key: null });
  const reassign = (user: string, id: string, to: string, server = app) =>
    post(server, user, `${BASE}/${id}/reassign`, { assigned_user_id: to }, { key: null });

  const row = async (id: string) =>
    (
      await kit.one<{
        status: string;
        ack_class: string;
        assigned_user_id: string;
        requester_user_id: string;
        acknowledged_by_user_id: string | null;
        requested_at: Date;
        window_started_at: Date;
        deadline_at: Date;
        version: number;
        current_tier: number;
        patient_id: string;
      }>("SELECT * FROM message_acknowledgment_request WHERE id=$1", [id])
    )[0];
  const events = (id: string) =>
    kit.one<{
      event_type: string;
      actor_user_id: string | null;
      from_status: string | null;
      to_status: string | null;
      assigned_user_id: string | null;
      previous_assigned_user_id: string | null;
    }>("SELECT * FROM message_acknowledgment_event WHERE request_id=$1 ORDER BY created_at, id", [
      id,
    ]);
  const outboxNames = async (id: string) =>
    (
      await kit.one<{ event_type: string }>(
        "SELECT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, id",
        [id],
      )
    ).map((r) => r.event_type);
  const totals = async () => [
    await kit.count("SELECT count(*)::int AS n FROM message_acknowledgment_request"),
    await kit.count("SELECT count(*)::int AS n FROM message_acknowledgment_event"),
    await kit.count(
      "SELECT count(*)::int AS n FROM outbox_event WHERE event_type LIKE 'm36.ack.%'",
    ),
  ];

  /** Runs `sql` as the NOBYPASSRLS app role in a rolled-back transaction; returns the error message or null. */
  const asApp = async (
    sql: string,
    params: unknown[] = [],
    ctx: { org?: string; user?: string | null } = {},
  ): Promise<{ error: string | null; rows: Record<string, unknown>[] }> => {
    await kit.appConn.query("BEGIN");
    try {
      await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [ctx.org ?? ORG_A]);
      if (ctx.user !== null) {
        await kit.appConn.query("SELECT set_config('app.user_id', $1, true)", [ctx.user ?? nurse]);
      }
      const res = await kit.appConn.query(sql, params);
      return { error: null, rows: res.rows };
    } catch (err) {
      return { error: (err as Error).message, rows: [] };
    } finally {
      await kit.appConn.query("ROLLBACK");
    }
  };
  /** Runs the statements in order as the app role in a rolled-back transaction; returns the LAST one's error (earlier ones must pass). */
  const asAppSeq = async (
    statements: Array<[string, unknown[]] | [string, unknown[], string | null]>,
    user: string = nurse,
  ): Promise<string | null> => {
    await kit.appConn.query("BEGIN");
    try {
      await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
      await kit.appConn.query("SELECT set_config('app.user_id', $1, true)", [user]);
      for (const [i, [sql, params, actor]] of statements.entries()) {
        // WP 4.4: an escalation is the timer's write (no acting user); a statement may name its own actor (null = the system).
        if (actor !== undefined) {
          await kit.appConn.query("SELECT set_config('app.user_id', $1, true)", [actor ?? ""]);
        }
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
  /** Runs `sql` as the superuser (triggers still fire); returns the error message or null. */
  const asAdmin = async (sql: string, params: unknown[] = []): Promise<string | null> => {
    try {
      await kit.admin.query(sql, params);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  };

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "wp42");
    nurse = await seed("nurse", ORG_A, SEND_KEYS);
    aide = await seed("aide", ORG_A, SEND_KEYS);
    rn = await seed("rn", ORG_A, RECEIVE_KEYS);
    rn2 = await seed("rn2", ORG_A, RECEIVE_KEYS);
    unqualified = await seed("unqualified", ORG_A, STAFF_KEYS);
    outsider = await seed("outsider", ORG_A, RECEIVE_KEYS);
    outsiderSender = await seed("outsendr", ORG_A, SEND_KEYS);
    part2Blocked = await seed("part2", ORG_A, RECEIVE_KEYS);
    orgBUser = await seed("orgb", ORG_B, [...SEND_KEYS, ...RECEIVE_KEYS]);
    channel = await mkChannel(kit, "care_team", PATIENT, [
      nurse,
      aide,
      rn,
      rn2,
      unqualified,
      part2Blocked,
    ]);
    careTeam = [nurse, aide, rn, rn2, unqualified, outsider, outsiderSender, part2Blocked];

    const registry = createPredicateRegistry();
    registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
      const channelId = typeof target.id === "string" ? target.id : null;
      if (!channelId || !ctx.organizationId || !ctx.userId) return false;
      return kit.service.canViewChannel(ctx.organizationId, ctx.userId, channelId);
    });
    registerAbacRegistry(registry);

    app = makeServer(FLAGS_ON);
    offApp = makeServer(FLAGS_ACK_OFF);
    // A publisher that fails on the requested event: proves it shares the urgent send transaction.
    const real = catalogOutbox();
    failingApp = makeServer(
      { ...FLAGS_ON },
      {
        publish: async (tx, e) => {
          if (e.eventName === "m36.ack.requested") throw new Error("injected publisher failure");
          return real.publish(tx, e);
        },
      },
    );
    limitedApp = makeServer({ ...FLAGS_ON }, catalogOutbox(), true);
    await Promise.all([app.ready(), offApp.ready(), failingApp.ready(), limitedApp.ready()]);
  }, 240_000);

  afterAll(async () => {
    await Promise.all([app?.close(), offApp?.close(), failingApp?.close(), limitedApp?.close()]);
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await kit?.close();
  });

  describe("create", () => {
    it("stores a pending important request with the 60 minute default, one event and one id-only outbox row", async () => {
      const messageId = await routineMessage(nurse);
      const before = await totals();

      const res = await create(nurse, messageId, rn);

      expect(res.statusCode, res.body).toBe(201);
      const id = res.json().request.id as string;
      const r = await row(id);
      expect(r).toMatchObject({
        status: "pending",
        ack_class: "important",
        assigned_user_id: rn,
        requester_user_id: nurse,
        patient_id: PATIENT,
        current_tier: 0,
        version: 0,
      });
      expect(r!.deadline_at.getTime() - r!.requested_at.getTime()).toBe(
        ACK_DEADLINE_POLICY.important.defaultMinutes * MIN,
      );
      expect(r!.window_started_at.getTime()).toBe(r!.requested_at.getTime());
      expect(await events(id)).toMatchObject([
        {
          event_type: "requested",
          actor_user_id: nurse,
          to_status: "pending",
          assigned_user_id: rn,
        },
      ]);
      expect(await outboxNames(id)).toEqual(["m36.ack.requested"]);
      expect(await totals()).toEqual([before[0]! + 1, before[1]! + 1, before[2]! + 1]);

      const [event] = await kit.one<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM outbox_event WHERE aggregate_id=$1",
        [id],
      );
      expect(JSON.stringify(event!.payload)).not.toContain(PATIENT);
      expect(JSON.stringify(event!.payload)).not.toContain("routine note");
    });

    it("an aide holding messaging.urgent.send may raise one (05 matrix) for a message she wrote", async () => {
      const messageId = await routineMessage(aide);
      expect((await create(aide, messageId, rn)).statusCode).toBe(201);
    });

    it("a replay (new key, same key) is 200, one request and one event; another assignee is 409", async () => {
      const messageId = await routineMessage(nurse);
      const key = randomUUID();
      const first = await post(
        app,
        nurse,
        BASE,
        { message_id: messageId, assigned_user_id: rn },
        { key },
      );
      expect(first.statusCode).toBe(201);
      const before = await totals();

      const sameKey = await post(
        app,
        nurse,
        BASE,
        { message_id: messageId, assigned_user_id: rn },
        { key },
      );
      const newKey = await create(nurse, messageId, rn);
      const other = await create(nurse, messageId, rn2);

      expect(sameKey.statusCode).toBe(201); // the idempotency store replays the original answer verbatim
      expect(newKey.statusCode).toBe(200);
      expect(newKey.json()).toMatchObject({ created: false, changed: false });
      expect(other.statusCode).toBe(409);
      expect(errorCode(other)).toBe("ACK_ALREADY_REQUESTED");
      expect(await totals()).toEqual(before);
    });

    it("replays even after the assignee lost qualification (replay is checked before eligibility)", async () => {
      const { messageId } = await freshRequest(rn2);
      keysOf.set(rn2, STAFF_KEYS);
      try {
        const again = await create(nurse, messageId, rn2);
        expect(again.statusCode, again.body).toBe(200);
        expect(again.json().created).toBe(false);
      } finally {
        keysOf.set(rn2, RECEIVE_KEYS);
      }
    });

    it("refuses and writes NOTHING for: a non-author, the author as assignee, an aide, an unqualified, an outsider, a Part 2 blocked user, a cross-tenant id", async () => {
      const messageId = await routineMessage(nurse);
      const before = await totals();
      const attempts: Array<[string, string, string, number, string]> = [
        ["non-author", aide, rn2, 403, "ACK_NOT_REQUESTER"],
        ["self", nurse, nurse, 422, "ACK_ASSIGNEE_INVALID"],
        ["aide assignee", nurse, aide, 422, "ACK_ASSIGNEE_INVALID"],
        ["unqualified", nurse, unqualified, 422, "ACK_ASSIGNEE_INVALID"],
        ["not in channel", nurse, outsider, 422, "ACK_ASSIGNEE_INVALID"],
        ["part 2", nurse, part2Blocked, 422, "ACK_ASSIGNEE_INVALID"],
        ["other tenant", nurse, orgBUser, 422, "ACK_ASSIGNEE_INVALID"],
      ];
      for (const [label, caller, assignee, status, code] of attempts) {
        const res = await create(caller, messageId, assignee);
        expect(res.statusCode, `${label}: ${res.body}`).toBe(status);
        expect(errorCode(res), label).toBe(code);
      }
      expect(await totals()).toEqual(before);
    });

    it("a user without messaging.urgent.send, or without the message's channel, writes nothing", async () => {
      const messageId = await routineMessage(nurse);
      const before = await totals();
      expect((await create(unqualified, messageId, rn)).statusCode).toBe(403);
      expect((await create(outsiderSender, messageId, rn)).statusCode).toBe(404);
      expect(await totals()).toEqual(before);
    });

    it("a message outside a patient care-team channel is refused", async () => {
      const loc = await mkChannel(kit, "location", randomUUID(), [nurse, rn]);
      const messageId = await routineMessage(nurse, loc);
      const res = await create(nurse, messageId, rn);
      expect(res.statusCode).toBe(422);
      expect(errorCode(res)).toBe("ACK_NOT_PATIENT_CHANNEL");
    });

    it("flag off: 404, nothing written; an urgent send then creates no request but still works", async () => {
      const messageId = await routineMessage(nurse);
      const before = await totals();
      const off = await create(nurse, messageId, rn, offApp);
      expect(off.statusCode).toBe(404);

      const sent = await post(
        offApp,
        nurse,
        `/api/v1/messaging/channels/${channel}/urgent-messages`,
        {
          client_message_id: randomUUID(),
          body_doc: sbarDoc(),
          recipient_user_id: rn,
        },
      );
      expect(sent.statusCode, sent.body).toBe(201);
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM message_acknowledgment_request WHERE message_id=$1",
          [sent.json().message_id],
        ),
      ).toBe(0);
      expect(await totals()).toEqual(before);
    });

    it("an urgent send creates its urgent request (15 minutes) in the same transaction as the message", async () => {
      const sent = await post(app, nurse, `/api/v1/messaging/channels/${channel}/urgent-messages`, {
        client_message_id: randomUUID(),
        body_doc: sbarDoc(),
        recipient_user_id: rn,
      });
      expect(sent.statusCode, sent.body).toBe(201);

      const [r] = await kit.one<{ id: string }>(
        "SELECT id FROM message_acknowledgment_request WHERE message_id=$1",
        [sent.json().message_id],
      );
      const stored = await row(r!.id);
      expect(stored).toMatchObject({
        ack_class: "urgent",
        assigned_user_id: rn,
        requester_user_id: nurse,
      });
      expect(stored!.deadline_at.getTime() - stored!.requested_at.getTime()).toBe(
        ACK_DEADLINE_POLICY.urgent.defaultMinutes * MIN,
      );
      expect(await outboxNames(r!.id)).toEqual(["m36.ack.requested"]);
    });

    it("an urgent send replay creates no second request or event", async () => {
      const clientId = randomUUID();
      const send = () =>
        post(app, nurse, `/api/v1/messaging/channels/${channel}/urgent-messages`, {
          client_message_id: clientId,
          body_doc: sbarDoc(),
          recipient_user_id: rn,
        });
      expect((await send()).statusCode).toBe(201);
      const before = await totals();

      expect((await send()).statusCode).toBe(200);

      expect(await totals()).toEqual(before);
    });

    it("POST /escalations for an urgent message made while the flag was off creates the urgent request for its named recipient only", async () => {
      const sent = await post(
        offApp,
        nurse,
        `/api/v1/messaging/channels/${channel}/urgent-messages`,
        {
          client_message_id: randomUUID(),
          body_doc: sbarDoc(),
          recipient_user_id: rn,
        },
      );
      const messageId = sent.json().message_id as string;

      expect((await create(nurse, messageId, rn2)).statusCode).toBe(422);
      const ok = await create(nurse, messageId, rn);
      expect(ok.statusCode, ok.body).toBe(201);
      expect(ok.json().request.ack_class).toBe("urgent");
    });

    it("a failing publisher rolls the urgent message back with its request (one transaction)", async () => {
      const clientId = randomUUID();
      const messages = () => kit.count("SELECT count(*)::int AS n FROM message");
      const before = [await messages(), ...(await totals())];

      const res = await post(
        failingApp,
        nurse,
        `/api/v1/messaging/channels/${channel}/urgent-messages`,
        {
          client_message_id: clientId,
          body_doc: sbarDoc(),
          recipient_user_id: rn,
        },
      );

      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect([await messages(), ...(await totals())]).toEqual(before);
    });

    it("the rate limit refuses past the pair budget and creates nothing beyond it", async () => {
      let created = 0;
      let refused = 0;
      for (let i = 0; i < 7; i++) {
        const messageId = await routineMessage(nurse);
        const res = await create(nurse, messageId, rn2, limitedApp);
        if (res.statusCode === 201) created += 1;
        else if (res.statusCode === 429) refused += 1;
      }
      expect(created).toBe(5);
      expect(refused).toBe(2);
    });
  });

  describe("reads never acknowledge", () => {
    it("opening, listing, marking read and fetching the request leave it pending with no new event", async () => {
      const { id, messageId } = await freshRequest();
      const before = await totals();

      await getJson(app, rn, `/api/v1/messaging/channels/${channel}/messages`);
      await post(app, rn, `/api/v1/messaging/messages/${messageId}/read`, {}, { key: null });
      await getJson(app, rn, `${BASE}/${id}`);
      await getJson(app, rn, `/api/v1/messaging/channels/${channel}/escalations`);
      await getJson(app, nurse, `${BASE}/${id}`);

      expect((await row(id))?.status).toBe("pending");
      expect((await row(id))?.acknowledged_by_user_id).toBeNull();
      expect((await events(id)).map((e) => e.event_type)).toEqual(["requested"]);
      expect(await totals()).toEqual(before);
      const receiptStatuses = await kit.one<{ status: string }>(
        "SELECT status::text FROM message_receipt WHERE message_id=$1",
        [messageId],
      );
      expect(receiptStatuses.every((r) => r.status !== "ack")).toBe(true);
    });

    it("the detail read returns the history and the viewer's own actions", async () => {
      const { id } = await freshRequest();

      const asRn = (await getJson(app, rn, `${BASE}/${id}`)).json();
      const asNurse = (await getJson(app, nurse, `${BASE}/${id}`)).json();

      expect(asRn.events).toHaveLength(1);
      expect(asRn.request.viewer_actions).toEqual({
        can_acknowledge: true,
        can_reassign: true,
        can_resolve: false,
      });
      expect(asNurse.request.viewer_actions.can_acknowledge).toBe(false);
    });

    it("a user who cannot see the channel, another tenant and a malformed id all get the same 404", async () => {
      const { id } = await freshRequest();
      const hidden = await getJson(app, outsider, `${BASE}/${id}`);
      const otherTenant = await getJson(app, orgBUser, `${BASE}/${id}`, ORG_B);
      const missing = await getJson(app, rn, `${BASE}/${randomUUID()}`);
      const malformed = await getJson(app, rn, `${BASE}/zzz`);

      for (const res of [hidden, otherTenant, missing, malformed]) expect(res.statusCode).toBe(404);
      expect(otherTenant.json().error?.code).toBe(missing.json().error?.code);
    });
  });

  describe("acknowledge", () => {
    it("is an explicit action by the assignee: the status, the actor, one event, one outbox row, one audit row", async () => {
      const { id } = await freshRequest();

      const res = await acknowledge(rn, id);

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ changed: true, request: { status: "acknowledged" } });
      expect(await row(id)).toMatchObject({
        status: "acknowledged",
        acknowledged_by_user_id: rn,
        version: 1,
      });
      expect(await events(id)).toMatchObject([
        { event_type: "requested" },
        {
          event_type: "acknowledged",
          actor_user_id: rn,
          from_status: "pending",
          to_status: "acknowledged",
        },
      ]);
      expect(await outboxNames(id)).toEqual(["m36.ack.requested", "m36.ack.acknowledged"]);
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM audit_event WHERE resource_id=$1 AND actor_user_id=$2 AND event_type='message_acknowledgment_request.update'",
          [id, rn],
        ),
      ).toBe(1);
    });

    it("refuses and writes NOTHING for an aide, the author, another recipient, an outsider and another tenant", async () => {
      const { id } = await freshRequest();
      const before = await totals();

      const attempts: Array<[string, Promise<{ statusCode: number }>, number]> = [
        ["aide (no receive key)", acknowledge(aide, id), 403],
        ["author (no receive key)", acknowledge(nurse, id), 403],
        ["another recipient", acknowledge(rn2, id), 403],
        ["outsider", acknowledge(outsider, id), 404],
        [
          "other tenant",
          post(app, orgBUser, `${BASE}/${id}/acknowledge`, {}, { org: ORG_B, key: null }),
          404,
        ],
      ];
      for (const [label, call, status] of attempts)
        expect((await call).statusCode, label).toBe(status);

      expect((await row(id))?.status).toBe("pending");
      expect(await totals()).toEqual(before);
    });

    it("refuses the assignee when her qualification lapsed (clean 403), and a Part 2 block", async () => {
      const { id } = await freshRequest(rn2);
      keysOf.set(rn2, STAFF_KEYS);
      try {
        const res = await acknowledge(rn2, id);
        expect(res.statusCode).toBe(403);
        expect(errorCode(res)).toBe("ACK_NOT_QUALIFIED");
      } finally {
        keysOf.set(rn2, RECEIVE_KEYS);
      }
      expect((await row(id))?.status).toBe("pending");
    });

    it("double acknowledge is idempotent: 200 changed:false, one event, one outbox row", async () => {
      const { id } = await freshRequest();
      expect((await acknowledge(rn, id)).statusCode).toBe(200);
      const before = await totals();

      const again = await acknowledge(rn, id);

      expect(again.statusCode).toBe(200);
      expect(again.json().changed).toBe(false);
      expect(await totals()).toEqual(before);
    });

    it("still works when the creation flag is off (an open request must be settleable)", async () => {
      const { id } = await freshRequest();
      expect((await acknowledge(rn, id, offApp)).statusCode).toBe(200);
    });

    it("a concurrent double acknowledge leaves exactly one acknowledged event", async () => {
      const { id } = await freshRequest();

      const results = await Promise.all([
        acknowledge(rn, id),
        acknowledge(rn, id),
        acknowledge(rn, id),
      ]);

      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      expect((await events(id)).filter((e) => e.event_type === "acknowledged")).toHaveLength(1);
    });
  });

  describe("resolve", () => {
    it("is refused before the request is acknowledged", async () => {
      const { id } = await freshRequest();

      const res = await resolve(rn, id);

      expect(res.statusCode).toBe(409);
      expect(errorCode(res)).toBe("ACK_NOT_ACKNOWLEDGED");
      expect((await row(id))?.status).toBe("pending");
    });

    it("closes an acknowledged request once, with the actor; a repeat is idempotent; acknowledging again is refused", async () => {
      const { id } = await freshRequest();
      await acknowledge(rn, id);

      const done = await resolve(rn, id);
      const again = await resolve(rn, id);
      const late = await acknowledge(rn, id);

      expect(done.json()).toMatchObject({ changed: true, request: { status: "resolved" } });
      expect(again.json().changed).toBe(false);
      expect(late.statusCode).toBe(409);
      expect((await events(id)).map((e) => e.event_type)).toEqual([
        "requested",
        "acknowledged",
        "resolved",
      ]);
      expect((await row(id))?.status).toBe("resolved");
    });

    it("is for the assignee only (the author and another recipient are refused)", async () => {
      const { id } = await freshRequest();
      await acknowledge(rn, id);

      expect((await resolve(nurse, id)).statusCode).toBe(403);
      expect((await resolve(rn2, id)).statusCode).toBe(403);
      expect((await row(id))?.status).toBe("acknowledged");
    });
  });

  describe("reassign", () => {
    it("restarts the window for the new assignee and keeps the original requested_at", async () => {
      const { id } = await freshRequest();
      const first = (await row(id))!;
      await new Promise((r) => setTimeout(r, 25));

      const res = await reassign(nurse, id, rn2);

      expect(res.statusCode, res.body).toBe(200);
      const next = (await row(id))!;
      expect(next).toMatchObject({
        status: "pending",
        assigned_user_id: rn2,
        current_tier: 0,
        version: 1,
      });
      expect(next.requested_at.getTime()).toBe(first.requested_at.getTime());
      expect(next.window_started_at.getTime()).toBeGreaterThan(first.window_started_at.getTime());
      expect(next.deadline_at.getTime() - next.window_started_at.getTime()).toBe(
        ACK_DEADLINE_POLICY.important.defaultMinutes * MIN,
      );
      expect(await events(id)).toMatchObject([
        { event_type: "requested" },
        {
          event_type: "reassigned",
          actor_user_id: nurse,
          assigned_user_id: rn2,
          previous_assigned_user_id: rn,
        },
      ]);
      expect(await outboxNames(id)).toEqual(["m36.ack.requested", "m36.ack.reassigned"]);
    });

    it("lets the assignee hand an acknowledged request on: back to pending, the acknowledgment cleared", async () => {
      const { id } = await freshRequest();
      await acknowledge(rn, id);

      const res = await reassign(rn, id, rn2);

      expect(res.statusCode, res.body).toBe(200);
      expect(await row(id)).toMatchObject({
        status: "pending",
        assigned_user_id: rn2,
        acknowledged_by_user_id: null,
      });
    });

    it("refuses the SENDER once the request is taken (403 ACK_NOT_ASSIGNEE, nothing written); the assignee's hand-off keeps the acknowledgment in the history", async () => {
      const { id } = await freshRequest();
      await acknowledge(rn, id);
      const before = await totals();

      const refused = await reassign(nurse, id, rn2);

      expect(refused.statusCode, refused.body).toBe(403);
      expect(errorCode(refused)).toBe("ACK_NOT_ASSIGNEE");
      expect(await totals()).toEqual(before);
      expect((await row(id))?.status).toBe("acknowledged");

      const handed = await reassign(rn, id, rn2);

      expect(handed.statusCode, handed.body).toBe(200);
      expect((await events(id)).map((e) => [e.event_type, e.from_status, e.to_status])).toEqual([
        ["requested", null, "pending"],
        ["acknowledged", "pending", "acknowledged"],
        ["reassigned", "acknowledged", "pending"],
      ]);
    });

    it("makes the sender re-pass a live urgent.send check; a failing lookup is a failure, and the assignee needs no such check", async () => {
      const { id } = await freshRequest();
      const keys = keysOf.get(nurse) ?? [];
      keysOf.set(
        nurse,
        keys.filter((k) => k !== "messaging.urgent.send"),
      );
      try {
        const refused = await reassign(nurse, id, rn2);
        expect(refused.statusCode, refused.body).toBe(403);
        expect((await row(id))?.assigned_user_id).toBe(rn);
      } finally {
        keysOf.set(nurse, keys);
      }
      // The assignee's own role lapsing must not strand the item: she can still hand it on.
      const rnKeys = keysOf.get(rn) ?? [];
      keysOf.set(rn, STAFF_KEYS);
      try {
        const handed = await reassign(rn, id, rn2);
        expect(handed.statusCode, handed.body).toBe(200);
      } finally {
        keysOf.set(rn, rnKeys);
      }
    });

    it("refuses a non-party, an ineligible target, the requester, the current assignee, and a closed request", async () => {
      const { id } = await freshRequest();
      const before = await totals();
      expect((await reassign(aide, id, rn2)).statusCode).toBe(403);
      expect((await reassign(rn2, id, rn)).statusCode).toBe(403);
      for (const target of [unqualified, aide, nurse, rn, outsider, part2Blocked, orgBUser]) {
        const res = await reassign(nurse, id, target);
        expect(res.statusCode, target).toBe(422);
        expect(errorCode(res)).toBe("ACK_ASSIGNEE_INVALID");
      }
      expect(await totals()).toEqual(before);

      await acknowledge(rn, id);
      await resolve(rn, id);
      expect((await reassign(nurse, id, rn2)).statusCode).toBe(409);
    });

    it("a repeat by the same actor is a success without a second event", async () => {
      const { id } = await freshRequest();
      await reassign(nurse, id, rn2);
      const before = await totals();

      const again = await reassign(nurse, id, rn2);

      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().changed).toBe(false);
      expect(await totals()).toEqual(before);
    });
  });

  describe("the database holds the state machine", () => {
    let pendingId: string;
    beforeAll(async () => {
      pendingId = (await freshRequest()).id;
    });
    const update = (set: string, id = () => pendingId) =>
      asApp(`UPDATE message_acknowledgment_request SET ${set} WHERE id=$1`, [id()]);

    it.each([
      [
        "pending -> resolved",
        "status='resolved', resolved_at=now(), resolved_by_user_id=assigned_user_id, version=version+1",
      ],
      ["pending -> pending without a new assignee", "version=version+1"],
      [
        "a version that skips",
        "status='acknowledged', acknowledged_at=now(), acknowledged_by_user_id=assigned_user_id, version=version+2",
      ],
      [
        "acknowledging as someone else",
        "status='acknowledged', acknowledged_at=now(), acknowledged_by_user_id=requester_user_id, version=version+1",
      ],
      ["pending -> acknowledged without an actor", "status='acknowledged', version=version+1"],
    ])("refuses %s", async (_label, set) => {
      expect((await update(set)).error).not.toBeNull();
    });

    it("accepts the transitions 4.4 and 4.5 will need (pending -> escalated -> tier up -> failed_unreachable) so they cannot be blocked", async () => {
      // The escalation writes are the TIMER's (no acting user); the final acknowledgment is the assignee's.
      const up = (
        set: string,
        actor?: string | null,
      ): [string, unknown[], string | null | undefined] => [
        `UPDATE message_acknowledgment_request SET ${set}, version=version+1 WHERE id=$1`,
        [pendingId],
        actor,
      ];
      const err = await asAppSeq(
        [
          up("status='escalated', current_tier=1", null),
          up("current_tier=2", null),
          up("status='failed_unreachable'", null),
          up(
            "status='acknowledged', acknowledged_at=now(), acknowledged_by_user_id=assigned_user_id",
            rn,
          ),
        ] as Array<[string, unknown[], string | null]>,
        rn,
      );
      expect(err).toBeNull();
    });

    it("refuses escalated -> resolved, a lower tier, and failed_unreachable -> escalated", async () => {
      const up = (set: string): [string, unknown[], string | null] => [
        `UPDATE message_acknowledgment_request SET ${set}, version=version+1 WHERE id=$1`,
        [pendingId],
        null,
      ];
      expect(
        await asAppSeq([
          up("status='escalated', current_tier=2"),
          up("status='resolved', resolved_at=now(), resolved_by_user_id=assigned_user_id"),
        ]),
      ).toMatch(/not allowed/);
      expect(
        await asAppSeq([up("status='escalated', current_tier=2"), up("current_tier=1")]),
      ).toMatch(/not allowed/);
      expect(
        await asAppSeq([
          up("status='failed_unreachable'"),
          up("status='escalated', current_tier=1"),
        ]),
      ).toMatch(/not allowed/);
    });

    it("refuses any change to a resolved request", async () => {
      const { id } = await freshRequest();
      await acknowledge(rn, id);
      await resolve(rn, id);
      expect(
        (
          await asApp(
            "UPDATE message_acknowledgment_request SET status='pending', assigned_user_id=$2, version=version+1 WHERE id=$1",
            [id, rn2],
          )
        ).error,
      ).toMatch(/final/);
      expect(
        (
          await asApp("UPDATE message_acknowledgment_request SET version=version+1 WHERE id=$1", [
            id,
          ])
        ).error,
      ).toMatch(/final/);
    });

    it("the superuser cannot change identity, class, requester or requested_at either", async () => {
      for (const set of [
        "patient_id=gen_random_uuid()",
        "ack_class='urgent'",
        "requester_user_id=assigned_user_id",
        "requested_at=requested_at - interval '1 hour'",
        "message_id=gen_random_uuid()",
      ]) {
        expect(
          await asAdmin(
            `UPDATE message_acknowledgment_request SET ${set}, version=version+1 WHERE id=$1`,
            [pendingId],
          ),
          set,
        ).not.toBeNull();
      }
    });

    it("only the assigned user (the session actor) can write an acknowledgment or a close, even with the right columns", async () => {
      const ackSet =
        "status='acknowledged', acknowledged_at=now(), acknowledged_by_user_id=assigned_user_id, version=version+1";
      const ackAs = (user: string | null) =>
        asApp(`UPDATE message_acknowledgment_request SET ${ackSet} WHERE id=$1`, [pendingId], {
          user,
        });
      // the requester, a stranger and a system write (no actor) cannot; the assignee can
      expect((await ackAs(nurse)).error).toMatch(/only the assigned user/);
      expect((await ackAs(rn2)).error).toMatch(/only the assigned user/);
      expect((await ackAs(null)).error).toMatch(/only the assigned user/);
      expect((await ackAs(rn)).error).toBeNull();
      // closing: another user (and a system write) is refused, the assignee is not
      const { id } = await freshRequest();
      await acknowledge(rn, id);
      const closeAs = (user: string | null) =>
        asApp(
          "UPDATE message_acknowledgment_request SET status='resolved', resolved_at=now(), resolved_by_user_id=assigned_user_id, version=version+1 WHERE id=$1",
          [id],
          { user },
        );
      expect((await closeAs(rn2)).error).toMatch(/only the assigned user/);
      expect((await closeAs(null)).error).toMatch(/only the assigned user/);
      expect((await closeAs(rn)).error).toBeNull();
    });

    it("a reassign is by the sender or the assignee only, a cancel by the sender only, and a window starts now", async () => {
      const reassignSet = (to: string, start = "now()") =>
        `status='pending', assigned_user_id='${to}', window_started_at=${start}, deadline_at=${start} + interval '60 minutes', version=version+1`;
      const as = (set: string, user: string) =>
        asApp(`UPDATE message_acknowledgment_request SET ${set} WHERE id=$1`, [pendingId], {
          user,
        });
      expect((await as(reassignSet(rn2), aide)).error).toMatch(/only the sender or the assignee/);
      expect((await as(reassignSet(rn2), nurse)).error).toBeNull();
      expect((await as(reassignSet(rn2), rn)).error).toBeNull();
      expect((await as(reassignSet(rn2, "now() + interval '30 minutes'"), nurse)).error).toMatch(
        /starts a new window now/,
      );
      const cancel = "status='cancelled', cancelled_at=now(), version=version+1";
      expect((await as(cancel, rn)).error).toMatch(/only the sender withdraws/);
      expect((await as(cancel, nurse)).error).toBeNull();
    });

    it("once taken, only the assignee can return the request to pending (the sender cannot, whatever the service does)", async () => {
      const { id } = await freshRequest();
      await acknowledge(rn, id);
      const back = (to: string) =>
        `status='pending', assigned_user_id='${to}', window_started_at=now(), deadline_at=now() + interval '60 minutes', acknowledged_at=NULL, acknowledged_by_user_id=NULL, version=version+1`;
      const attempt = (user: string) =>
        asApp(`UPDATE message_acknowledgment_request SET ${back(rn2)} WHERE id=$1`, [id], { user });

      expect((await attempt(nurse)).error).toMatch(/only the person who took responsibility/);
      expect((await attempt(rn)).error).toBeNull();
    });

    it("refuses a forged history event: another person's name, a status the request is not in, a system event from a user session", async () => {
      const { id } = await freshRequest();
      const insert = (actor: string | null, kind: string, toStatus: string, user: string | null) =>
        asApp(
          `INSERT INTO message_acknowledgment_event
             (organization_id, request_id, event_type, actor_user_id, actor_kind, from_status, to_status, assigned_user_id, tier)
           VALUES ($1, $2, 'acknowledged', $3, $4, 'pending', $5, $6, 0)`,
          [ORG_A, id, actor, kind, toStatus, rn],
          { user },
        );

      expect((await insert(rn, "user", "pending", nurse)).error).toMatch(/message_ack_event_actor/);
      expect((await insert(nurse, "user", "resolved", nurse)).error).toMatch(
        /message_ack_event_status/,
      );
      expect((await insert(null, "system", "pending", nurse)).error).toMatch(
        /message_ack_event_actor/,
      );
      expect((await insert(nurse, "user", "pending", null)).error).toMatch(
        /message_ack_event_actor/,
      );
      // The honest shapes pass: the session's own user with the request's own status, and a system event with no user session.
      expect((await insert(nurse, "user", "pending", nurse)).error).toBeNull();
      expect((await insert(null, "system", "pending", null)).error).toBeNull();
      expect(await events(id)).toHaveLength(1);
    });

    it("the patient is the care-team channel's, and a request cannot start in the past or the future", async () => {
      const messageId = await routineMessage(nurse);
      const insert = (patient: string, startOffset = "0 minutes") =>
        asApp(
          `INSERT INTO message_acknowledgment_request
             (organization_id, message_id, channel_id, patient_id, ack_class, requester_user_id, assigned_user_id, requested_at, window_started_at, deadline_at)
           VALUES ($1,$2,$3,$4,'important',$5,$6, now() + $7::interval, now() + $7::interval, now() + $7::interval + interval '60 minutes')`,
          [ORG_A, messageId, channel, patient, nurse, rn, startOffset],
        );
      expect((await insert(randomUUID())).error).toMatch(/care-team channel's patient/);
      expect((await insert(PATIENT, "1 hour")).error).toMatch(/starts now/);
      expect((await insert(PATIENT, "-1 hour")).error).toMatch(/starts now/);
      expect((await insert(PATIENT)).error).toBeNull();
    });

    it("the record of who took responsibility cannot be rewritten or erased on a later transition", async () => {
      const { id } = await freshRequest();
      await acknowledge(rn, id);
      const base =
        "status='resolved', resolved_at=now(), resolved_by_user_id=assigned_user_id, version=version+1";
      for (const extra of [
        "acknowledged_at=now() + interval '1 minute'",
        "acknowledged_at=NULL, acknowledged_by_user_id=NULL",
      ]) {
        expect(
          (
            await asApp(
              `UPDATE message_acknowledgment_request SET ${base}, ${extra} WHERE id=$1`,
              [id],
              { user: rn },
            )
          ).error,
          extra,
        ).not.toBeNull();
      }
      expect(
        (
          await asApp(`UPDATE message_acknowledgment_request SET ${base} WHERE id=$1`, [id], {
            user: rn,
          })
        ).error,
      ).toBeNull();
    });

    it("the app role cannot even name the immutable columns (no grant)", async () => {
      const res = await asApp(
        "UPDATE message_acknowledgment_request SET patient_id=gen_random_uuid() WHERE id=$1",
        [pendingId],
      );
      expect(res.error).toMatch(/permission denied/);
    });

    it("refuses a window longer than the platform maximum for the class (CHECK), a critical class, and parties that are the same", async () => {
      const messageId = await routineMessage(nurse);
      const insert = (cls: string, minutes: number, assigned = rn, requester = nurse) =>
        asApp(
          `INSERT INTO message_acknowledgment_request
             (organization_id, message_id, channel_id, patient_id, ack_class, requester_user_id, assigned_user_id, requested_at, window_started_at, deadline_at)
           VALUES ($1,$2,$3,$4,$5::message_ack_class,$6,$7,now(),now(), now() + ($8 || ' minutes')::interval)`,
          [ORG_A, messageId, channel, PATIENT, cls, requester, assigned, String(minutes)],
        );
      expect((await insert("important", 121)).error).toMatch(/window/);
      expect((await insert("important", 0)).error).toMatch(/window/);
      expect((await insert("critical_symptom", 5)).error).toMatch(/critical/);
      expect((await insert("important", 60, nurse, nurse)).error).toMatch(
        /parties|author|assignee/,
      );
      expect((await insert("important", 120)).error).toBeNull();
    });

    it("refuses a request whose requester is not the message author, whose message is deleted, or whose assignee is not an org member", async () => {
      const messageId = await routineMessage(nurse);
      const insert = (requester: string, assigned: string, msg = messageId) =>
        asApp(
          `INSERT INTO message_acknowledgment_request
             (organization_id, message_id, channel_id, patient_id, ack_class, requester_user_id, assigned_user_id, requested_at, window_started_at, deadline_at)
           VALUES ($1,$2,$3,$4,'important',$5,$6,now(),now(), now() + interval '60 minutes')`,
          [ORG_A, msg, channel, PATIENT, requester, assigned],
        );
      expect((await insert(aide, rn)).error).toMatch(/author/);
      expect((await insert(nurse, orgBUser)).error).toMatch(/active member/);
      const deleted = await routineMessage(nurse);
      await kit.admin.query(
        "UPDATE message SET status='deleted', deleted_at=now(), edited_at=NULL WHERE id=$1",
        [deleted],
      );
      expect((await insert(nurse, rn, deleted)).error).toMatch(/missing or deleted/);
    });

    it("an urgent request must follow the urgent message's named recipient", async () => {
      const sent = await post(
        offApp,
        nurse,
        `/api/v1/messaging/channels/${channel}/urgent-messages`,
        {
          client_message_id: randomUUID(),
          body_doc: sbarDoc(),
          recipient_user_id: rn,
        },
      );
      const insert = (cls: string, assigned: string) =>
        asApp(
          `INSERT INTO message_acknowledgment_request
             (organization_id, message_id, channel_id, patient_id, ack_class, requester_user_id, assigned_user_id, requested_at, window_started_at, deadline_at)
           VALUES ($1,$2,$3,$4,$5::message_ack_class,$6,$7,now(),now(), now() + interval '15 minutes')`,
          [ORG_A, sent.json().message_id, channel, PATIENT, cls, nurse, assigned],
        );
      expect((await insert("important", rn)).error).toMatch(/follows the message urgency/);
      expect((await insert("urgent", rn2)).error).toMatch(/follows the message urgency/);
      expect((await insert("urgent", rn)).error).toBeNull();
    });

    it("the history table takes INSERT only: UPDATE is refused for the app role and the superuser, DELETE for both", async () => {
      const [ev] = await events(pendingId);
      expect(ev).toBeDefined();
      const evId = (
        await kit.one<{ id: string }>(
          "SELECT id FROM message_acknowledgment_event WHERE request_id=$1 LIMIT 1",
          [pendingId],
        )
      )[0]!.id;
      expect(
        (await asApp("UPDATE message_acknowledgment_event SET tier=5 WHERE id=$1", [evId])).error,
      ).toMatch(/permission denied|append_only/);
      expect(
        (await asApp("DELETE FROM message_acknowledgment_event WHERE id=$1", [evId])).error,
      ).toMatch(/permission denied|append_only/);
      expect(
        await asAdmin("UPDATE message_acknowledgment_event SET tier=5 WHERE id=$1", [evId]),
      ).toMatch(/append_only/);
      expect(await asAdmin("DELETE FROM message_acknowledgment_event WHERE id=$1", [evId])).toMatch(
        /append_only/,
      );
      expect(
        await kit.count("SELECT count(*)::int AS n FROM message_acknowledgment_event WHERE id=$1", [
          evId,
        ]),
      ).toBe(1);
    });

    it("the tenant-destruction role may erase history (the erasure path), nobody else", async () => {
      const { id } = await freshRequest();
      await kit.admin.query("BEGIN");
      try {
        await kit.admin.query("SET LOCAL ROLE chartwarden_destruction");
        await kit.admin.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
        const res = await kit.admin.query(
          "DELETE FROM message_acknowledgment_event WHERE request_id=$1",
          [id],
        );
        expect(res.rowCount).toBe(1);
      } finally {
        await kit.admin.query("ROLLBACK");
      }
    });

    it("erasing a request or its message as a chartwarden_destruction login cascades through the append-only history", async () => {
      await kit.admin.query(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wp42_destroyer') THEN
           CREATE ROLE wp42_destroyer LOGIN PASSWORD 'wp42_destroyer_pw'; END IF; END $$;`,
      );
      // Membership is re-granted every run: the live kit drops and recreates chartwarden_destruction, which silently ends it.
      await kit.admin.query("GRANT chartwarden_destruction TO wp42_destroyer");
      const url = new URL(DB_URL as string);
      url.username = "wp42_destroyer";
      url.password = "wp42_destroyer_pw";
      const destroyer = new Client({ connectionString: url.toString() });
      await destroyer.connect();
      try {
        for (const target of ["request", "message"] as const) {
          const { id, messageId } = await freshRequest();
          await acknowledge(rn, id);
          expect((await events(id)).length).toBeGreaterThan(1);
          await destroyer.query("BEGIN");
          try {
            await destroyer.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
            const res =
              target === "request"
                ? await destroyer.query("DELETE FROM message_acknowledgment_request WHERE id=$1", [
                    id,
                  ])
                : await destroyer.query("DELETE FROM message WHERE id=$1", [messageId]);
            expect(res.rowCount).toBe(1);
            const left = await destroyer.query(
              "SELECT count(*)::int AS n FROM message_acknowledgment_event WHERE request_id=$1",
              [id],
            );
            expect(left.rows[0].n).toBe(0);
          } finally {
            await destroyer.query("ROLLBACK");
          }
        }
      } finally {
        await destroyer.end();
      }
    });

    it("the same cascade is refused for the app role and the table owner without the destruction role", async () => {
      const { id } = await freshRequest();
      // The app role has no DELETE on the request, so it cannot start the cascade at all.
      expect(
        (await asApp("DELETE FROM message_acknowledgment_request WHERE id=$1", [id])).error,
      ).toMatch(/permission denied/);
      // A superuser (the owner) deleting the parent is not the erasure path either: the history survives.
      expect(await asAdmin("DELETE FROM message_acknowledgment_request WHERE id=$1", [id])).toMatch(
        /append_only/,
      );
      expect((await events(id)).length).toBeGreaterThan(0);
    });

    it("chartwarden_app has no DELETE on either table and no UPDATE on the history", async () => {
      const priv = async (table: string, p: string) =>
        (
          await kit.one<{ ok: boolean }>(
            "SELECT has_table_privilege('chartwarden_app', $1, $2) AS ok",
            [table, p],
          )
        )[0]!.ok;
      expect(await priv("message_acknowledgment_request", "DELETE")).toBe(false);
      expect(await priv("message_acknowledgment_event", "DELETE")).toBe(false);
      expect(await priv("message_acknowledgment_event", "UPDATE")).toBe(false);
      expect(await priv("message_acknowledgment_event", "INSERT")).toBe(true);
    });
  });

  describe("deleting and editing the message", () => {
    it("deleting the message cancels the open request in the same transaction, with the actor and an event", async () => {
      const { id, messageId } = await freshRequest();
      await acknowledge(rn, id);

      const del = await app.inject({
        method: "DELETE",
        url: `/api/v1/messaging/messages/${messageId}`,
        headers: as(nurse, ORG_A),
      });

      expect(del.statusCode, del.body).toBe(204);
      expect((await row(id))?.status).toBe("cancelled");
      expect((await events(id)).at(-1)).toMatchObject({
        event_type: "cancelled",
        actor_user_id: nurse,
        to_status: "cancelled",
      });
      expect((await outboxNames(id)).at(-1)).toBe("m36.ack.cancelled");
      expect((await acknowledge(rn, id)).statusCode).toBe(409);
    });

    it("a request raised between the cancel and the tombstone (a race) makes the delete a 409 with a clear code, not a 500", async () => {
      const messageId = await routineMessage(nurse);
      await kit.admin.query(
        `CREATE OR REPLACE FUNCTION wp42_race() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
           INSERT INTO message_acknowledgment_request
             (organization_id, message_id, channel_id, patient_id, ack_class, requester_user_id, assigned_user_id, deadline_at)
           SELECT NEW.organization_id, NEW.id, NEW.channel_id, c.subject_id, 'important', NEW.author_user_id, '${rn}',
                  now() + interval '60 minutes'
             FROM channel c WHERE c.organization_id = NEW.organization_id AND c.id = NEW.channel_id;
           RETURN NEW; END $$`,
      );
      await kit.admin.query(
        `CREATE TRIGGER a_wp42_race BEFORE UPDATE ON message FOR EACH ROW
           WHEN (NEW.status = 'deleted' AND OLD.status <> 'deleted') EXECUTE FUNCTION wp42_race()`,
      );
      try {
        const del = await app.inject({
          method: "DELETE",
          url: `/api/v1/messaging/messages/${messageId}`,
          headers: as(nurse, ORG_A),
        });

        expect(del.statusCode, del.body).toBe(409);
        expect(errorCode(del)).toBe("ACK_MESSAGE_HAS_OPEN_REQUEST");
      } finally {
        await kit.admin.query("DROP TRIGGER a_wp42_race ON message");
        await kit.admin.query("DROP FUNCTION wp42_race()");
      }
      const left = await kit.one<{ status: string }>("SELECT status FROM message WHERE id=$1", [
        messageId,
      ]);
      expect(left[0]?.status).not.toBe("deleted");
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM message_acknowledgment_request WHERE message_id=$1",
          [messageId],
        ),
      ).toBe(0);
    });

    it("deleting a message whose request is already resolved cancels nothing", async () => {
      const { id, messageId } = await freshRequest();
      await acknowledge(rn, id);
      await resolve(rn, id);

      await app.inject({
        method: "DELETE",
        url: `/api/v1/messaging/messages/${messageId}`,
        headers: as(nurse, ORG_A),
      });

      expect((await row(id))?.status).toBe("resolved");
      expect((await events(id)).map((e) => e.event_type)).not.toContain("cancelled");
    });

    it("the database refuses to tombstone a message while its request is open (a path that forgot to cancel fails loudly)", async () => {
      const { messageId } = await freshRequest();

      const err = await asAdmin(
        "UPDATE message SET status='deleted', deleted_at=now(), edited_at=NULL WHERE id=$1",
        [messageId],
      );

      expect(err).toMatch(/cancel the open request/);
    });

    it("a message with a request cannot be edited (422), but the same author can still edit an ordinary message", async () => {
      const { messageId } = await freshRequest();
      const edit = await app.inject({
        method: "PATCH",
        url: `/api/v1/messaging/messages/${messageId}`,
        headers: as(nurse, ORG_A),
        payload: { body: "changed my mind" },
      });
      expect(edit.statusCode).toBe(422);
      expect(errorCode(edit)).toBe("ACK_MESSAGE_NOT_EDITABLE");

      const plain = await routineMessage(nurse);
      const ok = await app.inject({
        method: "PATCH",
        url: `/api/v1/messaging/messages/${plain}`,
        headers: as(nurse, ORG_A),
        payload: { body: "ordinary note, edited" },
      });
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it("the database refuses an edit once a request exists, even around the service", async () => {
      const { messageId } = await freshRequest();

      const err = await asAdmin("UPDATE message SET status='edited', edited_at=now() WHERE id=$1", [
        messageId,
      ]);

      expect(err).toMatch(/cannot be edited/);
    });
  });

  describe("the channel list", () => {
    it("returns every OPEN request even when more recent closed ones exceed the cap, open first", async () => {
      const listCh = await mkChannel(kit, "care_team", "bbbbbbbb-bbbb-4bbb-8bbb-0000000a42b2", [
        nurse,
        rn,
        rn2,
      ]);
      const raise = async (assignee: string) => {
        const messageId = await routineMessage(nurse, listCh);
        const res = await create(nurse, messageId, assignee);
        expect(res.statusCode, res.body).toBe(201);
        return res.json().request.id as string;
      };
      const oldOpen = await raise(rn);
      const secondOpen = await raise(rn2);
      const closed: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const id = await raise(rn);
        await acknowledge(rn, id);
        await resolve(rn, id);
        closed.push(id);
      }
      const store = createDbAckStore(kit.handle.db);
      const list = (limit: number) =>
        store.run({ orgId: ORG_A, userId: nurse }, (tx) => tx.listForChannel(listCh, limit));

      const capped = await list(3);
      expect(capped.map((r) => r.id)).toEqual([secondOpen, oldOpen, closed[3]]);

      // The cap never drops an open request: two open rows and a cap of one still return both.
      expect((await list(1)).map((r) => r.id)).toEqual([secondOpen, oldOpen]);
      expect((await list(100)).map((r) => r.id)).toEqual([
        secondOpen,
        oldOpen,
        closed[3],
        closed[2],
        closed[1],
        closed[0],
      ]);
    });
  });

  describe("audit", () => {
    it("every transition has an audit row naming the actor, and the patient id is not copied into it", async () => {
      const { id } = await freshRequest();
      await acknowledge(rn, id);
      await reassign(rn, id, rn2);

      const rows = await kit.one<{
        event_type: string;
        actor_user_id: string;
        before: unknown;
        after: unknown;
      }>(
        "SELECT event_type, actor_user_id, before, after FROM audit_event WHERE resource_id=$1 AND resource_kind='message_acknowledgment_request' AND event_type NOT LIKE '%.viewed' ORDER BY created_at, id",
        [id],
      );

      expect(rows.map((r) => [r.event_type, r.actor_user_id])).toEqual([
        ["message_acknowledgment_request.insert", nurse],
        ["message_acknowledgment_request.update", rn],
        ["message_acknowledgment_request.update", rn],
      ]);
      expect(JSON.stringify(rows)).not.toContain(PATIENT);
    });

    it("the reads and transitions land read-audit rows with the resource id", async () => {
      const { id } = await freshRequest();
      await getJson(app, rn, `${BASE}/${id}`);
      await getJson(app, rn, `/api/v1/messaging/channels/${channel}/escalations`);

      const q =
        "SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND resource_id=$2 AND actor_user_id=$3 AND event_type LIKE '%.viewed'";
      expect(await kit.count(q, [ORG_A, id, rn])).toBeGreaterThanOrEqual(1);
      expect(await kit.count(q, [ORG_A, channel, rn])).toBeGreaterThanOrEqual(1);
    });
  });

  describe("notification", () => {
    const emitted: Array<{ org: string; alert: Record<string, unknown> }> = [];
    const alerts = {
      emit: async (org: string, alert: Record<string, unknown>) => {
        emitted.push({ org, alert });
        return { alertId: "a", resolvedRecipientCount: 1 };
      },
    } as unknown as AlertEmitter;
    const consumer = () =>
      buildM36AckNotificationsConsumer({
        alerts,
        messaging: kit.service,
        isWaitingForAssignee: ack.isWaitingForAssignee,
        stillQualified: ack.stillQualified,
      });
    const stored = async (id: string, type: string) => {
      const [e] = await kit.one<{ id: string; payload: Record<string, unknown> }>(
        "SELECT id, payload FROM outbox_event WHERE aggregate_id=$1 AND event_type=$2 ORDER BY created_at DESC LIMIT 1",
        [id, type],
      );
      return { id: e!.id, eventType: type, organizationId: ORG_A, payload: e!.payload } as never;
    };

    it("feeds the stored important event through the real consumer: ONE generic alert, no patient, name or text", async () => {
      const { id } = await freshRequest();
      emitted.length = 0;

      await consumer().handle(await stored(id, "m36.ack.requested"));

      expect(emitted).toHaveLength(1);
      const alert = emitted[0]!.alert;
      expect(alert).toMatchObject({ eventType: "m36.ack.requested", severity: "warn" });
      expect(alert.payload).toMatchObject({ recipientUserId: rn });
      expect(JSON.stringify(alert)).not.toMatch(new RegExp(`${PATIENT}|routine note|Uncontrolled`));
    });

    it("stays silent for the urgent class (the 4.1 alert covers it)", async () => {
      const sent = await post(app, nurse, `/api/v1/messaging/channels/${channel}/urgent-messages`, {
        client_message_id: randomUUID(),
        body_doc: sbarDoc(),
        recipient_user_id: rn,
      });
      const [r] = await kit.one<{ id: string }>(
        "SELECT id FROM message_acknowledgment_request WHERE message_id=$1",
        [sent.json().message_id],
      );
      emitted.length = 0;

      await consumer().handle(await stored(r!.id, "m36.ack.requested"));

      expect(emitted).toHaveLength(0);
    });

    it("alerts the NEW assignee of a reassign, and a stale event (reassigned again since) alerts nobody", async () => {
      const { id } = await freshRequest();
      await reassign(nurse, id, rn2);
      const toRn2 = await stored(id, "m36.ack.reassigned");
      emitted.length = 0;
      await consumer().handle(toRn2);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.alert.payload).toMatchObject({ recipientUserId: rn2 });

      await reassign(nurse, id, rn);
      emitted.length = 0;
      await consumer().handle(toRn2);
      expect(emitted).toHaveLength(0);
    });

    it("a stale event alerts nobody once the request was taken, even though it is still open and still hers", async () => {
      const { id } = await freshRequest();
      const requested = await stored(id, "m36.ack.requested");
      await acknowledge(rn, id);
      emitted.length = 0;

      await consumer().handle(requested);

      expect(emitted).toHaveLength(0);
    });
  });

  describe("tenancy", () => {
    it("another tenant reads none of it through RLS, and cannot write", async () => {
      const { id } = await freshRequest();

      const readOther = await asApp(
        "SELECT id FROM message_acknowledgment_request WHERE id=$1",
        [id],
        { org: ORG_B },
      );
      const readEvents = await asApp(
        "SELECT id FROM message_acknowledgment_event WHERE request_id=$1",
        [id],
        { org: ORG_B },
      );
      const writeOther = await asApp(
        "UPDATE message_acknowledgment_request SET status='cancelled', cancelled_at=now(), version=version+1 WHERE id=$1",
        [id],
        { org: ORG_B },
      );

      expect(readOther.rows).toEqual([]);
      expect(readEvents.rows).toEqual([]);
      expect(writeOther.error).toBeNull();
      expect((await row(id))?.status).toBe("pending");
    });

    it("the other tenant's calls on this tenant's request are the uniform 404 and change nothing", async () => {
      const { id } = await freshRequest();
      const before = await totals();
      for (const action of ["acknowledge", "resolve"]) {
        const res = await post(
          app,
          orgBUser,
          `${BASE}/${id}/${action}`,
          {},
          { org: ORG_B, key: null },
        );
        expect(res.statusCode, action).toBe(404);
      }
      const re = await post(
        app,
        orgBUser,
        `${BASE}/${id}/reassign`,
        { assigned_user_id: orgBUser },
        { org: ORG_B, key: null },
      );
      expect(re.statusCode).toBe(404);
      expect(await totals()).toEqual(before);
    });
  });
});
