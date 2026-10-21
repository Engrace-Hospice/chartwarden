// WP 4.10 (ADR-0077) - snooze and reminder routes over the real service on an in-memory store: auth, permission, Idempotency-Key,
// owner scoping, validation, the typed urgent refusals, the uniform 404 when the feature is off, no-store and read audit.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  requirePermission,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
import { createInMemoryMessagingService } from "@chartwarden/messaging";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import { REQUIRE_IDEMPOTENCY_KEY } from "../src/modules/36-messaging/routes/messaging-routes";
import {
  DISABLED_SNOOZE_REMINDER,
  registerSnoozeReminderRoutes,
} from "../src/modules/36-messaging/routes/snooze-reminder-routes";
import { createSnoozeReminderService } from "../src/modules/36-messaging/snooze-reminders/snooze-reminder-service";
import { createMemorySnoozeReminderStore } from "../src/modules/36-messaging/snooze-reminders/snooze-reminder-test-kit";

const ORG = "11111111-1111-4111-8111-111111111111";
const CH = "aaaaaaaa-aaaa-4aaa-8aaa-00000000c4c4";
const MSG = "bbbbbbbb-bbbb-4bbb-8bbb-00000000d0d0";
const URGENT_MSG = "bbbbbbbb-bbbb-4bbb-8bbb-00000000d1d1";
const MIN = 60_000;

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

const USERS = ["rn_1", "rn_2", "rn_3"];

function makeServer(options: { enabled?: boolean; perms?: Record<string, string[]> } = {}) {
  const messaging = createInMemoryMessagingService({
    seed: {
      eligibleStaff: USERS.map((userId) => ({
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
      ],
    },
  });
  const grants = createInMemoryEffectivePermissionStore(
    USERS.map((userId) => ({
      orgId: ORG,
      userId,
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: options.perms?.[userId] ?? ["messaging.read", "messaging.send"],
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
  const kit = createMemorySnoozeReminderStore({
    messages: new Map([
      [`${ORG}:${MSG}`, { channelId: CH }],
      [`${ORG}:${URGENT_MSG}`, { channelId: CH, urgent: true }],
    ]),
  });
  const service = createSnoozeReminderService({
    isEnabled: async () => options.enabled !== false,
    store: kit.store,
    canViewChannel: messaging.canViewChannel,
  });
  registerSnoozeReminderRoutes(
    app,
    { service },
    {
      read: requirePermission("messaging.read") as never,
      requireIdempotencyKey: REQUIRE_IDEMPOTENCY_KEY,
    },
  );
  return { app, kit };
}

let keySeq = 0;
const as = (user: string, withKey = false) => ({
  "x-test-user": user,
  ...(withKey ? { "idempotency-key": `k-${++keySeq}` } : {}),
});
type App = ReturnType<typeof makeServer>["app"];
const snoozeUrl = `/api/v1/messaging/channels/${CH}/snooze`;
const putSnooze = (app: App, user: string, payload: object, withKey = true, channel = CH) =>
  app.inject({
    method: "PUT",
    url: `/api/v1/messaging/channels/${channel}/snooze`,
    headers: as(user, withKey),
    payload,
  });
const reminderUrl = (id = MSG) => `/api/v1/messaging/messages/${id}/reminder`;
const putReminder = (app: App, user: string, payload: object, withKey = true, id = MSG) =>
  app.inject({ method: "PUT", url: reminderUrl(id), headers: as(user, withKey), payload });
const inMinutes = (n: number) => new Date(Date.now() + n * MIN).toISOString();

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

describe("snooze routes", () => {
  it("snoozes for the session user, never a user or organisation named in the body; no-store", async () => {
    const { app, kit } = makeServer();
    const res = await putSnooze(app, "rn_1", {
      duration_minutes: 60,
      user_id: "rn_2",
      organization_id: "other",
    });
    // additionalProperties: false - a body that names someone else is refused outright.
    expect(res.statusCode).toBe(422);
    expect(kit.snoozes.size).toBe(0);
    const ok = await putSnooze(app, "rn_1", { duration_minutes: 60 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ channel_id: CH, snoozable: true });
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect([...kit.snoozes.keys()]).toEqual([`${ORG}:rn_1:${CH}`]);
    await app.close();
  });

  it("requires an Idempotency-Key, a session and messaging.read; a bad channel id is a 404", async () => {
    const { app, kit } = makeServer({ perms: { rn_2: [] } });
    expect((await putSnooze(app, "rn_1", { duration_minutes: 60 }, false)).statusCode).toBe(400);
    const anon = await app.inject({ method: "GET", url: snoozeUrl });
    expect(anon.statusCode).toBe(401);
    expect((await putSnooze(app, "rn_2", { duration_minutes: 60 })).statusCode).toBe(403);
    expect(
      (await putSnooze(app, "rn_1", { duration_minutes: 60 }, true, "not-a-uuid")).statusCode,
    ).toBe(404);
    expect(kit.snoozes.size).toBe(0);
    await app.close();
  });

  it("422s a duration outside 5 minutes to 24 hours and a non-integer", async () => {
    const { app } = makeServer();
    for (const duration_minutes of [4, 1441, 0, -1, 1.5]) {
      expect((await putSnooze(app, "rn_1", { duration_minutes })).statusCode).toBe(422);
    }
    expect((await putSnooze(app, "rn_1", {})).statusCode).toBe(422);
    expect((await putSnooze(app, "rn_1", { duration_minutes: 1440 })).statusCode).toBe(200);
    await app.close();
  });

  it("a non-member sees the uniform 404 for read, write and the state of a conversation", async () => {
    const { app, kit } = makeServer();
    expect((await putSnooze(app, "rn_3", { duration_minutes: 60 })).statusCode).toBe(404);
    const get = await app.inject({ method: "GET", url: snoozeUrl, headers: as("rn_3") });
    expect(get.statusCode).toBe(404);
    expect(kit.snoozes.size).toBe(0);
    await app.close();
  });

  it("an open acknowledgment request answers the typed 409 and the state says not snoozable", async () => {
    const { app, kit } = makeServer();
    kit.openRequests.add(`${ORG}:rn_1:${CH}`);
    const res = await putSnooze(app, "rn_1", { duration_minutes: 60 });
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.json())).toContain("SNOOZE_URGENT_NOT_ALLOWED");
    const get = await app.inject({ method: "GET", url: snoozeUrl, headers: as("rn_1") });
    expect(get.json()).toEqual({ channel_id: CH, snoozed_until: null, snoozable: false });
    expect(kit.snoozes.size).toBe(0);
    await app.close();
  });

  it("reads the caller's own state (read-audited against the channel), and ends it idempotently", async () => {
    const { app } = makeServer();
    await putSnooze(app, "rn_1", { duration_minutes: 60 });
    const mine = await app.inject({ method: "GET", url: snoozeUrl, headers: as("rn_1") });
    expect(mine.json().snoozed_until).not.toBeNull();
    const peer = await app.inject({ method: "GET", url: snoozeUrl, headers: as("rn_2") });
    expect(peer.json().snoozed_until).toBeNull();
    expect(captured.some((r) => r.resourceKind === "channel" && r.resourceId === CH)).toBe(true);
    const del = (user: string) =>
      app.inject({ method: "DELETE", url: snoozeUrl, headers: as(user) });
    expect((await del("rn_2")).json()).toEqual({ cleared: false });
    expect((await del("rn_1")).json()).toEqual({ cleared: true });
    expect((await del("rn_1")).json()).toEqual({ cleared: false });
    await app.close();
  });
});

describe("reminder routes", () => {
  it("sets one for the session user and lists only the caller's own, read-audited", async () => {
    const { app } = makeServer();
    const res = await putReminder(app, "rn_1", { remind_at: inMinutes(30) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ message_id: MSG, channel_id: CH });
    expect(res.headers["cache-control"]).toBe("no-store");
    const list = (user: string) =>
      app.inject({ method: "GET", url: "/api/v1/messaging/reminders", headers: as(user) });
    expect((await list("rn_1")).json().reminders).toHaveLength(1);
    expect((await list("rn_1")).json().max_pending).toBe(25);
    expect((await list("rn_2")).json().reminders).toHaveLength(0);
    expect(captured.some((r) => r.resourceKind === "message_reminder")).toBe(true);
    await app.close();
  });

  it("requires an Idempotency-Key and refuses a body that names another user or has no offset", async () => {
    const { app, kit } = makeServer();
    expect((await putReminder(app, "rn_1", { remind_at: inMinutes(30) }, false)).statusCode).toBe(
      400,
    );
    expect(
      (await putReminder(app, "rn_1", { remind_at: inMinutes(30), user_id: "rn_2" })).statusCode,
    ).toBe(422);
    const noOffset = await putReminder(app, "rn_1", { remind_at: "2030-01-01T10:00:00" });
    expect(noOffset.statusCode).toBe(422);
    expect(JSON.stringify(noOffset.json())).toContain("REMINDER_TIME_INVALID");
    expect(kit.reminders.size).toBe(0);
    await app.close();
  });

  it("422s a time under a minute or beyond 30 days", async () => {
    const { app } = makeServer();
    expect((await putReminder(app, "rn_1", { remind_at: inMinutes(0) })).statusCode).toBe(422);
    expect(
      (await putReminder(app, "rn_1", { remind_at: inMinutes(31 * 24 * 60) })).statusCode,
    ).toBe(422);
    await app.close();
  });

  it("an urgent message answers the typed 409; a hidden or unknown message is the uniform 404", async () => {
    const { app } = makeServer();
    const urgent = await putReminder(app, "rn_1", { remind_at: inMinutes(30) }, true, URGENT_MSG);
    expect(urgent.statusCode).toBe(409);
    expect(JSON.stringify(urgent.json())).toContain("REMINDER_URGENT_NOT_ALLOWED");
    const hidden = await putReminder(app, "rn_3", { remind_at: inMinutes(30) });
    expect(hidden.statusCode).toBe(404);
    const unknown = await putReminder(
      app,
      "rn_1",
      { remind_at: inMinutes(30) },
      true,
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    );
    expect(unknown.statusCode).toBe(404);
    // The same body, whatever the reason (only the per-request correlation id differs).
    const shape = (res: typeof hidden) => ({ ...res.json().error, correlationId: undefined });
    expect(shape(hidden)).toEqual(shape(unknown));
    await app.close();
  });

  it("cancels idempotently and only the caller's own", async () => {
    const { app } = makeServer();
    await putReminder(app, "rn_1", { remind_at: inMinutes(30) });
    const del = (user: string) =>
      app.inject({ method: "DELETE", url: reminderUrl(), headers: as(user) });
    expect((await del("rn_2")).json()).toEqual({ cleared: false });
    expect((await del("rn_1")).json()).toEqual({ cleared: true });
    expect((await del("rn_1")).json()).toEqual({ cleared: false });
    const bad = await app.inject({
      method: "DELETE",
      url: reminderUrl("nope"),
      headers: as("rn_1"),
    });
    expect(bad.statusCode).toBe(404);
    await app.close();
  });
});

describe("with the feature off", () => {
  it("every route is the same 404 and nothing is written", async () => {
    const { app, kit } = makeServer({ enabled: false });
    const calls = [
      app.inject({ method: "GET", url: snoozeUrl, headers: as("rn_1") }),
      putSnooze(app, "rn_1", { duration_minutes: 60 }),
      app.inject({ method: "DELETE", url: snoozeUrl, headers: as("rn_1") }),
      app.inject({ method: "GET", url: "/api/v1/messaging/reminders", headers: as("rn_1") }),
      putReminder(app, "rn_1", { remind_at: inMinutes(30) }),
      app.inject({ method: "DELETE", url: reminderUrl(), headers: as("rn_1") }),
    ];
    for (const res of await Promise.all(calls)) expect(res.statusCode).toBe(404);
    expect(kit.snoozes.size + kit.reminders.size).toBe(0);
    await app.close();
  });

  it("the default (no service bound) is also the uniform 404", async () => {
    const { app } = makeServer();
    await app.close();
    const bare = buildServer({
      db: fakeDb,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
    });
    registerSnoozeReminderRoutes(bare, DISABLED_SNOOZE_REMINDER, {
      read: requirePermission("messaging.read") as never,
      requireIdempotencyKey: REQUIRE_IDEMPOTENCY_KEY,
    });
    const res = await bare.inject({
      method: "GET",
      url: "/api/v1/messaging/reminders",
      headers: as("rn_1"),
    });
    expect(res.statusCode).toBe(404);
    await bare.close();
  });
});
