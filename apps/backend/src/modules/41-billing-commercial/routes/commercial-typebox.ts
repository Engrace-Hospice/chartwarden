// apps/backend/src/modules/41-billing-commercial/routes/commercial-typebox.ts — M41 request/response schemas (issue #722).
// Named `*-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox import for a Drizzle one.
// Org / actor / membership binding is ALWAYS server-side (request.context): no body or query carries an org id or an acting
// membership id. Responses carry ids, dates, codes, money and rule messages only - never a member id, MBI or authorization number.
import {
  COMMERCIAL_AUTHORIZATION_STATUS_VALUES,
  COMMERCIAL_CLAIM_STATE_VALUES,
  COMMERCIAL_HOSPICE_LEVEL_OF_CARE_VALUES,
  COMMERCIAL_OVERRIDE_REASON_MIN_LENGTH,
  COMMERCIAL_SUBMISSION_STATUS_VALUES,
} from "@chartwarden/types";
import { type Static, Type } from "@sinclair/typebox";

// FormatRegistry entries (uuid, date) are registered by the shared M23 `parse` helper module imported by the routes.
const uuid = () => Type.String({ format: "uuid" });
const isoDate = () => Type.String({ format: "date" });
const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));

export const IdParamsSchema = Type.Object({ id: uuid() }, { additionalProperties: false });
export const OverrideParamsSchema = Type.Object(
  { id: uuid(), resultId: uuid() },
  { additionalProperties: false },
);

export const AssembleCommercialClaimBodySchema = Type.Object(
  {
    providerEntityId: uuid(),
    patientId: uuid(),
    serviceFrom: isoDate(),
    serviceTo: isoDate(),
    planId: Type.Optional(uuid()),
    clearinghouseKey: Type.Optional(Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,39}$" })),
  },
  { additionalProperties: false },
);

export const OverrideBodySchema = Type.Object(
  { reason: Type.String({ minLength: COMMERCIAL_OVERRIDE_REASON_MIN_LENGTH, maxLength: 2000 }) },
  { additionalProperties: false },
);

export const RecordAuthorizationBodySchema = Type.Object(
  {
    providerEntityId: uuid(),
    patientId: uuid(),
    planId: uuid(),
    authorizationNumber: Type.String({ pattern: "^[A-Za-z0-9._-]{1,50}$" }),
    levelOfCare: Type.Optional(
      Type.Union([lit(COMMERCIAL_HOSPICE_LEVEL_OF_CARE_VALUES), Type.Null()]),
    ),
    obtainedOn: isoDate(),
    effectiveFrom: isoDate(),
    effectiveTo: Type.Optional(Type.Union([isoDate(), Type.Null()])),
  },
  { additionalProperties: false },
);

export const SetAuthorizationStatusBodySchema = Type.Object(
  { status: lit(COMMERCIAL_AUTHORIZATION_STATUS_VALUES.filter((s) => s !== "approved")) },
  { additionalProperties: false },
);

/** Work-queue filter. `payerKind` is the coordination-of-benefits kind: `commercial_only` (no other payer) or the secondary program. */
export const COMMERCIAL_PAYER_KIND_FILTER_VALUES = [
  "commercial_only",
  "medicare_secondary",
  "medicaid_secondary",
] as const;
export const ClaimListQuerySchema = Type.Object(
  {
    providerEntityId: uuid(),
    state: Type.Optional(lit(COMMERCIAL_CLAIM_STATE_VALUES)),
    payerKind: Type.Optional(lit(COMMERCIAL_PAYER_KIND_FILTER_VALUES)),
    patientId: Type.Optional(uuid()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);
export const PlanListQuerySchema = Type.Object(
  { providerEntityId: uuid() },
  { additionalProperties: false },
);

export const AuthorizationListQuerySchema = Type.Object(
  { providerEntityId: uuid(), patientId: uuid() },
  { additionalProperties: false },
);

// ── responses ────────────────────────────────────────────────────────────────────────────────────────────────────

export const ValidationResultViewSchema = Type.Object({
  id: Type.String(),
  ruleKey: Type.String(),
  severity: Type.String(),
  outcome: Type.String(),
  overridable: Type.Boolean(),
  overridden: Type.Boolean(),
  blocking: Type.Boolean(),
  message: Type.String(),
});

export const ValidationRunViewSchema = Type.Object({
  runId: Type.String(),
  outcome: Type.String(),
  results: Type.Array(ValidationResultViewSchema),
});

export const AssembleCommercialClaimResponseSchema = Type.Object({
  claimId: Type.String(),
  state: Type.String(),
  tob: Type.String(),
  totalChargeCents: Type.Integer(),
  expectedPaymentCents: Type.Union([Type.Integer(), Type.Null()]),
  lineCount: Type.Integer(),
  secondaryPayerKind: Type.Union([Type.String(), Type.Null()]),
  validation: ValidationRunViewSchema,
});

export const CommercialClaimLineViewSchema = Type.Object({
  lineNumber: Type.Integer(),
  levelOfCare: Type.String(),
  revenueCode: Type.String(),
  hcpcsCode: Type.Union([Type.String(), Type.Null()]),
  serviceFrom: Type.String(),
  serviceTo: Type.String(),
  units: Type.Integer(),
  unitRateCents: Type.Union([Type.Integer(), Type.Null()]),
  lineChargeCents: Type.Integer(),
});

const nullableString = () => Type.Union([Type.String(), Type.Null()]);

export const CommercialClaimSummarySchema = Type.Object({
  id: Type.String(),
  claimControlNumber: Type.String(),
  state: Type.String(),
  patientId: Type.String(),
  planId: Type.String(),
  planName: Type.String(),
  tob: Type.String(),
  serviceFrom: Type.String(),
  serviceTo: Type.String(),
  secondaryPayerKind: nullableString(),
  totalChargeCents: Type.Integer(),
  expectedPaymentCents: Type.Union([Type.Integer(), Type.Null()]),
  updatedAt: Type.String(),
});
export const ClaimListResponseSchema = Type.Object({
  items: Type.Array(CommercialClaimSummarySchema),
  hasMore: Type.Boolean(),
  /** Pass back as `cursor` for the next page; null when there is none. */
  nextCursor: nullableString(),
});

export const PayerPlanViewSchema = Type.Object({
  id: Type.String(),
  payerId: Type.String(),
  planName: Type.String(),
  claimFilingIndicator: Type.String(),
  authorizationRequirement: Type.String(),
  authorizationLeadDays: Type.Union([Type.Integer(), Type.Null()]),
  eligibilityStalenessPolicy: Type.String(),
  eligibilityMaxAgeDays: Type.Integer(),
  effectiveFrom: Type.String(),
  effectiveTo: nullableString(),
  payerStatus: nullableString(),
  routes: Type.Array(
    Type.Object({
      clearinghouseKey: Type.String(),
      clearinghousePayerId: Type.String(),
      effectiveFrom: Type.String(),
      effectiveTo: nullableString(),
    }),
  ),
});
export const PayerPlanListResponseSchema = Type.Object({ items: Type.Array(PayerPlanViewSchema) });

export const CommercialClaimViewSchema = Type.Object({
  plan: Type.Object({
    id: Type.String(),
    payerId: Type.String(),
    planName: Type.String(),
    authorizationRequirement: Type.String(),
    payerStatus: nullableString(),
  }),
  authorizations: Type.Array(
    Type.Object({
      id: Type.String(),
      status: Type.String(),
      levelOfCare: nullableString(),
      effectiveFrom: Type.String(),
      effectiveTo: nullableString(),
    }),
  ),
  claim: Type.Object({
    id: Type.String(),
    claimControlNumber: Type.String(),
    state: Type.String(),
    patientId: Type.String(),
    providerEntityId: Type.String(),
    planId: Type.String(),
    tob: Type.String(),
    serviceFrom: Type.String(),
    serviceTo: Type.String(),
    claimFilingIndicator: Type.String(),
    secondaryPayerKind: Type.Union([Type.String(), Type.Null()]),
    totalChargeCents: Type.Integer(),
    expectedPaymentCents: Type.Union([Type.Integer(), Type.Null()]),
    readyAt: Type.Union([Type.String(), Type.Null()]),
  }),
  lines: Type.Array(CommercialClaimLineViewSchema),
  validation: Type.Union([ValidationRunViewSchema, Type.Null()]),
});

export const ReadyResponseSchema = Type.Object({
  claimId: Type.String(),
  state: Type.String(),
  validation: ValidationRunViewSchema,
});

export const VoidResponseSchema = Type.Object({ claimId: Type.String(), state: Type.String() });

export const OverrideResponseSchema = Type.Object({
  overrideId: Type.String(),
  auditEventId: Type.String(),
  ruleKey: Type.String(),
});

export const AuthorizationViewSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  planId: Type.String(),
  levelOfCare: Type.Union([Type.String(), Type.Null()]),
  status: Type.String(),
  obtainedOn: Type.String(),
  effectiveFrom: Type.String(),
  effectiveTo: Type.Union([Type.String(), Type.Null()]),
});

export const AuthorizationListResponseSchema = Type.Object({
  items: Type.Array(AuthorizationViewSchema),
});

// ─── Submission (ADR-0053 D10): send gate, submit, timeline ─────────────────────────────────────────────────────────
const SendGateReasonSchema = Type.Object({
  /** A stable `COMMERCIAL_SEND_GATE_CODES` value the UI branches on. */
  code: Type.String(),
  /** Fixed text that says what to do next; never a rule, vendor or patient value. */
  message: Type.String(),
  /** Rule keys behind a validation, authorization or eligibility reason. */
  ruleKeys: Type.Optional(Type.Array(Type.String())),
});

export const SendGateViewSchema = Type.Object({
  claimId: Type.String(),
  state: Type.String(),
  patientId: Type.String(),
  canSubmit: Type.Boolean(),
  /** The platform clearinghouse's key; null when none is bound. */
  clearinghouseKey: nullableString(),
  reasons: Type.Array(SendGateReasonSchema),
});

export const SubmissionViewSchema = Type.Object({
  submissionId: Type.String(),
  claimId: Type.String(),
  /** `queued` until the clearinghouse transport accepts it. */
  status: lit(COMMERCIAL_SUBMISSION_STATUS_VALUES),
  controlNumber: Type.String(),
  clearinghouseKey: Type.String(),
  attemptCount: Type.Integer(),
  requestedAt: Type.String(),
  replayed: Type.Boolean(),
});

const TimelineItemSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("state_change"),
    at: Type.String(),
    fromState: nullableString(),
    toState: Type.String(),
    actorKind: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal("submission"),
    at: Type.String(),
    submissionId: Type.String(),
    status: lit(COMMERCIAL_SUBMISSION_STATUS_VALUES),
    controlNumber: Type.String(),
    clearinghouseKey: Type.String(),
    attemptCount: Type.Integer(),
    failureCode: nullableString(),
    sentAt: nullableString(),
  }),
]);

export const TimelineViewSchema = Type.Object({
  claimId: Type.String(),
  patientId: Type.String(),
  state: Type.String(),
  items: Type.Array(TimelineItemSchema),
  /** True when the oldest rows were cut by the bound. */
  truncated: Type.Boolean(),
});

export type AssembleCommercialClaimBody = Static<typeof AssembleCommercialClaimBodySchema>;
export type RecordAuthorizationBody = Static<typeof RecordAuthorizationBodySchema>;
