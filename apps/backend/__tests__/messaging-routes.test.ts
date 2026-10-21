// apps/backend/__tests__/messaging-routes.test.ts — M36-T07 messaging route-inventory integration
// tests (M36 spec §4.1–4.2; the §4.5 permission handshake; the `channel_visibility` ABAC gate).
//
// Exercises M36's routes through the FULL M1 middleware chain via Fastify `inject` with no live
// infra: buildServer() mounts the foundation host, registerMessagingRoutes() mounts the §4.1
// inventory over the in-memory MessagingRouteService (@chartwarden/messaging) seeded with a care-team
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
  setBreakGlassAuditHook,
  setBreakGlassChecker,
} from "@chartwarden/auth";
import { type MessagingRouteService, createInMemoryMessagingService } from "@chartwarden/messaging";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  CHANNEL_MEMBER_ADMIN_PREDICATE,
  CHANNEL_VISIBILITY_PREDICATE,
  registerMessagingRoutes,
} from "../src/modules/36-messaging/index";
import { channelMemberAdminPredicate } from "../src/modules/36-messaging/routes/messaging-routes";

/** Test-only auth shim: populate request.context from headers (mirrors terminology-routes.test). */
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
  // lead_1: may send AND manage members (WP 2.3 add-to-conversation prompt).
  {
    userId: "lead_1",
    permissions: ["messaging.read", "messaging.send", "messaging.manage_members"],
  },
  // intern: no messaging key at all → 403 everywhere.
  { userId: "intern_1", permissions: ["patient.read"] },
  { userId: "suspended_1", permissions: ["messaging.read"] },
];

function makeServer(): { app: ReturnType<typeof buildServer>; service: MessagingRouteService } {
  const service = createInMemoryMessagingService({
    now: () => new Date("2026-06-15T12:00:00Z"),
    seed: {
      eligibleStaff: [
        { orgId: ORG, userId: "rn_1", displayName: "Nurse One", roles: ["Registered Nurse"] },
        { orgId: ORG, userId: "rn_2", displayName: "Nurse Two", roles: ["Registered Nurse"] },
        { orgId: ORG, userId: "admin_1", displayName: "Admin One", roles: ["Org Admin"] },
        { orgId: ORG, userId: "lead_1", displayName: "Lead One", roles: ["Org Admin"] },
        {
          orgId: ORG,
          userId: "suspended_1",
          displayName: "Suspended User",
          roles: ["Registered Nurse"],
          status: "suspended",
        },
        { orgId: "org_b", userId: "foreign_1", displayName: "Foreign User", roles: [] },
      ],
      careTeamPatients: [
        { orgId: ORG, patientId: "patient_x", memberUserIds: ["rn_1"] },
        { orgId: ORG, patientId: "patient_new", memberUserIds: ["rn_1"] },
        { orgId: ORG, patientId: "patient_archived", memberUserIds: ["rn_1"] },
        { orgId: "org_b", patientId: "patient_foreign", memberUserIds: ["foreign_1"] },
      ],
      channels: [
        {
          channelId: CT,
          orgId: ORG,
          kind: "care_team",
          title: "Care Team — Patient X",
          subjectId: "patient_x",
          members: [{ userId: "rn_1", role: "owner" }],
        },
        {
          channelId: "ch_loc",
          orgId: ORG,
          kind: "location",
          title: "Location channel",
          subjectId: "loc_1",
          members: [
            { userId: "rn_1", role: "owner" },
            { userId: "suspended_1", source: "auto" },
            { userId: "foreign_1", source: "auto" },
          ],
        },
        {
          channelId: "ch_ann",
          orgId: ORG,
          kind: "announcement",
          title: "Announcements",
          subjectId: null,
          members: [],
        },
        {
          channelId: "ch_archived",
          orgId: ORG,
          kind: "care_team",
          title: "Archived care team",
          subjectId: "patient_archived",
          archivedAt: "2026-06-01T00:00:00.000Z",
          members: [{ userId: "rn_1", source: "auto" }],
        },
      ],
      alerts: [
        {
          orgId: ORG,
          userId: "rn_1",
          item: {
            alertId: "al_1",
            eventType: "m10.hope.sfv_created",
            category: "clinical_urgent",
            severity: "warn",
            summary: "SFV follow-up due",
            deepLink: null,
            createdAt: "2026-06-14T00:00:00Z",
            deliveryStatus: "delivered",
            readAt: null,
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
  registry.register(CHANNEL_MEMBER_ADMIN_PREDICATE, channelMemberAdminPredicate(service));
  registerAbacRegistry(registry);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerMessagingRoutes(app, { service, announcements: service });
  return { app, service };
}

/** WP 1.2: the send routes require an `Idempotency-Key`; a fresh one per call is a distinct send. */
const withKey = (headers: Record<string, string>): Record<string, string> => ({
  ...headers,
  "idempotency-key": crypto.randomUUID(),
});
const RN1 = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "clinical_rn" };
const RN2 = { "x-test-user": "rn_2", "x-test-org": ORG, "x-test-roles": "clinical_rn" };
const ADMIN = { "x-test-user": "admin_1", "x-test-org": ORG, "x-test-roles": "org_admin" };
const LEAD = { "x-test-user": "lead_1", "x-test-org": ORG, "x-test-roles": "org_admin" };
const INTERN = { "x-test-user": "intern_1", "x-test-org": ORG, "x-test-roles": "intern" };
const SUSPENDED = {
  "x-test-user": "suspended_1",
  "x-test-org": ORG,
  "x-test-roles": "clinical_rn",
};

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
        headers: withKey(RN2),
        payload: { body: "hello" },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it("denies detail and history as soon as effective clinical access is revoked", async () => {
      const { app, service } = makeServer();
      let clinicallyAuthorized = true;
      const originalCanView = service.canViewChannel.bind(service);
      service.canViewChannel = async (orgId, userId, channelId) =>
        clinicallyAuthorized && originalCanView(orgId, userId, channelId);

      const before = await app.inject({
        method: "GET",
        url: `/api/v1/messaging/channels/${CT}`,
        headers: RN1,
      });
      expect(before.statusCode).toBe(200);

      clinicallyAuthorized = false;
      for (const url of [
        `/api/v1/messaging/channels/${CT}`,
        `/api/v1/messaging/channels/${CT}/messages`,
      ]) {
        const denied = await app.inject({ method: "GET", url, headers: RN1 });
        expect(denied.statusCode).toBe(403);
        expect(denied.json()).not.toHaveProperty("title");
        expect(denied.json()).not.toHaveProperty("messages");
      }
      await app.close();
    });

    it("preserves an audited read-only break-glass access after normal visibility denies", async () => {
      const { app, service } = makeServer();
      service.canViewChannel = async () => false;
      const audit = vi.fn(async () => undefined);
      setBreakGlassChecker(async (_context, action, target) =>
        action === "messaging.read" && target.id === CT ? { eventId: "bg-m36-1" } : null,
      );
      setBreakGlassAuditHook(audit);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/messaging/channels/${CT}`,
        headers: RN1,
      });
      expect(response.statusCode).toBe(200);
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "messaging.read",
          grant: { eventId: "bg-m36-1" },
          target: { id: CT },
        }),
      );
      await app.close();
    });
  });

  describe("WP 1.2 idempotent send (Idempotency-Key required)", () => {
    const send = (
      app: ReturnType<typeof buildServer>,
      headers: Record<string, string>,
      body = "hi",
    ) =>
      app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${CT}/messages`,
        headers,
        payload: { body },
      });

    it("rejects a send with no Idempotency-Key (400 IDEMPOTENCY_KEY_REQUIRED)", async () => {
      const { app } = makeServer();
      const res = await send(app, RN1);
      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.json())).toContain("IDEMPOTENCY_KEY_REQUIRED");
      await app.close();
    });

    it("rejects an announce with no Idempotency-Key (400)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/messaging/announce",
        headers: ADMIN,
        payload: { body: "all-hands" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("replays the original response for the same key + body, and 409s a different body", async () => {
      const { app } = makeServer();
      const headers = withKey(RN1);
      const first = await send(app, headers);
      const replay = await send(app, headers);
      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(201);
      expect(replay.json().messageId).toBe(first.json().messageId);

      const changed = await send(app, headers, "a different body");
      expect(changed.statusCode).toBe(409);
      await app.close();
    });
  });

  describe("§4.2 messages (post / history / read / edit / delete)", () => {
    it("a member posts a message (201) and reads it back in history", async () => {
      const { app } = makeServer();
      const post = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${CT}/messages`,
        headers: withKey(RN1),
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

    it("persists only authoritative structured references and rejects forged labels/ranges", async () => {
      const { app } = makeServer();
      const opened = await app.inject({
        method: "POST",
        url: "/api/v1/messaging/dm",
        headers: RN1,
        payload: { userId: "rn_2" },
      });
      const channelId = opened.json().channelId as string;

      const candidates = await app.inject({
        method: "GET",
        url: `/api/v1/messaging/channels/${channelId}/mention-candidates?q=Nurse`,
        headers: RN1,
      });
      expect(candidates.statusCode).toBe(200);
      expect(candidates.json().candidates).toContainEqual(
        expect.objectContaining({ kind: "staff", entityId: "rn_2", displayName: "Nurse Two" }),
      );

      const valid = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${channelId}/messages`,
        headers: withKey(RN1),
        payload: {
          body: "Update @Nurse Two",
          references: [{ kind: "staff", entityId: "rn_2", start: 7, end: 17 }],
        },
      });
      expect(valid.statusCode).toBe(201);
      const history = await app.inject({
        method: "GET",
        url: `/api/v1/messaging/channels/${channelId}/messages`,
        headers: RN1,
      });
      expect(history.json().messages[0].references).toEqual([
        expect.objectContaining({
          kind: "staff",
          entityId: "rn_2",
          displayLabel: "Nurse Two",
        }),
      ]);

      const forged = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${channelId}/messages`,
        headers: withKey(RN1),
        payload: {
          body: "Update @Chief Doctor",
          references: [{ kind: "staff", entityId: "rn_2", start: 7, end: 20 }],
        },
      });
      expect(forged.statusCode).toBe(422);

      const overlapping = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${channelId}/messages`,
        headers: withKey(RN1),
        payload: {
          body: "@Nurse Two",
          references: [
            { kind: "staff", entityId: "rn_2", start: 0, end: 10 },
            { kind: "staff", entityId: "rn_2", start: 1, end: 10 },
          ],
        },
      });
      expect(overlapping.statusCode).toBe(422);
      await app.close();
    });

    it("only the author may edit/delete (a non-member sees 404, like the DB service)", async () => {
      const { app } = makeServer();
      const post = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${CT}/messages`,
        headers: withKey(RN1),
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

      // rn_2 has messaging.send but is neither the author nor a channel member → 404 (no existence
      // oracle; a member who is not the author gets 403, see in-memory-message-access.test.ts).
      const forged = await app.inject({
        method: "PATCH",
        url: `/api/v1/messaging/messages/${messageId}`,
        headers: RN2,
        payload: { body: "tampered" },
      });
      expect(forged.statusCode).toBe(404);
      await app.close();
    });

    it("retrieves the latest page first and walks backward without duplicates", async () => {
      const { app } = makeServer();
      for (const body of ["first update", "second update", "latest update"]) {
        const response = await app.inject({
          method: "POST",
          url: `/api/v1/messaging/channels/${CT}/messages`,
          headers: withKey(RN1),
          payload: { body },
        });
        expect(response.statusCode).toBe(201);
      }

      const latest = await app.inject({
        method: "GET",
        url: `/api/v1/messaging/channels/${CT}/messages?direction=backward&limit=2`,
        headers: RN1,
      });
      expect(latest.statusCode).toBe(200);
      expect(latest.json().messages.map((message: { body: string }) => message.body)).toEqual([
        "second update",
        "latest update",
      ]);
      expect(latest.json().messages[0].authorDisplayName).toBe("Nurse One");

      const older = await app.inject({
        method: "GET",
        url: `/api/v1/messaging/channels/${CT}/messages?direction=backward&limit=2&cursor=${encodeURIComponent(latest.json().nextCursor)}`,
        headers: RN1,
      });
      expect(older.statusCode).toBe(200);
      expect(older.json().messages.map((message: { body: string }) => message.body)).toEqual([
        "first update",
      ]);
      expect(
        new Set(
          [...latest.json().messages, ...older.json().messages].map(
            (message: { messageId: string }) => message.messageId,
          ),
        ).size,
      ).toBe(3);
      await app.close();
    });
  });

  describe("§4.2 DM (idempotent)", () => {
    it("searches only active staff in the bound organization and excludes self", async () => {
      const { app } = makeServer();
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/messaging/dm/staff?q=Nurse",
        headers: RN1,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().staff).toEqual([
        { userId: "rn_2", displayName: "Nurse Two", roles: ["Registered Nurse"] },
      ]);
      await app.close();
    });

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

    it("returns an authorized peer label, preview, activity and confirmed unread count", async () => {
      const { app } = makeServer();
      const open = await app.inject({
        method: "POST",
        url: "/api/v1/messaging/dm",
        headers: RN1,
        payload: { userId: "rn_2" },
      });
      const channelId = open.json().channelId as string;
      const sent = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${channelId}/messages`,
        headers: withKey(RN2),
        payload: { body: "Thanks for the update\nI will follow up." },
      });
      expect(sent.statusCode).toBe(201);

      const inbox = await app.inject({
        method: "GET",
        url: "/api/v1/messaging/channels",
        headers: RN1,
      });
      const summary = inbox
        .json()
        .channels.find((channel: { channelId: string }) => channel.channelId === channelId);
      expect(summary).toMatchObject({
        title: "Nurse Two",
        participantRoles: ["Registered Nurse"],
        unreadCount: 1,
        lastActivityAt: "2026-06-15T12:00:00.000Z",
        lastMessage: {
          preview: "Thanks for the update I will follow up.",
          authorDisplayName: "Nurse Two",
        },
      });

      const read = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/messages/${sent.json().messageId}/read`,
        headers: RN1,
        payload: { upTo: true },
      });
      expect(read.statusCode).toBe(204);
      const refreshed = await app.inject({
        method: "GET",
        url: "/api/v1/messaging/channels",
        headers: RN1,
      });
      expect(
        refreshed
          .json()
          .channels.find((channel: { channelId: string }) => channel.channelId === channelId)
          .unreadCount,
      ).toBe(0);
      await app.close();
    });

    it("does not reveal or open DMs with suspended or foreign-tenant users", async () => {
      const { app } = makeServer();
      for (const userId of ["suspended_1", "foreign_1"]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/messaging/dm",
          headers: RN1,
          payload: { userId },
        });
        expect(response.statusCode).toBe(404);
        expect(response.json().error.code).toBe("NOT_FOUND");
      }
      await app.close();
    });
  });

  describe("patient care-team conversation", () => {
    it("reuses an existing channel and idempotently provisions one through the care-team roster", async () => {
      const { app } = makeServer();
      const existing = await app.inject({
        method: "POST",
        url: "/api/v1/messaging/patients/patient_x/care-team-channel",
        headers: RN1,
      });
      expect(existing.statusCode).toBe(200);
      expect(existing.json()).toEqual({
        channelId: CT,
        kind: "care_team",
        patientId: "patient_x",
        archived: false,
      });

      const first = await app.inject({
        method: "POST",
        url: "/api/v1/messaging/patients/patient_new/care-team-channel",
        headers: RN1,
      });
      const second = await app.inject({
        method: "POST",
        url: "/api/v1/messaging/patients/patient_new/care-team-channel",
        headers: RN1,
      });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.json().channelId).toBe(first.json().channelId);
      await app.close();
    });

    it("conceals foreign, unknown, unassigned, and suspended access with no channel metadata", async () => {
      const { app } = makeServer();
      const attempts = [
        { headers: RN1, patientId: "patient_foreign" },
        { headers: RN1, patientId: "unknown_patient" },
        { headers: RN2, patientId: "patient_x" },
        { headers: SUSPENDED, patientId: "patient_x" },
      ];
      for (const attempt of attempts) {
        const response = await app.inject({
          method: "POST",
          url: `/api/v1/messaging/patients/${attempt.patientId}/care-team-channel`,
          headers: attempt.headers,
        });
        expect(response.statusCode).toBe(404);
        expect(response.json()).not.toHaveProperty("channelId");
        expect(response.json()).not.toHaveProperty("patientId");
      }
      await app.close();
    });

    it("preserves archived state and the existing member's read-only history", async () => {
      const { app } = makeServer();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/messaging/patients/patient_archived/care-team-channel",
        headers: RN1,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ channelId: "ch_archived", archived: true });

      const send = await app.inject({
        method: "POST",
        url: "/api/v1/messaging/channels/ch_archived/messages",
        headers: withKey(RN1),
        payload: { body: "must not send" },
      });
      expect(send.statusCode).toBe(410);
      await app.close();
    });
  });

  describe("WP 2.3 mention of a non-member", () => {
    const nonMembers = (headers: Record<string, string>, q: string) =>
      makeServer().app.inject({
        method: "GET",
        url: `/api/v1/messaging/channels/${CT}/mention-non-members?q=${q}`,
        headers,
      });

    it("offers names only, never members, self, suspended or foreign-org people (to someone who can add)", async () => {
      const { app, service } = makeServer();
      await service.addMember(ORG, {
        channelId: CT,
        userId: "lead_1",
        actor: { kind: "user", userId: "admin_1", roles: ["org_admin"], locationIds: [] },
      });
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/messaging/channels/${CT}/mention-non-members?q=One`,
        headers: LEAD,
      });
      await app.close();
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.canAdd).toBe(true);
      expect(body.people.map((p: { displayName: string }) => p.displayName).sort()).toEqual([
        "Admin One",
      ]);
      expect(Object.keys(body.people[0]).sort()).toEqual(["displayName", "entityId"]);
      expect(JSON.stringify(body)).not.toMatch(/Foreign|Suspended|Nurse One/);
    });

    it("needs a 2+ character query so the directory cannot be dumped", async () => {
      const res = await nonMembers(RN1, "N");
      expect(res.json().people).toEqual([]);
    });

    it("a sender without member-management authority gets no names at all, only canAdd=false", async () => {
      const res = await nonMembers(RN1, "Nurse");
      expect(res.json()).toEqual({ people: [], canAdd: false });
    });

    it("a non-member of the channel is refused like any hidden channel", async () => {
      const res = await nonMembers(RN2, "Nurse");
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain("Nurse");
    });

    it("a sender without messaging.send is refused", async () => {
      const res = await nonMembers(ADMIN, "Nurse");
      expect([403, 404]).toContain(res.statusCode);
    });

    it("canAdd is true for a member-admin who is in the channel", async () => {
      const { app, service } = makeServer();
      await service.addMember(ORG, {
        channelId: CT,
        userId: "lead_1",
        actor: { kind: "user", userId: "admin_1", roles: ["org_admin"], locationIds: [] },
      });
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/messaging/channels/${CT}/mention-non-members?q=Nurse`,
        headers: LEAD,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().canAdd).toBe(true);
      await app.close();
    });

    it("a staff reference to a non-member is refused (a mention never grants access)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${CT}/messages`,
        headers: withKey(RN1),
        payload: {
          body: "Hello @Nurse Two",
          references: [{ kind: "staff", entityId: "rn_2", start: 6, end: 16 }],
        },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("INVALID_MESSAGE_REFERENCES");
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

      const suspended = await app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${CT}/members`,
        headers: ADMIN,
        payload: { userId: "suspended_1" },
      });
      expect(suspended.statusCode).toBe(404);
      await app.close();
    });

    it("GET members: admin lists only active, same-org members with names; others 403", async () => {
      const { app } = makeServer();
      const list = await app.inject({
        method: "GET",
        url: "/api/v1/messaging/channels/ch_loc/members",
        headers: ADMIN,
      });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({
        members: [{ userId: "rn_1", role: "owner", source: "manual", displayName: "Nurse One" }],
      });
      const denied = await app.inject({
        method: "GET",
        url: "/api/v1/messaging/channels/ch_loc/members",
        headers: RN1,
      });
      expect(denied.statusCode).toBe(403);
      const missing = await app.inject({
        method: "GET",
        url: "/api/v1/messaging/channels/nope/members",
        headers: ADMIN,
      });
      expect(missing.statusCode).toBe(403); // predicate fails closed: a foreign id answers the same
      await app.close();
    });

    it("POST archive: org_admin archives (204), repeat is idempotent, sends then 410", async () => {
      const { app } = makeServer();
      const url = "/api/v1/messaging/channels/ch_loc/archive";
      expect((await app.inject({ method: "POST", url, headers: RN1 })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url, headers: ADMIN })).statusCode).toBe(204);
      expect((await app.inject({ method: "POST", url, headers: ADMIN })).statusCode).toBe(204);
      const detail = await app.inject({
        method: "GET",
        url: "/api/v1/messaging/channels/ch_loc",
        headers: RN1,
      });
      expect(detail.json().archivedAt).toBe("2026-06-15T12:00:00.000Z");
      const send = await app.inject({
        method: "POST",
        url: "/api/v1/messaging/channels/ch_loc/messages",
        headers: withKey(RN1),
        payload: { body: "hi" },
      });
      expect(send.statusCode).toBe(410);
      const missing = await app.inject({
        method: "POST",
        url: "/api/v1/messaging/channels/nope/archive",
        headers: ADMIN,
      });
      expect(missing.statusCode).toBe(403); // predicate fails closed: a foreign id answers the same
      await app.close();
    });

    it("POST archive: lifecycle-managed and private kinds are refused (409/403)", async () => {
      const { app } = makeServer();
      for (const [id, code] of [
        [CT, 409],
        ["ch_ann", 409],
      ] as const) {
        const res = await app.inject({
          method: "POST",
          url: `/api/v1/messaging/channels/${id}/archive`,
          headers: ADMIN,
        });
        expect(res.statusCode).toBe(code);
        expect(res.json().error.code).toBe("CHANNEL_LIFECYCLE_MANAGED");
      }
      await app.close();
    });

    it("archive is org_admin-only at the service even when manage rights pass", async () => {
      const { service } = makeServer();
      const lead = {
        kind: "user" as const,
        userId: "lead_1",
        roles: ["clinical_lead"],
        locationIds: ["loc_1"],
      };
      await expect(
        service.archiveChannel(ORG, { channelId: "ch_loc", actor: lead }),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(service.listMembers(ORG, lead, "ch_loc")).resolves.toHaveLength(1);
    });

    it("POST unarchive: org_admin restores an archived channel (204), repeat is idempotent, sends work again", async () => {
      const { app } = makeServer();
      const base = "/api/v1/messaging/channels/ch_loc";
      const send = () =>
        app.inject({
          method: "POST",
          url: `${base}/messages`,
          headers: withKey(RN1),
          payload: { body: "hi" },
        });
      expect(
        (await app.inject({ method: "POST", url: `${base}/archive`, headers: ADMIN })).statusCode,
      ).toBe(204);
      expect((await send()).statusCode).toBe(410);
      const url = `${base}/unarchive`;
      expect((await app.inject({ method: "POST", url, headers: RN1 })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url, headers: ADMIN })).statusCode).toBe(204);
      expect((await app.inject({ method: "POST", url, headers: ADMIN })).statusCode).toBe(204);
      const detail = await app.inject({ method: "GET", url: base, headers: RN1 });
      expect(detail.json().archivedAt).toBeNull();
      expect((await send()).statusCode).toBe(201);
      await app.close();
    });

    it("POST unarchive: lifecycle-managed kinds are refused (409)", async () => {
      const { app } = makeServer();
      for (const id of [CT, "ch_ann"]) {
        const res = await app.inject({
          method: "POST",
          url: `/api/v1/messaging/channels/${id}/unarchive`,
          headers: ADMIN,
        });
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe("CHANNEL_LIFECYCLE_MANAGED");
      }
      await app.close();
    });

    it("unarchive is org_admin-only at the service even when manage rights pass", async () => {
      const { service } = makeServer();
      const lead = {
        kind: "user" as const,
        userId: "lead_1",
        roles: ["clinical_lead"],
        locationIds: ["loc_1"],
      };
      await expect(
        service.unarchiveChannel(ORG, { channelId: "ch_loc", actor: lead }),
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it("a clinician cannot announce; org_admin can (201)", async () => {
      const { app } = makeServer();
      const denied = await app.inject({
        method: "POST",
        url: "/api/v1/messaging/announce",
        headers: withKey(RN1),
        payload: { body: "all-hands at noon" },
      });
      expect(denied.statusCode).toBe(403);

      const ok = await app.inject({
        method: "POST",
        url: "/api/v1/messaging/announce",
        headers: withKey(ADMIN),
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
      const alert = res.json().alerts.find((a: { alertId: string }) => a.alertId === "al_1");
      expect(alert).toMatchObject({
        summary: "SFV follow-up due",
        deepLink: null,
        deliveryStatus: "delivered",
        readAt: null,
      });
      expect(alert).not.toHaveProperty("payload");
      await app.close();
    });

    it("keeps read/unread state working with the presentation fields", async () => {
      const { app } = makeServer();
      const marked = await app.inject({
        method: "POST",
        url: "/api/v1/alerts/al_1/read",
        headers: RN1,
      });
      expect(marked.statusCode).toBe(204);

      const inbox = await app.inject({
        method: "GET",
        url: "/api/v1/alerts/inbox",
        headers: RN1,
      });
      const alert = inbox.json().alerts.find((a: { alertId: string }) => a.alertId === "al_1");
      expect(alert).toMatchObject({
        summary: "SFV follow-up due",
        deepLink: null,
        deliveryStatus: "delivered",
      });
      expect(alert.readAt).toEqual(expect.any(String));
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

    it("GAP-102: refuses a severity downgrade on a system_locked rule → 422, nothing cloned", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/alert-rules/platform:field_safety.sos",
        headers: ADMIN,
        payload: { severityFloor: "info" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("LOCKED_RULE_SEVERITY_DOWNGRADE");
      const list = await app.inject({ method: "GET", url: "/api/v1/alert-rules", headers: RN1 });
      const sos = list
        .json()
        .rules.find((r: { eventType: string }) => r.eventType === "field_safety.sos");
      expect(sos.severityFloor).toBe("critical");
      expect(sos.organizationId).toBeNull();
      await app.close();
    });

    it("GAP-102: refuses a resolver change on a system_locked rule → 422", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/alert-rules/platform:system.backup_failure",
        headers: ADMIN,
        payload: { recipientResolver: "broadcast" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("LOCKED_RULE_RESOLVER_IMMUTABLE");
      await app.close();
    });

    it("GAP-102: a tightening/no-op edit of a locked rule clones it and the clone stays editable", async () => {
      const { app } = makeServer();
      const first = await app.inject({
        method: "PATCH",
        url: "/api/v1/alert-rules/platform:field_safety.sos",
        headers: ADMIN,
        payload: { severityFloor: "critical" },
      });
      expect(first.statusCode).toBe(200);
      const cloneId = first.json().ruleId;
      expect(first.json().systemLocked).toBe(true);
      const again = await app.inject({
        method: "PATCH",
        url: `/api/v1/alert-rules/${cloneId}`,
        headers: ADMIN,
        payload: { severityFloor: "critical" },
      });
      expect(again.statusCode).toBe(200);
      // and the clone cannot be used to weaken it either
      const weaken = await app.inject({
        method: "PATCH",
        url: `/api/v1/alert-rules/${cloneId}`,
        headers: ADMIN,
        payload: { severityFloor: "warn" },
      });
      expect(weaken.statusCode).toBe(422);
      expect(weaken.json().error.code).toBe("LOCKED_RULE_SEVERITY_DOWNGRADE");
      await app.close();
    });

    it("clones a platform default into an org-scoped override on first edit (200)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/alert-rules/platform:m10.hope.sfv_created",
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
        url: "/api/v1/alert-rules/platform:m10.hope.sfv_created",
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
        url: "/api/v1/alert-rules/platform:m10.hope.sfv_created",
        headers: RN1,
        payload: { enabled: false },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });
});
