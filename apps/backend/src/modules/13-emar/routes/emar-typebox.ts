// apps/backend/src/modules/13-emar/routes/emar-typebox.ts — M13-T08 TypeBox route schemas (§4.2).
// Named `*-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox import
// for a Drizzle one, and so the OpenAPI route scanner skips it. Validation runs through TypeBox `Value` →
// M1's VALIDATION_FAILED envelope (422). The per-mode `data` payload is carried opaquely as `Type.Unknown()`
// at this boundary (the server discriminates on `mode` and validates against the per-mode TypeBox); the
// lifecycle-bearing envelope fields are pinned here. `medClass` rides the record/refusal bodies so the route's
// `administering_clinician_eligible[:medClass]` ABAC floor resolves at authz time (the service re-verifies it
// against M12's `getAdministrationContext`).
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";
import type {
  AdministrationPolicyView as ServiceAdministrationPolicyView,
  AdministrationView as ServiceAdministrationView,
  DeploymentView as ServiceDeploymentView,
  EmarRouteService as ServiceEmarRouteService,
  IvSessionView as ServiceIvSessionView,
  MissedDoseView as ServiceMissedDoseView,
  ReconciliationDecisionView as ServiceReconciliationDecisionView,
  ScheduledDoseView as ServiceScheduledDoseView,
  WorksheetView as ServiceWorksheetView,
} from "./service";

/** Literal-union helper — a response enum field mirrors the §3.2 pgEnum union (not a bare `Type.String()`,
 * which the M30 read-DTO lesson flagged as a "silent lie" that lets the wire vocab drift from the view). */
const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}

/** §2.1 — the administration mode discriminator (mirrors `AdministrationMode`). */
const ADMINISTRATION_MODE = Type.Union([
  Type.Literal("single_dose"),
  Type.Literal("iv_continuous_start"),
  Type.Literal("iv_continuous_rate_change"),
  Type.Literal("iv_continuous_pause"),
  Type.Literal("iv_continuous_resume"),
  Type.Literal("iv_continuous_stop"),
]);
/** The medication-class taxonomy (mirrors M12's `MedClass`) — carried for the §4.7 ABAC floor at the route. */
const MED_CLASS = Type.Union([
  Type.Literal("standard"),
  Type.Literal("controlled_substance"),
  Type.Literal("compounded"),
]);
const PRN_REQUESTED_BY = Type.Union([
  Type.Literal("clinician_observed"),
  Type.Literal("patient_request"),
  Type.Literal("caregiver_request"),
  Type.Literal("scheduled_reassessment_protocol"),
]);

/** §2.9 BCMA — the optional bedside scan (camera plugin); the server re-derives the canonical `matchResult`. */
const BARCODE_SCAN = Type.Object({
  scannedNdc: Type.Optional(Type.String({ maxLength: 64 })),
  scannedRxnormRxcui: Type.Optional(Type.String({ maxLength: 64 })),
  scannedLotNumber: Type.Optional(Type.String({ maxLength: 64 })),
  scannedExpirationDate: Type.Optional(Type.String({ maxLength: 10 })),
  patientWristbandPayloadDigest: Type.Optional(Type.String({ maxLength: 128 })),
});

// ── request bodies (§4.2) ───────────────────────────────────────────────────────────────────────────────
export const RecordAdministrationRequest = Type.Object({
  medicationOrderId: Type.String({ format: "uuid" }),
  medClass: MED_CLASS,
  mode: ADMINISTRATION_MODE,
  administeredAt: Type.String({ format: "date-time" }),
  scheduledDoseId: Type.Optional(Type.String({ format: "uuid" })),
  comfortKitDeploymentId: Type.Optional(Type.String({ format: "uuid" })),
  encounterId: Type.Optional(Type.String({ format: "uuid" })),
  /** §2.11 D11 — REQUIRED for `rate_change`/`pause`/`resume`/`stop` (they continue a session); REFUSED
   *  for `iv_continuous_start`, which mints one and returns it on the recorded row. */
  ivSessionId: Type.Optional(Type.String({ format: "uuid" })),
  data: Type.Unknown(),
  prn: Type.Optional(
    Type.Object({
      triggeringPrnReason: Type.String({ minLength: 1, maxLength: 1000 }),
      requestedByKind: PRN_REQUESTED_BY,
      triggeringAssessmentId: Type.Optional(Type.String({ format: "uuid" })),
      intervalOverride: Type.Optional(
        Type.Object({ reason: Type.String({ minLength: 40, maxLength: 1000 }) }),
      ),
    }),
  ),
  lateEntryReason: Type.Optional(Type.String({ minLength: 20, maxLength: 1000 })),
  offlineCapture: Type.Optional(
    Type.Object({
      deviceId: Type.String({ format: "uuid" }),
      localId: Type.String({ format: "uuid" }),
      capturedAt: Type.String({ format: "date-time" }),
    }),
  ),
  barcodeScan: Type.Optional(BARCODE_SCAN),
  notes: Type.Optional(Type.String({ maxLength: 2000 })),
});

export const RecordCaregiverAttestedRequest = Type.Object({
  patientId: Type.String({ format: "uuid" }),
  medicationOrderId: Type.String({ format: "uuid" }),
  administeredAt: Type.String({ format: "date-time" }),
  administeredAmount: Type.Number({ minimum: 0.0001, maximum: 10000 }),
  administeredUnit: Type.String({ maxLength: 32 }),
  route: Type.String({ maxLength: 64 }),
  caregiverAttestationText: Type.String({ minLength: 1, maxLength: 1000 }),
  barcodeScan: Type.Optional(BARCODE_SCAN),
  notes: Type.Optional(Type.String({ maxLength: 2000 })),
});

export const WitnessAttestRequest = Type.Object({
  patientId: Type.String({ format: "uuid" }),
  medicationOrderId: Type.String({ format: "uuid" }),
  administeringClinicianMembershipId: Type.String({ format: "uuid" }),
  attestationText: Type.String({ minLength: 1, maxLength: 500 }),
});

export const AcknowledgeCaregiverRequest = Type.Object({
  note: Type.Optional(Type.String({ maxLength: 1000 })),
});
export const DisputeCaregiverRequest = Type.Object({
  disputeReason: Type.String({ minLength: 1, maxLength: 1000 }),
});
export const CorrectAdministrationRequest = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
  administeredAt: Type.Optional(Type.String({ format: "date-time" })),
  data: Type.Optional(Type.Unknown()),
  notes: Type.Optional(Type.String({ maxLength: 2000 })),
});
export const VoidAdministrationRequest = Type.Object({
  voidReason: Type.String({ minLength: 1, maxLength: 1000 }),
});
export const RecordRefusalRequest = Type.Object({
  patientId: Type.String({ format: "uuid" }),
  medicationOrderId: Type.String({ format: "uuid" }),
  medClass: MED_CLASS,
  scheduledDoseId: Type.Optional(Type.String({ format: "uuid" })),
  refusedAt: Type.String({ format: "date-time" }),
  refusalReason: Type.Optional(Type.String({ maxLength: 1000 })),
});
export const OfflineSyncRequest = Type.Object({
  rows: Type.Array(RecordAdministrationRequest, { minItems: 1, maxItems: 500 }),
});
export const IntentionalHoldRequest = Type.Object({
  reason: Type.Optional(Type.String({ maxLength: 1000 })),
});
export const RecordDecisionRequest = Type.Object({
  lineKind: Type.String({ minLength: 1, maxLength: 64 }),
  sourceId: Type.String({ minLength: 1, maxLength: 128 }),
  decision: Type.Union([
    Type.Literal("carry_forward"),
    Type.Literal("discontinue"),
    Type.Literal("hold"),
    Type.Literal("new_order"),
    Type.Literal("document_only"),
  ]),
  decisionNotes: Type.Optional(Type.String({ maxLength: 1000 })),
});
export const UpdateDecisionRequest = Type.Object({
  decision: Type.Union([
    Type.Literal("carry_forward"),
    Type.Literal("discontinue"),
    Type.Literal("hold"),
    Type.Literal("new_order"),
    Type.Literal("document_only"),
  ]),
  decisionNotes: Type.Optional(Type.String({ maxLength: 1000 })),
  /**
   * §2.8 D17 — the M12 draft this decision produced ("send to prescriber"). The column
   * `medication_reconciliation_decision.resulting_medication_order_id` has existed since M13-T02 and
   * nothing ever wrote it, so a reconciliation that CREATED an order kept no link to it and the
   * worksheet could not show which lines had been actioned. Written here rather than through a new
   * route: linking IS an update to the decision, and the M12 draft itself is minted by the caller
   * against M12's own `POST /api/v1/medication-orders` — M13 does not write another module's table.
   */
  resultingMedicationOrderId: Type.Optional(Type.String({ format: "uuid" })),
});
export const AddCaregiverReportedLineRequest = Type.Object({
  drugName: Type.String({ minLength: 1, maxLength: 200 }),
  reportedDose: Type.Optional(Type.String({ maxLength: 100 })),
  reportedRoute: Type.Optional(Type.String({ maxLength: 64 })),
});
export const FinalizeReconciliationRequest = Type.Object({
  attestation: Type.String({ minLength: 1, maxLength: 500 }),
});
export const VoidReconciliationRequest = Type.Object({
  voidReason: Type.String({ minLength: 1, maxLength: 1000 }),
});
export const AcknowledgeReturnRequest = Type.Object({
  note: Type.Optional(Type.String({ maxLength: 1000 })),
});
export const AdministrationPolicyRequest = Type.Object({
  graceWindowMinutes: Type.Optional(Type.Integer({ minimum: 0, maximum: 1440 })),
  prnMinimumIntervalMinutes: Type.Optional(Type.Integer({ minimum: 0, maximum: 1440 })),
  emarPdfOnCommit: Type.Optional(Type.Boolean()),
});

// ── params + queries ────────────────────────────────────────────────────────────────────────────────────
export const IdParamsSchema = Type.Object({ id: Type.String({ format: "uuid" }) });
export const SessionParamsSchema = Type.Object({ sessionId: Type.String({ format: "uuid" }) });
export const DecisionLineParamsSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  lineId: Type.String({ minLength: 1, maxLength: 128 }),
});
export const AdministrationListQuerySchema = Type.Object({
  patient: Type.String({ format: "uuid" }),
  since: Type.Optional(Type.String({ format: "date-time" })),
  until: Type.Optional(Type.String({ format: "date-time" })),
});
export const ScheduledDoseQuerySchema = Type.Object({
  patient: Type.String({ format: "uuid" }),
  from: Type.Optional(Type.String({ format: "date-time" })),
  to: Type.Optional(Type.String({ format: "date-time" })),
});
export const MissedDoseQuerySchema = Type.Object({
  patient: Type.String({ format: "uuid" }),
  since: Type.Optional(Type.String({ format: "date-time" })),
});
export const WorksheetQuerySchema = Type.Object({
  patient: Type.String({ format: "uuid" }),
});
export const DeploymentQuerySchema = Type.Object({
  patient: Type.String({ format: "uuid" }),
});

// ── read responses (§4.1 / §6.1; M13-T10 Track-B screens) ───────────────────────────────────────────────
// The GET/mutation handlers return the service view DTOs (apps/backend/.../routes/service.ts), not route-level
// TypeBox. These schemas mirror those views 1:1 so the generated client (`packages/ui/src/core/api`) types the
// read surfaces, and each is pinned to its service view by a compile-time `Conforms` alias below — a view field
// added, renamed, or retyped breaks `bun run build` rather than silently drifting from the client. Enum-bearing
// fields publish the §3.2 pgEnum literal union (via `lit`), not a bare `Type.String()`. `null`-able row fields
// use the explicit `<T>|null` union. The server stays authoritative for the §2.2 lifecycle, the §2.5 late-entry
// tier, and the §2.9 BCMA match result.
const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);

// §3.2 pgEnum value mirrors (kept in lock-step with `@wardenx/types` / `@wardenx/emar`).
const ADMINISTRATION_STATUS = lit([
  "committed",
  "pending_caregiver_review",
  "superseded",
  "voided",
] as const);
const ADMINISTRATION_ACTOR_KIND = lit([
  "clinician",
  "caregiver_attested",
  "system_iv_session_event",
] as const);
const ADMINISTRATION_LATE_ENTRY_TIER = lit([
  "normal",
  "late",
  "significant_late",
  "administrative_override",
] as const);
const BARCODE_MATCH_RESULT = lit([
  "match",
  "wrong_drug",
  "wrong_patient",
  "expired",
  "no_order_active",
] as const);
const SCHEDULED_DOSE_STATUS = lit([
  "pending",
  "administered",
  "missed",
  "cancelled",
  "intentionally_held",
] as const);
const RECONCILIATION_DECISION_KIND = lit([
  "carry_forward",
  "discontinue",
  "hold",
  "new_order",
  "document_only",
] as const);
const RECONCILIATION_TRIGGER_KIND = lit([
  "admission",
  "transfer_in",
  "discharge",
  "recertification",
] as const);
const RECONCILIATION_WORKSHEET_STATUS = lit([
  "pending",
  "in_progress",
  "finalized",
  "voided",
] as const);

export const AdministrationViewSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  admissionId: Type.String(),
  medicationOrderId: Type.String(),
  mode: ADMINISTRATION_MODE,
  status: ADMINISTRATION_STATUS,
  actorKind: ADMINISTRATION_ACTOR_KIND,
  administeredAt: Type.String(),
  recordedAt: Type.String(),
  lateEntryTier: ADMINISTRATION_LATE_ENTRY_TIER,
  administeringClinicianMembershipId: Nullable(Type.String()),
  witnessMembershipId: Nullable(Type.String()),
  encounterId: Nullable(Type.String()),
  scheduledDoseId: Nullable(Type.String()),
  comfortKitDeploymentId: Nullable(Type.String()),
  ivSessionId: Nullable(Type.String()),
  isControlledSubstance: Type.Boolean(),
  isComfortKitDrawdown: Type.Boolean(),
  requiresRnReview: Type.Boolean(),
  supersededById: Nullable(Type.String()),
  barcodeMatchResult: Nullable(BARCODE_MATCH_RESULT),
});
export const AdministrationListResponseSchema = Type.Array(AdministrationViewSchema);

export const ScheduledDoseViewSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  medicationOrderId: Type.String(),
  dueAt: Type.String(),
  status: SCHEDULED_DOSE_STATUS,
});
export const ScheduledDoseListResponseSchema = Type.Array(ScheduledDoseViewSchema);

export const MissedDoseViewSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  scheduledDoseId: Type.String(),
  medicationOrderId: Type.String(),
  dueAt: Type.String(),
  acknowledgedAt: Nullable(Type.String()),
});
export const MissedDoseListResponseSchema = Type.Array(MissedDoseViewSchema);

const ReconciliationDecisionViewSchema = Type.Object({
  lineId: Type.String(),
  lineKind: Type.String(),
  sourceId: Type.String(),
  decision: RECONCILIATION_DECISION_KIND,
  /** The M12 draft this decision produced, once one has been sent to the prescriber. */
  resultingMedicationOrderId: Nullable(Type.String()),
});
export const WorksheetViewSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  admissionId: Type.String(),
  triggerKind: RECONCILIATION_TRIGGER_KIND,
  status: RECONCILIATION_WORKSHEET_STATUS,
  lineCount: Type.Integer(),
  decisions: Type.Array(ReconciliationDecisionViewSchema),
});
export const WorksheetListResponseSchema = Type.Array(WorksheetViewSchema);

export const DeploymentViewSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  admissionId: Type.String(),
  disposalStatus: Type.String(),
});
export const DeploymentListResponseSchema = Type.Array(DeploymentViewSchema);

export const IvSessionViewSchema = Type.Object({
  sessionId: Type.String(),
  medicationOrderId: Type.String(),
  startedAt: Type.String(),
  endedAt: Nullable(Type.String()),
  /** §2.11 — the derived session state, so a client can offer only the segments the graph accepts next. */
  state: lit(["none", "running", "paused", "stopped"] as const),
  segments: Type.Array(
    Type.Object({
      kind: ADMINISTRATION_MODE,
      recordedAt: Type.String(),
      rate: Nullable(Type.Number()),
      rateUnit: Nullable(Type.String()),
    }),
  ),
});

export const AdministrationPolicyViewSchema = Type.Object({
  graceWindowMinutes: Type.Integer(),
  prnMinimumIntervalMinutes: Type.Integer(),
  emarPdfOnCommit: Type.Boolean(),
});

/** The §2.6 D7 witness-attestation token the mint route returns. The token is a SERVER-MINTED, single-use
 * bearer credential (check-request-header-auth.ts classifies `x-witness-attestation` as `verified` on that
 * basis) with a 60-second life, so the administering clinician's device has to receive it out of band and
 * spend it immediately — publishing the shape is what lets a client show the witness what to relay and how
 * long they have, instead of a caller guessing at an undeclared body. */
export const WitnessTokenResponseSchema = Type.Object({
  token: Type.String(),
  expiresInSeconds: Type.Integer(),
});

/** §2.10 D18 — the offline-queue drain receipt: how many rows committed, and each committed row. */
export const OfflineSyncResponseSchema = Type.Object({
  synced: Type.Integer(),
  results: Type.Array(AdministrationViewSchema),
});

// ── compile-time pins: what each schema PUBLISHES (`T`) must be assignable to what the service RETURNS (`V`),
// so a view field added/renamed/retyped fails the build instead of drifting from the generated client. ────────
type Conforms<T extends V, V> = T;
type _AdministrationView = Conforms<
  Static<typeof AdministrationViewSchema>,
  ServiceAdministrationView
>;
type _ScheduledDoseView = Conforms<
  Static<typeof ScheduledDoseViewSchema>,
  ServiceScheduledDoseView
>;
type _MissedDoseView = Conforms<Static<typeof MissedDoseViewSchema>, ServiceMissedDoseView>;
type _ReconciliationDecisionView = Conforms<
  Static<typeof ReconciliationDecisionViewSchema>,
  ServiceReconciliationDecisionView
>;
type _WorksheetView = Conforms<Static<typeof WorksheetViewSchema>, ServiceWorksheetView>;
type _DeploymentView = Conforms<Static<typeof DeploymentViewSchema>, ServiceDeploymentView>;
type _IvSessionView = Conforms<Static<typeof IvSessionViewSchema>, ServiceIvSessionView>;
type _AdministrationPolicyView = Conforms<
  Static<typeof AdministrationPolicyViewSchema>,
  ServiceAdministrationPolicyView
>;
type _WitnessTokenResponse = Conforms<
  Static<typeof WitnessTokenResponseSchema>,
  Awaited<ReturnType<ServiceEmarRouteService["mintWitnessToken"]>>
>;
type _OfflineSyncResponse = Conforms<
  Static<typeof OfflineSyncResponseSchema>,
  Awaited<ReturnType<ServiceEmarRouteService["offlineSync"]>>
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
