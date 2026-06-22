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

// ── request bodies (§4.2) ───────────────────────────────────────────────────────────────────────────────
export const RecordAdministrationRequest = Type.Object({
  medicationOrderId: Type.String({ format: "uuid" }),
  medClass: MED_CLASS,
  mode: ADMINISTRATION_MODE,
  administeredAt: Type.String({ format: "date-time" }),
  scheduledDoseId: Type.Optional(Type.String({ format: "uuid" })),
  comfortKitDeploymentId: Type.Optional(Type.String({ format: "uuid" })),
  encounterId: Type.Optional(Type.String({ format: "uuid" })),
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
