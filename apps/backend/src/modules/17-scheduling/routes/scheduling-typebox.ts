// apps/backend/src/modules/17-scheduling/routes/scheduling-typebox.ts — M17-T07 TypeBox route schemas (§4.2).
// Named `*-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox import
// for a Drizzle one, and so the OpenAPI route scanner skips it. Validation runs through TypeBox `Value` → M1's
// VALIDATION_FAILED envelope (422). The create/reassign bodies carry the assignment facts (`assignedMembershipId`
// / `visitPurpose` / `patientId` / `scheduledStartedAt`/`scheduledEndedAt`) so the assignment-write routes'
// four §4.7 pre-schedule predicates resolve at authz time. Response view shapes (the §5 screens' reads) are
// enriched into the OpenAPI contract with the screens in M17-T08.
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
if (!FormatRegistry.Has("date")) {
  FormatRegistry.Set("date", (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v));
}

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/** §3.2 visit purpose value set (mirrors `VisitPurpose`). */
const VISIT_PURPOSE = Type.Union([
  Type.Literal("routine_visit"),
  Type.Literal("prn"),
  Type.Literal("aide_poc"),
  Type.Literal("msw_assessment"),
  Type.Literal("msw_followup"),
  Type.Literal("chaplain_visit"),
  Type.Literal("chaplain_assessment"),
  Type.Literal("volunteer_visit"),
  Type.Literal("f2f"),
  Type.Literal("recert"),
  Type.Literal("loc_change"),
  Type.Literal("pronouncement"),
  Type.Literal("admission_visit"),
  Type.Literal("discharge_visit"),
]);

/** §3.2 visit setting value set (mirrors `VisitSetting`). */
const VISIT_SETTING = Type.Union([
  Type.Literal("patient_home"),
  Type.Literal("facility"),
  Type.Literal("inpatient_unit"),
  Type.Literal("telephonic"),
]);

const TIME_OFF_KIND = Type.Union([
  Type.Literal("pto"),
  Type.Literal("sick"),
  Type.Literal("bereavement"),
  Type.Literal("training"),
  Type.Literal("other"),
]);

const RRULE_BYDAY = Type.Union([
  Type.Literal("MO"),
  Type.Literal("TU"),
  Type.Literal("WE"),
  Type.Literal("TH"),
  Type.Literal("FR"),
  Type.Literal("SA"),
  Type.Literal("SU"),
]);

// ── params + query ──────────────────────────────────────────────────────────────────────────────────────
export const VisitIdParamsSchema = Type.Object({ visitId: Type.String({ format: "uuid" }) });
export const ProposalIdParamsSchema = Type.Object({ proposalId: Type.String({ format: "uuid" }) });
export const IdParamsSchema = Type.Object({ id: Type.String({ format: "uuid" }) });
export const MembershipIdParamsSchema = Type.Object({ membershipId: Type.String({ format: "uuid" }) });

export const VisitListQuerySchema = Type.Object({
  clinician: Type.Optional(Type.String({ format: "uuid" })),
  patient: Type.Optional(Type.String({ format: "uuid" })),
  from: Type.Optional(Type.String({ format: "date-time" })),
  to: Type.Optional(Type.String({ format: "date-time" })),
  status: Type.Optional(Type.String({ maxLength: 32 })),
});
export const ProposalListQuerySchema = Type.Object({
  patient: Type.Optional(Type.String({ format: "uuid" })),
});
export const RecurringListQuerySchema = Type.Object({
  patient: Type.String({ format: "uuid" }),
});
export const AvailabilityQuerySchema = Type.Object({
  membership: Type.String({ format: "uuid" }),
});
export const TimeOffListQuerySchema = Type.Object({
  membership: Type.Optional(Type.String({ format: "uuid" })),
  state: Type.Optional(Type.String({ maxLength: 32 })),
  from: Type.Optional(Type.String({ format: "date-time" })),
  to: Type.Optional(Type.String({ format: "date-time" })),
});
export const DayViewQuerySchema = Type.Object({
  membership: Type.Optional(Type.String({ format: "uuid" })),
  date: Type.String({ format: "date" }),
});
export const WeekViewQuerySchema = Type.Object({
  membership: Type.Optional(Type.String({ format: "uuid" })),
  weekStart: Type.String({ format: "date" }),
});
export const MapViewQuerySchema = Type.Object({
  membership: Type.String({ format: "uuid" }),
  date: Type.String({ format: "date" }),
});
export const PortalUpcomingQuerySchema = Type.Object({
  patient: Type.String({ format: "uuid" }),
  withinHours: Type.Optional(Type.Integer({ minimum: 1, maximum: 720 })),
});
export const MetricsQuerySchema = Type.Object({
  from: Type.String({ format: "date-time" }),
  to: Type.String({ format: "date-time" }),
  discipline: Type.Optional(Type.String({ maxLength: 32 })),
});
export const RouteEfficiencyQuerySchema = Type.Object({
  membership: Type.String({ format: "uuid" }),
  from: Type.String({ format: "date-time" }),
  to: Type.String({ format: "date-time" }),
});

// ── request bodies (§4.2) ───────────────────────────────────────────────────────────────────────────────
export const CreateVisitRequest = Type.Object({
  patientId: Type.String({ format: "uuid" }),
  admissionId: Type.String({ format: "uuid" }),
  patientAddressId: Nullable(Type.String({ format: "uuid" })),
  externalFacilityId: Nullable(Type.String({ format: "uuid" })),
  assignedMembershipId: Type.String({ format: "uuid" }),
  visitPurpose: VISIT_PURPOSE,
  visitSetting: VISIT_SETTING,
  scheduledStartedAt: Type.String({ format: "date-time" }),
  scheduledEndedAt: Type.String({ format: "date-time" }),
  schedulerInternalNotes: Type.Optional(Type.String({ maxLength: 1000 })),
  caregiverReminderOptIn: Type.Optional(Type.Boolean()),
  parentRecurringVisitId: Type.Optional(Type.String({ format: "uuid" })),
});

export const EditVisitRequest = Type.Object({
  scheduledStartedAt: Type.Optional(Type.String({ format: "date-time" })),
  scheduledEndedAt: Type.Optional(Type.String({ format: "date-time" })),
  assignedMembershipId: Type.Optional(Type.String({ format: "uuid" })),
  visitPurpose: Type.Optional(VISIT_PURPOSE),
  visitSetting: Type.Optional(VISIT_SETTING),
  schedulerInternalNotes: Type.Optional(Type.String({ maxLength: 1000 })),
});

export const StartVisitRequest = Type.Object({
  evvMissingReason: Type.Optional(Type.String({ minLength: 40, maxLength: 1000 })),
});

export const CancelVisitRequest = Type.Object({
  reason: Type.String({ minLength: 20, maxLength: 1000 }),
  reasonCode: Type.String({ minLength: 1, maxLength: 64 }),
});

export const RescheduleVisitRequest = Type.Object({
  newScheduledStartedAt: Type.String({ format: "date-time" }),
  newScheduledEndedAt: Type.String({ format: "date-time" }),
  newAssignedMembershipId: Type.Optional(Type.String({ format: "uuid" })),
  reason: Type.String({ minLength: 20, maxLength: 1000 }),
});

export const NoShowVisitRequest = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
});

export const ReassignVisitRequest = Type.Object({
  newAssignedMembershipId: Type.String({ format: "uuid" }),
  reason: Type.Optional(Type.String({ maxLength: 1000 })),
});

export const DismissProposalRequest = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
});

export const CreateRecurringVisitRequest = Type.Object({
  patientId: Type.String({ format: "uuid" }),
  admissionId: Type.String({ format: "uuid" }),
  assignedMembershipId: Type.String({ format: "uuid" }),
  visitPurpose: VISIT_PURPOSE,
  visitSetting: VISIT_SETTING,
  patientAddressId: Type.Optional(Type.String({ format: "uuid" })),
  rrule: Type.String({ minLength: 10, maxLength: 500 }),
  byday: Type.Optional(Type.Array(RRULE_BYDAY)),
  timeOfDayStart: Type.String({ pattern: "^[0-2][0-9]:[0-5][0-9]$" }),
  timeOfDayEnd: Type.String({ pattern: "^[0-2][0-9]:[0-5][0-9]$" }),
  timeZone: Type.String({ minLength: 1, maxLength: 64 }),
  startDate: Type.String({ format: "date" }),
  endDate: Type.Optional(Type.String({ format: "date" })),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
});

export const DiscontinueRecurringVisitRequest = Type.Object({
  reason: Type.Optional(Type.String({ maxLength: 1000 })),
});

/** A weekly availability slot (one per weekday in the upsert). */
const AvailabilitySlot = Type.Object({
  weekday: Type.Integer({ minimum: 0, maximum: 6 }),
  startTime: Type.String({ pattern: "^[0-2][0-9]:[0-5][0-9]$" }),
  endTime: Type.String({ pattern: "^[0-2][0-9]:[0-5][0-9]$" }),
});
export const UpsertAvailabilityRequest = Type.Object({
  timeZone: Type.String({ minLength: 1, maxLength: 64 }),
  slots: Type.Array(AvailabilitySlot, { maxItems: 21 }),
});

export const RequestTimeOffRequest = Type.Object({
  membershipId: Type.String({ format: "uuid" }),
  kind: TIME_OFF_KIND,
  startsAt: Type.String({ format: "date-time" }),
  endsAt: Type.String({ format: "date-time" }),
  reason: Type.Optional(Type.String({ maxLength: 1000 })),
});
export const ApproveTimeOffRequest = Type.Object({});
export const DenyTimeOffRequest = Type.Object({
  reason: Type.String({ minLength: 20, maxLength: 1000 }),
});
export const CancelTimeOffRequest = Type.Object({});

export const OptimizeDayRequest = Type.Object({
  membershipId: Type.String({ format: "uuid" }),
  serviceDate: Type.String({ format: "date" }),
  debounceKey: Type.Optional(Type.String({ maxLength: 128 })),
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
