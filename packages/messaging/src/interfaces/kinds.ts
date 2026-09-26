// @wardenx/messaging — channel kind discriminator + the messaging type surface.
//
// M36-T01 (spec §2.3, §3.1, §3.2). This file is the TYPE-LEVEL home for the messaging
// enums and, above all, the `channel_kind` discriminator that drives a channel's
// lifecycle, membership source, and retention class (§2.3). The Drizzle `pgEnum` DDL
// lives in packages/db/src/enums.ts (M36-T01) and the per-table schema lands in
// packages/db/src/schema/messaging/* at M36-T02 — manifest is law there (M36 owns 15
// tables, §3.3–3.6 / §3.11 / §3.13). The seam contracts (MessagingProvider /
// AlertEmitter / RecipientResolver) and the catalog-validated dispatch path are M36-T06
// (§4.6); this task ships only the shared kind/enum types they will build on.
//
// Design call (§2.3): ONE discriminator (`channel_kind`) drives everything. Rather than
// scatter lifecycle/membership/retention rules across channel subtypes, every channel is
// one `channel` row whose `channel_kind` fixes (a) whether it has a subject, (b) where its
// membership comes from, and (c) its retention class — enforced at the schema level with a
// per-kind CHECK and immutable after insert.

/**
 * The seven channel kinds (§2.3). The single discriminator on `channel`. Mirrors the
 * `channel_kind` pgEnum (§3.2). Kind is immutable after creation (CHECK on UPDATE, M36-T02).
 */
export type ChannelKind =
  | "care_team"
  | "discipline"
  | "location"
  | "on_call"
  | "dm"
  | "announcement"
  | "bereavement";

/** Runtime list of every channel kind — the value-level mirror of {@link ChannelKind} for
 *  places that need the kinds at runtime (e.g. a `:kind` route-param union, M36-T07). */
export const CHANNEL_KINDS = [
  "care_team",
  "discipline",
  "location",
  "on_call",
  "dm",
  "announcement",
  "bereavement",
] as const satisfies readonly ChannelKind[];

/** A channel's retention clock (§2.3, M36-F02 / ADR-0004). Only `announcement` is
 *  `operational` (1 yr); all clinical channels are `care_related` (6+ yr); `bereavement`
 *  carries its own class (auto-archive at plan close + 13 months, but a care record). */
export type ChannelRetentionClass = "operational" | "care_related" | "bereavement";

/** Where a channel's membership comes from (§2.3). `auto` kinds are reconciled by the
 *  per-kind sync jobs (M36-T04) against a seam (CareTeamProvider/OnCallProvider) or M2
 *  role/location state; `manual`/`broadcast` kinds are edited directly (admin-gated). */
export type ChannelMembershipSource = "auto" | "manual" | "broadcast";

/** Whether a kind requires a `subject_id` (§2.3 / §2.5 subject-by-kind CHECK). */
export type ChannelSubjectRequirement = "required" | "forbidden";

/**
 * The compile-time encoding of the §2.3 table: for each `channel_kind`, the invariant the
 * schema CHECK enforces (M36-T02) — does it carry a subject, what is its retention class,
 * and where does its membership come from. Consumers (sync jobs, route validators, the
 * lifecycle engine) read this single source rather than re-deriving the rules per kind.
 */
export interface ChannelKindDescriptor {
  readonly kind: ChannelKind;
  /** What `subject_id` references for this kind, or `null` when the kind has no subject. */
  readonly subject:
    | "patient_id"
    | "discipline" // org_id + discipline string
    | "location_id"
    | "provider_entity_id"
    | "bereavement_plan_id"
    | null;
  readonly subjectRequirement: ChannelSubjectRequirement;
  readonly retentionClass: ChannelRetentionClass;
  readonly membershipSource: ChannelMembershipSource;
  /** Auto-created/archived from a source-module lifecycle event (M5/M16/M19), if any. */
  readonly lifecycleSource: "M5" | "M16" | "M19" | "M2" | "manual";
}

/**
 * The §2.3 discriminator table as data. The CHECK constraint in §3.3 (M36-T02) is the
 * runtime enforcement of these same rules at the DB; this is the app-layer mirror.
 */
export const CHANNEL_KIND_DESCRIPTORS: {
  readonly [K in ChannelKind]: ChannelKindDescriptor & { kind: K };
} = {
  care_team: {
    kind: "care_team",
    subject: "patient_id",
    subjectRequirement: "required",
    retentionClass: "care_related",
    membershipSource: "auto",
    lifecycleSource: "M5",
  },
  discipline: {
    kind: "discipline",
    subject: "discipline",
    subjectRequirement: "required",
    retentionClass: "care_related",
    membershipSource: "auto",
    lifecycleSource: "M2",
  },
  location: {
    kind: "location",
    subject: "location_id",
    subjectRequirement: "required",
    retentionClass: "care_related",
    membershipSource: "auto",
    lifecycleSource: "M2",
  },
  on_call: {
    kind: "on_call",
    subject: "provider_entity_id",
    subjectRequirement: "required",
    retentionClass: "care_related",
    membershipSource: "auto",
    lifecycleSource: "M19",
  },
  dm: {
    kind: "dm",
    subject: null,
    subjectRequirement: "forbidden",
    retentionClass: "care_related",
    membershipSource: "manual",
    lifecycleSource: "manual",
  },
  announcement: {
    kind: "announcement",
    subject: null,
    subjectRequirement: "forbidden",
    retentionClass: "operational",
    membershipSource: "broadcast",
    lifecycleSource: "manual",
  },
  bereavement: {
    kind: "bereavement",
    subject: "bereavement_plan_id",
    subjectRequirement: "required",
    retentionClass: "bereavement",
    membershipSource: "auto",
    lifecycleSource: "M16",
  },
} as const;

// ── Remaining §3.2 enum unions (type-level mirrors of packages/db/src/enums.ts) ──────────

/** A member's role within a channel (§3.3). */
export type ChannelMemberRole = "owner" | "member" | "read_only" | "portal_caregiver";

/** Auto-synced vs manually-added membership (§2.5). */
export type ChannelMemberSource = "auto" | "manual";

/** A message authored by a user vs the system (§3.4). */
export type MessageAuthorKind = "user" | "system";

/** Body rendering hint (§3.4). */
export type MessageBodyKind = "plain" | "markdown" | "system";

/** Message lifecycle (§2.4.2). `deleted` is a tombstone; body_cipher is retained until
 *  retention expiry (M36-F02 / ADR-0004). */
export type MessageStatus = "sent" | "edited" | "deleted";

/** Per-recipient receipt state (§3.4). */
export type MessageReceiptStatus = "delivered" | "read" | "ack";

/** Socket.IO-driven user presence (§3.5). */
export type PresenceStatus = "online" | "away" | "offline";

/** The broad class of an alert (§3.6). */
export type AlertCategory =
  | "clinical_urgent"
  | "clinical_routine"
  | "operational"
  | "field_safety"
  | "administrative"
  | "system";

/** The legacy `alert`/`alert_rule` severity ladder (§3.2). */
export type AlertSeverity = "info" | "warn" | "critical";

/** The named resolver an alert_rule uses to compute recipients (§3.6). */
export type AlertRecipientResolver =
  | "care_team"
  | "on_call"
  | "discipline"
  | "role_set"
  | "tenant_admins"
  | "user_list"
  | "broadcast";

/**
 * The §2.4.3 fan-out outcome of a dispatched alert.
 *
 * F-109 — `pending` is the state the §2.4.3 state machine OPENS in ("alert row written;
 * notification_delivery rows enqueued") and the enum never had, so `alert.outcome` was
 * `NOT NULL DEFAULT 'delivered'`: the column could not say "not settled yet", so it said the most
 * flattering thing it could say, and nothing ever corrected it. Migration 0240 adds the value.
 */
export type AlertOutcome = "pending" | "delivered" | "partial" | "failed";

/** An outcome an alert has actually SETTLED on — what {@link computeOutcome} returns. */
export type SettledAlertOutcome = Exclude<AlertOutcome, "pending">;

/** The per-recipient delivery channels (§3.6). `voice` is SOS-only (§2.5). */
export type NotificationChannel = "in_app" | "push" | "sms" | "email" | "voice";

/** Per recipient × channel delivery state (§2.4.4). */
export type NotificationStatus =
  | "pending"
  | "sent"
  | "delivered"
  | "failed"
  | "skipped_quiet_hours"
  | "forwarded";

/** Out-of-band channels a user can register a delivery endpoint on (§3.5). */
export type DeliveryEndpointChannel = "push" | "sms" | "email";

/** Endpoint verification lifecycle (§3.5). */
export type DeliveryEndpointVerification = "verified" | "pending" | "expired";

/** The broader payload-catalog severity ladder (§3.11, M36-F06b) — DISTINCT from
 *  {@link AlertSeverity}. Tenants may tighten but never loosen (D11). */
export type AlertPayloadSeverity = "INFO" | "WARN" | "MEDIUM" | "HIGH" | "CRITICAL";
