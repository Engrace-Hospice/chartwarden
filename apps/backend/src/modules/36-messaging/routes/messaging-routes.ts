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
import { abacRegistry, registerPredicate, requireAbac, requirePermission } from "@wardenx/auth";
import type { MessagingRouteService } from "@wardenx/messaging";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AddMemberBodySchema,
  AlertRuleParamsSchema,
  AlertRulePatchSchema,
  AnnounceBodySchema,
  ChannelParamsSchema,
  EditMessageBodySchema,
  EndpointParamsSchema,
  ListMessagesQuerySchema,
  MemberParamsSchema,
  MessageParamsSchema,
  OpenDmBodySchema,
  PreferencesBodySchema,
  ReadBodySchema,
  RegisterEndpointBodySchema,
  SendMessageBodySchema,
  VerifyEndpointBodySchema,
  parse,
} from "./messaging-typebox";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The named ABAC predicate the channel-scoped routes gate on (§4.5). */
export const CHANNEL_VISIBILITY_PREDICATE = "channel_visibility";

/** The injection surface for the messaging routes (mirrors M38's `TerminologyRouteDeps`). */
export interface MessagingRouteDeps {
  /** The §4.1–4.2 application service (in-memory in the slice; Drizzle/Valkey in prod). */
  service: MessagingRouteService;
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
  if (abacRegistry.has(CHANNEL_VISIBILITY_PREDICATE)) return;
  registerPredicate(CHANNEL_VISIBILITY_PREDICATE, async (context, target) => {
    const channelId = typeof target.id === "string" ? target.id : null;
    if (!channelId || !context.organizationId || !context.userId) return false;
    return service.canViewChannel(context.organizationId, context.userId, channelId);
  });
}

/** The org-scoped actor (org binding is server-side: the context, never the body). */
function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

const READ = requirePermission("messaging.read") as PreHandler;
const SEND = requirePermission("messaging.send") as PreHandler;
const DM = requirePermission("messaging.dm") as PreHandler;
const MANAGE_MEMBERS = requirePermission("messaging.manage_members") as PreHandler;
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

  // ── channels & messages (§4.2) ───────────────────────────────────────────────────────────

  // --- list the channels the user is a member of (no per-channel ABAC: scoped by membership) -
  app.get("/api/v1/messaging/channels", { preHandler: [READ] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    return { channels: await service.listChannels(organizationId, userId) };
  });

  // --- channel detail + recent members (+ channel_visibility ABAC) ---------------------------
  app.get(
    "/api/v1/messaging/channels/:id",
    { preHandler: [READ, VIEW_CHANNEL] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      return service.getChannel(organizationId, userId, id);
    },
  );

  // --- paginated message history (+ channel_visibility ABAC) ---------------------------------
  app.get(
    "/api/v1/messaging/channels/:id/messages",
    { preHandler: [READ, VIEW_CHANNEL] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      const q = parse(ListMessagesQuerySchema, request.query);
      return service.listMessages(organizationId, {
        channelId: id,
        userId,
        cursor: q.cursor,
        limit: q.limit,
      });
    },
  );

  // --- post a message (messaging.send + channel_visibility ABAC) -----------------------------
  app.post(
    "/api/v1/messaging/channels/:id/messages",
    { preHandler: [SEND, SEND_TO_CHANNEL] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      const body = parse(SendMessageBodySchema, request.body);
      const result = await service.sendMessage(organizationId, {
        channelId: id,
        authorUserId: userId,
        body: body.body,
        bodyKind: body.bodyKind,
        parentMessageId: body.parentMessageId,
        quotedMessageId: body.quotedMessageId,
        attachments: body.attachments,
        correlationId: request.context.correlationId,
      });
      return reply.code(201).send(result);
    },
  );

  // --- edit a message within the edit window (author check in the service) -------------------
  app.patch(
    "/api/v1/messaging/messages/:id",
    { preHandler: [SEND] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(MessageParamsSchema, request.params);
      const body = parse(EditMessageBodySchema, request.body);
      return service.editMessage(organizationId, { userId, messageId: id, body: body.body });
    },
  );

  // --- soft-delete a message (author check in the service) -----------------------------------
  app.delete(
    "/api/v1/messaging/messages/:id",
    { preHandler: [SEND] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(MessageParamsSchema, request.params);
      await service.deleteMessage(organizationId, { userId, messageId: id });
      return reply.code(204).send();
    },
  );

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

  // --- add a manual member (admin override on auto channels — audited) -----------------------
  app.post(
    "/api/v1/messaging/channels/:id/members",
    { preHandler: [MANAGE_MEMBERS] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(ChannelParamsSchema, request.params);
      const body = parse(AddMemberBodySchema, request.body);
      await service.addMember(organizationId, { channelId: id, userId: body.userId, role: body.role });
      return reply.code(204).send();
    },
  );

  // --- remove a member -----------------------------------------------------------------------
  app.delete(
    "/api/v1/messaging/channels/:id/members/:userId",
    { preHandler: [MANAGE_MEMBERS] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const { id, userId } = parse(MemberParamsSchema, request.params);
      await service.removeMember(organizationId, { channelId: id, userId });
      return reply.code(204).send();
    },
  );

  // --- post to the tenant announcement channel (org_admin) -----------------------------------
  app.post("/api/v1/messaging/announce", { preHandler: [ANNOUNCE] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const body = parse(AnnounceBodySchema, request.body);
    const result = await service.announce(organizationId, { authorUserId: userId, body: body.body });
    return reply.code(201).send(result);
  });

  // ── notification preferences & endpoints (§4.2; SELF-only) ─────────────────────────────────

  // --- self-read preferences -----------------------------------------------------------------
  app.get("/api/v1/notifications/preferences", { preHandler: [PREFS] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    return service.getPreferences(organizationId, userId);
  });

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
  app.post("/api/v1/notifications/endpoints", { preHandler: [ENDPOINT] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const body = parse(RegisterEndpointBodySchema, request.body);
    const result = await service.registerEndpoint(organizationId, userId, {
      channel: body.channel,
      target: body.target,
    });
    return reply.code(201).send(result);
  });

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
  app.get("/api/v1/alerts/inbox", { preHandler: [READ] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    return { alerts: await service.alertInbox(organizationId, userId) };
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
