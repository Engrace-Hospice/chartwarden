// apps/backend/src/modules/16-bereavement/routes/mailing-typebox.ts — M16 mailing program (ADR-0109 D10) request + response schemas, routes 42-52.
//
// Request bodies, params and queries for the mailing routes, plus the response DTOs the OpenAPI enrichment publishes (pinned to the service views
// by `m16-response-dtos.ts`). No body carries a version or an idempotency key: `If-Match` and `Idempotency-Key` ride the headers, and the header decides.
// Neither a request nor a response carries a recipient name or address: those exist only inside the batch PDF.
import {
  BEREAVEMENT_BUILT_MAILING_KEYS,
  BEREAVEMENT_MAILING_EXCLUSION_REASONS,
  BereavementMailingContent,
} from "@chartwarden/types";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { RelationshipCode } from "./m16-typebox";

const Uuid = Type.String({ format: "uuid" });
const Str = Type.String();
const Int = Type.Integer();
const Bool = Type.Boolean();
const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);
/** A union of string literals that keeps its literal static type (`Type.Union` over a runtime array widens to `unknown`). */
const literals = <const T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>(Type.Union(values.map((v) => Type.Literal(v))));

/** `MM-DD` (the tenant's occurrence-date override); an impossible date such as 02-30 is dropped by the date math, not rejected here. */
const MonthDay = Type.String({ pattern: "^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$" });

/** The four mailing keys a tenant can configure (the deferred `decedent_birthday` is not accepted). */
export const BuiltMailingKey = literals(BEREAVEMENT_BUILT_MAILING_KEYS);
const AnyMailingKey = literals([...BEREAVEMENT_BUILT_MAILING_KEYS, "decedent_birthday"] as const);
const RunKind = literals(["newsletter", "holiday", "memorial_invitation"] as const);
const RunStatus = literals([
  "draft",
  "generating",
  "ready",
  "mailed",
  "cancelled",
  "failed",
] as const);
const ItemStatus = literals([
  "included",
  "excluded",
  "logged",
  "excluded_after_render",
  "email_sent",
  "email_failed",
] as const);
const ExclusionReason = literals(BEREAVEMENT_MAILING_EXCLUSION_REASONS);

// ── requests ────────────────────────────────────────────────────────────────────────────────────────

export const MailingKeyParams = Type.Object({ mailingKey: BuiltMailingKey });
export const MailingRunParams = Type.Object({ runId: Uuid });

/** Route 43 — a tenant's config for one mailing key. `If-Match` is the current version (0 when never configured). */
export const PutMailingConfigBody = Type.Object({
  enabled: Bool,
  leadDays: Type.Integer({ minimum: 3, maximum: 60 }),
  schedule: Type.Optional(
    Type.Object({
      monthDays: Type.Optional(Type.Array(MonthDay, { maxItems: 12 })),
      monthDay: Type.Optional(MonthDay),
    }),
  ),
  // null = every relationship; an EMPTY list would silently mail nobody, so it is refused
  audienceRelationships: Nullable(Type.Array(RelationshipCode, { minItems: 1, maxItems: 16 })),
  content: BereavementMailingContent,
});

/** Route 47 — replace a draft run's wording. */
export const UpdateMailingRunContentBody = Type.Object({ content: BereavementMailingContent });

export const MailingRunListQuerySchema = Type.Object({
  status: Type.Optional(RunStatus),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export const MailingItemListQuerySchema = Type.Object({
  status: Type.Optional(ItemStatus),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});
export const ContactTimelineQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export type PutMailingConfigBody = Static<typeof PutMailingConfigBody>;
export type MailingRunListQuery = Static<typeof MailingRunListQuerySchema>;
export type MailingItemListQuery = Static<typeof MailingItemListQuerySchema>;
export type ContactTimelineQuery = Static<typeof ContactTimelineQuerySchema>;

// ── responses ───────────────────────────────────────────────────────────────────────────────────────

const ScheduleSchema = Type.Object({
  monthDays: Type.Optional(Type.Array(Str)),
  monthDay: Type.Optional(Str),
});

export const MailingConfigViewResponseSchema = Type.Object({
  mailingKey: AnyMailingKey,
  configured: Bool,
  enabled: Bool,
  leadDays: Int,
  schedule: ScheduleSchema,
  audienceRelationships: Nullable(Type.Array(RelationshipCode)),
  content: BereavementMailingContent,
  version: Int,
  updatedAt: Nullable(Str),
});
export const MailingConfigListResponseSchema = Type.Array(MailingConfigViewResponseSchema);

const ItemCountsSchema = Type.Object({
  included: Int,
  excluded: Int,
  logged: Int,
  excludedAfterRender: Int,
});

export const MailingRunViewResponseSchema = Type.Object({
  runId: Str,
  runKind: RunKind,
  mailingKey: Nullable(AnyMailingKey),
  occurrenceKey: Str,
  scheduledFor: Str,
  status: RunStatus,
  content: BereavementMailingContent,
  recipientCount: Int,
  excludedCount: Int,
  failureCode: Nullable(Str),
  hasDocument: Bool,
  generatedAt: Nullable(Str),
  mailedAt: Nullable(Str),
  itemCounts: ItemCountsSchema,
  version: Int,
  createdAt: Str,
});

export const MailingItemViewResponseSchema = Type.Object({
  itemId: Str,
  contactId: Str,
  planId: Str,
  relationshipCode: RelationshipCode,
  channel: literals(["postal", "email"] as const),
  status: ItemStatus,
  exclusionReason: Nullable(ExclusionReason),
  ordinal: Nullable(Int),
});

export const MailingDownloadViewResponseSchema = Type.Object({
  runId: Str,
  url: Str,
  expiresAt: Str,
});

const pageOf = <T extends TSchema>(item: T) =>
  Type.Object({
    data: Type.Array(item),
    next_cursor: Nullable(Str),
    has_more: Bool,
    total_count: Type.Optional(Int),
  });
export const MailingRunPageResponseSchema = pageOf(MailingRunViewResponseSchema);
export const MailingItemPageResponseSchema = pageOf(MailingItemViewResponseSchema);

// ── route 52 — the contact's activity timeline ─────────────────────────────────────────────────────

const OutreachKindResponse = literals([
  "phone_call",
  "in_person_visit",
  "sympathy_card",
  "sympathy_letter",
  "anniversary_letter",
  "email",
  "portal_message",
  "group_support_invitation",
  "external_referral",
] as const);
const ActivityKindResponse = literals([
  "newsletter_mailing",
  "holiday_mailing",
  "memorial_invitation_mailing",
  "support_group_session",
  "memorial_service_attendance",
] as const);
const OutcomeResponse = literals([
  "engaged",
  "brief_acknowledgement",
  "declined",
  "no_response",
  "voicemail_left",
  "wrong_number",
  "returned_undeliverable",
  "requested_followup",
  "requested_no_further_contact",
  "crisis_referral",
  "artifact_rendered",
  "mailed",
  "emailed",
  "attended",
] as const);

export const ContactTimelineEntryResponseSchema = Type.Object({
  entryId: Str,
  at: Str,
  source: literals(["outreach", "program_activity"] as const),
  kind: Nullable(OutreachKindResponse),
  activityKind: Nullable(ActivityKindResponse),
  /** The outcome of the touchpoint; ABSENT on an outreach entry for a volunteer (call outcomes are clinical content, D10). */
  outcome: Type.Optional(OutcomeResponse),
});
export const ContactTimelinePageResponseSchema = Type.Object({
  data: Type.Array(ContactTimelineEntryResponseSchema),
  next_cursor: Nullable(Str),
  has_more: Bool,
  total_count: Type.Optional(Int),
  redactedCategories: Type.Array(literals(["sud", "clinical_risk"] as const)),
});
