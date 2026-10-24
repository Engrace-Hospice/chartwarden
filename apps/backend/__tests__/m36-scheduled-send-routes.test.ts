// WP 2.6 - scheduled-send routes over a recording service double: auth, channel gate, announcement guard, Idempotency-Key,
// owner scoping, validation, error mapping, no-store and read audit.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
import {
  type AnnouncementService,
  type ScheduledMessageView,
  type ScheduledSendService,
  createInMemoryMessagingService,
} from "@chartwarden/messaging";
import { NotFoundError, ChartWardenError } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import { registerScheduledSendRoutes } from "../src/modules/36-messaging/routes/scheduled-send-routes";

const ORG = "org_a";
const CH = "aaaaaaaa-aaaa-4aaa-8aaa-00000000c4c4";
const NEWS = "aaaaaaaa-aaaa-4aaa-8aaa-00000000d5d5";
const ROOT = "bbbbbbbb-bbbb-4bbb-8bbb-00000000d0d0";
const SID = "cccccccc-cccc-4ccc-8ccc-00000000e1e1";
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

interface CapturedRow {
  eventType: string;
  resourceKind: string;
  resourceId?: string;
}
let captured: CapturedRow[] = [];
const fakeTx = {
  execute: async () => undefined,
  insert: () => ({
    values: async (row: CapturedRow) => {
      captured.push(row);
    },
  }),
};
const fakeDb = {
  transaction: async (fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx),
} as unknown as DbClient;

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = ["clinical_rn"];
  request.context.locationIds = [];
}

/** Records calls; owner-scoped like the real service so the routes' user binding is observable. */
function recordingService() {
  const rows = new Map<string, ScheduledMessageView & { owner: string }>();
  const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
  const service: ScheduledSendService = {
    async create(_org, input) {
      calls.push({ op: "create", input: { ...input } });
      if (input.body === "full") throw new ChartWardenError("SCHEDULE_LIMIT_REACHED", "cap", 409);
      const view: ScheduledMessageView = {
        id: SID,
        channelId: input.channelId,
        parentMessageId: input.parentMessageId ?? null,
        body: input.body,
        scheduledFor: input.scheduledFor,
        timeZone: input.timeZone ?? "UTC",
        status: "pending",
        blockedReason: null,
        createdAt: FUTURE,
        updatedAt: FUTURE,
      };
      rows.set(SID, { ...view, owner: input.userId });
      return view;
    },
    async listMine(_org, input) {
      calls.push({ op: "list", input: { ...input } });
      return [...rows.values()]
        .filter(
          (r) => r.owner === input.userId && (!input.channelId || r.channelId === input.channelId),
        )
        .map(({ owner: _owner, ...view }) => view);
    },
    async cancel(_org, input) {
      calls.push({ op: "cancel", input: { ...input } });
      const row = rows.get(input.id);
      if (!row || row.owner !== input.userId) return { cancelled: false };
      rows.delete(input.id);
      return { cancelled: true };
    },
    async reschedule(_org, input) {
      calls.push({ op: "reschedule", input: { ...input } });
      const row = rows.get(input.id);
      if (!row || row.owner !== input.userId)
        throw new NotFoundError("scheduled_message", input.id);
      return { ...row, scheduledFor: input.scheduledFor };
    },
  };
  return { service, calls };
}

function makeServer(perms: Record<string, string[]> = {}) {
  const messaging = createInMemoryMessagingService({
    seed: {
      eligibleStaff: ["rn_1", "rn_2", "rn_3"].map((userId) => ({
        orgId: ORG,
        userId,
        displayName: userId,
        roles: ["clinical_rn"],
      })),
      channels: [
        {
          channelId: CH,
          orgId: ORG,
          kind: "location" as const,
          subjectId: "loc_1",
          members: [{ userId: "rn_1" }, { userId: "rn_2" }],
        },
        {
          channelId: NEWS,
          orgId: ORG,
          kind: "location" as const,
          subjectId: "loc_2",
          members: [{ userId: "rn_1" }, { userId: "rn_2" }],
        },
      ],
    },
  });
  const grants = createInMemoryEffectivePermissionStore(
    ["rn_1", "rn_2", "rn_3"].map((userId) => ({
      orgId: ORG,
      userId,
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: perms[userId] ?? ["messaging.read", "messaging.send"],
        },
      ],
    })),
  );
  registerEffectivePermissionResolver(grants.store);
  const registry = createPredicateRegistry();
  registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) =>
    typeof target.id === "string" && ctx.organizationId && ctx.userId
      ? messaging.canViewChannel(ctx.organizationId, ctx.userId, target.id)
      : false,
  );
  registerAbacRegistry(registry);
  const app = buildServer({
    db: fakeDb,
    authenticate: headerAuth,
    security: { rateLimitEnabled: false },
  });
  const recorder = recordingService();
  registerScheduledSendRoutes(app, {
    service: recorder.service,
    // NEWS stands in for the announcement channel
    announcements: {
      isAnnouncementChannel: async (_org: string, _user: string, id: string) => id === NEWS,
    } as unknown as AnnouncementService,
  });
  return { app, calls: recorder.calls };
}

const as = (user: string, key?: string) => ({
  "x-test-user": user,
  ...(key ? { "idempotency-key": key } : {}),
});
const create = (
  app: ReturnType<typeof makeServer>["app"],
  user: string,
  payload: object,
  channel = CH,
  key: string | null = `k-${++keySeq}`,
) =>
  app.inject({
    method: "POST",
    url: `/api/v1/messaging/channels/${channel}/scheduled-messages`,
    headers: as(user, key ?? undefined),
    payload,
  });
let keySeq = 0;
const ok = { body: "hello", scheduledFor: FUTURE, timeZone: "America/Chicago" };

beforeEach(() => {
  captured = [];
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("scheduled-send routes", () => {
  it("creates for the caller, taking org and user from the session, never the body", async () => {
    const { app, calls } = makeServer();
    const res = await create(app, "rn_1", { ...ok, userId: "rn_2", organizationId: "other" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: SID, status: "pending", body: "hello" });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(calls[0]).toMatchObject({ op: "create", input: { userId: "rn_1", channelId: CH } });
    await app.close();
  });

  it("requires an Idempotency-Key to create", async () => {
    const { app, calls } = makeServer();
    const res = await create(app, "rn_1", ok, CH, null);
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("refuses a user who cannot see the channel, and a user without messaging.send", async () => {
    const { app } = makeServer({ rn_2: ["messaging.read"] });
    expect((await create(app, "rn_3", ok)).statusCode).toBe(403);
    expect((await create(app, "rn_2", ok)).statusCode).toBe(403);
    await app.close();
  });

  it("keeps the announcement channel org_admin-only: messaging.announce is required", async () => {
    const { app } = makeServer({
      rn_2: ["messaging.read", "messaging.send", "messaging.announce"],
    });
    expect((await create(app, "rn_1", ok, NEWS)).statusCode).toBe(403);
    expect((await create(app, "rn_2", ok, NEWS)).statusCode).toBe(201);
    await app.close();
  });

  it("is 401 without a session and 404 for a malformed channel id", async () => {
    const { app } = makeServer();
    const anon = await app.inject({ method: "GET", url: "/api/v1/messaging/scheduled-messages" });
    expect(anon.statusCode).toBe(401);
    expect((await create(app, "rn_1", ok, "not-a-uuid")).statusCode).toBe(404);
    await app.close();
  });

  it("422s a malformed body, an unparseable time and a malformed parent id", async () => {
    const { app } = makeServer();
    expect((await create(app, "rn_1", { body: "x" })).statusCode).toBe(422);
    expect((await create(app, "rn_1", { ...ok, scheduledFor: "soon" })).statusCode).toBe(422);
    expect((await create(app, "rn_1", { ...ok, parentMessageId: "nope" })).statusCode).toBe(422);
    expect((await create(app, "rn_1", { ...ok, parentMessageId: ROOT })).statusCode).toBe(201);
    await app.close();
  });

  it("maps the service's limit error to 409", async () => {
    const { app } = makeServer();
    const res = await create(app, "rn_1", { ...ok, body: "full" });
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.json())).toContain("SCHEDULE_LIMIT_REACHED");
    await app.close();
  });

  it("lists only the caller's own, no-store, with a read-audit row that has no body", async () => {
    const { app } = makeServer();
    await create(app, "rn_1", ok);
    const mine = await app.inject({
      method: "GET",
      url: "/api/v1/messaging/scheduled-messages",
      headers: as("rn_1"),
    });
    expect(mine.json().scheduledMessages).toHaveLength(1);
    expect(mine.headers["cache-control"]).toBe("no-store");
    const other = await app.inject({
      method: "GET",
      url: "/api/v1/messaging/scheduled-messages",
      headers: as("rn_2"),
    });
    expect(other.json().scheduledMessages).toHaveLength(0);
    expect(captured.some((r) => r.resourceKind === "scheduled_message")).toBe(true);
    expect(JSON.stringify(captured)).not.toContain("hello");
    await app.close();
  });

  it("cancels idempotently and only the caller's own", async () => {
    const { app } = makeServer();
    await create(app, "rn_1", ok);
    const del = (user: string) =>
      app.inject({
        method: "DELETE",
        url: `/api/v1/messaging/scheduled-messages/${SID}`,
        headers: as(user),
      });
    expect((await del("rn_2")).json()).toEqual({ cancelled: false });
    expect((await del("rn_1")).json()).toEqual({ cancelled: true });
    expect((await del("rn_1")).json()).toEqual({ cancelled: false });
    const bad = await app.inject({
      method: "DELETE",
      url: "/api/v1/messaging/scheduled-messages/not-a-uuid",
      headers: as("rn_1"),
    });
    expect(bad.statusCode).toBe(404);
    await app.close();
  });

  it("reschedules the caller's own; a colleague's id is a 404 (no oracle)", async () => {
    const { app } = makeServer();
    await create(app, "rn_1", ok);
    const later = new Date(Date.now() + 7_200_000).toISOString();
    const patch = (user: string, payload: object) =>
      app.inject({
        method: "PATCH",
        url: `/api/v1/messaging/scheduled-messages/${SID}`,
        headers: as(user),
        payload,
      });
    const moved = await patch("rn_1", { scheduledFor: later });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().scheduledFor).toBe(later);
    expect((await patch("rn_2", { scheduledFor: later })).statusCode).toBe(404);
    expect((await patch("rn_1", {})).statusCode).toBe(422);
    await app.close();
  });
});
