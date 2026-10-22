import { CHANNEL_KINDS } from "@chartwarden/messaging";
import type {
  AlertInboxItem as ServiceAlertInboxItem,
  AlertRuleView as ServiceAlertRuleView,
  CareTeamConversation as ServiceCareTeamConversation,
  ChannelDetail as ServiceChannelDetail,
  ChannelMemberView as ServiceChannelMemberView,
  ChannelSummary as ServiceChannelSummary,
  DeliveryEndpointView as ServiceDeliveryEndpointView,
  NotificationPreferencesView as ServiceNotificationPreferencesView,
  ResolvedMessage as ServiceResolvedMessage,
} from "@chartwarden/messaging";
import { MESSAGE_REACTION_KEYS, ValidationError } from "@chartwarden/types";
// apps/backend/src/modules/36-messaging/routes/messaging-typebox.ts — M36-T07 complete TypeBox
// route schemas for the messaging / notification / alert-rule API surface (M36 spec §4.1–4.2).
// Named `messaging-typebox` (not `*schema*`) so the table-ownership import heuristic never
// mistakes a TypeBox-schema import for a Drizzle one.
//
// Validation runs through TypeBox's `Value` (not the Fastify ajv pipeline) so a bad request fails
// with M1's `VALIDATION_FAILED` envelope — the same house style M1/M2/M3/M4/M38 routes use — and
// query-string scalars are coerced (`limit=50` → 50, `upTo=true` → true) before the shape check.
// Routing-map / quiet-hours SEMANTICS (unknown category/severity/channel → INVALID_ROUTING_MAP)
// are validated in the service, not here: the structural schema accepts the record shape and the
// service maps an unknown key to the §4.2 422 domain error.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ClinicalLinkViewSchema } from "./clinical-link-typebox";

// --- shared scalars ---------------------------------------------------------------------------

/** Free-form opaque id (channels/messages/endpoints/rules). minLength:1, not uuid-format, so the
 *  slice's deterministic ids and production uuids both route. */
const Id = Type.String({ minLength: 1, maxLength: 64 });
// A canonical uuid (no `format: "uuid"`: that format is not registered with TypeBox at runtime here).
export const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const ChannelKindSchema = Type.Union(CHANNEL_KINDS.map((k) => Type.Literal(k)));
const SeveritySchema = Type.Union([
  Type.Literal("info"),
  Type.Literal("warn"),
  Type.Literal("critical"),
]);
const MemberRoleSchema = Type.Union([
  Type.Literal("owner"),
  Type.Literal("member"),
  Type.Literal("read_only"),
  Type.Literal("portal_caregiver"),
]);
const ResolverSchema = Type.Union([
  Type.Literal("care_team"),
  Type.Literal("on_call"),
  Type.Literal("discipline"),
  Type.Literal("role_set"),
  Type.Literal("tenant_admins"),
  Type.Literal("user_list"),
  Type.Literal("broadcast"),
]);

// --- channels & messages (§4.2) ---------------------------------------------------------------

export const ChannelParamsSchema = Type.Object({ id: Id });
export const MessageParamsSchema = Type.Object({ id: Id });
export const ThreadParamsSchema = Type.Object({ id: Id, messageId: Id });
export const MemberParamsSchema = Type.Object({ id: Id, userId: Id });
export const PatientConversationParamsSchema = Type.Object({ patientId: Id });

export const ListMessagesQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  direction: Type.Optional(Type.Union([Type.Literal("forward"), Type.Literal("backward")])),
  anchorMessageId: Type.Optional(Id),
});

export const MentionCandidateQuerySchema = Type.Object({
  q: Type.Optional(Type.String({ maxLength: 100 })),
});

const MessageReferenceInputSchema = Type.Object({
  kind: Type.Union([Type.Literal("staff"), Type.Literal("patient")]),
  entityId: Id,
  start: Type.Integer({ minimum: 0, maximum: 8000 }),
  end: Type.Integer({ minimum: 1, maximum: 8001 }),
});

// WP 1.5: a send names uploads the caller already authorized + completed (POST /attachments/uploads); the server looks
// up name/type/size itself. A canonical uuid, so a malformed id is a 422 and never reaches a uuid cast.
const UuidId = Type.String({ pattern: UUID_PATTERN });
const AttachmentSchema = Type.Object({ attachmentId: UuidId });

export const AttachmentParamsSchema = Type.Object({ id: UuidId });
export const ClinicalLinkParamsSchema = Type.Object({ linkId: UuidId });
export const AttachmentStatusResponseSchema = Type.Object({
  attachmentId: Type.String(),
  channelId: Type.String(),
  fileName: Type.String(),
  mimeType: Type.String(),
  byteSize: Type.Integer(),
  scanState: Type.Union([
    Type.Literal("pending"),
    Type.Literal("clean"),
    Type.Literal("quarantined"),
  ]),
  availability: Type.Union([
    Type.Literal("uploading"),
    Type.Literal("scanning"),
    Type.Literal("available"),
    Type.Literal("blocked"),
  ]),
  attached: Type.Boolean(),
});
export const AuthorizeAttachmentResponseSchema = Type.Object({
  attachmentId: Type.String(),
  upload: Type.Object({
    method: Type.Literal("PUT"),
    url: Type.String(),
    headers: Type.Record(Type.String(), Type.String()),
    expiresAt: Type.String(),
  }),
  status: AttachmentStatusResponseSchema,
});
export const AttachmentAccessResponseSchema = Type.Object({
  url: Type.String(),
  expiresAt: Type.String(),
  fileName: Type.String(),
  mimeType: Type.String(),
  byteSize: Type.Integer(),
});
export const AuthorizeAttachmentBodySchema = Type.Object({
  channelId: UuidId,
  fileName: Type.String({ minLength: 1, maxLength: 255 }),
  contentType: Type.String({ minLength: 1, maxLength: 127 }),
  byteSize: Type.Integer({ minimum: 1, maximum: 25_000_000 }),
  /** Lowercase hex SHA-256 of the file. The presigned PUT enforces it, so the bytes cannot differ from it. */
  sha256Hex: Type.String({ pattern: "^[0-9a-f]{64}$" }),
});

/**
 * WP 2.1: the versioned structured body. The shape here is only the envelope; the closed node set, the link scheme
 * allowlist and the depth/node/size limits are enforced by `sanitizeRichBody` (packages/types), which is the
 * authority on every write and re-runs on every read. Additive: `body` as a plain string keeps working.
 */
export const RichBodySchema = Type.Object({
  schemaVersion: Type.Literal(1),
  doc: Type.Object({
    type: Type.Literal("doc"),
    content: Type.Array(Type.Unknown(), { maxItems: 500 }),
  }),
});

export const SendMessageBodySchema = Type.Object({
  // WP 1.5: text may be absent or blank when the message carries an attachment; the service refuses a send with
  // neither (the schema cannot express "body or attachments").
  body: Type.Optional(Type.String({ maxLength: 8000 })),
  bodyKind: Type.Optional(Type.Union([Type.Literal("plain"), Type.Literal("markdown")])),
  // WP 2.1: exclusive with `body`. Mentions are the doc's mention nodes; `references` must then be absent.
  bodyDoc: Type.Optional(RichBodySchema),
  parentMessageId: Type.Optional(Id),
  quotedMessageId: Type.Optional(Id),
  // WP 1.2 DB backstop: a client-minted uuid, stable across retries of one composed message.
  clientMessageId: Type.Optional(Type.String({ pattern: UUID_PATTERN })),
  attachments: Type.Optional(Type.Array(AttachmentSchema, { maxItems: 10 })),
  references: Type.Optional(Type.Array(MessageReferenceInputSchema, { maxItems: 25 })),
});

export const EditMessageBodySchema = Type.Object({
  // Blank is allowed only while the message keeps an attachment (checked in the service).
  // WP 2.1: exactly one of `body` and `bodyDoc` (checked in the route). An edit without `bodyDoc` stores plain text.
  body: Type.Optional(Type.String({ maxLength: 8000 })),
  bodyDoc: Type.Optional(RichBodySchema),
  references: Type.Optional(Type.Array(MessageReferenceInputSchema, { maxItems: 25 })),
});

export const ReadBodySchema = Type.Object({
  upTo: Type.Optional(Type.Boolean()),
});

export const OpenDmBodySchema = Type.Object({
  userId: Id, // the peer user to open/find a DM with
});

export const DmStaffSearchQuerySchema = Type.Object({
  q: Type.Optional(Type.String({ maxLength: 100 })),
});

export const AddMemberBodySchema = Type.Object({
  userId: Id,
  role: Type.Optional(MemberRoleSchema),
});

export const AnnounceBodySchema = Type.Object({
  body: Type.String({ minLength: 1, maxLength: 8000 }),
});

// --- notification preferences & endpoints (§4.2) ----------------------------------------------

const RoutingMapSchema = Type.Record(
  Type.String(),
  Type.Record(Type.String(), Type.Array(Type.String())),
);
const QuietRangeSchema = Type.Object({
  daysOfWeek: Type.Array(Type.Integer({ minimum: 0, maximum: 6 })),
  start: Type.String({ pattern: "^[0-2][0-9]:[0-5][0-9]$" }),
  end: Type.String({ pattern: "^[0-2][0-9]:[0-5][0-9]$" }),
});
const QuietHoursSchema = Type.Object({
  tz: Type.String({ minLength: 1 }),
  ranges: Type.Array(QuietRangeSchema),
  severityOverride: SeveritySchema,
});

export const PreferencesBodySchema = Type.Object({
  routingMap: RoutingMapSchema,
  quietHours: QuietHoursSchema,
  vacationForwardToUserId: Type.Optional(Type.Union([Id, Type.Null()])),
  vacationUntil: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export const RegisterEndpointBodySchema = Type.Object({
  channel: Type.Union([Type.Literal("push"), Type.Literal("sms"), Type.Literal("email")]),
  target: Type.String({ minLength: 1, maxLength: 512 }),
  // WP 5.11: push only. Absent = `web` (a browser subscription). `fcm`/`apns` carry a bare native device token in `target`.
  provider: Type.Optional(
    Type.Union([Type.Literal("web"), Type.Literal("fcm"), Type.Literal("apns")]),
  ),
});

export const EndpointParamsSchema = Type.Object({ id: Id });
export const VerifyEndpointBodySchema = Type.Object({
  token: Type.String({ minLength: 1, maxLength: 64 }),
});

// --- alert rules (§4.2) -----------------------------------------------------------------------

export const AlertRuleParamsSchema = Type.Object({ id: Id });
export const AlertRulePatchSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  severityFloor: Type.Optional(SeveritySchema),
  recipientResolver: Type.Optional(ResolverSchema),
});

// --- §4.2 RESPONSE DTOs (F0 enrichment) -------------------------------------------------------
// The read/mutation routes returned typed `MessagingRouteService` views but published NO response
// contract, so the generated client typed every body as `never`. These DTOs mirror those views 1:1
// and are pinned to them by the compile-time `Conforms` aliases below, so a view field added or
// renamed breaks `bun run build` rather than silently drifting from the generated client. Enums are
// literal unions (not `Type.String()`) so a wire enum can never publish as a lie.

const NullableString = () => Type.Union([Type.String(), Type.Null()]);
const MemberSourceSchema = Type.Union([Type.Literal("auto"), Type.Literal("manual")]);
const MessageBodyKindSchema = Type.Union([
  Type.Literal("plain"),
  Type.Literal("markdown"),
  Type.Literal("system"),
  Type.Literal("rich"),
]);
const NotificationChannelSchema = Type.Union([
  Type.Literal("in_app"),
  Type.Literal("push"),
  Type.Literal("sms"),
  Type.Literal("email"),
  Type.Literal("voice"),
]);
const AlertCategorySchema = Type.Union([
  Type.Literal("clinical_urgent"),
  Type.Literal("clinical_routine"),
  Type.Literal("operational"),
  Type.Literal("field_safety"),
  Type.Literal("administrative"),
  Type.Literal("system"),
]);
const EndpointChannelSchema = Type.Union([
  Type.Literal("push"),
  Type.Literal("sms"),
  Type.Literal("email"),
]);
const EndpointVerificationSchema = Type.Union([
  Type.Literal("verified"),
  Type.Literal("pending"),
  Type.Literal("expired"),
]);
const DeliveryStatusSchema = Type.Union([
  Type.Literal("delivered"),
  Type.Literal("partial"),
  Type.Literal("failed"),
  Type.Literal("pending"),
]);

// ── channels & messages ──────────────────────────────────────────────────────────────────────
export const ChannelSummaryResponseSchema = Type.Object({
  channelId: Type.String(),
  kind: ChannelKindSchema,
  title: NullableString(),
  subjectId: NullableString(),
  archivedAt: NullableString(),
  unreadCount: Type.Integer(),
  mentionCount: Type.Integer(),
  participantRoles: Type.Array(Type.String()),
  lastActivityAt: Type.String(),
  lastMessage: Type.Union([
    Type.Object({
      messageId: Type.String(),
      preview: Type.String(),
      createdAt: Type.String(),
      authorDisplayName: NullableString(),
    }),
    Type.Null(),
  ]),
});
export const ChannelListResponseSchema = Type.Object({
  channels: Type.Array(ChannelSummaryResponseSchema),
});
const ChannelMemberViewSchema = Type.Object({
  userId: Type.String(),
  role: MemberRoleSchema,
  source: MemberSourceSchema,
  /** WP 2.9: so a member list can show who is in a department channel. */
  displayName: Type.Optional(NullableString()),
});
/** GET /channels/:id/members: the FULL active member list (admin screen), not the detail's embedded list. */
export const ChannelMembersResponseSchema = Type.Object({
  members: Type.Array(ChannelMemberViewSchema),
});
export const ChannelDetailResponseSchema = Type.Object({
  channelId: Type.String(),
  kind: ChannelKindSchema,
  title: NullableString(),
  subjectId: NullableString(),
  archivedAt: NullableString(),
  unreadCount: Type.Integer(),
  mentionCount: Type.Integer(),
  participantRoles: Type.Array(Type.String()),
  lastActivityAt: Type.String(),
  lastMessage: Type.Union([
    Type.Object({
      messageId: Type.String(),
      preview: Type.String(),
      createdAt: Type.String(),
      authorDisplayName: NullableString(),
    }),
    Type.Null(),
  ]),
  patientId: NullableString(),
  members: Type.Array(ChannelMemberViewSchema),
});
const MessageAttachmentViewSchema = Type.Object({
  attachmentId: Type.String(),
  fileName: Type.String(),
  mimeType: Type.String(),
  byteSize: Type.Integer(),
  availability: Type.Union([Type.Literal("available"), Type.Literal("scanning")]),
});
// WP 2.10: a poll as it rides on a message (defined here so the message schema does not import poll-typebox).
export const PollViewSchema = Type.Object({
  pollId: Type.String(),
  closed: Type.Boolean(),
  closedAt: NullableString(),
  totalVotes: Type.Integer({ minimum: 0 }),
  myOptionId: NullableString(),
  canClose: Type.Boolean(),
  options: Type.Array(
    Type.Object({
      optionId: Type.String(),
      label: Type.String(),
      voteCount: Type.Integer({ minimum: 0 }),
    }),
  ),
});
export const ResolvedMessageSchema = Type.Object({
  messageId: Type.String(),
  channelId: Type.String(),
  authorUserId: NullableString(),
  authorDisplayName: NullableString(),
  // For bodyKind "rich" this is the plain-text projection (never JSON, never link targets); `bodyDoc` is the document.
  body: Type.String(),
  bodyKind: MessageBodyKindSchema,
  bodyDoc: Type.Optional(RichBodySchema),
  // True when a stored rich body cannot be read back: show "could not be displayed", not "deleted".
  bodyUnreadable: Type.Optional(Type.Literal(true)),
  createdAt: Type.String(),
  // WP 1.3: when a live message was last edited (additive; null/absent = never edited or deleted).
  editedAt: Type.Optional(NullableString()),
  parentMessageId: NullableString(),
  // WP 4.1: present only for a non-routine message ("Urgent clinical"); a display marker, never a delivery state.
  urgency: Type.Optional(Type.Union([Type.Literal("important"), Type.Literal("urgent")])),
  // WP 2.2: live direct replies and the newest one's time (additive; absent on providers that do not compute it).
  replyCount: Type.Optional(Type.Integer({ minimum: 0 })),
  lastReplyAt: Type.Optional(NullableString()),
  // WP 2.4: non-clinical reaction counts (never a sign-off) and the pin flag (additive).
  reactions: Type.Optional(
    Type.Array(
      Type.Object({
        emoji: Type.Union(MESSAGE_REACTION_KEYS.map((key) => Type.Literal(key))),
        count: Type.Integer({ minimum: 1 }),
        reactedByMe: Type.Boolean(),
      }),
    ),
  ),
  pinned: Type.Optional(Type.Boolean()),
  // WP 2.10: the poll on this message (additive; absent when the message has none).
  poll: Type.Optional(PollViewSchema),
  // WP 3.2: ids and kind only; open a chip with GET /clinical-links/:link_id/resolve.
  clinicalLinks: Type.Optional(Type.Array(ClinicalLinkViewSchema)),
  references: Type.Array(
    Type.Object({
      kind: Type.Union([Type.Literal("staff"), Type.Literal("patient")]),
      entityId: Type.String(),
      start: Type.Integer(),
      end: Type.Integer(),
      displayLabel: Type.String(),
      navigable: Type.Boolean(),
    }),
  ),
  attachments: Type.Optional(Type.Array(MessageAttachmentViewSchema)),
  hiddenAttachmentCount: Type.Optional(Type.Integer({ minimum: 0 })),
  // WP 5.6: an approved redaction masks the message (body empty); ISO instant. A legal-hold flag only for `messaging.retention.manage` holders.
  redactedAt: Type.Optional(Type.String()),
  legalHold: Type.Optional(Type.Literal(true)),
});
export const MessageListResponseSchema = Type.Object({
  messages: Type.Array(ResolvedMessageSchema),
  nextCursor: Type.Optional(Type.String()),
  patientId: NullableString(),
});
export const ListThreadQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export const ThreadResponseSchema = Type.Object({
  root: ResolvedMessageSchema,
  replies: Type.Array(ResolvedMessageSchema),
  nextCursor: Type.Optional(Type.String()),
  patientId: NullableString(),
});
export const SendMessageResponseSchema = Type.Object({
  messageId: Type.String(),
  channelId: Type.String(),
  createdAt: Type.String(),
});
export const EditMessageResponseSchema = Type.Object({
  messageId: Type.String(),
  editedAt: Type.String(),
});
export const OpenDmResponseSchema = Type.Object({
  channelId: Type.String(),
  created: Type.Boolean(),
});
export const OpenCareTeamConversationResponseSchema = Type.Object({
  channelId: Type.String(),
  kind: Type.Literal("care_team"),
  patientId: Type.String(),
  archived: Type.Boolean(),
});
export const DmStaffSearchResponseSchema = Type.Object({
  staff: Type.Array(
    Type.Object({
      userId: Id,
      displayName: Type.String(),
      roles: Type.Array(Type.String()),
    }),
  ),
});
export const MentionNonMemberQuerySchema = Type.Object({
  q: Type.Optional(Type.String({ maxLength: 100 })),
});
export const MentionNonMemberResponseSchema = Type.Object({
  people: Type.Array(Type.Object({ entityId: Type.String(), displayName: Type.String() })),
  /** True only when the caller may add members to this channel (permission AND channel-scoped authority). */
  canAdd: Type.Boolean(),
});
export const MentionCandidateResponseSchema = Type.Object({
  candidates: Type.Array(
    Type.Object({
      kind: Type.Union([Type.Literal("staff"), Type.Literal("patient")]),
      entityId: Type.String(),
      displayName: Type.String(),
      detail: NullableString(),
    }),
  ),
});

// ── notification preferences & endpoints ─────────────────────────────────────────────────────
const RoutingMapResponseSchema = Type.Record(
  Type.String(),
  Type.Record(Type.String(), Type.Array(NotificationChannelSchema)),
);
export const NotificationPreferencesResponseSchema = Type.Object({
  id: Type.String(),
  userId: Type.String(),
  routingMap: RoutingMapResponseSchema,
  quietHours: QuietHoursSchema,
  vacationForwardToUserId: NullableString(),
  vacationUntil: NullableString(),
  updatedAt: Type.String(),
});
export const PutPreferencesResponseSchema = Type.Object({
  id: Type.String(),
  updatedAt: Type.String(),
});
export const DeliveryEndpointResponseSchema = Type.Object({
  endpointId: Type.String(),
  channel: EndpointChannelSchema,
  verificationStatus: EndpointVerificationSchema,
});

// ── alerts ───────────────────────────────────────────────────────────────────────────────────
const AlertInboxItemSchema = Type.Object({
  alertId: Type.String(),
  eventType: Type.String(),
  category: AlertCategorySchema,
  severity: SeveritySchema,
  summary: Type.String(),
  deepLink: NullableString(),
  createdAt: Type.String(),
  deliveryStatus: DeliveryStatusSchema,
  readAt: NullableString(),
});
export const AlertInboxResponseSchema = Type.Object({
  alerts: Type.Array(AlertInboxItemSchema),
});
export const AlertRuleResponseSchema = Type.Object({
  ruleId: Type.String(),
  organizationId: NullableString(),
  eventType: Type.String(),
  category: AlertCategorySchema,
  severityFloor: SeveritySchema,
  recipientResolver: ResolverSchema,
  systemLocked: Type.Boolean(),
  enabled: Type.Boolean(),
});
export const AlertRuleListResponseSchema = Type.Object({
  rules: Type.Array(AlertRuleResponseSchema),
});
export const AlertParamsSchema = Type.Object({
  id: Id,
});

// Compile-time pins: `T` (what the schema publishes) must be assignable to `V` (what the service
// returns). A drifted view field fails `bun run build` here rather than silently in the client.
type Conforms<T extends V, V> = T;
type _ChannelSummary = Conforms<Static<typeof ChannelSummaryResponseSchema>, ServiceChannelSummary>;
type _ChannelMember = Conforms<Static<typeof ChannelMemberViewSchema>, ServiceChannelMemberView>;
type _ChannelDetail = Conforms<Static<typeof ChannelDetailResponseSchema>, ServiceChannelDetail>;
type _CareTeamConversation = Conforms<
  Static<typeof OpenCareTeamConversationResponseSchema>,
  ServiceCareTeamConversation
>;
// `bodyDoc` is validated by sanitizeRichBody (the schema is only its envelope), so it is compared separately.
type _ResolvedMessage = Conforms<
  Omit<Static<typeof ResolvedMessageSchema>, "bodyDoc">,
  Omit<ServiceResolvedMessage, "bodyDoc">
>;
type _Prefs = Conforms<
  Static<typeof NotificationPreferencesResponseSchema>,
  ServiceNotificationPreferencesView
>;
type _Endpoint = Conforms<
  Static<typeof DeliveryEndpointResponseSchema>,
  ServiceDeliveryEndpointView
>;
type _AlertInbox = Conforms<Static<typeof AlertInboxItemSchema>, ServiceAlertInboxItem>;
type _AlertRule = Conforms<Static<typeof AlertRuleResponseSchema>, ServiceAlertRuleView>;

export type SendMessageBody = Static<typeof SendMessageBodySchema>;
export type PreferencesBody = Static<typeof PreferencesBodySchema>;
export type AlertRulePatchBody = Static<typeof AlertRulePatchSchema>;

/**
 * Validate `raw` against `schema`, coercing query-string scalars first (`limit=50` → 50,
 * `upTo=true` → true), and return the typed value. Throws M1's `VALIDATION_FAILED` envelope on a
 * miss (the same `parse` contract M38's routes use), so a malformed request renders the standard
 * 422 envelope rather than a Fastify ajv 400.
 */
export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  const converted = Value.Convert(schema, raw ?? {});
  if (!Value.Check(schema, converted)) {
    const first = [...Value.Errors(schema, converted)][0];
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return converted as Static<T>;
}
