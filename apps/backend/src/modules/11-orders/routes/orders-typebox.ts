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
import type { OrderKind } from "@wardenx/types";
import { ValidationError } from "@wardenx/types";
import type {
  OrderDetailView as ServiceOrderDetailView,
  OrderView as ServiceOrderView,
  StandingOrderView as ServiceStandingOrderView,
  VerbalPolicyView as ServiceVerbalPolicyView,
} from "./service";

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
      fromLevel: Type.Union([
        Type.Literal("rhc"),
        Type.Literal("irc"),
        Type.Literal("chc"),
        Type.Literal("gip"),
      ]),
      toLevel: Type.Union([
        Type.Literal("rhc"),
        Type.Literal("irc"),
        Type.Literal("chc"),
        Type.Literal("gip"),
      ]),
    }),
  ),
});

export const SignOrderRequest = Type.Object({
  signerDiscipline: Type.String({ minLength: 1, maxLength: 64 }),
  signedAtClient: Type.String({ format: "date-time" }),
  signatureContext: Type.Optional(
    Type.Object({ reason: Type.Optional(Type.String({ maxLength: 2000 })) }),
  ),
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
  /** M40 physician identity inherited by each active spawned M11 Order. */
  orderingPhysicianMdmId: Type.String({ format: "uuid" }),
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

// ── §4.2 RESPONSE DTOs (F0 enrichment) ─────────────────────────────────────────────────────────────
// The read routes return the service's view projections (OrderView / StandingOrderView / VerbalPolicyView
// + the `{ orders }` / `{ standingOrders }` / suggestions / spawn envelopes) but published NO response
// contract, so the generated client typed every GET/mutation body as `never`. These DTOs mirror the
// service views 1:1 and are pinned to them by the compile-time `Conforms` aliases below, so a view field
// added, renamed, or re-typed breaks `bun run build` rather than silently drifting from the client. The
// lifecycle enums are published as their canonical literal unions (never a lax `Type.String()`), so the
// wire vocabulary is honest; `transmissionStatus` / `resultsStatus` are `string` in the view itself.
const ORDER_STATUS = lit([
  "draft",
  "pending_signature",
  "verbal_pending",
  "active",
  "completed",
  "discontinued",
  "expired_unsigned",
] as const);
const ORDER_DISCONTINUATION_REASON = lit([
  "clinical_judgement",
  "patient_request",
  "adverse_event",
  "replaced_by_corrected_order",
  "admission_discharged",
  "level_of_care_change",
  "standing_order_discontinued",
  "corrected_replacement",
  "expired_verbal",
] as const);
const STANDING_ORDER_STATUS = lit(["active", "paused", "expired", "discontinued"] as const);
const nullableString = () => Type.Union([Type.String(), Type.Null()]);

/** Route 2 / mutation responses — the §2.2 D2 order view projection (never the raw Drizzle row). */
export const OrderViewResponseSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  admissionId: Type.String(),
  kind: ORDER_KIND,
  status: ORDER_STATUS,
  priority: PRIORITY,
  version: Type.Integer(),
  drafterMembershipId: Type.String(),
  drafterDiscipline: Type.String(),
  orderingPhysicianMdmId: Type.String(),
  cosignRequired: Type.Boolean(),
  cosignStatus: Type.Union([Type.Literal("pending"), Type.Literal("attached"), Type.Null()]),
  transmissionStatus: Type.String(),
  resultsStatus: Type.String(),
  verbalDeadlineAt: nullableString(),
  discontinuationReason: Type.Union([ORDER_DISCONTINUATION_REASON, Type.Null()]),
  replacesOrderId: nullableString(),
  triggeringAssessmentId: nullableString(),
  triggeringHopeAssessmentId: nullableString(),
  signedAt: nullableString(),
  signedBy: nullableString(),
  completedAt: nullableString(),
  createdAt: Type.String(),
});

/** Single-order detail only. List and work-queue reads deliberately omit clinical JSON payloads. */
export const OrderDetailResponseSchema = Type.Intersect([
  OrderViewResponseSchema,
  Type.Object({
    kindVersion: Type.String(),
    data: Type.Unknown(),
    requirements: Type.Array(
      Type.Object({
        code: Type.Union([
          Type.Literal("clinical_details"),
          Type.Literal("rn_cosignature"),
          Type.Literal("physician_signature"),
          Type.Literal("verbal_signature"),
        ]),
        label: Type.String(),
        status: Type.Union([
          Type.Literal("not_required"),
          Type.Literal("pending"),
          Type.Literal("satisfied"),
        ]),
        deadlineAt: Type.Optional(Type.String()),
      }),
    ),
    allowedActions: Type.Object({
      edit: Type.Boolean(),
      request_signature: Type.Boolean(),
      record_verbal: Type.Boolean(),
      sign: Type.Boolean(),
      cosign: Type.Boolean(),
      complete: Type.Boolean(),
      discontinue: Type.Boolean(),
      correct: Type.Boolean(),
    }),
  }),
]);

/** Route 19 / standing-order mutation responses — the §2.4 D5 standing-order view projection. */
export const StandingOrderViewResponseSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  admissionId: Type.String(),
  kind: ORDER_KIND,
  cadence: CADENCE,
  status: STANDING_ORDER_STATUS,
  nextSpawnAt: nullableString(),
  spawnCount: Type.Integer(),
  maxSpawns: Type.Union([Type.Integer(), Type.Null()]),
});

/** Routes 26 / 27 — the §2.3 D3 org verbal-order policy view. */
export const VerbalPolicyViewResponseSchema = Type.Object({
  windowHours: Type.Integer(),
  businessHoursOnly: Type.Boolean(),
  lpnCosignRequiredKinds: Type.Array(ORDER_KIND),
  npCosignRequiredKinds: Type.Array(ORDER_KIND),
  platformFloorWindowHours: Type.Integer(),
  policyVersion: Type.String(),
});

/** The `{ orders }` envelope the list / worklist reads return. */
export const OrderListResponseSchema = Type.Object({ orders: Type.Array(OrderViewResponseSchema) });
/** The `{ standingOrders }` envelope the standing-order list read returns. */
export const StandingOrderListResponseSchema = Type.Object({
  standingOrders: Type.Array(StandingOrderViewResponseSchema),
});
/** Route 17 — the derived §D7 suggestion banner. */
export const SuggestionsResponseSchema = Type.Object({
  patientId: Type.String(),
  suggestions: Type.Array(Type.Object({ kind: ORDER_KIND, reason: Type.String() })),
});
/** Route 25 — the PRN manual-spawn result (the newly-minted order id). */
export const SpawnResponseSchema = Type.Object({ orderId: Type.String() });

// Compile-time pins: `T` (what the schema publishes) must be assignable to `V` (what the service returns).
type Conforms<T extends V, V> = T;
type _OrderView = Conforms<Static<typeof OrderViewResponseSchema>, ServiceOrderView>;
type _OrderDetailView = Conforms<Static<typeof OrderDetailResponseSchema>, ServiceOrderDetailView>;
type _StandingOrderView = Conforms<
  Static<typeof StandingOrderViewResponseSchema>,
  ServiceStandingOrderView
>;
type _VerbalPolicyView = Conforms<
  Static<typeof VerbalPolicyViewResponseSchema>,
  ServiceVerbalPolicyView
>;
type _OrderList = Conforms<
  Static<typeof OrderListResponseSchema>,
  { readonly orders: readonly ServiceOrderView[] }
>;
type _StandingOrderList = Conforms<
  Static<typeof StandingOrderListResponseSchema>,
  { readonly standingOrders: readonly ServiceStandingOrderView[] }
>;
type _Suggestions = Conforms<
  Static<typeof SuggestionsResponseSchema>,
  {
    readonly patientId: string;
    readonly suggestions: ReadonlyArray<{ kind: OrderKind; reason: string }>;
  }
>;
type _Spawn = Conforms<Static<typeof SpawnResponseSchema>, { readonly orderId: string }>;

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
