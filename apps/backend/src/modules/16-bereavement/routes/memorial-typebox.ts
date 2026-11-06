// apps/backend/src/modules/16-bereavement/routes/memorial-typebox.ts — M16 memorial services (ADR-0109 D10, PR 3) request + response schemas,
// routes 67-76. `If-Match` and `Idempotency-Key` ride the headers. The response DTOs are pinned to the service views by `m16-response-dtos.ts`.
import { type TSchema, Type } from "@sinclair/typebox";
import { JoinUrl, ProgramModality } from "./group-typebox";
import { RelationshipCode } from "./m16-typebox";

const Uuid = Type.String({ format: "uuid" });
const Str = Type.String();
const Int = Type.Integer();
const Bool = Type.Boolean();
const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);
const literals = <const T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>(Type.Union(values.map((v) => Type.Literal(v))));
const Instant = Type.String({ format: "date-time" });
const LocalDate = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });

const MemorialStatus = literals(["draft", "published", "held", "cancelled"] as const);
const Delivery = literals(["mailing", "portal_only"] as const);
const InvitationStatus = literals([
  "invited",
  "rsvp_yes",
  "rsvp_no",
  "rsvp_maybe",
  "attended",
  "no_show",
  "withdrawn",
] as const);
const RsvpSource = literals(["staff_phone", "portal"] as const);
export const RsvpResponse = literals(["yes", "no", "maybe"] as const);
/** A guest COUNT (names are deferred); counts only on a yes. */
export const Guests = Type.Integer({ minimum: 0, maximum: 10 });

// ── requests ────────────────────────────────────────────────────────────────────────────────────────

export const MemorialParams = Type.Object({ serviceId: Uuid });
export const MemorialInvitationParams = Type.Object({ serviceId: Uuid, invitationId: Uuid });
export const ContactInvitationParams = Type.Object({ contactId: Uuid, invitationId: Uuid });

/** Routes 68 / 70 — a service's fields (`inviteWindowMonths` is fixed once published). */
export const MemorialFieldsBody = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 160 }),
  description: Nullable(Type.String({ maxLength: 2000 })),
  startsAt: Instant,
  endsAt: Instant,
  modality: ProgramModality,
  venueText: Nullable(Type.String({ maxLength: 500 })),
  /** Omit to keep the stored link; null clears it. */
  joinUrl: Type.Optional(Nullable(JoinUrl)),
  capacity: Nullable(Type.Integer({ minimum: 1, maximum: 5000 })),
  rsvpBy: Nullable(LocalDate),
  inviteWindowMonths: Type.Integer({ minimum: 1, maximum: 13 }),
});
/** Route 72. */
export const CloseMemorialBody = Type.Object({ status: literals(["held", "cancelled"] as const) });
/** Route 74 — the family's answer, taken by phone. */
export const MemorialRsvpBody = Type.Object({ response: RsvpResponse, guests: Guests });
/** Route 75. */
export const MemorialAttendanceBody = Type.Object({ attended: Bool });
export const MemorialListQuerySchema = Type.Object({
  status: Type.Optional(MemorialStatus),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

// ── responses ───────────────────────────────────────────────────────────────────────────────────────

const RsvpCounts = Type.Object({
  invited: Int,
  yes: Int,
  no: Int,
  maybe: Int,
  attended: Int,
  noShow: Int,
  guestsExpected: Int,
});
const MemorialViewFields = {
  serviceId: Str,
  title: Str,
  description: Nullable(Str),
  startsAt: Str,
  endsAt: Str,
  modality: ProgramModality,
  venueText: Nullable(Str),
  hasJoinUrl: Bool,
  capacity: Nullable(Int),
  rsvpBy: Nullable(Str),
  inviteWindowMonths: Int,
  status: MemorialStatus,
  publishedAt: Nullable(Str),
  invitedCount: Int,
  rsvpCounts: RsvpCounts,
  mailingRunId: Nullable(Str),
  version: Int,
  createdAt: Str,
};
export const MemorialViewResponseSchema = Type.Object(MemorialViewFields);
export const MemorialDetailResponseSchema = Type.Object({
  ...MemorialViewFields,
  joinUrl: Nullable(Str),
});
export const MemorialPageResponseSchema = Type.Object({
  data: Type.Array(MemorialViewResponseSchema),
  next_cursor: Nullable(Str),
  has_more: Bool,
  total_count: Type.Optional(Int),
});
export const MemorialInvitationResponseSchema = Type.Object({
  invitationId: Str,
  serviceId: Str,
  contactId: Str,
  planId: Str,
  displayName: Str,
  relationshipCode: RelationshipCode,
  delivery: Delivery,
  status: InvitationStatus,
  guests: Int,
  rsvpSource: Nullable(RsvpSource),
  rsvpAt: Nullable(Str),
  attendedAt: Nullable(Str),
  version: Int,
});
export const MemorialInvitationListResponseSchema = Type.Array(MemorialInvitationResponseSchema);
export const ContactMemorialInvitationResponseSchema = Type.Object({
  invitationId: Str,
  serviceId: Str,
  serviceTitle: Str,
  startsAt: Str,
  serviceStatus: MemorialStatus,
  delivery: Delivery,
  status: InvitationStatus,
  guests: Int,
  rsvpSource: Nullable(RsvpSource),
  rsvpAt: Nullable(Str),
  version: Int,
});
export const ContactMemorialInvitationListResponseSchema = Type.Array(
  ContactMemorialInvitationResponseSchema,
);
