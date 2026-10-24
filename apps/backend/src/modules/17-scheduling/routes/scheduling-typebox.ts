import { ValidationError } from "@chartwarden/types";
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
import type {
  AvailabilityView as ServiceAvailabilityView,
  ProposalView as ServiceProposalView,
  RecurringView as ServiceRecurringView,
  TimeOffView as ServiceTimeOffView,
  SchedulingRouteService as ServiceType,
  VisitView as ServiceVisitView,
} from "./service";

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

/** §2.2.1 visit lifecycle status (mirrors `VisitStatus`). Pinned literals so the response DTO conforms. */
const VISIT_STATUS = Type.Union([
  Type.Literal("proposed"),
  Type.Literal("published"),
  Type.Literal("en_route"),
  Type.Literal("in_visit"),
  Type.Literal("completed"),
  Type.Literal("no_show"),
  Type.Literal("cancelled"),
  Type.Literal("rescheduled"),
]);

/** §1.1 time-off lifecycle state (mirrors `TimeOffState`). */
const TIME_OFF_STATE = Type.Union([
  Type.Literal("requested"),
  Type.Literal("approved"),
  Type.Literal("denied"),
  Type.Literal("cancelled"),
  Type.Literal("consumed"),
]);

// GAP-093 — mirrors `credential_discipline` / `credential_status` (packages/db/src/enums.ts).
const CREDENTIAL_DISCIPLINE = Type.Union([
  Type.Literal("rn"),
  Type.Literal("lpn"),
  Type.Literal("chha"),
  Type.Literal("msw"),
  Type.Literal("chaplain"),
  Type.Literal("volunteer"),
  Type.Literal("md"), // PHYSICIAN — MD or DO (same level, one value)
  Type.Literal("np"),
  Type.Literal("pa"), // F-030 — a distinct licence below MD/DO; in no visit-purpose list
]);
const CREDENTIAL_STATUS = Type.Union([
  Type.Literal("active"),
  Type.Literal("suspended"),
  Type.Literal("revoked"),
]);

// ── params + query ──────────────────────────────────────────────────────────────────────────────────────
export const VisitIdParamsSchema = Type.Object({ visitId: Type.String({ format: "uuid" }) });
export const ProposalIdParamsSchema = Type.Object({ proposalId: Type.String({ format: "uuid" }) });
export const IdParamsSchema = Type.Object({ id: Type.String({ format: "uuid" }) });
export const MembershipIdParamsSchema = Type.Object({
  membershipId: Type.String({ format: "uuid" }),
});
export const MembershipCredentialParamsSchema = Type.Object({
  membershipId: Type.String({ format: "uuid" }),
  credentialId: Type.String({ format: "uuid" }),
});

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
  // GAP-050 — the HTTP route is always the documented self-attest path, so the reason is mandatory.
  evvMissingReason: Type.String({ minLength: 40, maxLength: 1000 }),
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

// ── response view schemas (§5 screen reads; enriched into the OpenAPI contract in M17-T08) ──────────────────
/** §4.1 — the visit projection the day/week/visit-detail screens read (mirrors `VisitView`). */
export const VisitViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  organizationId: Type.String({ format: "uuid" }),
  patientId: Type.String({ format: "uuid" }),
  admissionId: Type.String({ format: "uuid" }),
  assignedMembershipId: Type.String({ format: "uuid" }),
  visitPurpose: VISIT_PURPOSE,
  visitSetting: VISIT_SETTING,
  scheduledStartedAt: Type.String({ format: "date-time" }),
  scheduledEndedAt: Type.String({ format: "date-time" }),
  serviceDate: Type.String({ format: "date" }),
  status: VISIT_STATUS,
  patientAddressId: Nullable(Type.String({ format: "uuid" })),
  externalFacilityId: Nullable(Type.String({ format: "uuid" })),
  rescheduledIntoVisitId: Nullable(Type.String({ format: "uuid" })),
  cancellationReasonCode: Nullable(Type.String()),
});
export const VisitListResponseSchema = Type.Array(VisitViewSchema);

/** §5 — proposal inbox row (mirrors `ProposalView`). */
export const ProposalViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  patientId: Type.String({ format: "uuid" }),
  admissionId: Type.String({ format: "uuid" }),
  proposedVisitPurpose: VISIT_PURPOSE,
  proposedForDate: Type.String({ format: "date" }),
  source: Type.Optional(Type.String()),
  suggestedMembershipId: Type.Optional(Nullable(Type.String({ format: "uuid" }))),
  proposedStartedAt: Type.Optional(Type.String({ format: "date-time" })),
  proposedEndedAt: Type.Optional(Type.String({ format: "date-time" })),
  publishedAsVisitId: Type.Optional(Nullable(Type.String({ format: "uuid" }))),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("published"),
    Type.Literal("dismissed"),
    Type.Literal("stale"),
  ]),
});
export const ProposalListResponseSchema = Type.Array(ProposalViewSchema);

/** §5 — recurring-policy row (mirrors `RecurringView`). */
export const RecurringViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  patientId: Type.String({ format: "uuid" }),
  assignedMembershipId: Type.String({ format: "uuid" }),
  visitPurpose: VISIT_PURPOSE,
  rrule: Type.String(),
  status: Type.Union([Type.Literal("active"), Type.Literal("discontinued")]),
  admissionId: Type.Optional(Type.String({ format: "uuid" })),
  visitSetting: Type.Optional(VISIT_SETTING),
  patientAddressId: Type.Optional(Nullable(Type.String({ format: "uuid" }))),
  timeOfDayStart: Type.Optional(Type.String()),
  timeOfDayEnd: Type.Optional(Type.String()),
  timeZone: Type.Optional(Type.String()),
  startDate: Type.Optional(Type.String({ format: "date" })),
  count: Type.Optional(Nullable(Type.Integer())),
});
export const RecurringListResponseSchema = Type.Array(RecurringViewSchema);

/** §5 — weekly availability pattern (mirrors `AvailabilityView`). */
export const AvailabilityViewSchema = Type.Object({
  membershipId: Type.String({ format: "uuid" }),
  timeZone: Type.String(),
  slots: Type.Array(
    Type.Object({
      weekday: Type.Integer({ minimum: 0, maximum: 6 }),
      startTime: Type.String(),
      endTime: Type.String(),
    }),
  ),
});

/** §5 — time-off approval-queue / my-PTO row (mirrors `TimeOffView`). */
export const TimeOffViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  membershipId: Type.String({ format: "uuid" }),
  kind: TIME_OFF_KIND,
  startsAt: Type.String({ format: "date-time" }),
  endsAt: Type.String({ format: "date-time" }),
  state: TIME_OFF_STATE,
});
export const TimeOffListResponseSchema = Type.Array(TimeOffViewSchema);

// GAP-093 — membership_credential grant/revoke/list.
export const CredentialViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  membershipId: Type.String({ format: "uuid" }),
  credentialType: CREDENTIAL_DISCIPLINE,
  status: CREDENTIAL_STATUS,
  effectiveAt: Type.String({ format: "date" }),
  expiresAt: Nullable(Type.String({ format: "date" })),
  revokedAt: Nullable(Type.String({ format: "date-time" })),
  revokedReason: Nullable(Type.String()),
  issuingBody: Nullable(Type.String()),
  grantedByMembershipId: Type.String({ format: "uuid" }),
  createdAt: Type.String({ format: "date-time" }),
});
export const CredentialListResponseSchema = Type.Array(CredentialViewSchema);
// GAP-029 — on-call rotation entries (the source behind tonightsOnCallRoster).
export const OnCallRotationViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  membershipId: Type.String({ format: "uuid" }),
  discipline: Type.Union([
    Type.Literal("clinical_rn"),
    Type.Literal("clinical_lpn"),
    Type.Literal("medical_director"),
    Type.Literal("msw"),
    Type.Literal("chaplain"),
  ]),
  startsAt: Type.String({ format: "date-time" }),
  endsAt: Type.String({ format: "date-time" }),
  cancelledAt: Nullable(Type.String({ format: "date-time" })),
});
export const OnCallRotationListResponseSchema = Type.Array(OnCallRotationViewSchema);
export const EligibleCliniciansQuerySchema = Type.Object({
  patientId: Type.String({ format: "uuid" }),
  visitPurpose: VISIT_PURPOSE,
  scheduledStartedAt: Type.String({ format: "date-time" }),
  scheduledEndedAt: Type.String({ format: "date-time" }),
});
// Scheduling-UI read models (GET /scheduling/eligible-clinicians, GET /scheduling/staff). The
// discipline vocabulary is `SchedulingDiscipline`, which is the same set as `CREDENTIAL_DISCIPLINE`.
export const EligibleClinicianViewSchema = Type.Object({
  membershipId: Type.String({ format: "uuid" }),
  displayName: Type.String(),
  disciplines: Type.Array(CREDENTIAL_DISCIPLINE),
  eligible: Type.Boolean(),
  reasonCodes: Type.Array(Type.String()),
});
export const EligibleCliniciansResponseSchema = Type.Array(EligibleClinicianViewSchema);
export const SchedulingStaffViewSchema = Type.Object({
  membershipId: Type.String({ format: "uuid" }),
  displayName: Type.String(),
  discipline: Nullable(CREDENTIAL_DISCIPLINE),
});
export const SchedulingStaffResponseSchema = Type.Array(SchedulingStaffViewSchema);
export const SchedulingContextResponseSchema = Type.Object({ timeZone: Type.String() });
export const GrantCredentialRequest = Type.Object({
  credentialType: CREDENTIAL_DISCIPLINE,
  effectiveAt: Type.String({ format: "date" }),
  expiresAt: Type.Optional(Nullable(Type.String({ format: "date" }))),
  issuingBody: Type.Optional(Type.String({ maxLength: 200 })),
});
export const OnCallRotationQuerySchema = Type.Object({
  includeCancelled: Type.Optional(Type.Boolean()),
});
const ONCALL_ROTATION_DISCIPLINE = Type.Union([
  Type.Literal("clinical_rn"),
  Type.Literal("clinical_lpn"),
  Type.Literal("medical_director"),
  Type.Literal("msw"),
  Type.Literal("chaplain"),
]);
export const CreateOnCallRotationRequest = Type.Object({
  membershipId: Type.String({ format: "uuid" }),
  discipline: ONCALL_ROTATION_DISCIPLINE,
  startsAt: Type.String({ format: "date-time" }),
  endsAt: Type.String({ format: "date-time" }),
});
export const RevokeCredentialRequest = Type.Object({
  reason: Type.String({ minLength: 3, maxLength: 1000 }),
});

/** §5 — day-view grid (per-clinician visits for one service date). */
export const DayViewResponseSchema = Type.Object({
  date: Type.String({ format: "date" }),
  membershipId: Nullable(Type.String({ format: "uuid" })),
  visits: VisitListResponseSchema,
});

/** §5 — week-view grid. */
export const WeekViewResponseSchema = Type.Object({
  weekStart: Type.String({ format: "date" }),
  membershipId: Nullable(Type.String({ format: "uuid" })),
  visits: VisitListResponseSchema,
});

/** §5 — map-view ordered stops (polylines are coords-only, D9; the slice returns ordered stops). */
export const MapViewResponseSchema = Type.Object({
  membershipId: Type.String({ format: "uuid" }),
  date: Type.String({ format: "date" }),
  stops: VisitListResponseSchema,
});

/** §5.1 — org-wide visit metrics (on-time / no-show / reschedule rates). */
export const VisitMetricsResponseSchema = Type.Object({
  onTimeRate: Type.Number(),
  noShowRate: Type.Number(),
  rescheduleRate: Type.Number(),
});

/** §5.1 — per-clinician route-efficiency metrics. */
export const RouteEfficiencyResponseSchema = Type.Object({
  membershipId: Type.String({ format: "uuid" }),
  totalProposedMiles: Type.Number(),
  overrideRate: Type.Number(),
});

/** Route 7 — reschedule returns the original (→ rescheduled) visit + the newly-created visit. */
export const RescheduleResponseSchema = Type.Object({
  original: VisitViewSchema,
  created: VisitViewSchema,
});

/** Route 26 — §7.9 on-demand optimisation result (degraded when the flag is OFF / OSRM unhealthy). */
export const OptimizeDayResponseSchema = Type.Object({
  membershipId: Type.String({ format: "uuid" }),
  serviceDate: Type.String({ format: "date" }),
  degraded: Type.Boolean(),
  reason: Type.Optional(Type.String()),
  segmentCount: Type.Integer(),
});

/** Route 27 — §4.3 portal upcoming visits (lay-language label; scrubbed; no raw enum/PHI notes). */
export const PortalUpcomingResponseSchema = Type.Array(
  Type.Object({
    visitId: Type.String({ format: "uuid" }),
    scheduledStartedAt: Type.String({ format: "date-time" }),
    scheduledEndedAt: Type.String({ format: "date-time" }),
    visitPurposeLabel: Type.String(),
    visitSetting: VISIT_SETTING,
  }),
);

// ── §4.2 compile-time response pins ────────────────────────────────────────────────────────────────────────
// `T` (what a schema publishes) must be assignable to `V` (what the service returns), so a service-view field
// added or renamed breaks `bun run build` rather than silently drifting from the generated client.
type Conforms<T extends V, V> = T;
type _Visit = Conforms<Static<typeof VisitViewSchema>, ServiceVisitView>;
type _VisitList = Conforms<Static<typeof VisitListResponseSchema>, readonly ServiceVisitView[]>;
type _Proposal = Conforms<Static<typeof ProposalViewSchema>, ServiceProposalView>;
type _ProposalList = Conforms<
  Static<typeof ProposalListResponseSchema>,
  readonly ServiceProposalView[]
>;
type _Recurring = Conforms<Static<typeof RecurringViewSchema>, ServiceRecurringView>;
type _RecurringList = Conforms<
  Static<typeof RecurringListResponseSchema>,
  readonly ServiceRecurringView[]
>;
type _Availability = Conforms<Static<typeof AvailabilityViewSchema>, ServiceAvailabilityView>;
type _TimeOff = Conforms<Static<typeof TimeOffViewSchema>, ServiceTimeOffView>;
type _TimeOffList = Conforms<
  Static<typeof TimeOffListResponseSchema>,
  readonly ServiceTimeOffView[]
>;
type _DayView = Conforms<Static<typeof DayViewResponseSchema>, ReturnType<ServiceType["dayView"]>>;
type _WeekView = Conforms<
  Static<typeof WeekViewResponseSchema>,
  ReturnType<ServiceType["weekView"]>
>;
type _MapView = Conforms<Static<typeof MapViewResponseSchema>, ReturnType<ServiceType["mapView"]>>;
type _VisitMetrics = Conforms<
  Static<typeof VisitMetricsResponseSchema>,
  ReturnType<ServiceType["visitMetrics"]>
>;
type _RouteEff = Conforms<
  Static<typeof RouteEfficiencyResponseSchema>,
  ReturnType<ServiceType["routeEfficiencyMetrics"]>
>;
type _Reschedule = Conforms<
  Static<typeof RescheduleResponseSchema>,
  ReturnType<ServiceType["rescheduleVisit"]>
>;
type _Optimize = Conforms<
  Static<typeof OptimizeDayResponseSchema>,
  Awaited<ReturnType<ServiceType["optimizeDay"]>>
>;
type _Portal = Conforms<
  Static<typeof PortalUpcomingResponseSchema>,
  ReturnType<ServiceType["portalUpcoming"]>
>;
type _CredentialList = Conforms<
  Static<typeof CredentialListResponseSchema>,
  Awaited<ReturnType<ServiceType["listCredentials"]>>
>;
type _OnCallRotationList = Conforms<
  Static<typeof OnCallRotationListResponseSchema>,
  Awaited<ReturnType<ServiceType["listOnCallRotation"]>>
>;
type _OnCallRotationCreate = Conforms<
  Static<typeof OnCallRotationViewSchema>,
  Awaited<ReturnType<ServiceType["createOnCallRotationEntry"]>>
>;
type _CredentialGrant = Conforms<
  Static<typeof CredentialViewSchema>,
  Awaited<ReturnType<ServiceType["grantCredential"]>>
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
