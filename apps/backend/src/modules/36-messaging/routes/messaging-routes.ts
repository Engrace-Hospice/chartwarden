// apps/backend/src/modules/36-messaging/routes/messaging-routes.ts — M36-T07 the messaging route
// inventory (M36 spec §4.1–4.2; the §4.5 permission handshake; the `channel_visibility` ABAC gate).
//
// These are M36's tenant-user-facing routes: the channel/message surface (list/detail/history,
// post/edit/delete, read receipts, DM, member admin override, announcement), the SELF-only
// notification preferences + delivery endpoints, and the alert inbox + alert-rule read/override.
// Every route is gated by the REAL Authorization Contract (`requirePermission`/`requireAbac` from
// @chartwarden/auth, M3) on the §4.5 keys M36 registers into M3's catalog (M36_CONTRIBUTED_PERMISSIONS).
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
// in-memory adapter from @chartwarden/messaging; production injects the Drizzle/Valkey-backed service,
// whose mutations run inside `withOrgContext` so RLS on `app.org_id` is the backstop and whose
// `sendMessage` envelope-encrypts the body under the tenant DEK (§3.4). Org/actor binding is always
// server-side: the org/user come from `request.context`, never the body.
import {
  type AbacContext,
  abacRegistry,
  registerPredicate,
  requireAbac,
  requirePermission,
  resolveActorPermissions,
} from "@chartwarden/auth";
import { isValidNativePushToken, parseNativeDestination } from "@chartwarden/messaging";
import type {
  AnnouncementService,
  MemberAdminActor,
  MessagingRouteService,
} from "@chartwarden/messaging";
import {
  ChartWardenError,
  ForbiddenError,
  MESSAGING_RETENTION_MANAGE_PERMISSION,
  UnauthorizedError,
} from "@chartwarden/types";
import type { ExternalShareIndicatorDto } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { rejectIfUnderLegalHold } from "../governance/under-hold";
import { createRoleSendService } from "../oncall-directory/role-send-service";
import {
  DISABLED_AFTERHOURS_TRIAGE,
  registerAfterHoursTriageRoutes,
} from "./afterhours-triage-routes";
import { resolveRichWrite } from "../rich-body-codec";
import { type AckRouteDeps, DISABLED_ACK, registerAckRoutes } from "./ack-routes";
import { announcementSendGuard, registerAnnouncementRoutes } from "./announcement-routes";
import {
  type ClinicalLinkRouteDeps,
  DISABLED_CLINICAL_LINKS,
  registerClinicalLinkRoutes,
  validateRichBodyLinks,
} from "./clinical-link-routes";
import {
  DISABLED_DELIVERY_TARGET,
  type DeliveryTargetRouteDeps,
  registerDeliveryTargetRoutes,
} from "./delivery-target-routes";
import { DISABLED_HANDOFFS, type HandoffRouteDeps, registerHandoffRoutes } from "./handoff-routes";
import {
  DISABLED_IDG_DISCUSSIONS,
  type IdgDiscussionRouteDeps,
  registerIdgDiscussionRoutes,
} from "./idg-discussion-routes";
import {
  DISABLED_MEDICATION_QUESTIONS,
  type MedicationQuestionRouteDeps,
  registerMedicationQuestionRoutes,
} from "./medication-question-routes";
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
import { DISABLED_ONCALL, type OnCallRouteDeps, registerOnCallRoutes } from "./oncall-routes";
import { registerPatientContextRoutes, seamPatientContextPorts } from "./patient-context-routes";
import { type PresenceRouteDeps, registerPresenceRoutes } from "./presence-routes";
import {
  DISABLED_PROMOTIONS,
  type PromotionRouteDeps,
  registerPromotionRoutes,
} from "./promotion-routes";
import { registerReactionPinRoutes } from "./reaction-pin-routes";
import { DISABLED_REVIEW, type ReviewRouteDeps, registerReviewRoutes } from "./review-routes";
import { DISABLED_ROLE_SEND, registerRoleSendRoutes } from "./role-send-routes";
import {
  DISABLED_SBAR,
  type SbarRouteDeps,
  assertSbarFlag,
  registerSbarRoutes,
} from "./sbar-routes";
import { registerMessageSearchRoutes } from "./search-routes";
import {
  DISABLED_SNOOZE_REMINDER,
  type SnoozeReminderRouteDeps,
  registerSnoozeReminderRoutes,
} from "./snooze-reminder-routes";
import { type AckBroadcastRouteDeps, registerAckBroadcastRoutes } from "./ack-broadcast-routes";
import { DISABLED_INBOX, type InboxRouteDeps, registerInboxRoutes } from "./inbox-routes";
import { DISABLED_TASKS, type TaskRouteDeps, registerTaskRoutes } from "./task-routes";
import {
  DISABLED_UNACKNOWLEDGED,
  type UnacknowledgedRouteDeps,
  registerUnacknowledgedRoutes,
} from "./unacknowledged-routes";
import { DISABLED_URGENT, type UrgentRouteDeps, registerUrgentRoutes } from "./urgent-routes";

/** A @chartwarden/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The named ABAC predicate the channel-scoped routes gate on (§4.5). */
export const CHANNEL_VISIBILITY_PREDICATE = "channel_visibility";

/**
 * ADR-0087 (PROPOSED): the READ-only variant of `channel_visibility` - membership OR a live break-glass grant. Only the channel-detail,
 * message-list and thread GETs use it; every write, assignee and recipient check keeps `channel_visibility`, so a grant can never write.
 */
export const CHANNEL_VISIBILITY_READ_PREDICATE = "channel_visibility_read";

/** The §4.5 `location_membership` predicate for `messaging.manage_members` (GAP-103): org_admin, or
 *  clinical_lead on a location channel of their own location. */
export const CHANNEL_MEMBER_ADMIN_PREDICATE = "channel_member_admin";

/** The injection surface for the messaging routes (mirrors M38's `TerminologyRouteDeps`). */
export interface MessagingRouteDeps {
  /** The §4.1–4.2 application service (in-memory in the slice; Drizzle/Valkey in prod). */
  service: MessagingRouteService;
  /** WP 6.6 (ADR-0096 D18): the live "an outside partner can read this" fact for the channel detail. Omitted => the field is never present. */
  externalShare?: {
    indicator(
      actor: { organizationId: string; userId: string },
      channelId: string,
    ): Promise<ExternalShareIndicatorDto | null>;
  };
  /** WP 2.9: announcement receipts, department channels and the org_admin-only announcement send guard. */
  announcements: AnnouncementService;
  /** WP 2.12: ephemeral presence/typing. Omitted => the routes are registered but the tenant flag reads off. */
  presence?: PresenceRouteDeps;
  /** WP 3.2: clinical links (flag, source seams, link store). Omitted => flag off: links are refused and resolve 404s. */
  clinicalLinks?: Omit<ClinicalLinkRouteDeps, "canViewChannel">;
  /** WP 3.3: SBAR (flag + policy store). Omitted => flag off: an sbar body is refused and the policy route 404s. */
  sbar?: SbarRouteDeps;
  /** WP 3.4: communication tasks (flag + service). Omitted => flag off: every task route 404s and the list answers disabled. */
  tasks?: TaskRouteDeps;
  /** WP 3.5: clinical handoffs (flag + service). Omitted => flag off: every handoff route 404s and the list answers disabled. */
  handoffs?: HandoffRouteDeps;
  /** WP 3.8: lifecycle review queue (flag + service). Omitted => flag off: every review route 404s and the list answers disabled. */
  review?: ReviewRouteDeps;
  /** WP 3.7: chart promotion (flag + service). Omitted => flag off: every promotion route 404s and the list answers disabled. */
  promotions?: PromotionRouteDeps;
  /** WP 3.10: medication questions (service). Omitted => flag off: the ask route 404s and the options read answers disabled. */
  medicationQuestions?: MedicationQuestionRouteDeps;
  /** WP 4.1: the "Urgent clinical" entry (flag + service). Omitted => flag off: POST is the uniform 404. */
  urgent?: UrgentRouteDeps;
  /** WP 4.2: the acknowledgment-request aggregate (service + limiter). Omitted => every route is the uniform 404. */
  ackRequests?: AckRouteDeps;
  /** WP 4.9: the supervisor's unacknowledged queue (read-only). Omitted => an empty queue. */
  unacknowledged?: UnacknowledgedRouteDeps;
  /** WP 4.10: snooze and reminders (service). Omitted => every route is the uniform 404. */
  snoozeReminders?: SnoozeReminderRouteDeps;
  /** WP 6.1 (ADR-0091): the smart work inbox (read-only; tenant flag `messaging.smart_inbox`). Omitted => reads as off. */
  inbox?: InboxRouteDeps;
  /** WP 6.8 (ADR-0097): acknowledge-required broadcast (tenant flag `messaging.ack_broadcast`). Omitted => the routes are not registered (404). */
  ackBroadcast?: AckBroadcastRouteDeps;
  /** WP 4.12: the on-call "who is covering now" directory (read-only). Omitted => the uniform 404. */
  oncall?: OnCallRouteDeps;
  /** WP 4.8: resolve an out-of-band link's opaque delivery id to its in-app target. Omitted => the uniform 404. */
  deliveryTarget?: DeliveryTargetRouteDeps;
  /** WP 3.6: IDG discussions (flag + read-only store). Omitted => flag off: the list answers disabled. */
  idgDiscussions?: Omit<IdgDiscussionRouteDeps, "canViewChannel">;
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
  if (!abacRegistry.has(CHANNEL_VISIBILITY_READ_PREDICATE)) registerChannelVisibilityRead(service);
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

function registerChannelVisibilityRead(service: MessagingRouteService): void {
  registerPredicate(CHANNEL_VISIBILITY_READ_PREDICATE, async (context, target) => {
    const channelId = typeof target.id === "string" ? target.id : null;
    if (!channelId || !context.organizationId || !context.userId) return false;
    return service.canReadChannel(context.organizationId, context.userId, channelId);
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
    throw new ChartWardenError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "an Idempotency-Key header is required",
      400,
    );
  }
};

const READ = requirePermission("messaging.read") as PreHandler;
// The caller's OWN alert inbox / mark-read. Both service methods filter on recipient_user_id = the actor (never a
// body/param user id), so they expose nothing of anyone else's. `alert.inbox.self` exists so the zero-authority
// platform_alert_audience role (migration 1097) can read the alerts addressed to it without `messaging.read`
// (which opens channels). Either key suffices.
const OWN_ALERTS: PreHandler = async (request) => {
  const ctx = request.context;
  if (!ctx?.organizationId) throw new UnauthorizedError();
  const granted = await resolveActorPermissions(ctx);
  if (!granted.has("messaging.read") && !granted.has("alert.inbox.self"))
    throw new ForbiddenError("requires permission 'messaging.read' or 'alert.inbox.self'");
};
/**
 * WP 5.6 (ADR-0086): only a holder of `messaging.retention.manage` sees the "Legal hold" chip. That a hold exists is itself sensitive (a
 * custodian must not learn they are under one), so ordinary readers never get the flag. Decided here from the actor's effective permissions.
 */
const canSeeLegalHold = async (request: FastifyRequest): Promise<boolean> => {
  const ctx = request.context;
  if (!ctx?.organizationId) return false;
  return (await resolveActorPermissions(ctx)).has(MESSAGING_RETENTION_MANAGE_PERMISSION);
};
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
// ADR-0087: the three read GETs a break-glass grant opens (channel detail, message list, thread). Reads only.
const VIEW_CHANNEL_READ = requireAbac(
  "messaging.read",
  CHANNEL_VISIBILITY_READ_PREDICATE,
) as PreHandler;

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
      preHandler: [READ, VIEW_CHANNEL_READ],
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
      const detail = await service.getChannel(organizationId, userId, id);
      // The route's preHandler already proved the caller may read this channel; the indicator is computed live from the share table every time.
      // A break-glass reader passes the route's read predicate without being a member; the indicator is for MEMBERS (plain visibility, no grant).
      const isMember = deps.externalShare
        ? await service.canViewChannel(organizationId, userId, id)
        : false;
      const externalShare = isMember
        ? await deps.externalShare?.indicator({ organizationId, userId }, id)
        : null;
      return externalShare ? { ...detail, externalShare } : detail;
    },
  );

  // --- paginated message history (+ channel_visibility ABAC) ---------------------------------
  app.get(
    "/api/v1/messaging/channels/:id/messages",
    {
      preHandler: [READ, VIEW_CHANNEL_READ],
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
        showLegalHold: await canSeeLegalHold(request),
      });
    },
  );

  // --- WP 2.2: a message and its direct replies. No ACL of its own: the channel's `channel_visibility` predicate on
  // `:id` is the whole gate, and the service scopes the root and every reply to that channel (a message of another
  // channel is the 404 a random id gets). One aggregate read event per page, resource = the root message.
  app.get(
    "/api/v1/messaging/channels/:id/messages/:messageId/thread",
    {
      preHandler: [READ, VIEW_CHANNEL_READ],
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
        showLegalHold: await canSeeLegalHold(request),
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

  // --- WP 3.1: patient context panel (own file; per-tile permission re-check, a denied tile is absent) ---------------
  // The open-tasks tile reads the task service (flag-gated); with no tasks bound the flag reads off and the tile is absent.
  const taskDeps = deps.tasks ?? DISABLED_TASKS;
  registerPatientContextRoutes(
    app,
    { read: READ },
    { ...seamPatientContextPorts, openTaskCount: taskDeps.service.openTaskCount },
    taskDeps.isEnabled,
  );

  // --- WP 3.2: clinical links (message -> clinical record, read-through). Writes validate each link on send/edit. -----
  const clinicalLinkDeps: ClinicalLinkRouteDeps = {
    ...(deps.clinicalLinks ?? DISABLED_CLINICAL_LINKS),
    canViewChannel: service.canViewChannel,
  };
  registerClinicalLinkRoutes(app, { read: READ }, clinicalLinkDeps);

  // --- WP 3.3: SBAR (policy read/admin routes; the flag check on a send/edit body; lengths are checked in the service) --
  const sbarDeps = deps.sbar ?? DISABLED_SBAR;
  registerSbarRoutes(app, sbarDeps);

  // --- WP 3.4: communication tasks (message -> assignee task; thin row, no free text; flag-gated) -----------------------
  registerTaskRoutes(app, taskDeps, {
    read: READ,
    send: SEND,
    sendToChannel: SEND_TO_CHANNEL,
  });

  // --- WP 3.5: clinical handoffs (a set of open-work pointers offered to a colleague who accepts per item; flag-gated) ---
  registerHandoffRoutes(app, deps.handoffs ?? DISABLED_HANDOFFS, { read: READ, send: SEND });

  // --- WP 3.8: lifecycle review queue (a supervisor reassigns or closes the open tasks of a patient who left care; flag-gated) ---
  registerReviewRoutes(app, deps.review ?? DISABLED_REVIEW, { read: READ, send: SEND });
  // --- WP 3.10: "ask a nurse about a medication" (message + optional read-only link + the nurse's task; never an order) ---
  registerMedicationQuestionRoutes(app, deps.medicationQuestions ?? DISABLED_MEDICATION_QUESTIONS, {
    read: READ,
    viewChannel: VIEW_CHANNEL,
    send: SEND,
    sendToChannel: SEND_TO_CHANNEL,
    requireIdempotencyKey: REQUIRE_IDEMPOTENCY_KEY,
    validateLinks: (request, richBody) =>
      validateRichBodyLinks(request, clinicalLinkDeps, richBody),
  });

  // --- WP 4.1: "Urgent clinical" (an SBAR message to one qualified colleague, marked urgent; no paging or response tracking) ---
  registerUrgentRoutes(app, deps.urgent ?? DISABLED_URGENT, {
    read: READ,
    viewChannel: VIEW_CHANNEL,
    send: SEND,
    sendToChannel: SEND_TO_CHANNEL,
    requireIdempotencyKey: REQUIRE_IDEMPOTENCY_KEY,
    validateLinks: (request, richBody) =>
      validateRichBodyLinks(request, clinicalLinkDeps, richBody),
  });

  // --- WP 4.2: acknowledgment requests (one qualified colleague takes responsibility by an explicit action; no timers or paging) ---
  registerAckRoutes(app, deps.ackRequests ?? DISABLED_ACK, {
    read: READ,
    viewChannel: VIEW_CHANNEL,
    send: SEND,
    requireIdempotencyKey: REQUIRE_IDEMPOTENCY_KEY,
  });

  // --- WP 4.9: the supervisor's unacknowledged-urgent queue (registered beside the ack routes; the static path wins over `/escalations/:id`) ---
  registerUnacknowledgedRoutes(app, deps.unacknowledged ?? DISABLED_UNACKNOWLEDGED, {
    read: READ,
  });

  // --- WP 6.1: the smart work inbox (read-only ranked queue over the caller's own work) ---
  registerInboxRoutes(app, deps.inbox ?? DISABLED_INBOX, { read: READ });
  // --- WP 6.8: acknowledge-required broadcast (flag-gated inside; routes exist only when the boot supplies the service) ---
  if (deps.ackBroadcast) registerAckBroadcastRoutes(app, deps.ackBroadcast);

  // --- WP 4.12: the on-call directory (read-only; flag-gated in the service) ---
  registerOnCallRoutes(app, deps.oncall ?? DISABLED_ONCALL, { read: READ });

  // --- ADR-0081 (PROPOSED): role-based send over the urgent service and the same guarded router; flag-gated in the service ---
  registerRoleSendRoutes(
    app,
    deps.oncall?.roleSend && deps.urgent
      ? {
          service: createRoleSendService({ ...deps.oncall.roleSend, urgent: deps.urgent.service }),
          patientExists: deps.oncall.patientExists,
          ...(deps.urgent.rateLimit ? { rateLimit: deps.urgent.rateLimit } : {}),
        }
      : DISABLED_ROLE_SEND,
    {
      read: READ,
      viewChannel: VIEW_CHANNEL,
      send: SEND,
      sendToChannel: SEND_TO_CHANNEL,
      requireIdempotencyKey: REQUIRE_IDEMPOTENCY_KEY,
      validateLinks: (request, richBody) =>
        validateRichBodyLinks(request, clinicalLinkDeps, richBody),
    },
  );

  // --- ADR-0082 (PROPOSED): the fixed-text after-hours triage line of a message; flag-gated inside the service ---
  registerAfterHoursTriageRoutes(
    app,
    deps.oncall?.afterHoursLines ? { service: deps.oncall.afterHoursLines } : DISABLED_AFTERHOURS_TRIAGE,
    { read: READ, viewChannel: VIEW_CHANNEL },
  );

  // --- WP 4.10: snooze (non-urgent only) and reminders; the caller's own rows, flag-gated ---
  registerSnoozeReminderRoutes(app, deps.snoozeReminders ?? DISABLED_SNOOZE_REMINDER, {
    read: READ,
    requireIdempotencyKey: REQUIRE_IDEMPOTENCY_KEY,
  });

  // --- WP 4.8: the deep-link landing (an opaque delivery id -> channel + message + ack request, for the signed-in recipient only) ---
  registerDeliveryTargetRoutes(app, deps.deliveryTarget ?? DISABLED_DELIVERY_TARGET, {
    read: READ,
  });

  // --- WP 3.7: chart promotion (a message proposed for the chart; a reviewer decides in M8/M14, never here; flag-gated) ---
  registerPromotionRoutes(app, deps.promotions ?? DISABLED_PROMOTIONS, {
    read: READ,
    send: SEND,
    sendToChannel: SEND_TO_CHANNEL,
  });
  // --- WP 3.6: IDG discussions (read-only list of care-team root messages linked to an IDG meeting; flag-gated) ---------
  registerIdgDiscussionRoutes(
    app,
    { read: READ, viewChannel: VIEW_CHANNEL },
    {
      ...(deps.idgDiscussions ?? DISABLED_IDG_DISCUSSIONS),
      canViewChannel: service.canViewChannel,
    },
  );

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
      // WP 3.2: every clinicalLink node is authorised BEFORE the message commits (generic 422 on any failure).
      await assertSbarFlag(request, sbarDeps, rich?.richBody);
      const clinicalLinks = await validateRichBodyLinks(request, clinicalLinkDeps, rich?.richBody);
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
        clinicalLinks,
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
      throw new ChartWardenError("VALIDATION_FAILED", "an edit needs a body or a bodyDoc", 422);
    }
    const rich = resolveRichWrite(body);
    await assertSbarFlag(request, sbarDeps, rich?.richBody);
    const clinicalLinks = await validateRichBodyLinks(request, clinicalLinkDeps, rich?.richBody);
    return rejectIfUnderLegalHold(() =>
      service.editMessage(organizationId, {
        userId,
        messageId: id,
        body: rich?.plainText ?? body.body ?? "",
        richBody: rich?.richBody,
        references: rich ? rich.references : body.references,
        clinicalLinks,
      }),
    );
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
      // WP 5.5: link the endpoint to the session that registers it, so revoking that session expires it. Server-side context only.
      const sessionId = request.context.attributes?.sessionId;
      const provider = body.provider ?? "web";
      if (provider === "web" && parseNativeDestination(body.target) !== null)
        throw new ChartWardenError(
          "VALIDATION_FAILED",
          "a native push destination must be registered with its provider",
          422,
        );
      if (provider !== "web") {
        // A native token is only meaningful on the push channel, must look like that provider's token, and must be linked to the
        // registering session so a session revoke can expire it (fail closed: an unlinked native token would outlive a lost phone).
        if (body.channel !== "push" || !isValidNativePushToken(provider, body.target))
          throw new ChartWardenError("VALIDATION_FAILED", `invalid ${provider} push token`, 422);
        if (typeof sessionId !== "string" || sessionId === "")
          throw new ChartWardenError(
            "VALIDATION_FAILED",
            "a native push endpoint must be registered from a signed-in session",
            422,
          );
      }
      const result = await service.registerEndpoint(organizationId, userId, {
        channel: body.channel,
        target: body.target,
        ...(provider !== "web" ? { provider } : {}),
        ...(typeof sessionId === "string" && sessionId !== "" ? { sessionId } : {}),
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
      preHandler: [OWN_ALERTS],
      // GAP-064: alert summaries are clinical (SFV due, safety); account the list read.
      config: { auditRead: { resourceKind: "alert", list: true } },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      return { alerts: await service.alertInbox(organizationId, userId) };
    },
  );

  // --- mark one alert read for the current actor -----------------------------------------------
  app.post("/api/v1/alerts/:id/read", { preHandler: [OWN_ALERTS] }, async (request, reply) => {
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
