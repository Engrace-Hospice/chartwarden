// apps/backend/src/modules/18-evv/routes/evv-typebox.ts — M18-T06 TypeBox route schemas (§4.2).
// Named `*-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox import for
// a Drizzle one, and so the OpenAPI route scanner skips it. Validation runs through TypeBox `Value` → M1's
// VALIDATION_FAILED envelope (422). The check-in/check-out bodies carry the assignment facts (`visitId` +
// `capturedAt`) so the two §4.7 capture predicates (`assigned_clinician_for_visit` ∧ `evv_within_visit_window`)
// resolve at authz time. Coordinates (D10) never leave the system through these schemas except on the inbound
// capture body; the read DTOs are coordinate-free.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { EvvAggregatorSubmissionDto, EvvBracketDto, EvvEventDto } from "@chartwarden/types";
import { ValidationError } from "@chartwarden/types";
import type {
  ArrivalView as ServiceArrivalView,
  CheckResultView as ServiceCheckResultView,
  DeviceView as ServiceDeviceView,
  GeofencePolicyView as ServiceGeofencePolicyView,
  LocationView as ServiceLocationView,
  MetricsView as ServiceMetricsView,
  MissingResolutionView as ServiceMissingResolutionView,
} from "./service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}

const Coords = Type.Object({
  lat: Type.Number({ minimum: -90, maximum: 90 }),
  lng: Type.Number({ minimum: -180, maximum: 180 }),
});

// ── §4.2 capture bodies ────────────────────────────────────────────────────────────────────────────────
export const CheckInRequest = Type.Object({
  visitId: Type.String({ format: "uuid" }),
  serviceTypeCode: Type.String({ minLength: 1 }), // M38-validated at runtime
  capturedAt: Type.String({ format: "date-time" }), // device clock at the moment of tap
  coords: Coords,
  accuracyM: Type.Number({ minimum: 0, maximum: 500 }), // D4 boundary
  evvDeviceId: Type.String({ format: "uuid" }),
  offlineCapture: Type.Optional(Type.Boolean()),
  localId: Type.Optional(Type.String({ format: "uuid" })),
  gpsQualityAttested: Type.Optional(Type.Literal("degraded_attested")),
});

// No `expectedAttestationId` on either capture body (F-068 §3 — the third instance of the same shape,
// removed with the other two rather than left as the odd one out). It was a required uuid the client
// could not obtain: `DeviceView` — the only device projection there is — carries no attestation id, so
// self-register never handed one back. Nothing compared it either; `device_attestation_id_at_record` is
// written from the SERVER's own `evv_device` row. A re-attestation consistency check is a real thing to
// want, and it needs a value the client can hold and a server that reads it — neither existed.
export const CheckOutRequest = Type.Object({
  visitId: Type.String({ format: "uuid" }),
  capturedAt: Type.String({ format: "date-time" }),
  coords: Coords,
  accuracyM: Type.Number({ minimum: 0, maximum: 500 }),
  evvDeviceId: Type.String({ format: "uuid" }),
  offlineCapture: Type.Optional(Type.Boolean()),
  localId: Type.Optional(Type.String({ format: "uuid" })),
  gpsQualityAttested: Type.Optional(Type.Literal("degraded_attested")),
});

export const OfflineSyncRequest = Type.Object({
  evvDeviceId: Type.String({ format: "uuid" }),
  events: Type.Array(
    Type.Union([
      Type.Intersect([Type.Object({ kind: Type.Literal("check_in") }), CheckInRequest]),
      Type.Intersect([Type.Object({ kind: Type.Literal("check_out") }), CheckOutRequest]),
    ]),
    { minItems: 1, maxItems: 100 },
  ),
});

const OfflineCaptureBaseV2 = Type.Object({
  localId: Type.String({ format: "uuid" }),
  visitId: Type.String({ format: "uuid" }),
  capturedAt: Type.String({ format: "date-time" }),
  coords: Coords,
  accuracyM: Type.Number({ minimum: 0, maximum: 500 }),
  evvDeviceId: Type.String({ format: "uuid" }),
  offlineCapture: Type.Optional(Type.Literal(true)),
  gpsQualityAttested: Type.Optional(Type.Literal("degraded_attested")),
});

export const OfflineSyncV2Request = Type.Object(
  {
    evvDeviceId: Type.String({ format: "uuid" }),
    events: Type.Array(
      Type.Union([
        Type.Intersect([
          OfflineCaptureBaseV2,
          Type.Object({
            kind: Type.Literal("check_in"),
            serviceTypeCode: Type.String({ minLength: 1 }),
          }),
        ]),
        Type.Intersect([OfflineCaptureBaseV2, Type.Object({ kind: Type.Literal("check_out") })]),
      ]),
      { minItems: 1, maxItems: 100 },
    ),
  },
  { additionalProperties: false },
);

export const CorrectEventRequest = Type.Object({
  newEvent: Type.Union([CheckInRequest, CheckOutRequest]),
  correctionReason: Type.String({ minLength: 60 }),
});

// ── §4.2 missing-resolution bodies ────────────────────────────────────────────────────────────────────
export const ClinicianAttestResolutionRequest = Type.Object({
  reason: Type.String({ minLength: 40 }),
});

// No `stepUpAuthRefId` (F-068 §3). It was a REQUIRED uuid, and no caller could obtain one: the column it
// was meant to fill is annotated "M2 `step_up_session` (app-validated)" and there is no `step_up_session`
// table — the platform's step-up state is `session.last_step_up_at`, on a row whose `id` is `text`. No
// route anywhere returns a step-up assertion id, so satisfying the field meant inventing a uuid, and the
// route discarded it anyway. The step-up itself is unaffected: it is resolved server-side through
// `requestStepUpFresh` → M2's `SessionContextResolver`, which is the only reading that was ever real.
export const SupervisorOverrideResolutionRequest = Type.Object({
  reason: Type.String({ minLength: 60 }),
});

// ── §4.2 geofence-policy bodies ───────────────────────────────────────────────────────────────────────
export const EditTenantPolicyRequest = Type.Object({
  radiusM: Type.Integer({ minimum: 50, maximum: 1000 }),
  maxAccuracyM: Type.Integer({ minimum: 5, maximum: 100 }),
});

export const CreatePerAddressOverrideRequest = Type.Object({
  patientAddressId: Type.String({ format: "uuid" }),
  radiusM: Type.Integer({ minimum: 50, maximum: 1000 }),
  maxAccuracyM: Type.Integer({ minimum: 5, maximum: 100 }),
  overrideReason: Type.String({ minLength: 30 }),
});

// ── device bodies ─────────────────────────────────────────────────────────────────────────────────────
// No `attestationId` (F-068 §3), for the same reason and one more: it was required, unobtainable, and
// discarded — and a client-SUPPLIED attestation id would be the F-028 shape, an authorization-relevant
// fact taken unverified from the party being gated. The D8 binding of `evv_device.m2_device_attestation_id`
// to a real M2 `device_attestation` row (migration 0222) needs the attestation's id on `ResolvedActor`,
// which today carries only `{ valid, verifiedAt }`; until then the column keeps its minted placeholder and
// the gap is named at the write site rather than papered over with a field nobody can fill.
export const SelfRegisterDeviceRequest = Type.Object({
  platform: Type.Union([Type.Literal("ios"), Type.Literal("android")]),
  modelDescription: Type.String({ minLength: 1 }),
});
export const RejectDeviceRequest = Type.Object({ reason: Type.String({ minLength: 1 }) });
export const SuspendDeviceRequest = Type.Object({ reason: Type.String({ minLength: 1 }) });
export const RetireDeviceRequest = Type.Object({ reason: Type.Optional(Type.String()) });

// ── aggregator bodies ─────────────────────────────────────────────────────────────────────────────────
export const ResubmitSubmissionRequest = Type.Object({ reason: Type.Optional(Type.String()) });
export const CancelSubmissionRequest = Type.Object({ reason: Type.String({ minLength: 1 }) });

// ── params + queries ──────────────────────────────────────────────────────────────────────────────────
export const EventIdParams = Type.Object({ eventId: Type.String({ format: "uuid" }) });
export const VisitIdParams = Type.Object({ visitId: Type.String({ format: "uuid" }) });
export const IdParams = Type.Object({ id: Type.String({ format: "uuid" }) });
export const MembershipIdQuery = Type.Object({
  membership: Type.Optional(Type.String({ format: "uuid" })),
});
export const EventListQuery = Type.Object({
  visit: Type.Optional(Type.String({ format: "uuid" })),
  clinician: Type.Optional(Type.String({ format: "uuid" })),
  patient: Type.Optional(Type.String({ format: "uuid" })),
  from: Type.Optional(Type.String({ format: "date-time" })),
  to: Type.Optional(Type.String({ format: "date-time" })),
  gpsQuality: Type.Optional(Type.String()),
  kind: Type.Optional(Type.Union([Type.Literal("check_in"), Type.Literal("check_out")])),
  includeCoords: Type.Optional(Type.Boolean()),
});
export const EventGetQuery = Type.Object({ include: Type.Optional(Type.Literal("coords")) });
export const MissingResolutionListQuery = Type.Object({
  status: Type.Optional(Type.String()),
  visit: Type.Optional(Type.String({ format: "uuid" })),
});
export const AggregatorListQuery = Type.Object({
  stateCode: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
});
export const MetricsQuery = Type.Object({
  from: Type.String({ format: "date-time" }),
  to: Type.String({ format: "date-time" }),
  stateCode: Type.Optional(Type.String()),
});

// ── §4.1 read-response views (the coordinate-free projections the §5.1 read screens render via the typed
// client; M18-T07). Named `*View` and exported so scripts/openapi/enrichments.ts can type the GET responses
// from the SAME schemas without the OpenAPI scanner mistaking this for a route file. Every view is pinned to
// the shape the service actually returns by the compile-time `Conforms` aliases below, so a field added or
// renamed (or a wire enum widened to a bare `string`) breaks `bun run build` rather than drifting from the
// generated client. Wire enums are the narrow literal unions the service returns — a `Type.String()` here
// would be a silent lie (it types the client as `string` and hides a vocabulary that must stay pinned). ──────
const KindEnum = Type.Union([Type.Literal("check_in"), Type.Literal("check_out")]);
const GpsQualityEnum = Type.Union([
  Type.Literal("high"),
  Type.Literal("acceptable"),
  Type.Literal("degraded_attested"),
  Type.Literal("outside_geofence"),
  Type.Literal("no_geofence_baseline"),
  Type.Literal("suspected_spoof"),
]);
const DeviceStatusEnum = Type.Union([
  Type.Literal("pending_approval"),
  Type.Literal("approved"),
  Type.Literal("suspended"),
  Type.Literal("rejected"),
  Type.Literal("retired"),
]);
const MissingResolutionKindEnum = Type.Union([
  Type.Literal("missing_checkin"),
  Type.Literal("missing_checkout"),
  Type.Literal("outside_geofence_at_checkin"),
  Type.Literal("outside_geofence_at_checkout"),
  Type.Literal("device_integrity_failed_at_attempt"),
]);
const MissingResolutionStatusEnum = Type.Union([
  Type.Literal("open"),
  Type.Literal("closed_clinician_attested"),
  Type.Literal("closed_supervisor_override"),
  Type.Literal("closed_visit_voided"),
  Type.Literal("closed_documented_at_encounter"),
  Type.Literal("closed_system_checkout_received"),
]);
const AggregatorStatusEnum = Type.Union([
  Type.Literal("pending"),
  Type.Literal("queued"),
  Type.Literal("submitting"),
  Type.Literal("submitted"),
  Type.Literal("accepted"),
  Type.Literal("rejected"),
  Type.Literal("timeout"),
  Type.Literal("cancelled"),
]);
const BracketStateEnum = Type.Union([
  Type.Literal("present"),
  Type.Literal("missing_documented"),
  Type.Literal("missing_open"),
  Type.Literal("no_evv_path"),
]);
const GeofenceDecisionEnum = Type.Union([
  Type.Literal("pass"),
  Type.Literal("fail_distance"),
  Type.Literal("fail_accuracy"),
  Type.Literal("fail_no_baseline"),
]);

export const EvvEventView = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  visitId: Type.String(),
  patientId: Type.String(),
  kind: KindEnum,
  serviceTypeCode: Type.String(),
  postingMembershipId: Type.String(),
  postingDisciplineAtRecording: Type.String(),
  evvDeviceId: Type.String(),
  capturedAt: Type.String(),
  recordedAt: Type.String(),
  gpsQuality: GpsQualityEnum,
  offlineCapture: Type.Boolean(),
  replacesEventId: Type.Union([Type.String(), Type.Null()]),
  supersededByEventId: Type.Union([Type.String(), Type.Null()]),
});
export const EvvEventListResponse = Type.Array(EvvEventView);

export const EvvDeviceView = Type.Object({
  id: Type.String(),
  membershipId: Type.String(),
  platform: Type.Union([Type.Literal("ios"), Type.Literal("android")]),
  modelDescription: Type.String(),
  status: DeviceStatusEnum,
});
export const EvvDeviceListResponse = Type.Array(EvvDeviceView);

export const EvvGeofencePolicyView = Type.Object({
  tenant: Type.Object({ radiusM: Type.Number(), maxAccuracyM: Type.Number() }),
  perAddress: Type.Array(
    Type.Object({
      patientAddressId: Type.String(),
      radiusM: Type.Number(),
      maxAccuracyM: Type.Number(),
    }),
  ),
});

export const EvvMissingResolutionView = Type.Object({
  id: Type.String(),
  visitId: Type.String(),
  kind: MissingResolutionKindEnum,
  status: MissingResolutionStatusEnum,
  resolvedByMembershipId: Type.Union([Type.String(), Type.Null()]),
});
export const EvvMissingResolutionListResponse = Type.Array(EvvMissingResolutionView);

export const EvvAggregatorSubmissionView = Type.Object({
  id: Type.String(),
  visitId: Type.String(),
  stateCode: Type.String(),
  aggregatorVendor: Type.String(),
  status: AggregatorStatusEnum,
  aggregatorTransactionId: Type.Union([Type.String(), Type.Null()]),
  attemptCount: Type.Integer(),
});
export const EvvAggregatorSubmissionListResponse = Type.Array(EvvAggregatorSubmissionView);

export const EvvMetricsView = Type.Object({
  complianceRate: Type.Number(),
  lateCheckoutRate: Type.Number(),
  geofenceDeviationRate: Type.Number(),
  gpsSpoofingDetectedRate: Type.Number(),
  aggregatorSubmissionSuccessRate: Type.Number(),
});

// The capture verdict returned by check-in / check-out / correct (§4.7). The offline-sync batch returns one
// per event.
export const EvvCheckResultView = Type.Object({
  eventId: Type.String(),
  kind: KindEnum,
  gpsQuality: GpsQualityEnum,
  geofenceDecision: GeofenceDecisionEnum,
  visitStateAfterEvent: Type.Union([Type.String(), Type.Null()]),
});
export const EvvCheckResultListResponse = Type.Array(EvvCheckResultView);

const EvvOfflineAppliedResultView = Type.Object({
  localId: Type.String({ format: "uuid" }),
  status: Type.Union([Type.Literal("applied"), Type.Literal("already_applied")]),
  eventId: Type.String({ format: "uuid" }),
  kind: KindEnum,
  capturedAt: Type.String({ format: "date-time" }),
  gpsQuality: GpsQualityEnum,
  geofenceDecision: GeofenceDecisionEnum,
  visitStateAfterEvent: Type.Union([Type.String(), Type.Null()]),
});
const EvvOfflineFailureResultView = Type.Object({
  localId: Type.String({ format: "uuid" }),
  status: Type.Union([Type.Literal("rejected"), Type.Literal("retryable")]),
  code: Type.String(),
  correlationId: Type.String(),
});
export const EvvOfflineSyncV2Response = Type.Object({
  results: Type.Array(Type.Union([EvvOfflineAppliedResultView, EvvOfflineFailureResultView])),
  summary: Type.Object({
    applied: Type.Integer({ minimum: 0 }),
    alreadyApplied: Type.Integer({ minimum: 0 }),
    rejected: Type.Integer({ minimum: 0 }),
    retryable: Type.Integer({ minimum: 0 }),
  }),
});

// The bracket M8's EvvBracketResolver reads (mirrors the @chartwarden/types EvvBracketDto: nullable check-in /
// check-out events + the nested §4.3 EvvMissingResolutionDto, which carries `resolvedAt` the flat route view
// omits).
export const EvvBracketMissingResolutionView = Type.Object({
  id: Type.String(),
  visitId: Type.String(),
  kind: MissingResolutionKindEnum,
  status: MissingResolutionStatusEnum,
  resolvedByMembershipId: Type.Union([Type.String(), Type.Null()]),
  resolvedAt: Type.Union([Type.String(), Type.Null()]),
});
export const EvvBracketView = Type.Object({
  visitId: Type.String(),
  checkInEvent: Type.Union([EvvEventView, Type.Null()]),
  checkOutEvent: Type.Union([EvvEventView, Type.Null()]),
  bracketState: BracketStateEnum,
  missingResolution: Type.Union([EvvBracketMissingResolutionView, Type.Null()]),
});

// The coordinate-bearing last-known-location read (M20 field-safety live-awareness; D10, gated by
// `evv.location.read_team`).
export const EvvLocationView = Type.Object({
  membershipId: Type.String(),
  eventId: Type.String(),
  visitId: Type.String(),
  // GAP-032 — NULLABLE. The production service used to fill both with a hardcoded `0`, and a
  // non-nullable `number` gave a client no way to tell that from a genuine coordinate. Null now means
  // "the stored coordinate could not be recovered", which is a state a map UI must render differently.
  lat: Type.Union([Type.Number(), Type.Null()]),
  lng: Type.Union([Type.Number(), Type.Null()]),
  accuracyM: Type.Number(),
  capturedAt: Type.String(),
});
export const EvvLocationListResponse = Type.Array(EvvLocationView);

// The portal arrival surface (timestamps only, no coordinates; portal session class).
export const EvvArrivalView = Type.Object({
  visitId: Type.String(),
  arrivedAt: Type.Union([Type.String(), Type.Null()]),
  departedAt: Type.Union([Type.String(), Type.Null()]),
});

// Compile-time pins: `T` (what the schema publishes) must be assignable to `V` (what the service returns), so a
// view drift breaks the build rather than silently mistyping the generated client.
type Conforms<T extends V, V> = T;
type _EvvEvent = Conforms<Static<typeof EvvEventView>, EvvEventDto>;
type _EvvDevice = Conforms<Static<typeof EvvDeviceView>, ServiceDeviceView>;
type _EvvGeofencePolicy = Conforms<Static<typeof EvvGeofencePolicyView>, ServiceGeofencePolicyView>;
type _EvvMissingResolution = Conforms<
  Static<typeof EvvMissingResolutionView>,
  ServiceMissingResolutionView
>;
type _EvvAggregatorSubmission = Conforms<
  Static<typeof EvvAggregatorSubmissionView>,
  EvvAggregatorSubmissionDto
>;
type _EvvMetrics = Conforms<Static<typeof EvvMetricsView>, ServiceMetricsView>;
type _EvvCheckResult = Conforms<Static<typeof EvvCheckResultView>, ServiceCheckResultView>;
type _EvvBracket = Conforms<Static<typeof EvvBracketView>, EvvBracketDto>;
type _EvvLocation = Conforms<Static<typeof EvvLocationView>, ServiceLocationView>;
type _EvvArrival = Conforms<Static<typeof EvvArrivalView>, ServiceArrivalView>;

export type CheckInBody = Static<typeof CheckInRequest>;
export type CheckOutBody = Static<typeof CheckOutRequest>;

/** Validate `value` against `schema` → the M1 VALIDATION_FAILED envelope on the first error (M17 idiom; query
 * primitives are coerced via `Value.Convert`). */
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
