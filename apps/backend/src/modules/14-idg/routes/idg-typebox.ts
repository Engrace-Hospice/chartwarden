// apps/backend/src/modules/14-idg/routes/idg-typebox.ts — M14-T05 TypeBox route schemas (§4.2).
// Named `*-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox import
// for a Drizzle one, and so the OpenAPI route scanner skips it. Validation runs through TypeBox `Value` →
// M1's VALIDATION_FAILED envelope (422). The decision `payload` is carried as a `kind`-bearing open object at
// this boundary (the server discriminates on `kind` and validates the §2.6 union in the domain); the
// lifecycle-bearing envelope fields are pinned here. The cancel/reschedule bodies carry `proposedTransition` +
// `newScheduledStart` so the route's `per_patient_review_floor_clear` ABAC resolves at authz time.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/** §2.6 decision taxonomy (mirrors `IdgDecisionKind`). */
const DECISION_KIND = Type.Union([
  Type.Literal("care_plan_update"),
  Type.Literal("order_request"),
  Type.Literal("medication_recommendation"),
  Type.Literal("level_of_care_consideration"),
  Type.Literal("recertification_consideration"),
  Type.Literal("family_meeting_needed"),
  Type.Literal("bereavement_risk_flag"),
  Type.Literal("referral"),
  Type.Literal("team_note"),
]);

/** §2.7 agenda-item taxonomy (mirrors `IdgAgendaItemKind`). */
const AGENDA_KIND = Type.Union([
  Type.Literal("patient_review"),
  Type.Literal("carry_forward"),
  Type.Literal("administrative_note"),
  Type.Literal("family_meeting_setup"),
  Type.Literal("other"),
]);

/** Per-attendee participation status (mirrors `IdgAttendanceStatus`). */
const ATTENDANCE_STATUS = Type.Union([
  Type.Literal("present"),
  Type.Literal("tardy"),
  Type.Literal("partial"),
  Type.Literal("absent"),
  Type.Literal("excused"),
]);

/** The action-item status filter for the list route (any persisted state). */
const ACTION_ITEM_STATUS = Type.Union([
  Type.Literal("open"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
  Type.Literal("cancelled"),
]);
/** The action-item status a PATCH may transition TO (an item is never re-opened — `open` is genesis-only). */
const ACTION_ITEM_PATCH_STATUS = Type.Union([
  Type.Literal("in_progress"),
  Type.Literal("completed"),
  Type.Literal("cancelled"),
]);

const ACTION_ITEM_LINKED_KIND = Type.Union([
  Type.Literal("care_plan_version"),
  Type.Literal("order"),
  Type.Literal("encounter"),
  Type.Literal("medication_order"),
]);

// ── params + query ──────────────────────────────────────────────────────────────────────────────────────
export const IdParamsSchema = Type.Object({ id: Type.String({ format: "uuid" }) });
export const MeetingPacketParamsSchema = Type.Object({
  meetingId: Type.String({ format: "uuid" }),
  patientId: Type.String({ format: "uuid" }),
});
export const ScheduleQuerySchema = Type.Object({
  location: Type.String({ format: "uuid" }),
  from: Type.String({ format: "date-time" }),
  to: Type.String({ format: "date-time" }),
});
export const ActionItemListQuerySchema = Type.Object({
  assignee: Type.Optional(Type.String({ maxLength: 64 })),
  status: Type.Optional(ACTION_ITEM_STATUS),
});

// ── request bodies (§4.2) ───────────────────────────────────────────────────────────────────────────────
export const RecurringPolicyRequest = Type.Object({
  locationId: Type.String({ format: "uuid" }),
  cadenceDays: Type.Integer({ minimum: 1, maximum: 15 }),
  active: Type.Optional(Type.Boolean()),
});

export const ScheduleMeetingRequest = Type.Object({
  locationId: Type.String({ format: "uuid" }),
  scheduledStart: Type.String({ format: "date-time" }),
  scheduledEnd: Type.String({ format: "date-time" }),
});

export const CancelMeetingRequest = Type.Object({
  proposedTransition: Type.Literal("cancel"),
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
});

export const RescheduleMeetingRequest = Type.Object({
  proposedTransition: Type.Literal("reschedule"),
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
  newScheduledStart: Type.String({ format: "date-time" }),
  newScheduledEnd: Type.String({ format: "date-time" }),
});

export const AdjournMeetingRequest = Type.Object({});

export const RecordAttendanceRequest = Type.Object({
  membershipId: Type.String({ format: "uuid" }),
  discipline: Type.String({ minLength: 1, maxLength: 64 }),
  status: Type.Optional(ATTENDANCE_STATUS),
  checkedInAt: Type.Optional(Type.String({ format: "date-time" })),
});
export const UpdateAttendanceRequest = Type.Object({ status: ATTENDANCE_STATUS });

export const AddAgendaItemRequest = Type.Object({
  kind: AGENDA_KIND,
  patientId: Type.Optional(Type.String({ format: "uuid" })),
  noteText: Type.Optional(Type.String({ maxLength: 4000 })),
});
export const UpdateAgendaItemRequest = Type.Object({
  noteText: Type.Optional(Type.String({ maxLength: 4000 })),
});

/** The decision body — `payload` is carried as a `kind`-bearing open object; the §2.6 union is validated in the
 * domain validator. `patientId` is nullable (an administrative/team-note decision may not be patient-scoped). */
export const RecordDecisionRequest = Type.Object({
  patientId: Nullable(Type.String({ format: "uuid" })),
  agendaItemId: Type.Optional(Type.String({ format: "uuid" })),
  payload: Type.Object({ kind: DECISION_KIND }),
});
export const UpdateDecisionRequest = Type.Object({
  payload: Type.Object({ kind: DECISION_KIND }),
});
export const SupersedeDecisionRequest = Type.Object({
  reason: Type.Optional(Type.String({ maxLength: 2000 })),
});

export const CreateActionItemRequest = Type.Object({
  decisionId: Type.Optional(Type.String({ format: "uuid" })),
  patientId: Nullable(Type.String({ format: "uuid" })),
  assignedToMembershipId: Type.String({ format: "uuid" }),
  dueDate: Type.String({ format: "date-time" }),
  linkedArtifactKind: Type.Optional(ACTION_ITEM_LINKED_KIND),
  bodyText: Type.Optional(Type.String({ maxLength: 4000 })),
});
export const UpdateActionItemRequest = Type.Object({ status: ACTION_ITEM_PATCH_STATUS });

export const SubmitAmendmentRequest = Type.Object({
  amendmentReason: Type.String({ minLength: 1, maxLength: 4000 }),
});

/** Parse `raw` through `schema` → typed value, or throw M1's VALIDATION_FAILED envelope. */
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
