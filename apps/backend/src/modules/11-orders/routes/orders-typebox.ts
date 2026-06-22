// apps/backend/src/modules/11-orders/routes/orders-typebox.ts — M11-T06 TypeBox route schemas (§4.2).
// Named `*-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox
// import for a Drizzle one. Validation runs through TypeBox `Value` → M1's VALIDATION_FAILED envelope.
//
// The per-kind `data` payload is carried opaquely as `Type.Unknown()` at this boundary (the server
// discriminates on `kind` and validates against the per-kind TypeBox + the M38 terminology binding); the
// lifecycle-bearing envelope fields (kind / priority / signer / verbal-attestation / cosign-role /
// discontinuation reason) are pinned here so the route → pure `@wardenx/orders` machine flow is wired
// end-to-end. Unions mirror the canonical `@wardenx/types` order vocabularies (single source).
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ORDER_KINDS } from "@wardenx/types";
import { ValidationError } from "@wardenx/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));

/** The canonical §2.1 order-kind union, mirrored from @wardenx/types `ORDER_KINDS` (single source). */
const ORDER_KIND = lit(ORDER_KINDS);
/** The §2.1 dispatch priority. */
const PRIORITY = Type.Union([Type.Literal("routine"), Type.Literal("stat"), Type.Literal("asap")]);
/** The §4.2 cosigner-role vocabulary (RN case manager / clinical supervisor / medical director). */
const COSIGNER_ROLE = Type.Union([
  Type.Literal("rn_case_manager"),
  Type.Literal("clinical_supervisor"),
  Type.Literal("medical_director"),
]);
/** The §2.6 discontinuation-reason vocabulary accepted at the route boundary. */
const DISCONTINUE_REASON = Type.Union([
  Type.Literal("clinical_judgement"),
  Type.Literal("patient_request"),
  Type.Literal("adverse_event"),
  Type.Literal("level_of_care_change"),
]);
/** The §2.4 standing-order spawn cadence. */
const CADENCE = Type.Union([
  Type.Literal("daily"),
  Type.Literal("weekly"),
  Type.Literal("biweekly"),
  Type.Literal("monthly"),
  Type.Literal("prn"),
]);

// ── request bodies (§4.2) ───────────────────────────────────────────────────────────────────────────────
export const CreateOrderRequest = Type.Object({
  patientId: Type.String({ format: "uuid" }),
  admissionId: Type.String({ format: "uuid" }),
  kind: ORDER_KIND,
  /** The drafter's discipline (server discriminates the §2.1 author matrix; the ABAC predicate is authoritative). */
  drafterDiscipline: Type.String({ minLength: 1, maxLength: 64 }),
  data: Type.Unknown(), // server discriminates and validates against per-kind TypeBox + M38 terminology.
  priority: Type.Optional(PRIORITY),
  indicationText: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  orderingPhysicianMdmId: Type.String({ format: "uuid" }),
  sourceEncounterId: Type.Optional(Type.String({ format: "uuid" })),
  triggeringAssessmentId: Type.Optional(Type.String({ format: "uuid" })),
  triggeringHopeAssessmentId: Type.Optional(Type.String({ format: "uuid" })),
  replacesOrderId: Type.Optional(Type.String({ format: "uuid" })),
});

export const UpdateOrderRequest = Type.Object({
  data: Type.Unknown(),
  priority: Type.Optional(PRIORITY),
  indicationText: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
});

export const RequestSignatureRequest = Type.Object({
  signerDiscipline: Type.String({ minLength: 1, maxLength: 64 }),
  /** §2.5 axis 3 — the level-of-care transition (for `level_of_care_change` escalation-jump cosign). */
  levelChange: Type.Optional(
    Type.Object({
      fromLevel: Type.Union([Type.Literal("rhc"), Type.Literal("irc"), Type.Literal("chc"), Type.Literal("gip")]),
      toLevel: Type.Union([Type.Literal("rhc"), Type.Literal("irc"), Type.Literal("chc"), Type.Literal("gip")]),
    }),
  ),
});

export const SignOrderRequest = Type.Object({
  signerDiscipline: Type.String({ minLength: 1, maxLength: 64 }),
  signedAtClient: Type.String({ format: "date-time" }),
  signatureContext: Type.Optional(Type.Object({ reason: Type.Optional(Type.String({ maxLength: 2000 })) })),
});

export const SignOnBehalfRequest = Type.Object({
  signerDiscipline: Type.String({ minLength: 1, maxLength: 64 }),
  onBehalfOf: Type.String({ format: "uuid" }),
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
  signedAtClient: Type.String({ format: "date-time" }),
});

export const RecordVerbalRequest = Type.Object({
  recorderDiscipline: Type.String({ minLength: 1, maxLength: 64 }),
  verbalAttestation: Type.String({ minLength: 100, maxLength: 2000 }),
  receivedAt: Type.String({ format: "date-time" }),
  orderingPhysicianMdmId: Type.String({ format: "uuid" }),
});

export const CosignRequest = Type.Object({
  cosignerRole: COSIGNER_ROLE,
  attestationText: Type.String({ minLength: 50, maxLength: 1000 }),
});

export const DiscontinueRequest = Type.Object({
  reason: DISCONTINUE_REASON,
  effectiveAt: Type.String({ format: "date-time" }),
  notes: Type.Optional(Type.String({ maxLength: 2000 })),
});

export const CorrectOrderRequest = CreateOrderRequest;

export const CompleteOrderRequest = Type.Object({
  reason: Type.Optional(Type.String({ maxLength: 2000 })),
});

export const CreateStandingOrderRequest = Type.Object({
  patientId: Type.String({ format: "uuid" }),
  admissionId: Type.String({ format: "uuid" }),
  kind: ORDER_KIND,
  signerDiscipline: Type.String({ minLength: 1, maxLength: 64 }),
  cadence: CADENCE,
  data: Type.Unknown(),
  effectiveFrom: Type.Optional(Type.String({ format: "date-time" })),
  effectiveUntil: Type.Optional(Type.String({ format: "date-time" })),
  maxSpawns: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const UpdateStandingOrderRequest = Type.Object({
  data: Type.Optional(Type.Unknown()),
  effectiveUntil: Type.Optional(Type.String({ format: "date-time" })),
  maxSpawns: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const DiscontinueStandingOrderRequest = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
  alsoDiscontinueInstances: Type.Optional(Type.Boolean()),
});

export const SpawnStandingOrderRequest = Type.Object({
  contextNote: Type.Optional(Type.String({ maxLength: 2000 })),
});

export const VerbalPolicyRequest = Type.Object({
  windowHours: Type.Integer({ minimum: 1, maximum: 48 }),
  businessHoursOnly: Type.Optional(Type.Boolean()),
  lpnCosignRequiredKinds: Type.Optional(Type.Array(ORDER_KIND)),
  npCosignRequiredKinds: Type.Optional(Type.Array(ORDER_KIND)),
});

export const RegenerateVerbalTimerRequest = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
});

// ── params / query ──────────────────────────────────────────────────────────────────────────────────────
export const OrderParamsSchema = Type.Object({ id: Type.String({ format: "uuid" }) });
export const StandingOrderParamsSchema = Type.Object({ id: Type.String({ format: "uuid" }) });
export const PatientParamsSchema = Type.Object({ patientId: Type.String({ format: "uuid" }) });
export const VerbalTimerParamsSchema = Type.Object({ id: Type.String({ format: "uuid" }) });

export const OrderListQuerySchema = Type.Object({
  patientId: Type.Optional(Type.String({ format: "uuid" })),
  admissionId: Type.Optional(Type.String({ format: "uuid" })),
  kind: Type.Optional(ORDER_KIND),
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
