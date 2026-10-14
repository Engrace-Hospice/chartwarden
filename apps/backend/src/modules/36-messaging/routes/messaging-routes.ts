// apps/backend/src/modules/36-messaging/routes/messaging-routes.ts — M36-T07 the messaging route
// inventory (M36 spec §4.1–4.2; the §4.5 permission handshake; the `channel_visibility` ABAC gate).
//
// These are M36's tenant-user-facing routes: the channel/message surface (list/detail/history,
// post/edit/delete, read receipts, DM, member admin override, announcement), the SELF-only
// notification preferences + delivery endpoints, and the alert inbox + alert-rule read/override.
// Every route is gated by the REAL Authorization Contract (`requirePermission`/`requireAbac` from
// @wardenx/auth, M3) on the §4.5 keys M36 registers into M3's catalog (M36_CONTRIBUTED_PERMISSIONS).
//
// AUTH SHAPE (§4.5): read/send/manage_members carry the `channel_visibility` ABAC predicate (it
// branches per channel kind — caseload membership for care_team, bereavement membership for
// bereavement, a channel-member check otherwise; announcement is org-wide). `announce` is a flat
// org_admin RBAC key; the two `notifications.*` keys are self-only (org binding is server-side, so
// a user can only ever read/write THEIR OWN preferences — the handler reads request.context.userId,
// never a path/body user id); the alert-rule keys are tenant-admin RBAC. Webhook routes (signature
// auth, §4.9) and the platform-ops delivery-audit drill land with M36-T08.
//
// The handlers compose over the injected `MessagingRouteService` (M36-T07) — in the slice the
// in-memory adapter from @wardenx/messaging; production injects the Drizzle/Valkey-backed service,
// whose mutations run inside `withOrgContext` so RLS on `app.org_id` is the backstop and whose
// `sendMessage` envelope-encrypts the body under the tenant DEK (§3.4). Org/actor binding is always
// server-side: the org/user come from `request.context`, never the body.
import {
  type AbacContext,
  abacRegistry,
  registerPredicate,
  requireAbac,
  requirePermission,
} from "@wardenx/auth";
import type {
  AnnouncementService,
  MemberAdminActor,
  MessagingRouteService,
} from "@wardenx/messaging";
import { UnauthorizedError, WardenXError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { resolveRichWrite } from "../rich-body-codec";
import { announcementSendGuard, registerAnnouncementRoutes } from "./announcement-routes";
import {
  AddMemberBodySchema,
  AlertParamsSchema,
  AlertRuleParamsSchema,
  AlertRulePatchSchema,
  AnnounceBodySchema,
  ChannelParamsSchema,
  DmStaffSearchQuerySchema,
  EditMessageBodySchema,
  EndpointParamsSchema,
  ListMessagesQuerySchema,
  ListThreadQuerySchema,
  MemberParamsSchema,
  MentionCandidateQuerySchema,
  MentionNonMemberQuerySchema,
  MessageParamsSchema,
  OpenDmBodySchema,
  PatientConversationParamsSchema,
  PreferencesBodySchema,
  ReadBodySchema,
  RegisterEndpointBodySchema,
  SendMessageBodySchema,
  ThreadParamsSchema,
  VerifyEndpointBodySchema,
  parse,
} from "./messaging-typebox";
import { type PresenceRouteDeps, registerPresenceRoutes } from "./presence-routes";
import { registerReactionPinRoutes } from "./reaction-pin-routes";
import { registerMessageSearchRoutes } from "./search-routes";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The named ABAC predicate the channel-scoped routes gate on (§4.5). */
export const CHANNEL_VISIBILITY_PREDICATE = "channel_visibility";

/** The §4.5 `location_membership` predicate for `messaging.manage_members` (GAP-103): org_admin, or
 *  clinical_lead on a location channel of their own location. */
export const CHANNEL_MEMBER_ADMIN_PREDICATE = "channel_member_admin";

/** The injection surface for the messaging routes (mirrors M38's `TerminologyRouteDeps`). */
export interface MessagingRouteDeps {
  /** The §4.1–4.2 application service (in-memory in the slice; Drizzle/Valkey in prod). */
  service: MessagingRouteService;
  /** WP 2.9: announcement receipts, department channels and the org_admin-only announcement send guard. */
  announcements: AnnouncementService;
  /** WP 2.12: ephemeral presence/typing. Omitted => the routes are registered but the tenant flag reads off. */
  presence?: PresenceRouteDeps;
}

/**
 * Register the `channel_visibility` ABAC predicate (§4.5) into M3's shared predicate registry,
 * wired to the messaging service. The predicate reads the target channel id (`params.id`) and the
 * server-assembled actor (`context.userId` / `context.organizationId`); fail-closed by
 * construction — an unknown / cross-org / non-member channel resolves to `false`. Idempotent-safe:
 * the registry is single-owner, so the composition root calls this exactly once at boot (tests
 * register it per fresh registry). Separate from `registerMessagingRoutes` so the predicate can be
 * registered before the Authorization Contract's evaluator is installed.
 */
export function registerMessagingAbacPredicates(service: MessagingRouteService): void {
  // Single-owner registry; re-boot (tests) re-points safely (mirrors M39's abac-predicates guard).
  if (!abacRegistry.has(CHANNEL_VISIBILITY_PREDICATE)) registerChannelVisibility(service);
  if (!abacRegistry.has(CHANNEL_MEMBER_ADMIN_PREDICATE)) {
    registerPredicate(CHANNEL_MEMBER_ADMIN_PREDICATE, channelMemberAdminPredicate(service));
  }
}

function registerChannelVisibility(service: MessagingRouteService): void {
  registerPredicate(CHANNEL_VISIBILITY_PREDICATE, async (context, target) => {
    const channelId = typeof target.id === "string" ? target.id : null;
    if (!channelId || !context.organizationId || !context.userId) return false;
    return service.canViewChannel(context.organizationId, context.userId, channelId);
  });
}

/** The `channel_member_admin` predicate body — server-derived roles/locations, fail-closed. */
export function channelMemberAdminPredicate(
  service: MessagingRouteService,
): (context: AbacContext, target: Record<string, unknown>) => Promise<boolean> {
  return async (context, target) => {
    const channelId = typeof target.id === "string" ? target.id : null;
    if (!channelId || !context.organizationId || !context.userId) return false;
    return service.canManageMembers(context.organizationId, memberAdminActorOf(context), channelId);
  };
}

function memberAdminActorOf(source: {
  userId: string;
  roles: readonly string[];
  locationIds: readonly string[];
}): MemberAdminActor {
  return {
    kind: "user",
    userId: source.userId,
    roles: [...source.roles],
    locationIds: [...source.locationIds],
  };
}

/** The org-scoped actor (org binding is server-side: the context, never the body). */
function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

/**
 * WP 1.2 / ADR-0021 — a send must carry a client `Idempotency-Key` (1-128 chars) so the M1 idempotency middleware
 * (bootstrap/plugins/idempotency.ts) can replay a retry instead of posting twice. The middleware only guards a
 * request that HAS a key; this guard is what makes the key mandatory on the send routes.
 */
export const REQUIRE_IDEMPOTENCY_KEY: PreHandler = async (request) => {
  const raw = request.headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new WardenXError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "an Idempotency-Key header is required",
      400,
    );
  }
};

const READ = requirePermission("messaging.read") as PreHandler;
const SEND = requirePermission("messaging.send") as PreHandler;
const DM = requirePermission("messaging.dm") as PreHandler;
const MANAGE_MEMBERS = requirePermission("messaging.manage_members") as PreHandler;
// Break-glass is read-only: it must never open a member write (a PHI grant path).
const MANAGE_CHANNEL_MEMBERS = requireAbac(
  "messaging.manage_members",
  CHANNEL_MEMBER_ADMIN_PREDICATE,
  { breakGlassBypassable: false },
) as PreHandler;
const ANNOUNCE = requirePermission("messaging.announce") as PreHandler;
const PREFS = requirePermission("notifications.preferences.manage") as PreHandler;
const ENDPOINT = requirePermission("notifications.endpoint.manage") as PreHandler;
const RULES_READ = requirePermission("alert.rules.read") as PreHandler;
const RULES_MANAGE = requirePermission("alert.rules.manage") as PreHandler;

// §4.5: the channel-scoped routes additionally require the `channel_visibility` predicate over
// the target channel (`params.id`). Defined once and reused as a preHandler.
const VIEW_CHANNEL = requireAbac("messaging.read", CHANNEL_VISIBILITY_PREDICATE) as PreHandler;
const SEND_TO_CHANNEL = requireAbac("messaging.send", CHANNEL_VISIBILITY_PREDICATE) as PreHandler;

export function registerMessagingRoutes(app: FastifyInstance, deps: MessagingRouteDeps): void {
  const { service } = deps;
  // WP 2.9: sending into the announcement channel stays org_admin-only on this route too.
  // Required, not optional: a missing service would silently leave the announcement channel open to every member.
  if (!deps.announcements) {
    throw new Error(
      "registerMessagingRoutes: `announcements` is required (the announcement send guard fails closed)",
    );
  }
  const announceGuard = announcementSendGuard(deps.announcements);
  const announcementGuards = [announceGuard];
  registerAnnouncementRoutes(app, deps.announcements);

  // ── channels & messages (§4.2) ───────────────────────────────────────────────────────────

  // --- list the channels the user is a member of (no per-channel ABAC: scoped by membership) -
  app.get(
    "/api/v1/messaging/channels",
    {
      preHandler: [READ],
      // GAP-064: a channel title can name a patient ("Care Team — Patient X"); account the list read.
      config: { auditRead: { resourceKind: "messaging_channel", list: true } },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      return { channels: await service.listChannels(organizationId, userId) };
    },
  );

  // --- channel detail + recent members (+ channel_visibility ABAC) ---------------------------
  app.get(
    "/api/v1/messaging/channels/:id",
    {
      preHandler: [READ, VIEW_CHANNEL],
      // GAP-064: the patient is the care_team channel's server-derived patient, never a client value.
      config: {
        auditRead: {
          resourceKind: "messaging_channel",
          resourceIdParam: "id",
          patientIdPayloadPath: "patientId",
        },
      },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      return service.getChannel(organizationId, userId, id);
    },
  );

  // --- paginated message history (+ channel_visibility ABAC) ---------------------------------
  app.get(
    "/api/v1/messaging/channels/:id/messages",
    {
      preHandler: [READ, VIEW_CHANNEL],
      // GAP-064 (spec: message reads are audited): clinical bodies are decrypted here. One aggregate
      // list-read event per page (count + filter), attributed to the care_team channel's patient.
      config: {
        auditRead: { resourceKind: "message", list: true, patientIdPayloadPath: "patientId" },
      },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      const q = parse(ListMessagesQuerySchema, request.query);
      return service.listMessages(organizationId, {
        channelId: id,
        userId,
        cursor: q.cursor,
        limit: q.limit,
        direction: q.direction,
        anchorMessageId: q.anchorMessageId,
      });
    },
  );

  // --- WP 2.2: a message and its direct replies. No ACL of its own: the channel's `channel_visibility` predicate on
  // `:id` is the whole gate, and the service scopes the root and every reply to that channel (a message of another
  // channel is the 404 a random id gets). One aggregate read event per page, resource = the root message.
  app.get(
    "/api/v1/messaging/channels/:id/messages/:messageId/thread",
    {
      preHandler: [READ, VIEW_CHANNEL],
      config: {
        auditRead: {
          resourceKind: "message",
          resourceIdParam: "messageId",
          patientIdPayloadPath: "patientId",
        },
      },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id, messageId } = parse(ThreadParamsSchema, request.params);
      const q = parse(ListThreadQuerySchema, request.query);
      return service.listThread(organizationId, {
        channelId: id,
        messageId,
        userId,
        cursor: q.cursor,
        limit: q.limit,
      });
    },
  );

  // --- WP 2.4: reactions and pins (own file; the channel's guards, no sign-off affordance) ---------
  registerReactionPinRoutes(app, service, {
    read: READ,
    send: SEND,
    viewChannel: VIEW_CHANNEL,
    sendToChannel: SEND_TO_CHANNEL,
    announcementOnly: announceGuard,
  });

  // --- WP 2.7a: in-conversation search (own file; the channel's guards, read-audited) -------------
  registerMessageSearchRoutes(app, service, {
    read: READ,
    send: SEND,
    viewChannel: VIEW_CHANNEL,
    sendToChannel: SEND_TO_CHANNEL,
    announcementOnly: announceGuard,
  });

  // --- WP 2.12: ephemeral presence + typing (own file; the channel's guards, flag-gated, never persisted) ----------
  registerPresenceRoutes(app, deps.presence ?? { isEnabled: async () => false }, {
    read: READ,
    viewChannel: VIEW_CHANNEL,
  });

  // Structured autocomplete is scoped to a channel whose effective visibility has already been
  // revalidated. Patient results are intentionally limited by the service to the linked care-team
  // patient; this route never acts as a general patient directory.
  app.get(
    "/api/v1/messaging/channels/:id/mention-candidates",
    {
      preHandler: [READ, VIEW_CHANNEL],
      config: {
        auditRead: {
          resourceKind: "message_mention_candidate",
          resourceIdParam: "id",
          fields: ["minimum_necessary_identity"],
        },
      },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      const { q } = parse(MentionCandidateQuerySchema, request.query);
      return {
        candidates: await service.searchMentionCandidates(
          organizationId,
          userId,
          id,
          q?.trim() ?? "",
        ),
      };
    },
  );

  // WP 2.3: colleagues who are NOT in this conversation, for the composer's "Add <name>?" prompt. Names only; the
  // lookup never reveals thread content and a mention of a non-member is never persisted (sendMessage refuses it).
  // `canAdd` mirrors the member-management route's two checks, so the UI only offers what addMember will accept.
  app.get(
    "/api/v1/messaging/channels/:id/mention-non-members",
    {
      preHandler: [SEND, SEND_TO_CHANNEL],
      config: {
        auditRead: {
          none: "minimum-necessary staff names for the composer add-member prompt; no message or patient data",
        },
      },
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      const { q } = parse(MentionNonMemberQuerySchema, request.query);
      // Someone who cannot add people gets no names: a directory lookup is only for an action they may take. (No
      // per-route rate limit exists in this repo; the global authenticated tier and the 2-character minimum bound it.)
      const canAdd = await mayAddMembers(request, reply, organizationId, id);
      if (!canAdd) {
        // Still the channel-visibility answer (a hidden channel is the one 404), just no names.
        await service.searchMentionNonMembers(organizationId, userId, id, "");
        return { people: [], canAdd };
      }
      const people = await service.searchMentionNonMembers(
        organizationId,
        userId,
        id,
        q?.trim() ?? "",
      );
      return { people, canAdd };
    },
  );

  async function mayAddMembers(
    request: FastifyRequest,
    reply: FastifyReply,
    organizationId: string,
    channelId: string,
  ): Promise<boolean> {
    try {
      await MANAGE_MEMBERS(request, reply);
    } catch {
      return false;
    }
    return service.canManageMembers(organizationId, memberAdminActorOf(request.context), channelId);
  }

  // --- post a message (messaging.send + channel_visibility ABAC) -----------------------------
  app.post(
    "/api/v1/messaging/channels/:id/messages",
    {
      preHandler: [SEND, SEND_TO_CHANNEL, ...announcementGuards, REQUIRE_IDEMPOTENCY_KEY],
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      const body = parse(SendMessageBodySchema, request.body);
      const rich = resolveRichWrite(body);
      const result = await service.sendMessage(organizationId, {
        channelId: id,
        authorUserId: userId,
        body: rich?.plainText ?? body.body ?? "",
        bodyKind: rich ? "rich" : body.bodyKind,
        richBody: rich?.richBody,
        parentMessageId: body.parentMessageId,
        quotedMessageId: body.quotedMessageId,
        clientMessageId: body.clientMessageId,
        attachments: body.attachments,
        correlationId: request.context.correlationId,
        references: rich ? rich.references : body.references,
      });
      return reply.code(201).send(result);
    },
  );

  // --- edit a message within the edit window (author check in the service) -------------------
  app.patch("/api/v1/messaging/messages/:id", { preHandler: [SEND] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(MessageParamsSchema, request.params);
    const body = parse(EditMessageBodySchema, request.body);
    if (body.body === undefined && body.bodyDoc === undefined) {
      throw new WardenXError("VALIDATION_FAILED", "an edit needs a body or a bodyDoc", 422);
    }
    const rich = resolveRichWrite(body);
    return service.editMessage(organizationId, {
      userId,
      messageId: id,
      body: rich?.plainText ?? body.body ?? "",
      richBody: rich?.richBody,
      references: rich ? rich.references : body.references,
    });
  });

  // --- soft-delete a message (author check in the service) -----------------------------------
  app.delete("/api/v1/messaging/messages/:id", { preHandler: [SEND] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(MessageParamsSchema, request.params);
    await service.deleteMessage(organizationId, { userId, messageId: id });
    return reply.code(204).send();
  });

  // --- mark message(s) read (single or up-through-id) ----------------------------------------
  app.post(
    "/api/v1/messaging/messages/:id/read",
    { preHandler: [READ] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(MessageParamsSchema, request.params);
      const body = parse(ReadBodySchema, request.body);
      await service.markRead(organizationId, { userId, messageId: id, upTo: body.upTo });
      return reply.code(204).send();
    },
  );

  // --- open/find a DM channel with another user (idempotent) ---------------------------------
  app.post("/api/v1/messaging/dm", { preHandler: [DM] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const body = parse(OpenDmBodySchema, request.body);
    const result = await service.openDm(organizationId, userId, body.userId);
    return reply.code(result.created ? 201 : 200).send(result);
  });

  // Minimum-necessary directory for the DM picker. Organization and actor are server-derived;
  // suspended/revoked/foreign memberships are excluded by the service.
  app.get(
    "/api/v1/messaging/dm/staff",
    {
      preHandler: [DM],
      config: {
        auditRead: {
          none: "minimum-necessary staff directory (name/role) for the DM picker; no patient data",
        },
      },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { q } = parse(DmStaffSearchQuerySchema, request.query);
      return {
        staff: await service.searchDmEligibleStaff(organizationId, userId, q?.trim() ?? ""),
      };
    },
  );

  // Open/provision a patient care-team conversation. The service verifies tenant-bound patient
  // identity, current clinical roster or an explicit manual grant, synchronizes through the M36
  // provider, then revalidates effective access. The patient id never grants access by itself.
  app.post(
    "/api/v1/messaging/patients/:patientId/care-team-channel",
    {
      preHandler: [READ],
      config: {
        auditRead: {
          resourceKind: "patient_care_team_conversation",
          resourceIdParam: "patientId",
          patientIdParam: "patientId",
          fields: ["messaging_channel"],
        },
      },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { patientId } = parse(PatientConversationParamsSchema, request.params);
      return service.openCareTeamChannel(organizationId, userId, patientId);
    },
  );

  // --- the full active member list (admin screen). Same guard as the member writes: the list names
  // who can read a (possibly clinical) channel, so it is not a plain messaging.read.
  app.get(
    "/api/v1/messaging/channels/:id/members",
    {
      preHandler: [MANAGE_MEMBERS, MANAGE_CHANNEL_MEMBERS],
      config: { auditRead: { resourceKind: "messaging_channel_members", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      return {
        members: await service.listMembers(organizationId, memberAdminActorOf(request.context), id),
      };
    },
  );

  // --- archive a channel (org_admin only: the service refuses everyone else, and lifecycle-managed
  // kinds). Idempotent 204. Audited by the channel write-audit trigger with the real actor; no outbox
  // event: the catalog has none for archive (discharge-driven archive emits none either).
  app.post(
    "/api/v1/messaging/channels/:id/archive",
    { preHandler: [MANAGE_MEMBERS, MANAGE_CHANNEL_MEMBERS] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      await service.archiveChannel(organizationId, {
        channelId: id,
        actor: memberAdminActorOf(request.context),
      });
      return reply.code(204).send();
    },
  );

  // --- unarchive: the inverse of archive — same guards, kind policy and audit; idempotent 204.
  app.post(
    "/api/v1/messaging/channels/:id/unarchive",
    { preHandler: [MANAGE_MEMBERS, MANAGE_CHANNEL_MEMBERS] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      await service.unarchiveChannel(organizationId, {
        channelId: id,
        actor: memberAdminActorOf(request.context),
      });
      return reply.code(204).send();
    },
  );

  // --- add a manual member (admin override on auto channels — audited) -----------------------
  app.post(
    "/api/v1/messaging/channels/:id/members",
    { preHandler: [MANAGE_MEMBERS, MANAGE_CHANNEL_MEMBERS] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      const body = parse(AddMemberBodySchema, request.body);
      await service.addMember(organizationId, {
        channelId: id,
        userId: body.userId,
        role: body.role,
        actor: memberAdminActorOf(request.context),
      });
      return reply.code(204).send();
    },
  );

  // --- remove a member -----------------------------------------------------------------------
  app.delete(
    "/api/v1/messaging/channels/:id/members/:userId",
    { preHandler: [MANAGE_MEMBERS, MANAGE_CHANNEL_MEMBERS] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const { id, userId } = parse(MemberParamsSchema, request.params);
      await service.removeMember(organizationId, {
        channelId: id,
        userId,
        actor: memberAdminActorOf(request.context),
      });
      return reply.code(204).send();
    },
  );

  // --- post to the tenant announcement channel (org_admin) -----------------------------------
  app.post(
    "/api/v1/messaging/announce",
    { preHandler: [ANNOUNCE, REQUIRE_IDEMPOTENCY_KEY] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(AnnounceBodySchema, request.body);
      const result = await service.announce(organizationId, {
        authorUserId: userId,
        body: body.body,
      });
      return reply.code(201).send(result);
    },
  );

  // ── notification preferences & endpoints (§4.2; SELF-only) ─────────────────────────────────

  // --- self-read preferences -----------------------------------------------------------------
  app.get(
    "/api/v1/notifications/preferences",
    {
      preHandler: [PREFS],
      config: {
        auditRead: {
          none: "self-only delivery preferences (routing map, quiet hours); no patient data is surfaced",
        },
      },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      return service.getPreferences(organizationId, userId);
    },
  );

  // --- self-update preferences (422 INVALID_ROUTING_MAP / 409 VACATION_FORWARD_*) ------------
  app.put("/api/v1/notifications/preferences", { preHandler: [PREFS] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const body = parse(PreferencesBodySchema, request.body);
    return service.putPreferences(organizationId, userId, {
      routingMap: body.routingMap,
      quietHours: body.quietHours,
      vacationForwardToUserId: body.vacationForwardToUserId ?? null,
      vacationUntil: body.vacationUntil ?? null,
    });
  });

  // --- register a push / sms / email endpoint ------------------------------------------------
  app.post(
    "/api/v1/notifications/endpoints",
    { preHandler: [ENDPOINT] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(RegisterEndpointBodySchema, request.body);
      const result = await service.registerEndpoint(organizationId, userId, {
        channel: body.channel,
        target: body.target,
      });
      return reply.code(201).send(result);
    },
  );

  // --- confirm a verification token ----------------------------------------------------------
  app.post(
    "/api/v1/notifications/endpoints/:id/verify",
    { preHandler: [ENDPOINT] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(EndpointParamsSchema, request.params);
      const body = parse(VerifyEndpointBodySchema, request.body);
      return service.verifyEndpoint(organizationId, userId, id, body.token);
    },
  );

  // --- remove an endpoint --------------------------------------------------------------------
  app.delete(
    "/api/v1/notifications/endpoints/:id",
    { preHandler: [ENDPOINT] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(EndpointParamsSchema, request.params);
      await service.removeEndpoint(organizationId, userId, id);
      return reply.code(204).send();
    },
  );

  // ── alerts (§4.2) ──────────────────────────────────────────────────────────────────────────

  // --- the actor's recent alerts with delivery status ----------------------------------------
  app.get(
    "/api/v1/alerts/inbox",
    {
      preHandler: [READ],
      // GAP-064: alert summaries are clinical (SFV due, safety); account the list read.
      config: { auditRead: { resourceKind: "alert", list: true } },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      return { alerts: await service.alertInbox(organizationId, userId) };
    },
  );

  // --- mark one alert read for the current actor -----------------------------------------------
  app.post("/api/v1/alerts/:id/read", { preHandler: [READ] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(AlertParamsSchema, request.params);

    await service.markAlertRead(organizationId, userId, id);

    return reply.code(204).send();
  });

  // --- tenant + inherited platform alert rules -----------------------------------------------
  app.get("/api/v1/alert-rules", { preHandler: [RULES_READ] }, async (request) => {
    const { organizationId } = actorOf(request);
    return { rules: await service.listAlertRules(organizationId) };
  });

  // --- enable/disable/override (clones a platform default on first edit; §7.4 system_locked) -
  app.patch("/api/v1/alert-rules/:id", { preHandler: [RULES_MANAGE] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { id } = parse(AlertRuleParamsSchema, request.params);
    const patch = parse(AlertRulePatchSchema, request.body);
    return service.patchAlertRule(organizationId, { ruleId: id, patch });
  });
}
