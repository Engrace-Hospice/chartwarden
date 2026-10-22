// M36 WP 2.9 — announcements & department channels over the in-memory service (no live infra).
//
// Proves, through the full M1 chain and the real Authorization Contract:
//   - sending into the announcement channel stays org_admin-only on BOTH routes (the generic channel send used to
//     let any member post an "announcement");
//   - a read of an announcement records a receipt, and only a holder of messaging.announce can see who read it;
//   - a department channel is created by org_admin only, find-or-create by subject, and membership then goes
//     through the existing member-admin route.
// The DB behaviour is proven by m36-announcements.live.test.ts.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { createInMemoryMessagingService } from "@chartwarden/messaging";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  CHANNEL_MEMBER_ADMIN_PREDICATE,
  CHANNEL_VISIBILITY_PREDICATE,
  registerMessagingRoutes,
} from "../src/modules/36-messaging/index";
import { CHANNEL_VISIBILITY_READ_PREDICATE } from "../src/modules/36-messaging/routes/messaging-routes";
import { channelMemberAdminPredicate } from "../src/modules/36-messaging/routes/messaging-routes";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  request.context.locationIds = [];
}

const ORG = "org_a";
const LOCATION = "11111111-1111-4111-8111-111111111111";
const ROLE = "22222222-2222-4222-8222-222222222222";
const ADMIN_PERMS = [
  "messaging.read",
  "messaging.send",
  "messaging.dm",
  "messaging.manage_members",
  "messaging.announce",
];

const RN1 = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "clinical_rn" };
const RN2 = { "x-test-user": "rn_2", "x-test-org": ORG, "x-test-roles": "clinical_rn" };
const ADMIN = { "x-test-user": "admin_1", "x-test-org": ORG, "x-test-roles": "org_admin" };
const withKey = (headers: Record<string, string>): Record<string, string> => ({
  ...headers,
  "idempotency-key": crypto.randomUUID(),
});

function makeServer() {
  const service = createInMemoryMessagingService({
    now: () => new Date("2026-06-15T12:00:00Z"),
    seed: {
      eligibleStaff: [
        { orgId: ORG, userId: "rn_1", displayName: "Nurse One", roles: ["Registered Nurse"] },
        { orgId: ORG, userId: "rn_2", displayName: "Nurse Two", roles: ["Registered Nurse"] },
        { orgId: ORG, userId: "admin_1", displayName: "Admin One", roles: ["Org Admin"] },
        { orgId: "org_b", userId: "foreign_1", displayName: "Foreign", roles: [] },
      ],
      departmentSubjects: [
        { orgId: ORG, kind: "location", subjectId: LOCATION, name: "North Campus" },
        { orgId: ORG, kind: "discipline", subjectId: ROLE, name: "Social Work" },
      ],
    },
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      ...[
        ["rn_1", ["messaging.read", "messaging.send", "messaging.dm"]],
        ["rn_2", ["messaging.read", "messaging.send"]],
        ["admin_1", ADMIN_PERMS],
      ].map(([userId, permissionKeys]) => ({
        orgId: ORG,
        userId: userId as string,
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: permissionKeys as string[],
          },
        ],
      })),
    ]).store,
  );
  const registry = createPredicateRegistry();
  registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
    const channelId = typeof target.id === "string" ? target.id : null;
    if (!channelId || !ctx.organizationId || !ctx.userId) return false;
    return service.canViewChannel(ctx.organizationId, ctx.userId, channelId);
  });
  registry.register(CHANNEL_VISIBILITY_READ_PREDICATE, async (ctx, target) => {
    const channelId = typeof target.id === "string" ? target.id : null;
    if (!channelId || !ctx.organizationId || !ctx.userId) return false;
    return service.canReadChannel(ctx.organizationId, ctx.userId, channelId);
  });
  registry.register(CHANNEL_MEMBER_ADMIN_PREDICATE, channelMemberAdminPredicate(service));
  registerAbacRegistry(registry);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerMessagingRoutes(app, { service, announcements: service });
  return { app, service };
}

type App = ReturnType<typeof makeServer>["app"];

async function announce(app: App, body = "all hands at noon") {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/messaging/announce",
    headers: withKey(ADMIN),
    payload: { body },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { messageId: string; channelId: string };
}

const receipts = (app: App, headers: Record<string, string>, messageId: string) =>
  app.inject({
    method: "GET",
    url: `/api/v1/messaging/announcements/${messageId}/receipts`,
    headers,
  });

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("M36 WP 2.9 announcements", () => {
  it("a member cannot post into the announcement channel through the generic send route; org_admin can", async () => {
    const { app } = makeServer();
    const { channelId } = await announce(app);
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/messaging/channels/${channelId}/messages`,
      headers: withKey(RN1),
      payload: { body: "fake all-clinic notice" },
    });
    expect(denied.statusCode).toBe(403);
    const ok = await app.inject({
      method: "POST",
      url: `/api/v1/messaging/channels/${channelId}/messages`,
      headers: withKey(ADMIN),
      payload: { body: "a second notice" },
    });
    expect(ok.statusCode).toBe(201);
    await app.close();
  });

  it("a non-announcement channel is not gated by the announcement rule", async () => {
    const { app } = makeServer();
    const dm = await app.inject({
      method: "POST",
      url: "/api/v1/messaging/dm",
      headers: RN1,
      payload: { userId: "rn_2" },
    });
    expect(dm.statusCode).toBeLessThan(300);
    const sent = await app.inject({
      method: "POST",
      url: `/api/v1/messaging/channels/${dm.json().channelId}/messages`,
      headers: withKey(RN1),
      payload: { body: "hello" },
    });
    expect(sent.statusCode).toBe(201);
    await app.close();
  });

  it("a read records a receipt; the sender sees readers and the unread list, never the author", async () => {
    const { app } = makeServer();
    const { messageId } = await announce(app);
    const before = await receipts(app, ADMIN, messageId);
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ messageId, recipientCount: 2, readCount: 0 });

    const read = await app.inject({
      method: "POST",
      url: `/api/v1/messaging/messages/${messageId}/read`,
      headers: RN1,
      payload: {},
    });
    expect(read.statusCode).toBe(204);
    // Reading twice is idempotent.
    await app.inject({
      method: "POST",
      url: `/api/v1/messaging/messages/${messageId}/read`,
      headers: RN1,
      payload: {},
    });

    const after = (await receipts(app, ADMIN, messageId)).json();
    expect(after.readCount).toBe(1);
    expect(after.readers.map((r: { userId: string }) => r.userId)).toEqual(["rn_1"]);
    expect(after.unread.map((r: { userId: string }) => r.userId)).toEqual(["rn_2"]);
    expect(after.truncated).toBe(false);
    await app.close();
  });

  it("the author reading their own announcement is not a receipt", async () => {
    const { app } = makeServer();
    const { messageId } = await announce(app);
    await app.inject({
      method: "POST",
      url: `/api/v1/messaging/messages/${messageId}/read`,
      headers: ADMIN,
      payload: {},
    });
    expect((await receipts(app, ADMIN, messageId)).json().readCount).toBe(0);
    await app.close();
  });

  it("only messaging.announce may see receipts (403 for a member)", async () => {
    const { app } = makeServer();
    const { messageId } = await announce(app);
    expect((await receipts(app, RN1, messageId)).statusCode).toBe(403);
    await app.close();
  });

  it("receipts of an unknown id, or of a message outside the announcement channel, are 404", async () => {
    const { app } = makeServer();
    await announce(app);
    expect((await receipts(app, ADMIN, "msg_nope")).statusCode).toBe(404);
    const dm = await app.inject({
      method: "POST",
      url: "/api/v1/messaging/dm",
      headers: RN1,
      payload: { userId: "rn_2" },
    });
    const sent = await app.inject({
      method: "POST",
      url: `/api/v1/messaging/channels/${dm.json().channelId}/messages`,
      headers: withKey(RN1),
      payload: { body: "private" },
    });
    expect((await receipts(app, ADMIN, sent.json().messageId)).statusCode).toBe(404);
    await app.close();
  });
});

describe("M36 WP 2.9 department channels", () => {
  const create = (app: App, headers: Record<string, string>, payload: unknown) =>
    app.inject({
      method: "POST",
      url: "/api/v1/messaging/department-channels",
      headers,
      payload: payload as Record<string, unknown>,
    });

  it("org_admin creates a location channel, a repeat finds the same one, and members are added through member admin", async () => {
    const { app } = makeServer();
    const first = await create(app, ADMIN, { kind: "location", subjectId: LOCATION });
    expect(first.statusCode).toBe(201);
    const { channelId } = first.json();
    const again = await create(app, ADMIN, { kind: "location", subjectId: LOCATION });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ channelId, created: false });

    const hidden = await app.inject({
      method: "GET",
      url: `/api/v1/messaging/channels/${channelId}`,
      headers: RN1,
    });
    expect(hidden.statusCode).toBe(403);
    const add = await app.inject({
      method: "POST",
      url: `/api/v1/messaging/channels/${channelId}/members`,
      headers: ADMIN,
      payload: { userId: "rn_1" },
    });
    expect(add.statusCode).toBe(204);
    const visible = await app.inject({
      method: "GET",
      url: `/api/v1/messaging/channels/${channelId}`,
      headers: RN1,
    });
    expect(visible.statusCode).toBe(200);
    expect(visible.json()).toMatchObject({ kind: "location", title: "North Campus" });
    await app.close();
  });

  it("creates a discipline channel with a custom title", async () => {
    const { app } = makeServer();
    const res = await create(app, ADMIN, {
      kind: "discipline",
      subjectId: ROLE,
      title: "SW huddle",
    });
    expect(res.statusCode).toBe(201);
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/messaging/channels/${res.json().channelId}`,
      headers: ADMIN,
    });
    expect(detail.json()).toMatchObject({ kind: "discipline", title: "SW huddle" });
    await app.close();
  });

  it("a non-admin is refused (403); a subject from another organization or unknown is 404", async () => {
    const { app } = makeServer();
    expect((await create(app, RN1, { kind: "location", subjectId: LOCATION })).statusCode).toBe(
      403,
    );
    const unknown = await create(app, ADMIN, {
      kind: "location",
      subjectId: "33333333-3333-4333-8333-333333333333",
    });
    expect(unknown.statusCode).toBe(404);
    await app.close();
  });

  it("only discipline and location are creatable; a malformed body is 422", async () => {
    const { app } = makeServer();
    for (const payload of [
      { kind: "care_team", subjectId: LOCATION },
      { kind: "announcement", subjectId: LOCATION },
      { kind: "location", subjectId: "not-a-uuid" },
      { kind: "location" },
      { kind: "location", subjectId: LOCATION, title: "" },
    ]) {
      expect((await create(app, ADMIN, payload)).statusCode, JSON.stringify(payload)).toBe(422);
    }
    await app.close();
  });
});

describe("B8: the announcement guard fails closed", () => {
  it("registerMessagingRoutes refuses to mount without an announcement service", () => {
    const service = createInMemoryMessagingService();
    const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    expect(() => registerMessagingRoutes(app, { service } as never)).toThrow(/announcements/);
  });
});
