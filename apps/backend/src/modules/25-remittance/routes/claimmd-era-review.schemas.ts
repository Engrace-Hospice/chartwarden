import { Type } from "@sinclair/typebox";

const NullableString = Type.Union([Type.String(), Type.Null()]);
const NullableNumber = Type.Union([Type.Number(), Type.Null()]);
const Adjustment = Type.Object({
  groupCode: NullableString,
  reasonCode: NullableString,
  amount: NullableNumber,
  quantity: NullableNumber,
});
const Remark = Type.Object({ kind: NullableString, code: NullableString });
const ServiceLine = Type.Object({
  procedureCode: NullableString,
  revenueCode: NullableString,
  chargeAmount: NullableNumber,
  paidAmount: NullableNumber,
  paidUnits: NullableNumber,
  submittedUnits: NullableNumber,
  payerLineReference: NullableString,
  adjustments: Type.Array(Adjustment),
  remarks: Type.Array(Remark),
});
const Claim = Type.Object({
  patientControlNumber: NullableString,
  payerIcn: NullableString,
  statusCode: NullableNumber,
  totalCharge: NullableNumber,
  totalPayment: NullableNumber,
  patientResponsibility: NullableNumber,
  serviceFrom: NullableString,
  serviceTo: NullableString,
  adjustments: Type.Array(Adjustment),
  serviceLines: Type.Array(ServiceLine),
  remarks: Type.Array(Remark),
});
const FinancialAdjustment = Type.Object({
  scope: Type.Union([Type.Literal("claim"), Type.Literal("service_line")]),
  groupCode: NullableString,
  category: Type.Union([
    Type.Literal("contractual_obligation"),
    Type.Literal("patient_responsibility"),
    Type.Literal("other_adjustment"),
    Type.Literal("payer_initiated_reduction"),
    Type.Literal("correction_or_reversal"),
    Type.Literal("unsupported"),
  ]),
  reasonCode: NullableString,
  amountCents: Type.Union([Type.Integer(), Type.Null()]),
  description: Type.Literal("Description unavailable"),
});
const FinancialBalance = Type.Union([
  Type.Object({ status: Type.Literal("unavailable"), reason: Type.Literal("invalid_money_value") }),
  Type.Object({
    status: Type.Union([Type.Literal("balanced"), Type.Literal("discrepancy")]),
    claimPaymentsCents: Type.Integer(),
    providerAdjustmentsCents: Type.Integer(),
    reportedPaymentCents: Type.Integer(),
    expectedPaymentCents: Type.Integer(),
    differenceCents: Type.Integer(),
  }),
]);

export const ClaimMdEraReviewQuerySchema = Type.Object(
  {
    providerEntityId: Type.Optional(Type.String({ format: "uuid" })),
    locationId: Type.Optional(Type.String({ format: "uuid" })),
    state: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z_]+$" })),
    payer: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    fromDate: Type.Optional(Type.String({ format: "date" })),
    toDate: Type.Optional(Type.String({ format: "date" })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    limit: Type.Optional(Type.String({ pattern: "^[0-9]{1,3}$" })),
  },
  { additionalProperties: false },
);

export const ClaimMdEraReviewItemSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  providerEntityId: Type.String({ format: "uuid" }),
  locationId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  eraId: Type.String(),
  fileIndex: Type.Integer(),
  transactionSetControlNumber: Type.String({ minLength: 1, maxLength: 9 }),
  sourceDigest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  state: Type.String(),
  holdReason: NullableString,
  possibleDuplicate: Type.Boolean(),
  duplicateClassification: Type.Union([
    Type.Literal("none"),
    Type.Literal("possible"),
    Type.Literal("exact"),
  ]),
  existingAdviceId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  createdAt: Type.String({ format: "date-time" }),
  detailsAvailable: Type.Boolean(),
  payer: Type.Object({ name: NullableString, identifier: NullableString }),
  payee: Type.Object({ name: NullableString, npi: NullableString }),
  payment: Type.Object({
    trace: NullableString,
    method: NullableString,
    amount: NullableNumber,
    date: NullableString,
  }),
  claims: Type.Array(Claim),
  providerAdjustments: Type.Array(
    Type.Object({
      reason: NullableString,
      reference: NullableString,
      amount: NullableNumber,
      providerIdentifierMasked: NullableString,
      fiscalPeriod: NullableString,
      segmentPosition: NullableNumber,
      occurrence: NullableNumber,
      classification: Type.Union([
        Type.Literal("overpayment_recovery_reported"),
        Type.Literal("forward_balance_reported"),
        Type.Literal("other_provider_adjustment_reported"),
        Type.Literal("unclassified"),
      ]),
      historicalReference: Type.Literal("not_verified"),
      policyStatus: Type.Literal("not_configured"),
      postingEligible: Type.Literal(false),
    }),
  ),
  claimOutcomes: Type.Array(
    Type.Object({
      claimId: NullableString,
      patientControlNumber: NullableString,
      outcome: NullableString,
      module: NullableString,
      fileIndex: NullableNumber,
      transactionSetControlNumber: NullableString,
    }),
  ),
  reconciliationEligible: Type.Boolean(),
});

export const ClaimMdEraReviewSummarySchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  providerEntityId: Type.String({ format: "uuid" }),
  locationId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  state: Type.String(),
  holdReason: NullableString,
  possibleDuplicate: Type.Boolean(),
  duplicateClassification: Type.Union([
    Type.Literal("none"),
    Type.Literal("possible"),
    Type.Literal("exact"),
  ]),
  existingAdviceId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  createdAt: Type.String({ format: "date-time" }),
  detailsAvailable: Type.Boolean(),
  payer: Type.Object({ name: NullableString, identifier: NullableString }),
  payee: Type.Object({ name: NullableString }),
  payment: Type.Object({ method: NullableString, amount: NullableNumber, date: NullableString }),
  claimCount: Type.Integer({ minimum: 0 }),
  identityExceptionCount: Type.Integer({ minimum: 0 }),
  reconciliationEligible: Type.Boolean(),
});

export const ClaimMdEraReviewPageSchema = Type.Object({
  items: Type.Array(ClaimMdEraReviewSummarySchema),
  nextCursor: NullableString,
  searchWindowLimited: Type.Boolean(),
});

const HistoryEvent = Type.Object({
  eventType: Type.String({ maxLength: 80 }),
  description: Type.String({ maxLength: 240 }),
  occurredAt: Type.String({ format: "date-time" }),
  stageId: Type.String({ format: "uuid" }),
  fromState: NullableString,
  toState: NullableString,
  reasonCode: NullableString,
  origin: Type.Union([
    Type.Literal("ingestion"),
    Type.Literal("ownership"),
    Type.Literal("delivery"),
    Type.Literal("recovery"),
    Type.Literal("system"),
  ]),
  actorClassification: Type.Union([
    Type.Literal("platform_operator"),
    Type.Literal("system"),
    Type.Null(),
  ]),
  attemptCount: NullableNumber,
});

const History = Type.Object({
  availability: Type.Union([
    Type.Literal("available"),
    Type.Literal("partial"),
    Type.Literal("unavailable"),
  ]),
  events: Type.Array(HistoryEvent),
});

export const ClaimMdEraReviewDetailSchema = Type.Composite([
  ClaimMdEraReviewItemSchema,
  Type.Object({ history: History }),
]);

export const ClaimMdEraPostingPlanSchema = Type.Object({
  planId: Type.String({ format: "uuid" }),
  planDigest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  stageId: Type.String({ format: "uuid" }),
  providerEntityId: Type.String({ format: "uuid" }),
  payer: NullableString,
  paymentCents: Type.Union([Type.Integer(), Type.Null()]),
  billedCents: Type.Union([Type.Integer(), Type.Null()]),
  unresolvedCents: Type.Union([Type.Integer(), Type.Null()]),
  providerAdjustments: Type.Array(
    Type.Object({
      sourceDigest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
      providerIdentifierMasked: NullableString,
      fiscalPeriod: NullableString,
      segmentPosition: NullableNumber,
      occurrence: NullableNumber,
      reason: NullableString,
      reference: NullableString,
      amountCents: Type.Union([Type.Integer(), Type.Null()]),
      classification: Type.Union([
        Type.Literal("overpayment_recovery_reported"),
        Type.Literal("forward_balance_reported"),
        Type.Literal("other_provider_adjustment_reported"),
        Type.Literal("unclassified"),
      ]),
      historicalReference: Type.Literal("not_verified"),
      policy: Type.Object({ status: Type.Literal("not_configured"), version: Type.Null() }),
      action: Type.Literal("none"),
    }),
  ),
  claims: Type.Array(
    Type.Object({
      claimIndex: Type.Integer({ minimum: 0 }),
      billingModule: Type.Union([Type.Literal("M23"), Type.Literal("M41"), Type.Null()]),
      patientControlNumber: NullableString,
      payerIcn: NullableString,
      claimId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
      payerId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
      submissionId: NullableString,
      evidenceId: NullableString,
      evidenceVersion: Type.Integer({ minimum: 0 }),
      matching: Type.Union([
        Type.Literal("verified"),
        Type.Literal("human_confirmed_candidate"),
        Type.Literal("blocked"),
      ]),
      billedCents: Type.Union([Type.Integer(), Type.Null()]),
      paidCents: Type.Union([Type.Integer(), Type.Null()]),
      patientResponsibilityCents: Type.Union([Type.Integer(), Type.Null()]),
      adjustments: Type.Array(
        Type.Object({
          scope: Type.Literal("claim"),
          groupCode: Type.Union([
            Type.Literal("CO"),
            Type.Literal("PR"),
            Type.Literal("OA"),
            Type.Literal("PI"),
            Type.Literal("CR"),
            Type.Literal("unknown"),
          ]),
          reasonCode: NullableString,
          amountCents: Type.Union([Type.Integer(), Type.Null()]),
          responsibility: Type.Union([
            Type.Literal("provider_reported"),
            Type.Literal("patient_reported"),
            Type.Literal("other_unallocated"),
            Type.Literal("payer_initiated_reported"),
            Type.Literal("correction_or_reversal_reported"),
            Type.Literal("unsupported"),
          ]),
          classification: Type.Union([
            Type.Literal("contractual_obligation_reported"),
            Type.Literal("patient_responsibility_reported"),
            Type.Literal("other_adjustment_unresolved"),
            Type.Literal("payer_initiated_reduction_reported"),
            Type.Literal("correction_or_reversal_reported"),
            Type.Literal("unsupported"),
          ]),
          accountingDisposition: Type.Union([
            Type.Literal("unresolved_review"),
            Type.Literal("policy_required"),
          ]),
          policyVersion: Type.Null(),
          m25Action: Type.Union([Type.Literal("flagged_review"), Type.Literal("not_authorized")]),
        }),
      ),
      unresolvedCents: Type.Union([Type.Integer(), Type.Null()]),
      financialStatus: Type.Union([
        Type.Literal("fully_paid"),
        Type.Literal("partial_paid"),
        Type.Literal("unsupported"),
      ]),
      duplicate: Type.Union([Type.Literal("none"), Type.Literal("potential")]),
      eligible: Type.Boolean(),
      blockers: Type.Array(Type.String({ maxLength: 64 })),
    }),
  ),
  claimId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  eligible: Type.Boolean(),
  status: Type.Union([
    Type.Literal("eligible"),
    Type.Literal("blocked"),
    Type.Literal("already_posted"),
  ]),
  blockers: Type.Array(Type.String({ maxLength: 64 })),
  featureEnabled: Type.Boolean(),
  approval: Type.Union([
    Type.Literal("not_approved"),
    Type.Literal("approved"),
    Type.Literal("posted"),
  ]),
  createdAt: Type.String({ format: "date-time" }),
});
export const ClaimMdEraPostingActionRequestSchema = Type.Object(
  {
    planDigest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    reason: Type.String({ minLength: 3, maxLength: 500 }),
  },
  { additionalProperties: false },
);
export const ClaimMdEraPostingActionResultSchema = Type.Object({
  planId: Type.String({ format: "uuid" }),
  outcome: Type.Union([
    Type.Literal("approved"),
    Type.Literal("already_approved"),
    Type.Literal("posted"),
    Type.Literal("already_posted"),
  ]),
  adviceId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  remittanceLineId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  remittanceLineIds: Type.Array(Type.String({ format: "uuid" })),
  paymentCents: Type.Integer(),
});
export const ClaimMdEraPostingApprovalResultSchema = Type.Object({
  planId: Type.String({ format: "uuid" }),
  outcome: Type.Union([Type.Literal("approved"), Type.Literal("already_approved")]),
});
export const ClaimMdEraPostingHistorySchema = Type.Array(
  Type.Object({
    eventType: Type.Union([Type.Literal("approved"), Type.Literal("posted")]),
    planId: Type.String({ format: "uuid" }),
    occurredAt: Type.String({ format: "date-time" }),
    reason: Type.String({ maxLength: 500 }),
    adviceId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    remittanceLineId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    remittanceLineIds: Type.Array(Type.String({ format: "uuid" })),
  }),
);

export const ClaimMdEraMatchReviewSchema = Type.Object({
  stageId: Type.String({ format: "uuid" }),
  totalClaims: Type.Integer({ minimum: 0 }),
  verifiedSourceIdentities: Type.Integer({ minimum: 0 }),
  unresolvedSourceIdentities: Type.Integer({ minimum: 0 }),
  claims: Type.Array(
    Type.Object({
      claimIndex: Type.Integer({ minimum: 0 }),
      patientControlNumber: NullableString,
      payerIcn: NullableString,
      serviceLines: Type.Array(
        Type.Object({
          lineIndex: Type.Integer({ minimum: 0 }),
          payerLineReference: NullableString,
          outcome: Type.Union([
            Type.Literal("original_line_evidence_unavailable"),
            Type.Literal("payer_line_reference_missing"),
          ]),
        }),
      ),
      outcome: Type.Union([
        Type.Literal("verified"),
        Type.Literal("ambiguous"),
        Type.Literal("conflict"),
        Type.Literal("unmatched"),
        Type.Literal("unsupported"),
      ]),
      linkedClaimId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
      linkedModule: NullableString,
      decision: Type.Union([
        Type.Literal("unreviewed"),
        Type.Literal("confirmed_identity"),
        Type.Literal("human_confirmed_candidate"),
        Type.Literal("cleared"),
      ]),
      decisionVersion: Type.Integer({ minimum: 0 }),
      reason: NullableString,
      decisionAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
    }),
  ),
  decisionHistory: Type.Array(
    Type.Object({
      claimIndex: Type.Integer({ minimum: 0 }),
      decisionVersion: Type.Integer({ minimum: 1 }),
      decision: Type.Union([
        Type.Literal("confirmed_identity"),
        Type.Literal("human_confirmed_candidate"),
        Type.Literal("cleared"),
      ]),
      reason: Type.String({ maxLength: 500 }),
      occurredAt: Type.String({ format: "date-time" }),
      actorClassification: Type.Literal("authorized_reviewer"),
    }),
  ),
  serviceLineMatching: Type.Literal("not_available_without_original_line_reference"),
  financialReview: Type.Object({
    reportedPaymentCents: Type.Union([Type.Integer(), Type.Null()]),
    claimCount: Type.Integer(),
    chargeCents: Type.Union([Type.Integer(), Type.Null()]),
    claimPaymentCents: Type.Union([Type.Integer(), Type.Null()]),
    patientResponsibilityCents: Type.Union([Type.Integer(), Type.Null()]),
    claimAdjustmentCents: Type.Union([Type.Integer(), Type.Null()]),
    serviceLineAdjustmentCents: Type.Union([Type.Integer(), Type.Null()]),
    providerAdjustmentCents: Type.Union([Type.Integer(), Type.Null()]),
    balance: FinancialBalance,
    claims: Type.Array(
      Type.Object({
        claimIndex: Type.Integer(),
        status: Type.Union([
          Type.Literal("payer_denied"),
          Type.Literal("reversal"),
          Type.Literal("zero_payment"),
          Type.Literal("partial_payment"),
          Type.Literal("payment_reported"),
          Type.Literal("insufficient_data"),
        ]),
        chargeCents: Type.Union([Type.Integer(), Type.Null()]),
        paymentCents: Type.Union([Type.Integer(), Type.Null()]),
        patientResponsibilityCents: Type.Union([Type.Integer(), Type.Null()]),
        adjustments: Type.Array(FinancialAdjustment),
        lineEvidence: Type.Union([
          Type.Literal("original_line_evidence_unavailable"),
          Type.Literal("payer_line_reference_missing"),
        ]),
      }),
    ),
    adjustments: Type.Array(FinancialAdjustment),
    providerAdjustments: Type.Array(
      Type.Object({
        reason: NullableString,
        reference: NullableString,
        amountCents: Type.Union([Type.Integer(), Type.Null()]),
      }),
    ),
    exceptions: Type.Array(
      Type.Object({
        code: Type.String(),
        severity: Type.Union([
          Type.Literal("blocking"),
          Type.Literal("follow_up"),
          Type.Literal("informational"),
        ]),
        blocksReviewCompletion: Type.Boolean(),
        blocksFuturePosting: Type.Boolean(),
      }),
    ),
    canCompleteNonpostingReview: Type.Boolean(),
    financialPostingAuthorized: Type.Literal(false),
  }),
  financialReviewHistory: Type.Array(
    Type.Object({
      itemType: Type.Union([Type.Literal("era"), Type.Literal("claim")]),
      itemIndex: Type.Integer(),
      decisionVersion: Type.Integer(),
      disposition: Type.Union([
        Type.Literal("note"),
        Type.Literal("follow_up"),
        Type.Literal("reviewed"),
        Type.Literal("reopened"),
        Type.Literal("completed"),
      ]),
      reason: Type.String({ maxLength: 1000 }),
      occurredAt: Type.String({ format: "date-time" }),
      reviewerMembershipId: Type.String({ format: "uuid" }),
      currentSource: Type.Boolean(),
    }),
  ),
  readOnlyBalance: Type.Union([
    Type.Object({
      status: Type.Literal("unavailable"),
      reason: Type.Literal("invalid_money_value"),
    }),
    Type.Object({
      status: Type.Union([Type.Literal("balanced"), Type.Literal("discrepancy")]),
      claimPaymentsCents: Type.Integer(),
      providerAdjustmentsCents: Type.Integer(),
      reportedPaymentCents: Type.Integer(),
      expectedPaymentCents: Type.Integer(),
      differenceCents: Type.Integer(),
    }),
  ]),
  postingAuthorized: Type.Literal(false),
});

export const ClaimMdEraFinancialReviewDecisionRequestSchema = Type.Object(
  {
    itemType: Type.Union([Type.Literal("era"), Type.Literal("claim")]),
    itemIndex: Type.Integer({ minimum: -1, maximum: 999 }),
    disposition: Type.Union([
      Type.Literal("note"),
      Type.Literal("follow_up"),
      Type.Literal("reviewed"),
      Type.Literal("reopened"),
      Type.Literal("completed"),
    ]),
    expectedVersion: Type.Integer({ minimum: 0 }),
    reason: Type.String({ minLength: 3, maxLength: 1000 }),
  },
  { additionalProperties: false },
);

export const ClaimMdEraFinancialReviewDecisionResultSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  itemType: Type.Union([Type.Literal("era"), Type.Literal("claim")]),
  itemIndex: Type.Integer(),
  decisionVersion: Type.Integer({ minimum: 1 }),
  disposition: Type.Union([
    Type.Literal("note"),
    Type.Literal("follow_up"),
    Type.Literal("reviewed"),
    Type.Literal("reopened"),
    Type.Literal("completed"),
  ]),
  financialPostingAuthorized: Type.Literal(false),
});

export const ClaimMdEraHistoricalCandidatesSchema = Type.Object({
  complete: Type.Boolean(),
  candidates: Type.Array(
    Type.Object({
      module: Type.Union([Type.Literal("M23"), Type.Literal("M41")]),
      evidenceId: Type.String({ format: "uuid" }),
      claimId: Type.String({ format: "uuid" }),
      submissionId: Type.String({ format: "uuid" }),
      attemptKey: Type.String({ maxLength: 128 }),
      claimType: Type.String({ maxLength: 64 }),
      payerId: Type.String({ maxLength: 128 }),
      usage: Type.Union([Type.Literal("test"), Type.Literal("production")]),
      serviceFrom: NullableString,
      serviceTo: NullableString,
      chargeCents: Type.Union([Type.Integer(), Type.Null()]),
      lineage: Type.Union([
        Type.Literal("original"),
        Type.Literal("correction"),
        Type.Literal("replacement"),
        Type.Literal("void"),
        Type.Literal("unknown"),
      ]),
      attemptState: Type.String({ maxLength: 64 }),
      submittedAt: Type.String({ format: "date-time" }),
      supportingEvidence: Type.Array(Type.String({ maxLength: 120 })),
      selectable: Type.Boolean(),
      submittedLines: Type.Union([Type.Literal("available"), Type.Literal("unavailable")]),
    }),
  ),
  postingAuthorized: Type.Literal(false),
});

export const ClaimMdEraMatchDecisionRequestSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("confirm_identity"),
      Type.Literal("confirm_candidate"),
      Type.Literal("clear"),
    ]),
    expectedVersion: Type.Integer({ minimum: 0 }),
    reason: Type.String({ minLength: 3, maxLength: 500 }),
    evidenceId: Type.Optional(Type.String({ format: "uuid" })),
  },
  { additionalProperties: false },
);

export const ClaimMdEraMatchDecisionResultSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  claimIndex: Type.Integer({ minimum: 0 }),
  decisionVersion: Type.Integer({ minimum: 1 }),
  decision: Type.Union([
    Type.Literal("confirmed_identity"),
    Type.Literal("human_confirmed_candidate"),
    Type.Literal("cleared"),
  ]),
  postingAuthorized: Type.Literal(false),
});
