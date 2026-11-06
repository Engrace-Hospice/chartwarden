// apps/backend/src/modules/16-bereavement/routes/group-typebox.ts — M16 support groups (ADR-0109 D10, PR 3) request + response schemas, routes 53-66.
//
// No body carries a version or an idempotency key: `If-Match` and `Idempotency-Key` ride the headers. The response DTOs are pinned to the service
// views by `m16-response-dtos.ts`.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { RelationshipCode } from "./m16-typebox";

const Uuid = Type.String({ format: "uuid" });
const Str = Type.String();
const Int = Type.Integer();
const Bool = Type.Boolean();
const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);
const literals = <const T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>(Type.Union(values.map((v) => Type.Literal(v))));

export const GroupFormat = literals(["recurring", "drop_in"] as const);
export const ProgramModality = literals(["in_person", "virtual"] as const);
const FacilitatorKind = literals(["staff", "volunteer"] as const);
const GroupStatus = literals(["draft", "open", "completed", "cancelled"] as const);
const SessionStatus = literals(["scheduled", "held", "cancelled"] as const);
const EnrollmentStatus = literals(["enrolled", "withdrawn"] as const);
const WithdrawnReason = literals([
  "requested",
  "staff_removed",
  "opted_out",
  "plan_closed",
  "group_ended",
] as const);
/** An `https:` meeting link (a virtual group / memorial). */
export const JoinUrl = Type.String({ minLength: 12, maxLength: 500, pattern: "^https://" });
const Instant = Type.String({ format: "date-time" });

export const GroupRecurrence = Type.Object({
  firstDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  startTime: Type.String({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }),
  durationMinutes: Type.Integer({ minimum: 15, maximum: 480 }),
  intervalWeeks: Type.Integer({ minimum: 1, maximum: 4 }),
  count: Type.Integer({ minimum: 1, maximum: 52 }),
});

// ── requests ────────────────────────────────────────────────────────────────────────────────────────

export const GroupParams = Type.Object({ groupId: Uuid });
export const GroupSessionParams = Type.Object({ groupId: Uuid, sessionId: Uuid });
export const GroupContactParams = Type.Object({ groupId: Uuid, contactId: Uuid });

const GroupFields = {
  name: Type.String({ minLength: 1, maxLength: 120 }),
  description: Nullable(Type.String({ maxLength: 2000 })),
  modality: ProgramModality,
  enrollmentRequired: Bool,
  facilitatorKind: FacilitatorKind,
  facilitatorUserId: Uuid,
  coFacilitatorUserId: Nullable(Uuid),
  capacity: Nullable(Type.Integer({ minimum: 1, maximum: 500 })),
  timezone: Type.String({ minLength: 1, maxLength: 64 }),
  venueText: Nullable(Type.String({ maxLength: 500 })),
  /** Omit to keep the stored link; null clears it. */
  joinUrl: Type.Optional(Nullable(JoinUrl)),
};

/** Route 54 — a draft group. `recurrence` is required for `recurring` and must be null for `drop_in`. */
export const CreateGroupBody = Type.Object({
  ...GroupFields,
  format: GroupFormat,
  recurrence: Nullable(GroupRecurrence),
});
/** Route 56 — edit a draft or open group (`recurrence` only while a draft recurring group). */
export const UpdateGroupBody = Type.Object({
  ...GroupFields,
  recurrence: Type.Optional(GroupRecurrence),
});
/** Route 58. */
export const CloseGroupBody = Type.Object({
  status: literals(["completed", "cancelled"] as const),
});
/** Route 60 — one extra session. */
export const AddGroupSessionBody = Type.Object({ startsAt: Instant, endsAt: Instant });
/** Route 63. */
export const EnrollContactBody = Type.Object({ contactId: Uuid });
/** Route 64. */
export const WithdrawEnrollmentBody = Type.Object({
  reason: literals(["requested", "staff_removed"] as const),
});
/** Route 65. */
export const RecordAttendanceBody = Type.Object({
  contactIds: Type.Array(Uuid, { minItems: 1, maxItems: 200 }),
});
export const GroupListQuerySchema = Type.Object({
  status: Type.Optional(GroupStatus),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export type CreateGroupBody = Static<typeof CreateGroupBody>;
export type UpdateGroupBody = Static<typeof UpdateGroupBody>;

// ── responses ───────────────────────────────────────────────────────────────────────────────────────

const GroupViewFields = {
  groupId: Str,
  name: Str,
  description: Nullable(Str),
  format: GroupFormat,
  modality: ProgramModality,
  enrollmentRequired: Bool,
  facilitatorKind: FacilitatorKind,
  facilitatorUserId: Str,
  coFacilitatorUserId: Nullable(Str),
  capacity: Nullable(Int),
  status: GroupStatus,
  recurrence: Nullable(GroupRecurrence),
  timezone: Str,
  venueText: Nullable(Str),
  hasJoinUrl: Bool,
  enrolledCount: Int,
  nextSessionAt: Nullable(Str),
  openedAt: Nullable(Str),
  closedAt: Nullable(Str),
  version: Int,
  createdAt: Str,
};
export const GroupViewResponseSchema = Type.Object(GroupViewFields);
export const GroupDetailResponseSchema = Type.Object({
  ...GroupViewFields,
  joinUrl: Nullable(Str),
});
export const GroupPageResponseSchema = Type.Object({
  data: Type.Array(GroupViewResponseSchema),
  next_cursor: Nullable(Str),
  has_more: Bool,
  total_count: Type.Optional(Int),
});
export const GroupSessionResponseSchema = Type.Object({
  sessionId: Str,
  groupId: Str,
  sessionNo: Int,
  startsAt: Str,
  endsAt: Str,
  status: SessionStatus,
  attendeeCount: Int,
  version: Int,
});
export const GroupSessionListResponseSchema = Type.Array(GroupSessionResponseSchema);
export const GroupRosterResponseSchema = Type.Object({
  groupId: Str,
  projection: literals(["staff", "volunteer"] as const),
  entries: Type.Array(
    Type.Object({
      contactId: Str,
      displayName: Str,
      enrollmentStatus: EnrollmentStatus,
      attendedSessions: Int,
      /** Absent on the volunteer projection. */
      relationshipCode: Type.Optional(RelationshipCode),
      planId: Type.Optional(Str),
    }),
  ),
});
export const GroupEnrollmentResponseSchema = Type.Object({
  enrollmentId: Str,
  groupId: Str,
  groupName: Str,
  groupStatus: GroupStatus,
  contactId: Str,
  status: EnrollmentStatus,
  withdrawnReason: Nullable(WithdrawnReason),
  enrolledAt: Str,
  withdrawnAt: Nullable(Str),
});
export const GroupEnrollmentListResponseSchema = Type.Array(GroupEnrollmentResponseSchema);
export const AttendanceResultResponseSchema = Type.Object({
  sessionId: Str,
  recordedCount: Int,
  alreadyRecordedCount: Int,
  attendeeCount: Int,
});
