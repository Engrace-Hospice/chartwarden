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
import { IDG_DECISION_PAYLOAD_SCHEMA } from "../decision-payload-schema";
import type {
  ActionItemView as ServiceActionItemView,
  AgendaItemView as ServiceAgendaItemView,
  AttendanceView as ServiceAttendanceView,
  DecisionView as ServiceDecisionView,
  MeetingScheduleView as ServiceMeetingScheduleView,
  MeetingView as ServiceMeetingView,
  MinutesView as ServiceMinutesView,
  PacketDigestView as ServicePacketDigestView,
  RecurringPolicyView as ServiceRecurringPolicyView,
} from "./service";

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
export const PatientIdParamsSchema = Type.Object({ patientId: Type.String({ format: "uuid" }) });
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
  payload: IDG_DECISION_PAYLOAD_SCHEMA,
});
export const UpdateDecisionRequest = Type.Object({
  payload: IDG_DECISION_PAYLOAD_SCHEMA,
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

// ── response views (§4.2 — the read projections the GET routes return; M14-T07 enriches the contract so the
//    generated client (`packages/ui/src/core/api`) types the §5 screens' reads. Shapes mirror the route
//    service's view DTOs (routes/service.ts) — never the raw Drizzle row). ───────────────────────────────
const MEETING_STATUS = Type.Union([
  Type.Literal("scheduled"),
  Type.Literal("packets_building"),
  Type.Literal("packets_ready"),
  Type.Literal("live"),
  Type.Literal("adjourned"),
  Type.Literal("cancelled"),
  Type.Literal("rescheduled"),
]);

/** A single meeting in the location/range schedule list (GET /idg/schedule). */
export const MeetingScheduleViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  locationId: Type.String({ format: "uuid" }),
  status: MEETING_STATUS,
  scheduledStart: Type.String({ format: "date-time" }),
  scheduledEnd: Type.String({ format: "date-time" }),
});
export const ScheduleListResponseSchema = Type.Array(MeetingScheduleViewSchema);

/** One meeting's lifecycle view (GET /idg/meetings/:id). */
export const MeetingViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  organizationId: Type.String({ format: "uuid" }),
  locationId: Type.String({ format: "uuid" }),
  status: MEETING_STATUS,
  scheduledStart: Type.String({ format: "date-time" }),
  scheduledEnd: Type.String({ format: "date-time" }),
  adjournedAt: Nullable(Type.String({ format: "date-time" })),
});

/** A per-patient packet digest (GET /idg/meetings/:id/packets + .../packets/:patientId). */
export const PacketDigestViewSchema = Type.Object({
  packetId: Type.String({ format: "uuid" }),
  meetingId: Type.String({ format: "uuid" }),
  patientId: Type.String({ format: "uuid" }),
  frozenAt: Nullable(Type.String({ format: "date-time" })),
});
export const PacketListResponseSchema = Type.Array(PacketDigestViewSchema);

// Patient IDG review history (patient-chart tab). NOTE: `meetings` is published as a loose record array
// on purpose — each meeting item nests decisions[] + actionItems[] arrays of objects, and publishing that
// full depth makes openapi-fetch's generated client type instantiate past TypeScript's depth limit
// (TS2589) as one operation among 1000+. The rich per-meeting shape is the service
// `PatientIdgHistoryView.meetings` type, which the screen casts to; the live-RLS suite proves the shape.
export const PatientIdgHistoryResponseSchema = Type.Object({
  meetings: Type.Array(Type.Record(Type.String(), Type.Unknown())),
});

/** A caller's action-item view (GET /idg/action-items). */
export const ActionItemViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  meetingId: Type.String({ format: "uuid" }),
  decisionId: Nullable(Type.String({ format: "uuid" })),
  patientId: Nullable(Type.String({ format: "uuid" })),
  assignedToMembershipId: Type.String({ format: "uuid" }),
  status: Type.Union([
    Type.Literal("open"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
    Type.Literal("cancelled"),
    Type.Literal("auto_closed"),
  ]),
  dueDate: Type.String({ format: "date-time" }),
  linkedArtifactKind: Nullable(ACTION_ITEM_LINKED_KIND),
});
export const ActionItemListResponseSchema = Type.Array(ActionItemViewSchema);

/**
 * A meeting's minutes view (GET /idg/meetings/:id/minutes).
 *
 * The three `*Count` fields are the SIZES of `idg_minutes`' frozen snapshots, not the snapshots: those
 * nest the §3.3 denylisted decision narrative, and this module's read surface is narrative-free by
 * construction (see `PatientIdgHistoryView`). Null while `in_progress` — nothing is frozen yet, and
 * "no decisions" and "not yet snapshotted" are different facts. The readable document is the M22 render
 * at `minutesDocumentId`.
 */
export const MinutesViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  meetingId: Type.String({ format: "uuid" }),
  status: Type.Union([Type.Literal("in_progress"), Type.Literal("final")]),
  finalizedAt: Nullable(Type.String({ format: "date-time" })),
  finalizedByMembershipId: Nullable(Type.String({ format: "uuid" })),
  minutesDocumentId: Nullable(Type.String({ format: "uuid" })),
  attendanceCount: Nullable(Type.Integer({ minimum: 0 })),
  decisionCount: Nullable(Type.Integer({ minimum: 0 })),
  actionItemCount: Nullable(Type.Integer({ minimum: 0 })),
});

/** A recurring-policy view (POST/PATCH /idg/recurring-policies). */
export const RecurringPolicyViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  locationId: Type.String({ format: "uuid" }),
  cadenceDays: Type.Integer(),
  active: Type.Boolean(),
});

/** A single attendance row view (POST /idg/meetings/:id/attendance, PATCH /idg/attendance/:id). */
export const AttendanceViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  meetingId: Type.String({ format: "uuid" }),
  membershipId: Type.String({ format: "uuid" }),
  discipline: Type.String(),
  status: ATTENDANCE_STATUS,
  checkedInAt: Type.String({ format: "date-time" }),
});

/** The meeting's attendance roster (GET /idg/meetings/:id/attendance). */
export const AttendanceListResponseSchema = Type.Array(AttendanceViewSchema);

/** An agenda-item view (GET/POST /idg/meetings/:id/agenda, PATCH /idg/agenda/:id). */
export const AgendaItemViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  meetingId: Type.String({ format: "uuid" }),
  kind: AGENDA_KIND,
  patientId: Nullable(Type.String({ format: "uuid" })),
});

/** The meeting's ordered agenda (GET /idg/meetings/:id/agenda). */
export const AgendaListResponseSchema = Type.Array(AgendaItemViewSchema);

const DECISION_STATUS = Type.Union([
  Type.Literal("open"),
  Type.Literal("emitted"),
  Type.Literal("superseded"),
]);

/**
 * A decision view (GET /idg/meetings/:id/decisions, POST .../decisions, PATCH /idg/decisions/:id,
 * .../supersede). METADATA ONLY — `payload` (the D4 canonical narrative) and `quorumSnapshot` are
 * deliberately absent, on the `PatientIdgHistoryView` precedent, so the meeting-conduct read surface
 * never has to answer W-SUD-01.
 */
export const DecisionViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  meetingId: Type.String({ format: "uuid" }),
  patientId: Nullable(Type.String({ format: "uuid" })),
  agendaItemId: Nullable(Type.String({ format: "uuid" })),
  decisionKind: DECISION_KIND,
  status: DECISION_STATUS,
  wasQuorate: Type.Boolean(),
  recordedByMembershipId: Type.String({ format: "uuid" }),
  recordedAt: Type.String({ format: "date-time" }),
  supersededByDecisionId: Nullable(Type.String({ format: "uuid" })),
});
export const DecisionListResponseSchema = Type.Array(DecisionViewSchema);

/** The `{ id, removed: true }` envelope the DELETE routes return (attendance/agenda/action-items). */
export const RemovedResponseSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  removed: Type.Literal(true),
});

/** The amendment receipt (POST /idg/minutes/:id/amendments). */
export const AmendmentResponseSchema = Type.Object({
  amendmentId: Type.String({ format: "uuid" }),
  minutesId: Type.String({ format: "uuid" }),
});

// ── Compile-time pins (§4.2 F0 enrichment): `T` (what the schema publishes) must be assignable to `V`
//    (what the route service returns) — a view field added/renamed/retyped breaks `bun run build` rather
//    than silently drifting from the generated client. ──────────────────────────────────────────────────
type Conforms<T extends V, V> = T;
type _MeetingSchedule = Conforms<
  Static<typeof MeetingScheduleViewSchema>,
  ServiceMeetingScheduleView
>;
type _Meeting = Conforms<Static<typeof MeetingViewSchema>, ServiceMeetingView>;
type _Packet = Conforms<Static<typeof PacketDigestViewSchema>, ServicePacketDigestView>;
type _ActionItem = Conforms<Static<typeof ActionItemViewSchema>, ServiceActionItemView>;
type _Minutes = Conforms<Static<typeof MinutesViewSchema>, ServiceMinutesView>;
type _RecurringPolicy = Conforms<
  Static<typeof RecurringPolicyViewSchema>,
  ServiceRecurringPolicyView
>;
type _Attendance = Conforms<Static<typeof AttendanceViewSchema>, ServiceAttendanceView>;
type _AgendaItem = Conforms<Static<typeof AgendaItemViewSchema>, ServiceAgendaItemView>;
type _Decision = Conforms<Static<typeof DecisionViewSchema>, ServiceDecisionView>;
type _Removed = Conforms<
  Static<typeof RemovedResponseSchema>,
  { readonly id: string; readonly removed: true }
>;
type _Amendment = Conforms<
  Static<typeof AmendmentResponseSchema>,
  { readonly amendmentId: string; readonly minutesId: string }
>;

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
