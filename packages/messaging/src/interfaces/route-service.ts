// @wardenx/messaging — the M36 HTTP route-facing application service (M36-T07, spec §4.1–4.2).
//
// This is the surface the backend's §4.1 route inventory composes over — DISTINCT from the
// cross-module §4.6 `MessagingProvider`/`AlertEmitter` seams (which are the contracts OTHER
// modules import). The route service bundles the tenant-user-facing operations the REST surface
// needs (list my channels, channel detail + member CRUD, edit/delete a message, notification
// preferences + delivery endpoints, the alert inbox, and alert-rule read/override) — operations
// that are M36-internal and never crossed a module boundary. The interface lives HERE in the
// feature package (not the leaf @wardenx/types) so the in-memory slice impl and the production
// Drizzle/Valkey impl share one typed contract, and the backend route module injects it the way
// M38's routes inject `TerminologyProvider`.
//
// Every operation is org-scoped (the orgId is server-assembled from `request.context`, never the
// body) and the production impl runs each mutation inside `withOrgContext` so RLS on `app.org_id`
// is the backstop; the slice default (createInMemoryMessagingService) keeps it all in memory so
// the route inventory is integration-testable with no live infra.

import type { MemberAdminActor } from "../member-admin";
import type { QuietHoursConfig, RoutingMap } from "../resolution";
import type {
  AlertCategory,
  AlertRecipientResolver,
  AlertSeverity,
  ChannelKind,
  ChannelMemberRole,
  ChannelMemberSource,
  DeliveryEndpointChannel,
  DeliveryEndpointVerification,
  MessageBodyKind,
} from "./kinds";
import type { AttachmentInput, ResolvedMessage } from "./provider";

/** A channel as listed in the sidebar (§4.2 GET /channels) — no message bodies. */
export interface ChannelSummary {
  readonly channelId: string;
  readonly kind: ChannelKind;
  readonly title: string | null;
  readonly subjectId: string | null;
  readonly archivedAt: string | null;
  readonly unreadCount: number;
}

/** A channel member as returned on channel detail (§4.2 GET /channels/:id). */
export interface ChannelMemberView {
  readonly userId: string;
  readonly role: ChannelMemberRole;
  readonly source: ChannelMemberSource;
}

/** Channel detail + recent members (§4.2 GET /channels/:id). */
export interface ChannelDetail extends ChannelSummary {
  readonly members: readonly ChannelMemberView[];
}

/** The actor's effective view of one alert_rule (§4.2 GET /alert-rules) — platform default or
 *  the tenant's cloned override. `organizationId === null` ⇒ an inherited platform default. */
export interface AlertRuleView {
  readonly ruleId: string;
  readonly organizationId: string | null;
  readonly eventType: string;
  readonly category: AlertCategory;
  readonly severityFloor: AlertSeverity;
  readonly recipientResolver: AlertRecipientResolver;
  readonly systemLocked: boolean;
  readonly enabled: boolean;
}

/** The patch body for an alert-rule override (§4.2 PATCH /alert-rules/:id). */
export interface AlertRulePatch {
  readonly enabled?: boolean;
  readonly severityFloor?: AlertSeverity;
  readonly recipientResolver?: AlertRecipientResolver;
}

/** The actor's notification preferences (§4.2 GET/PUT /notifications/preferences). */
export interface NotificationPreferencesView {
  readonly id: string;
  readonly userId: string;
  readonly routingMap: RoutingMap;
  readonly quietHours: QuietHoursConfig;
  readonly vacationForwardToUserId: string | null;
  readonly vacationUntil: string | null;
  readonly updatedAt: string;
}

/** The PUT body for notification preferences (§4.2). */
export interface NotificationPreferencesInput {
  readonly routingMap: RoutingMap;
  readonly quietHours: QuietHoursConfig;
  readonly vacationForwardToUserId?: string | null;
  readonly vacationUntil?: string | null;
}

/** A registered out-of-band delivery endpoint (§4.2 POST /notifications/endpoints). */
export interface DeliveryEndpointView {
  readonly endpointId: string;
  readonly channel: DeliveryEndpointChannel;
  readonly verificationStatus: DeliveryEndpointVerification;
}

/** The register-endpoint body (§4.2): push is browser-verified, sms/email start pending. */
export interface DeliveryEndpointInput {
  readonly channel: DeliveryEndpointChannel;
  /** push: the subscription endpoint URL; sms: an E.164 number; email: an address. */
  readonly target: string;
}

/** One row in the actor's alert inbox (§4.2 GET /alerts/inbox) — sanitizer summary, no PHI. */
export interface AlertInboxItem {
  readonly alertId: string;
  readonly eventType: string;
  readonly category: AlertCategory;
  readonly severity: AlertSeverity;
  readonly summary: string;
  /** Safe WardenX-internal destination projected from the private payload, when present. */
  readonly deepLink: string | null;
  readonly createdAt: string;
  readonly deliveryStatus: "delivered" | "partial" | "failed" | "pending";

  /** Null until the current actor explicitly opens/reads the alert. */
  readonly readAt: string | null;
}

/** Minimum-necessary staff projection for starting a direct conversation. */
export interface DmEligibleStaffMember {
  readonly userId: string;
  readonly displayName: string;
  readonly roles: readonly string[];
}

/**
 * The §4.1–4.2 application service the M36 routes compose over. Mutations are idempotent where
 * the spec calls for it (openDm, markRead). Domain failures throw `WardenXError` subclasses the
 * M1 error handler renders (NOT_FOUND 404, CHANNEL_ARCHIVED 410, CHANNEL_NOT_VISIBLE 403,
 * SYSTEM_LOCKED 403, INVALID_RESOLVER 422, INVALID_ROUTING_MAP 422, VACATION_FORWARD_* 409).
 */
export interface MessagingRouteService {
  // ── channels & messages (§4.2) ──────────────────────────────────────────────────────────
  /** Channels the user is an active member of (§4.2 GET /channels). */
  listChannels(orgId: string, userId: string): Promise<ChannelSummary[]>;
  /** Channel detail + recent members; NOT_FOUND if absent (§4.2 GET /channels/:id). */
  getChannel(orgId: string, userId: string, channelId: string): Promise<ChannelDetail>;
  /** Paginated channel history — bodies decrypted for entitled readers only (§4.2). */
  listMessages(
    orgId: string,
    input: {
      channelId: string;
      userId: string;
      cursor?: string;
      limit?: number;
    },
  ): Promise<{ messages: readonly ResolvedMessage[]; nextCursor?: string }>;
  /** Post a message; CHANNEL_ARCHIVED (410) on an archived channel (§4.2). */
  sendMessage(
    orgId: string,
    input: {
      channelId: string;
      authorUserId: string;
      body: string;
      bodyKind?: MessageBodyKind;
      parentMessageId?: string;
      quotedMessageId?: string;
      attachments?: readonly AttachmentInput[];
      correlationId?: string;
    },
  ): Promise<{ messageId: string; channelId: string; createdAt: string }>;
  /** Edit within the edit window; FORBIDDEN unless the actor authored it (§4.2 PATCH). */
  editMessage(
    orgId: string,
    input: { userId: string; messageId: string; body: string },
  ): Promise<{ messageId: string; editedAt: string }>;
  /** Soft-delete (tombstone); FORBIDDEN unless the actor authored it (§4.2 DELETE). */
  deleteMessage(orgId: string, input: { userId: string; messageId: string }): Promise<void>;
  /** Mark message(s) read — single or up-through-id (§4.2 POST /messages/:id/read). */
  markRead(
    orgId: string,
    input: { userId: string; messageId: string; upTo?: boolean },
  ): Promise<void>;
  /** Open or find a 1:1 DM channel with another user — idempotent (§4.2 POST /dm). */
  openDm(
    orgId: string,
    userId: string,
    peerUserId: string,
  ): Promise<{ channelId: string; created: boolean }>;
  /** Active staff in the bound organization who may be selected as a DM peer. */
  searchDmEligibleStaff(
    orgId: string,
    userId: string,
    query: string,
  ): Promise<readonly DmEligibleStaffMember[]>;
  /** Add a manual member (admin override on auto channels — audited) (§4.2). The service itself
   *  enforces `mayManageChannelMembers` for `input.actor` (FORBIDDEN otherwise) and records the
   *  actor on the write-audit trail. */
  addMember(
    orgId: string,
    input: {
      channelId: string;
      userId: string;
      role?: ChannelMemberRole;
      actor: MemberAdminActor;
    },
  ): Promise<void>;
  /** Remove a member (§4.2 DELETE /channels/:id/members/:userId); same actor rules as addMember. */
  removeMember(
    orgId: string,
    input: { channelId: string; userId: string; actor: MemberAdminActor },
  ): Promise<void>;
  /** The `channel_member_admin` predicate's resolver (§4.5 `location_membership`): fail-closed
   *  `false` for an unknown / cross-org channel. */
  canManageMembers(orgId: string, actor: MemberAdminActor, channelId: string): Promise<boolean>;
  /** Post to the tenant `announcement` channel (org_admin) (§4.2 POST /announce). */
  announce(
    orgId: string,
    input: { authorUserId: string; body: string },
  ): Promise<{ messageId: string; channelId: string; createdAt: string }>;

  /** Whether the actor may see a channel — the `channel_visibility` ABAC predicate's resolver
   *  (§4.5): caseload membership for care_team, bereavement membership for bereavement, a
   *  channel-member check otherwise. NOT_FOUND channels resolve to `false` (no existence oracle). */
  canViewChannel(orgId: string, userId: string, channelId: string): Promise<boolean>;

  // ── notification preferences & endpoints (§4.2; SELF-only) ────────────────────────────────
  /** The actor's preferences, creating the default row on first read (§4.2 GET). */
  getPreferences(orgId: string, userId: string): Promise<NotificationPreferencesView>;
  /** Replace the actor's preferences; INVALID_ROUTING_MAP (422) / VACATION_FORWARD_* (409). */
  putPreferences(
    orgId: string,
    userId: string,
    input: NotificationPreferencesInput,
  ): Promise<{ id: string; updatedAt: string }>;
  /** Register a push/sms/email endpoint (§4.2 POST /notifications/endpoints). */
  registerEndpoint(
    orgId: string,
    userId: string,
    input: DeliveryEndpointInput,
  ): Promise<DeliveryEndpointView>;
  /** Confirm a verification token (§4.2 POST /notifications/endpoints/:id/verify). */
  verifyEndpoint(
    orgId: string,
    userId: string,
    endpointId: string,
    token: string,
  ): Promise<DeliveryEndpointView>;
  /** Remove an endpoint (§4.2 DELETE /notifications/endpoints/:id). */
  removeEndpoint(orgId: string, userId: string, endpointId: string): Promise<void>;

  // ── alerts (§4.2) ─────────────────────────────────────────────────────────────────────────
  /** The actor's recent alerts with delivery status (§4.2 GET /alerts/inbox). */
  alertInbox(orgId: string, userId: string): Promise<AlertInboxItem[]>;
  /** Mark one alert as read for the current actor. Idempotent. */
  markAlertRead(orgId: string, userId: string, alertId: string): Promise<void>;
  /** Tenant + inherited platform alert rules (§4.2 GET /alert-rules). */
  listAlertRules(orgId: string): Promise<AlertRuleView[]>;
  /** Override a rule: clones a platform default into an org-scoped row on first edit;
   *  SYSTEM_LOCKED (403) when disabling a system_locked rule; INVALID_RESOLVER (422) on an
   *  unknown resolver name; NOT_FOUND (404) on an unknown id (§4.2 PATCH /alert-rules/:id). */
  patchAlertRule(
    orgId: string,
    input: { ruleId: string; patch: AlertRulePatch },
  ): Promise<AlertRuleView>;
}
