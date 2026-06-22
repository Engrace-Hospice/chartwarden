// apps/backend/src/modules/12-dosespot/routes/dosespot-typebox.ts — M12-T08 TypeBox route schemas (§4.2).
// Named `*-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox import
// for a Drizzle one, and so the OpenAPI route scanner skips it. Validation runs through TypeBox `Value` →
// M1's VALIDATION_FAILED envelope (422). The per-class `data` payload is carried opaquely as `Type.Unknown()`
// at this boundary (the server discriminates on `medClass` and validates against the per-class TypeBox + the
// M38 RxNorm/NDC binding); the lifecycle-bearing envelope fields are pinned here.
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

/** §2.1 — the medication taxonomy (mirrors `MedClass`). */
const MED_CLASS = Type.Union([
  Type.Literal("standard"),
  Type.Literal("controlled_substance"),
  Type.Literal("compounded"),
]);
/** §2.4 — the DEA controlled-substance schedules. */
const DEA_SCHEDULE = Type.Union([
  Type.Literal("II"),
  Type.Literal("III"),
  Type.Literal("IV"),
  Type.Literal("V"),
]);
/** §2.4 §1311.116 — the EPCS second-factor type. */
const SECOND_FACTOR = Type.Union([
  Type.Literal("totp"),
  Type.Literal("passkey"),
  Type.Literal("push_confirm"),
]);
/** §2.7 — the refill-decision channel. */
const RESPONSE_CHANNEL = Type.Union([
  Type.Literal("electronic_via_dosespot"),
  Type.Literal("phone"),
  Type.Literal("fax"),
  Type.Literal("in_person"),
]);

// ── request bodies (§4.2) ───────────────────────────────────────────────────────────────────────────────
export const CreateMedicationOrderRequest = Type.Object({
  patientId: Type.String({ format: "uuid" }),
  admissionId: Type.String({ format: "uuid" }),
  medClass: MED_CLASS,
  rxnormRxcui: Type.Union([Type.String(), Type.Null()]),
  ndc: Type.Union([Type.String(), Type.Null()]),
  drugName: Type.String({ minLength: 1, maxLength: 200 }),
  strength: Type.String({ minLength: 1, maxLength: 100 }),
  doseForm: Type.String(),
  route: Type.String(),
  data: Type.Unknown(), // discriminated by medClass; per-class TypeBox + M38 binding applied server-side.
  /** The prescribing discipline (server discriminates the §2.1 author matrix; `prescriber_eligible` ABAC is authoritative). */
  prescriberDiscipline: Type.String({ minLength: 1, maxLength: 64 }),
  prescribingPhysicianMdmId: Type.String({ format: "uuid" }),
  dispensingPharmacyMdmId: Type.Optional(Type.String({ format: "uuid" })),
  deaSchedule: Type.Optional(DEA_SCHEDULE),
  containsControlled: Type.Optional(Type.Boolean()),
  refillsAuthorized: Type.Integer({ minimum: 0, maximum: 11 }),
});

export const UpdateMedicationOrderRequest = Type.Object({
  data: Type.Unknown(),
  drugName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  strength: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  refillsAuthorized: Type.Optional(Type.Integer({ minimum: 0, maximum: 11 })),
});

export const RequestSignatureRequest = Type.Object({
  signerDiscipline: Type.String({ minLength: 1, maxLength: 64 }),
});

export const SignMedicationOrderRequest = Type.Object({
  signerDiscipline: Type.String({ minLength: 1, maxLength: 64 }),
  signedAtClient: Type.String({ format: "date-time" }),
  /** §2.3 — true when the signer is the named ordering prescriber (required for the verbal follow-up sign). */
  signerIsOrderingPhysician: Type.Optional(Type.Boolean()),
});

export const SignControlledInitiateRequest = Type.Object({
  signerDiscipline: Type.String({ minLength: 1, maxLength: 64 }),
  schedule: DEA_SCHEDULE,
});

export const SignControlledCompleteRequest = Type.Object({
  nonce: Type.String({ minLength: 1 }),
  proof: Type.Object({
    factorType: SECOND_FACTOR,
    totpCode: Type.Optional(Type.String({ pattern: "^[0-9]{6}$" })),
    passkeyAssertion: Type.Optional(Type.Unknown()),
    pushConfirmReceipt: Type.Optional(Type.String()),
  }),
});

export const RecordVerbalRequest = Type.Object({
  recorderDiscipline: Type.String({ minLength: 1, maxLength: 64 }),
  verbalAttestation: Type.String({ minLength: 100, maxLength: 2000 }),
  receivedAt: Type.String({ format: "date-time" }),
  namedPrescriberMdmId: Type.String({ format: "uuid" }),
});

export const CosignRequest = Type.Object({
  cosignerRole: Type.Union([
    Type.Literal("rn_case_manager"),
    Type.Literal("clinical_supervisor"),
    Type.Literal("medical_director"),
  ]),
  attestationText: Type.String({ minLength: 50, maxLength: 1000 }),
});

export const DiscontinueRequest = Type.Object({
  reason: Type.Union([
    Type.Literal("clinical_judgement"),
    Type.Literal("patient_request"),
    Type.Literal("adverse_event"),
  ]),
  effectiveAt: Type.String({ format: "date-time" }),
  notes: Type.Optional(Type.String({ maxLength: 2000 })),
});

export const CompleteRequest = Type.Object({
  reason: Type.Optional(Type.String({ maxLength: 2000 })),
});

export const CorrectMedicationOrderRequest = CreateMedicationOrderRequest;

export const ApproveRefillRequest = Type.Object({
  refillsAuthorized: Type.Integer({ minimum: 0, maximum: 11 }),
  responseChannel: Type.Optional(RESPONSE_CHANNEL),
  notes: Type.Optional(Type.String({ maxLength: 2000 })),
});

export const DenyRefillRequest = Type.Object({
  denialReason: Type.String({ minLength: 10, maxLength: 1000 }),
  responseChannel: Type.Optional(RESPONSE_CHANNEL),
});

export const RxBenefitLookupRequest = Type.Object({
  patientId: Type.String({ format: "uuid" }),
  rxnormRxcui: Type.String({ minLength: 1 }),
});

export const HistoryRefreshRequest = Type.Object({});

export const ReconcileRequest = Type.Object({
  decision: Type.Union([
    Type.Literal("carry_forward"),
    Type.Literal("discontinue"),
    Type.Literal("document_only"),
  ]),
});

export const EnrollPrescriberRequest = Type.Object({
  deaAuthorizedSchedules: Type.Optional(Type.Array(DEA_SCHEDULE)),
});

export const RevokePrescriberRequest = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
});

export const RefillInboxPolicyRequest = Type.Object({
  slaWarnHours: Type.Optional(Type.Integer({ minimum: 1, maximum: 48 })),
  slaCriticalHours: Type.Optional(Type.Integer({ minimum: 1, maximum: 72 })),
});

export const ControlledSubstancePolicyRequest = Type.Object({
  scheduleIiiToVMaxRefills: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
});

// ── params / query ──────────────────────────────────────────────────────────────────────────────────────
export const OrderParamsSchema = Type.Object({ id: Type.String({ format: "uuid" }) });
export const RefillParamsSchema = Type.Object({ id: Type.String({ format: "uuid" }) });
export const HistoryRecordParamsSchema = Type.Object({ id: Type.String({ format: "uuid" }) });
export const PatientParamsSchema = Type.Object({ patientId: Type.String({ format: "uuid" }) });
export const MembershipParamsSchema = Type.Object({ membershipId: Type.String({ format: "uuid" }) });

export const MedicationOrderListQuerySchema = Type.Object({
  patientId: Type.Optional(Type.String({ format: "uuid" })),
  prescriberId: Type.Optional(Type.String({ format: "uuid" })),
  medClass: Type.Optional(MED_CLASS),
  status: Type.Optional(Type.String({ maxLength: 32 })),
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
