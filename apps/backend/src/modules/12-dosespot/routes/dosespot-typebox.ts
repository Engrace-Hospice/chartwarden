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
import type {
  ControlledSubstancePolicyView as ServiceControlledSubstancePolicyView,
  MedicationOrderView as ServiceMedicationOrderView,
  PrescriberRosterView as ServicePrescriberRosterView,
  RefillInboxPolicyView as ServiceRefillInboxPolicyView,
  RefillRequestView as ServiceRefillRequestView,
} from "./service";

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
export const MembershipParamsSchema = Type.Object({
  membershipId: Type.String({ format: "uuid" }),
});

export const MedicationOrderListQuerySchema = Type.Object({
  patientId: Type.Optional(Type.String({ format: "uuid" })),
  prescriberId: Type.Optional(Type.String({ format: "uuid" })),
  medClass: Type.Optional(MED_CLASS),
  status: Type.Optional(Type.String({ maxLength: 32 })),
});

// ── §4.2 RESPONSE DTOs (F0 enrichment) ─────────────────────────────────────────────────────────────
// The read/mutation routes returned typed service view shapes (`MedicationOrderView`, `RefillRequestView`,
// the policy/roster views, and the small result envelopes) but published NO response contract, so the
// generated client typed every body as `never`. These DTOs mirror the service views 1:1 and are pinned to
// them by the compile-time `Conforms` aliases below, so a view field added/renamed/retyped breaks
// `bun run build` rather than silently drifting from the client (a wire enum published as `Type.String()`
// is a silent lie: the enum-typed columns are published as their literal unions, never bare strings).
const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);

/** §2.2 — the medication-order lifecycle status (mirrors `MedicationOrderStatus`). */
const MED_ORDER_STATUS = Type.Union([
  Type.Literal("draft"),
  Type.Literal("pending_signature"),
  Type.Literal("verbal_pending"),
  Type.Literal("epcs_identity_pending"),
  Type.Literal("signed"),
  Type.Literal("queued_for_transmission"),
  Type.Literal("transmitted"),
  Type.Literal("ack_received"),
  Type.Literal("nack_received"),
  Type.Literal("active"),
  Type.Literal("completed"),
  Type.Literal("discontinued"),
  Type.Literal("transmission_failed"),
  Type.Literal("expired_unsigned"),
]);
/** §2.2 / §2.12 — the discontinuation reasons (mirrors `MedicationOrderDiscontinuationReason`). */
const DISCONTINUATION_REASON = Type.Union([
  Type.Literal("clinical_judgement"),
  Type.Literal("patient_request"),
  Type.Literal("adverse_event"),
  Type.Literal("replaced_by_corrected_order"),
  Type.Literal("admission_discharged"),
  Type.Literal("pharmacy_nack"),
  Type.Literal("corrected_replacement"),
  Type.Literal("expired_verbal"),
  Type.Literal("transmission_failed"),
  Type.Literal("no_refills_no_renewal"),
]);
/** §2.7 — the refill-inbox lifecycle status (mirrors `RefillRequestStatus`). */
const REFILL_STATUS = Type.Union([
  Type.Literal("pending"),
  Type.Literal("approved"),
  Type.Literal("denied"),
  Type.Literal("expired"),
]);

/** The medication-order read projection (routes 2–14, 16 rows). */
export const MedicationOrderResponseSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  admissionId: Type.String(),
  medClass: MED_CLASS,
  status: MED_ORDER_STATUS,
  drugName: Type.String(),
  strength: Type.String(),
  doseForm: Type.String(),
  route: Type.String(),
  rxnormRxcui: Nullable(Type.String()),
  ndc: Nullable(Type.String()),
  version: Type.Integer(),
  prescriberMembershipId: Type.String(),
  prescriberDiscipline: Type.String(),
  prescribingPhysicianMdmId: Type.String(),
  dispensingPharmacyMdmId: Nullable(Type.String()),
  isControlledSubstance: Type.Boolean(),
  deaSchedule: Nullable(DEA_SCHEDULE),
  cosignRequired: Type.Boolean(),
  cosignStatus: Nullable(Type.Union([Type.Literal("pending"), Type.Literal("attached")])),
  refillsRemaining: Type.Integer(),
  derivedFromRefillId: Nullable(Type.String()),
  replacesMedicationOrderId: Nullable(Type.String()),
  signedAt: Nullable(Type.String()),
  signedBy: Nullable(Type.String()),
  transmittedAt: Nullable(Type.String()),
  discontinuedAt: Nullable(Type.String()),
  discontinuationReason: Nullable(DISCONTINUATION_REASON),
  createdAt: Type.String(),
});
/** The `{ orders }` envelope the list + active-medications reads return. */
export const MedicationOrderListResponseSchema = Type.Object({
  orders: Type.Array(MedicationOrderResponseSchema),
});

/** The refill-request read projection (routes 20–21). */
export const RefillRequestResponseSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  sourceMedicationOrderId: Type.String(),
  status: REFILL_STATUS,
  requestedAt: Type.String(),
  prescriberMembershipId: Nullable(Type.String()),
  resultingMedicationOrderId: Nullable(Type.String()),
});
/** The `{ refills }` envelope the refill-inbox list returns. */
export const RefillListResponseSchema = Type.Object({
  refills: Type.Array(RefillRequestResponseSchema),
});

/** The prescriber-roster read projection (routes 25–26). */
export const PrescriberRosterResponseSchema = Type.Object({
  membershipId: Type.String(),
  enrolled: Type.Boolean(),
  deaAuthorizedSchedules: Type.Array(DEA_SCHEDULE),
  ial2Status: Type.String(),
});
/** The `{ prescribers }` envelope the roster list returns. */
export const PrescriberRosterListResponseSchema = Type.Object({
  prescribers: Type.Array(PrescriberRosterResponseSchema),
});

/** The refill-inbox SLA policy view (routes 28–29). */
export const RefillInboxPolicyResponseSchema = Type.Object({
  slaWarnHours: Type.Integer(),
  slaCriticalHours: Type.Integer(),
  platformFloorWarnHours: Type.Integer(),
  platformFloorCriticalHours: Type.Integer(),
});

/** The controlled-substance refill policy view (routes 30–31). */
export const ControlledSubstancePolicyResponseSchema = Type.Object({
  scheduleIiMaxRefills: Type.Integer(),
  scheduleIiiToVMaxRefills: Type.Integer(),
  epcsCertificationStatus: Type.String(),
});

/** Route 7 — the EPCS 2FA challenge nonce the controlled-sign initiate mints. */
export const SignControlledInitiateResponseSchema = Type.Object({
  nonce: Type.String(),
  expiresAt: Type.String(),
  requiredFactor: SECOND_FACTOR,
});

/** Routes 13/14 — the minted corrected/retransmitted order id. */
export const NewOrderIdResponseSchema = Type.Object({ newOrderId: Type.String() });

/** Route 15 — the DoseSpot transmission status + retry history. */
export const TransmissionResponseSchema = Type.Object({
  orderId: Type.String(),
  status: Type.String(),
  retryHistory: Type.Array(
    Type.Object({
      attempt: Type.Integer(),
      at: Type.String(),
      errorClass: Nullable(Type.String()),
    }),
  ),
});

/** Route 17 — the reconciled medication-history list. */
export const MedicationHistoryResponseSchema = Type.Object({
  records: Type.Array(
    Type.Object({ id: Type.String(), drugName: Type.String(), source: Type.String() }),
  ),
});

/** Route 18 — the enqueued MedHx-refresh job handle. */
export const HistoryRefreshResponseSchema = Type.Object({ jobId: Type.String() });

/** Route 19 — the (optional) order minted by a carry-forward reconciliation. */
export const ReconcileResponseSchema = Type.Object({ resultingOrderId: Nullable(Type.String()) });

/** Route 22 — the medication order minted by an approved refill. */
export const ResultingOrderIdResponseSchema = Type.Object({ resultingOrderId: Type.String() });

/** Route 23 — the refill-deny acknowledgment. */
export const DenyRefillResponseSchema = Type.Object({ status: Type.Literal("denied") });

/** Route 24 — the cached RxBenefit coverage lookup. */
export const RxBenefitResponseSchema = Type.Object({
  covered: Type.Boolean(),
  copayCents: Nullable(Type.Integer()),
});

/** Route 27 — the prescriber-revoke acknowledgment. */
export const RevokePrescriberResponseSchema = Type.Object({ status: Type.Literal("revoked") });

// Compile-time pins: `T` (what the schema publishes) must be assignable to `V` (what the service returns).
type Conforms<T extends V, V> = T;
type _MedOrder = Conforms<Static<typeof MedicationOrderResponseSchema>, ServiceMedicationOrderView>;
type _MedOrderList = Conforms<
  Static<typeof MedicationOrderListResponseSchema>,
  { readonly orders: readonly ServiceMedicationOrderView[] }
>;
type _Refill = Conforms<Static<typeof RefillRequestResponseSchema>, ServiceRefillRequestView>;
type _RefillList = Conforms<
  Static<typeof RefillListResponseSchema>,
  { readonly refills: readonly ServiceRefillRequestView[] }
>;
type _Roster = Conforms<Static<typeof PrescriberRosterResponseSchema>, ServicePrescriberRosterView>;
type _RosterList = Conforms<
  Static<typeof PrescriberRosterListResponseSchema>,
  { readonly prescribers: readonly ServicePrescriberRosterView[] }
>;
type _RefillPolicy = Conforms<
  Static<typeof RefillInboxPolicyResponseSchema>,
  ServiceRefillInboxPolicyView
>;
type _CsPolicy = Conforms<
  Static<typeof ControlledSubstancePolicyResponseSchema>,
  ServiceControlledSubstancePolicyView
>;
type _Initiate = Conforms<
  Static<typeof SignControlledInitiateResponseSchema>,
  { nonce: string; expiresAt: string; requiredFactor: "totp" | "passkey" | "push_confirm" }
>;
type _NewOrder = Conforms<Static<typeof NewOrderIdResponseSchema>, { newOrderId: string }>;
type _Transmission = Conforms<
  Static<typeof TransmissionResponseSchema>,
  {
    orderId: string;
    status: string;
    retryHistory: ReadonlyArray<{ attempt: number; at: string; errorClass: string | null }>;
  }
>;
type _MedHistory = Conforms<
  Static<typeof MedicationHistoryResponseSchema>,
  { records: ReadonlyArray<{ id: string; drugName: string; source: string }> }
>;
type _Refresh = Conforms<Static<typeof HistoryRefreshResponseSchema>, { jobId: string }>;
type _Reconcile = Conforms<
  Static<typeof ReconcileResponseSchema>,
  { resultingOrderId: string | null }
>;
type _Resulting = Conforms<
  Static<typeof ResultingOrderIdResponseSchema>,
  { resultingOrderId: string }
>;
type _DenyRefill = Conforms<Static<typeof DenyRefillResponseSchema>, { status: "denied" }>;
type _RxBenefit = Conforms<
  Static<typeof RxBenefitResponseSchema>,
  { covered: boolean; copayCents: number | null }
>;
type _Revoke = Conforms<Static<typeof RevokePrescriberResponseSchema>, { status: "revoked" }>;

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
