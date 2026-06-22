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
import { ValidationError } from "@wardenx/types";

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
  expectedAttestationId: Type.String({ format: "uuid" }),
  gpsQualityAttested: Type.Optional(Type.Literal("degraded_attested")),
});

export const CheckOutRequest = Type.Object({
  visitId: Type.String({ format: "uuid" }),
  capturedAt: Type.String({ format: "date-time" }),
  coords: Coords,
  accuracyM: Type.Number({ minimum: 0, maximum: 500 }),
  evvDeviceId: Type.String({ format: "uuid" }),
  offlineCapture: Type.Optional(Type.Boolean()),
  localId: Type.Optional(Type.String({ format: "uuid" })),
  expectedAttestationId: Type.String({ format: "uuid" }),
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

export const CorrectEventRequest = Type.Object({
  newEvent: Type.Union([CheckInRequest, CheckOutRequest]),
  correctionReason: Type.String({ minLength: 60 }),
});

// ── §4.2 missing-resolution bodies ────────────────────────────────────────────────────────────────────
export const ClinicianAttestResolutionRequest = Type.Object({
  reason: Type.String({ minLength: 40 }),
});

export const SupervisorOverrideResolutionRequest = Type.Object({
  reason: Type.String({ minLength: 60 }),
  stepUpAuthRefId: Type.String({ format: "uuid" }),
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
export const SelfRegisterDeviceRequest = Type.Object({
  platform: Type.Union([Type.Literal("ios"), Type.Literal("android")]),
  modelDescription: Type.String({ minLength: 1 }),
  attestationId: Type.String({ format: "uuid" }),
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
export const MembershipIdQuery = Type.Object({ membership: Type.Optional(Type.String({ format: "uuid" })) });
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
// from the SAME schemas without the OpenAPI scanner mistaking this for a route file. ──────────────────────────
export const EvvEventView = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  visitId: Type.String(),
  patientId: Type.String(),
  kind: Type.Union([Type.Literal("check_in"), Type.Literal("check_out")]),
  serviceTypeCode: Type.String(),
  postingMembershipId: Type.String(),
  postingDisciplineAtRecording: Type.String(),
  evvDeviceId: Type.String(),
  capturedAt: Type.String(),
  recordedAt: Type.String(),
  gpsQuality: Type.String(),
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
  status: Type.String(),
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
  kind: Type.String(),
  status: Type.String(),
  resolvedByMembershipId: Type.Union([Type.String(), Type.Null()]),
});
export const EvvMissingResolutionListResponse = Type.Array(EvvMissingResolutionView);

export const EvvAggregatorSubmissionView = Type.Object({
  id: Type.String(),
  visitId: Type.String(),
  stateCode: Type.String(),
  aggregatorVendor: Type.String(),
  status: Type.String(),
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
