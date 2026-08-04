// apps/backend/__tests__/messaging-routes.test.ts — M36-T07 messaging route-inventory integration
// tests (M36 spec §4.1–4.2; the §4.5 permission handshake; the `channel_visibility` ABAC gate).
//
// Exercises M36's routes through the FULL M1 middleware chain via Fastify `inject` with no live
// infra: buildServer() mounts the foundation host, registerMessagingRoutes() mounts the §4.1
// inventory over the in-memory MessagingRouteService (@wardenx/messaging) seeded with a care-team
// channel + an alert. The REAL Authorization Contract gates every route on the §4.5 keys, and the
// `channel_visibility` predicate (registered into a fresh registry per test) decides channel reads;
// a header-auth shim populates request.context.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { type MessagingRouteService, createInMemoryMessagingService } from "@wardenx/messaging";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  CHANNEL_VISIBILITY_PREDICATE,
  registerMessagingRoutes,
} from "../src/modules/36-messaging/index";

/** Test-only auth shim: populate request.context from headers (mirrors terminology-routes.test). */
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

const ORG = "org_a";
const CT = "ch_ct"; // a care-team channel rn_1 belongs to

const PERMISSION_SEED = [
  // rn_1: a clinician on the channel — read/send/dm + self prefs/endpoints + read rules.
  {
    userId: "rn_1",
    permissions: [
      "messaging.read",
      "messaging.send",
      "messaging.dm",
      "notifications.preferences.manage",
      "notifications.endpoint.manage",
      "alert.rules.read",
    ],
  },
  // rn_2: read/send but NOT a member of CT — proves the channel_visibility ABAC denial.
  { userId: "rn_2", permissions: ["messaging.read", "messaging.send"] },
  // admin: the gated keys — member admin override, announce, alert-rule edits.
  {
    userId: "admin_1",
    permissions: [
      "messaging.read",
      "messaging.manage_members",
      "messaging.announce",
      "alert.rules.read",
      "alert.rules.manage",
    ],
  },
  // intern: no messaging key at all → 403 everywhere.
  { userId: "intern_1", permissions: ["patient.read"] },
];

function makeServer(): { app: ReturnType<typeof buildServer>; service: MessagingRouteService } {
  const service = createInMemoryMessagingService({
    now: () => new Date("2026-06-15T12:00:00Z"),
    seed: {
      channels: [
        {
          channelId: CT,
          orgId: ORG,
          kind: "care_team",
          title: "Care Team — Patient X",
          subjectId: "patient_x",
          members: [{ userId: "rn_1", role: "owner" }],
        },
      ],
      alerts: [
        {
          orgId: ORG,
          userId: "rn_1",
          item: {
            alertId: "al_1",
            eventType: "hope.sfv_triggered",
            category: "clinical_urgent",
            severity: "warn",
            summary: "SFV follow-up due",
            createdAt: "2026-06-14T00:00:00Z",
            deliveryStatus: "delivered",
          },
        },
      ],
    },
  });

  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: ORG,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);

  // Register the channel_visibility predicate (wired to the service) into a fresh registry, then
  // install it as the contract's ABAC evaluator (test isolation; mirrors audit-accounting.test).
  const registry = createPredicateRegistry();
  registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
    const channelId = typeof target.id === "string" ? target.id : null;
    if (!channelId || !ctx.organizationId || !ctx.userId) return false;
    return service.canViewChannel(ctx.organizationId, ctx.userId, channelId);
  });
  registerAbacRegistry(registry);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerMessagingRoutes(app, { service });
  return { app, service };
}

const RN1 = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "clinical_rn" };
const RN2 = { "x-test-user": "rn_2", "x-test-org": ORG, "x-test-roles": "clinical_rn" };
const ADMIN = { "x-test-user": "admin_1", "x-test-org": ORG, "x-test-roles": "org_admin" };
const INTERN = { "x-test-user": "intern_1", "x-test-org": ORG, "x-test-roles": "intern" };

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

describe("M36-T07 messaging route inventory", () => {
  describe("§4.5 messaging.read gate", () => {
    it("unauthenticated → 401", async () => {
      const { app } = makeServer();
      const res = await app.inject({ method: "GET", url: "/api/v1/messaging/channels" });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("an actor without messaging.read → 403", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/messaging/channels",
        headers: INTERN,
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it("a member lists their channels", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/messaging/channels",
        headers: RN1,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().channels.map((c: { channelId: string }) => c.channelId)).toContain(CT);
      await app.close();
    });
  });

  describe("§4.5 channel_visibility ABAC (per-channel read/send)", () => {
    it("a member sees channel detail (ABAC allows)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/messaging/channels/${CT}`,
        headers: RN1,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().channelId).toBe(CT);
      await app.close();
    });

    it("a non-member with messaging.read is denied by the ABAC predicate → 403", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/messaging/channels/${CT}`,
        headers: RN2,
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it("a non-member cannot post to the channel → 403", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${CT}/messages`,
        headers: RN2,
        payload: { body: "hello" },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  describe("§4.2 messages (post / history / read / edit / delete)", () => {
    it("a member posts a message (201) and reads it back in history", async () => {
      const { app } = makeServer();
      const post = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${CT}/messages`,
        headers: RN1,
        payload: { body: "morning report posted" },
      });
      expect(post.statusCode).toBe(201);
      const messageId = post.json().messageId as string;
      expect(messageId).toBeTruthy();

      const history = await app.inject({
        method: "GET",
        url: `/api/v1/messaging/channels/${CT}/messages`,
        headers: RN1,
      });
      expect(history.statusCode).toBe(200);
      expect(history.json().messages.map((m: { messageId: string }) => m.messageId)).toContain(
        messageId,
      );

      const read = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/messages/${messageId}/read`,
        headers: RN1,
        payload: { upTo: true },
      });
      expect(read.statusCode).toBe(204);
      await app.close();
    });

    it("only the author may edit/delete (FORBIDDEN otherwise)", async () => {
      const { app } = makeServer();
      const post = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${CT}/messages`,
        headers: RN1,
        payload: { body: "original" },
      });
      const messageId = post.json().messageId as string;

      const edit = await app.inject({
        method: "PATCH",
        url: `/api/v1/messaging/messages/${messageId}`,
        headers: RN1,
        payload: { body: "edited" },
      });
      expect(edit.statusCode).toBe(200);

      // rn_2 has messaging.send but did not author the message → 403.
      const forged = await app.inject({
        method: "PATCH",
        url: `/api/v1/messaging/messages/${messageId}`,
        headers: RN2,
        payload: { body: "tampered" },
      });
      expect(forged.statusCode).toBe(403);
      await app.close();
    });
  });

  describe("§4.2 DM (idempotent)", () => {
    it("opens a DM (201) then finds the same one (200)", async () => {
      const { app } = makeServer();
      const open = await app.inject({
        method: "POST",
        url: "/api/v1/messaging/dm",
        headers: RN1,
        payload: { userId: "rn_2" },
      });
      expect(open.statusCode).toBe(201);
      const channelId = open.json().channelId as string;

      const again = await app.inject({
        method: "POST",
        url: "/api/v1/messaging/dm",
        headers: RN1,
        payload: { userId: "rn_2" },
      });
      expect(again.statusCode).toBe(200);
      expect(again.json().channelId).toBe(channelId);
      await app.close();
    });
  });

  describe("§4.2 member admin + announce (gated keys)", () => {
    it("a clinician cannot manage members; admin adds then removes one", async () => {
      const { app } = makeServer();
      const denied = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${CT}/members`,
        headers: RN1,
        payload: { userId: "rn_2" },
      });
      expect(denied.statusCode).toBe(403);

      const add = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${CT}/members`,
        headers: ADMIN,
        payload: { userId: "rn_2" },
      });
      expect(add.statusCode).toBe(204);

      // rn_2 is now a member → ABAC lets them read the channel.
      const visible = await app.inject({
        method: "GET",
        url: `/api/v1/messaging/channels/${CT}`,
        headers: RN2,
      });
      expect(visible.statusCode).toBe(200);

      const remove = await app.inject({
        method: "DELETE",
        url: `/api/v1/messaging/channels/${CT}/members/rn_2`,
        headers: ADMIN,
      });
      expect(remove.statusCode).toBe(204);
      await app.close();
    });

    it("a clinician cannot announce; org_admin can (201)", async () => {
      const { app } = makeServer();
      const denied = await app.inject({
        method: "POST",
        url: "/api/v1/messaging/announce",
        headers: RN1,
        payload: { body: "all-hands at noon" },
      });
      expect(denied.statusCode).toBe(403);

      const ok = await app.inject({
        method: "POST",
        url: "/api/v1/messaging/announce",
        headers: ADMIN,
        payload: { body: "all-hands at noon" },
      });
      expect(ok.statusCode).toBe(201);
      await app.close();
    });
  });

  describe("§4.2 notification preferences (self-only) + endpoints", () => {
    it("self-reads defaults, then updates; rejects an unknown routing-map category (422)", async () => {
      const { app } = makeServer();
      const read = await app.inject({
        method: "GET",
        url: "/api/v1/notifications/preferences",
        headers: RN1,
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().userId).toBe("rn_1");

      const ok = await app.inject({
        method: "PUT",
        url: "/api/v1/notifications/preferences",
        headers: RN1,
        payload: {
          routingMap: { clinical_urgent: { critical: ["push", "sms"] } },
          quietHours: { tz: "UTC", ranges: [], severityOverride: "critical" },
        },
      });
      expect(ok.statusCode).toBe(200);

      const bad = await app.inject({
        method: "PUT",
        url: "/api/v1/notifications/preferences",
        headers: RN1,
        payload: {
          routingMap: { not_a_category: { critical: ["push"] } },
          quietHours: { tz: "UTC", ranges: [], severityOverride: "critical" },
        },
      });
      expect(bad.statusCode).toBe(422);
      expect(bad.json().error.code).toBe("INVALID_ROUTING_MAP");
      await app.close();
    });

    it("rejects forwarding vacation to yourself (409)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/notifications/preferences",
        headers: RN1,
        payload: {
          routingMap: {},
          quietHours: { tz: "UTC", ranges: [], severityOverride: "critical" },
          vacationForwardToUserId: "rn_1",
          vacationUntil: "2026-07-01T00:00:00Z",
        },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("VACATION_FORWARD_SELF");
      await app.close();
    });

    it("rejects a vacationUntil that is not in the future (422, DB-005 — enforced at write time, not a DB CHECK)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/notifications/preferences",
        headers: RN1,
        payload: {
          routingMap: {},
          quietHours: { tz: "UTC", ranges: [], severityOverride: "critical" },
          vacationForwardToUserId: "rn_2",
          vacationUntil: "2020-01-01T00:00:00Z",
        },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("VACATION_UNTIL_NOT_FUTURE");
      await app.close();
    });

    it("accepts a genuinely future vacationUntil paired with a forward target (not a rubber stamp)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/notifications/preferences",
        headers: RN1,
        payload: {
          routingMap: {},
          quietHours: { tz: "UTC", ranges: [], severityOverride: "critical" },
          vacationForwardToUserId: "rn_2",
          vacationUntil: "2099-01-01T00:00:00Z",
        },
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("registers an sms endpoint (pending), rejects a wrong token, verifies, deletes", async () => {
      const { app } = makeServer();
      const reg = await app.inject({
        method: "POST",
        url: "/api/v1/notifications/endpoints",
        headers: RN1,
        payload: { channel: "sms", target: "+15555550123" },
      });
      expect(reg.statusCode).toBe(201);
      expect(reg.json().verificationStatus).toBe("pending");
      const endpointId = reg.json().endpointId as string;

      const wrong = await app.inject({
        method: "POST",
        url: `/api/v1/notifications/endpoints/${endpointId}/verify`,
        headers: RN1,
        payload: { token: "999999" },
      });
      expect(wrong.statusCode).toBe(422);

      const ok = await app.inject({
        method: "POST",
        url: `/api/v1/notifications/endpoints/${endpointId}/verify`,
        headers: RN1,
        payload: { token: "000000" },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().verificationStatus).toBe("verified");

      const del = await app.inject({
        method: "DELETE",
        url: `/api/v1/notifications/endpoints/${endpointId}`,
        headers: RN1,
      });
      expect(del.statusCode).toBe(204);
      await app.close();
    });
  });

  describe("§4.2 alerts inbox + alert-rules", () => {
    it("returns the actor's alert inbox", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/alerts/inbox",
        headers: RN1,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().alerts.map((a: { alertId: string }) => a.alertId)).toContain("al_1");
      await app.close();
    });

    it("lists tenant + inherited platform rules (read key)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/alert-rules",
        headers: RN1,
      });
      expect(res.statusCode).toBe(200);
      const events = res.json().rules.map((r: { eventType: string }) => r.eventType);
      expect(events).toContain("field_safety.sos");
      await app.close();
    });

    it("§7.4 refuses disabling a system_locked rule → SYSTEM_LOCKED (403)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/alert-rules/platform:field_safety.sos",
        headers: ADMIN,
        payload: { enabled: false },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("SYSTEM_LOCKED");
      await app.close();
    });

    it("clones a platform default into an org-scoped override on first edit (200)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/alert-rules/platform:hope.sfv_triggered",
        headers: ADMIN,
        payload: { enabled: false },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.organizationId).toBe(ORG);
      expect(body.enabled).toBe(false);
      await app.close();
    });

    it("rejects an unknown recipient resolver → INVALID_RESOLVER (422)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/alert-rules/platform:hope.sfv_triggered",
        headers: ADMIN,
        payload: { recipientResolver: "made_up" },
      });
      // TypeBox rejects the unknown literal first (422 VALIDATION_FAILED) — both are 422 by design.
      expect(res.statusCode).toBe(422);
      await app.close();
    });

    it("a clinician without alert.rules.manage cannot patch a rule → 403", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/alert-rules/platform:hope.sfv_triggered",
        headers: RN1,
        payload: { enabled: false },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });
});
