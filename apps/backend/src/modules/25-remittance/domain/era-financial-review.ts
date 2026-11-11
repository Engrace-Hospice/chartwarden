import { checkEraPaymentBalance, decimalDollarsToCents } from "./era-match-review";

export type EraFinancialDisposition = "note" | "follow_up" | "reviewed" | "reopened" | "completed";

export interface EraFinancialClaimInput {
  readonly statusCode: number | null;
  readonly totalCharge: number | null;
  readonly totalPayment: number | null;
  readonly patientResponsibility: number | null;
  readonly adjustments: readonly {
    readonly groupCode: string | null;
    readonly reasonCode: string | null;
    readonly amount: number | null;
  }[];
  readonly serviceLines: readonly {
    readonly chargeAmount: number | null;
    readonly paidAmount: number | null;
    readonly payerLineReference: string | null;
    readonly adjustments: readonly {
      readonly groupCode: string | null;
      readonly reasonCode: string | null;
      readonly amount: number | null;
    }[];
  }[];
}

export interface EraFinancialReviewInput {
  readonly stageState: string;
  readonly duplicateClassification: "none" | "possible" | "exact";
  readonly reportedPayment: number | null;
  readonly claims: readonly EraFinancialClaimInput[];
  readonly providerAdjustments: readonly {
    readonly reason: string | null;
    readonly reference: string | null;
    readonly amount: number | null;
  }[];
  readonly identityOutcomes: readonly string[];
}

export interface EraFinancialReviewProjection {
  readonly reportedPaymentCents: number | null;
  readonly claimCount: number;
  readonly chargeCents: number | null;
  readonly claimPaymentCents: number | null;
  readonly patientResponsibilityCents: number | null;
  readonly claimAdjustmentCents: number | null;
  readonly serviceLineAdjustmentCents: number | null;
  readonly providerAdjustmentCents: number | null;
  readonly balance: ReturnType<typeof checkEraPaymentBalance>;
  readonly claims: readonly {
    readonly claimIndex: number;
    readonly status:
      | "payer_denied"
      | "reversal"
      | "zero_payment"
      | "partial_payment"
      | "payment_reported"
      | "insufficient_data";
    readonly chargeCents: number | null;
    readonly paymentCents: number | null;
    readonly patientResponsibilityCents: number | null;
    readonly adjustments: readonly EraAdjustmentProjection[];
    readonly lineEvidence: "original_line_evidence_unavailable" | "payer_line_reference_missing";
  }[];
  readonly adjustments: readonly EraAdjustmentProjection[];
  readonly providerAdjustments: readonly {
    readonly reason: string | null;
    readonly reference: string | null;
    readonly amountCents: number | null;
  }[];
  readonly exceptions: readonly {
    readonly code: string;
    readonly severity: "blocking" | "follow_up" | "informational";
    readonly blocksReviewCompletion: boolean;
    readonly blocksFuturePosting: boolean;
  }[];
  readonly canCompleteNonpostingReview: boolean;
  readonly financialPostingAuthorized: false;
}

export interface EraAdjustmentProjection {
  readonly scope: "claim" | "service_line";
  readonly groupCode: string | null;
  readonly category:
    | "contractual_obligation"
    | "patient_responsibility"
    | "other_adjustment"
    | "payer_initiated_reduction"
    | "correction_or_reversal"
    | "unsupported";
  readonly reasonCode: string | null;
  readonly amountCents: number | null;
  readonly description: "Description unavailable";
}

function adjustmentCategory(groupCode: string | null): EraAdjustmentProjection["category"] {
  switch (groupCode) {
    case "CO":
      return "contractual_obligation";
    case "PR":
      return "patient_responsibility";
    case "OA":
      return "other_adjustment";
    case "PI":
      return "payer_initiated_reduction";
    case "CR":
      return "correction_or_reversal";
    default:
      return "unsupported";
  }
}

function centsSum(values: readonly (number | null)[]): number | null {
  const cents = values.map((value) => (value === null ? null : decimalDollarsToCents(value)));
  if (cents.some((value) => value === null)) return null;
  const total = (cents as number[]).reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : null;
}

function sumMinorUnits(values: readonly (number | null)[]): number | null {
  if (values.some((value) => value === null)) return null;
  const total = (values as number[]).reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : null;
}

function projectAdjustments(
  scope: EraAdjustmentProjection["scope"],
  source: EraFinancialClaimInput["adjustments"],
): EraAdjustmentProjection[] {
  return source.map((adjustment) => ({
    scope,
    groupCode: adjustment.groupCode,
    category: adjustmentCategory(adjustment.groupCode),
    reasonCode: adjustment.reasonCode,
    amountCents: adjustment.amount === null ? null : decimalDollarsToCents(adjustment.amount),
    description: "Description unavailable",
  }));
}

/** Read-only facts only. No inferred allowed amount, allocation, write-off, bank settlement, or posting state. */
export function projectEraFinancialReview(
  input: EraFinancialReviewInput,
): EraFinancialReviewProjection {
  const chargeCents = centsSum(input.claims.map((claim) => claim.totalCharge));
  const claimPaymentCents = centsSum(input.claims.map((claim) => claim.totalPayment));
  const reportedPaymentCents =
    input.reportedPayment === null ? null : decimalDollarsToCents(input.reportedPayment);
  const patientResponsibilityCents = centsSum(
    input.claims.map((claim) => claim.patientResponsibility),
  );
  const claimAdjustments = input.claims.flatMap((claim) =>
    projectAdjustments("claim", claim.adjustments),
  );
  const lineAdjustments = input.claims.flatMap((claim) =>
    claim.serviceLines.flatMap((line) => projectAdjustments("service_line", line.adjustments)),
  );
  const adjustments = [...claimAdjustments, ...lineAdjustments];
  const claimAdjustmentCents = sumMinorUnits(
    claimAdjustments.map((adjustment) => adjustment.amountCents),
  );
  const serviceLineAdjustmentCents = sumMinorUnits(
    lineAdjustments.map((adjustment) => adjustment.amountCents),
  );
  const providerAdjustments = input.providerAdjustments.map((adjustment) => ({
    reason: adjustment.reason,
    reference: adjustment.reference,
    amountCents: adjustment.amount === null ? null : decimalDollarsToCents(adjustment.amount),
  }));
  const providerAdjustmentCents = sumMinorUnits(
    providerAdjustments.map((adjustment) => adjustment.amountCents),
  );
  const balance =
    input.reportedPayment === null
      ? { status: "unavailable" as const, reason: "invalid_money_value" as const }
      : checkEraPaymentBalance({
          claimPayments: input.claims.map((claim) => claim.totalPayment),
          providerAdjustments: input.providerAdjustments.map((adjustment) => adjustment.amount),
          reportedPayment: input.reportedPayment,
        });

  const exceptions: EraFinancialReviewProjection["exceptions"][number][] = [];
  if (input.stageState !== "staged")
    exceptions.push({
      code: "UPSTREAM_STAGE_HELD",
      severity: "blocking",
      blocksReviewCompletion: true,
      blocksFuturePosting: true,
    });
  if (input.duplicateClassification !== "none")
    exceptions.push({
      code:
        input.duplicateClassification === "exact"
          ? "EXACT_DUPLICATE_ERA"
          : "POSSIBLE_DUPLICATE_ERA",
      severity: "blocking",
      blocksReviewCompletion: true,
      blocksFuturePosting: true,
    });
  if (input.identityOutcomes.some((outcome) => outcome === "conflict"))
    exceptions.push({
      code: "CLAIM_IDENTITY_CONFLICT",
      severity: "blocking",
      blocksReviewCompletion: true,
      blocksFuturePosting: true,
    });
  if (input.identityOutcomes.some((outcome) => outcome !== "verified"))
    exceptions.push({
      code: "CLAIM_IDENTITY_UNRESOLVED",
      severity: "blocking",
      blocksReviewCompletion: true,
      blocksFuturePosting: true,
    });
  if (balance.status === "discrepancy")
    exceptions.push({
      code: "ERA_PAYMENT_BALANCE_DISCREPANCY",
      severity: "blocking",
      blocksReviewCompletion: true,
      blocksFuturePosting: true,
    });
  if (balance.status === "unavailable")
    exceptions.push({
      code: "ERA_PAYMENT_BALANCE_UNVERIFIED",
      severity: "follow_up",
      blocksReviewCompletion: false,
      blocksFuturePosting: true,
    });
  if (input.providerAdjustments.length > 0)
    exceptions.push({
      code: "PROVIDER_ADJUSTMENT_REQUIRES_POLICY_REVIEW",
      severity: "follow_up",
      blocksReviewCompletion: false,
      blocksFuturePosting: true,
    });
  if (input.claims.some((claim) => claim.serviceLines.some((line) => !line.payerLineReference)))
    exceptions.push({
      code: "SERVICE_LINE_REFERENCE_MISSING",
      severity: "informational",
      blocksReviewCompletion: false,
      blocksFuturePosting: true,
    });
  if (input.claims.some((claim) => claim.statusCode === 22))
    exceptions.push({
      code: "REVERSAL_REQUIRES_INVESTIGATION",
      severity: "follow_up",
      blocksReviewCompletion: false,
      blocksFuturePosting: true,
    });
  if (adjustments.some((adjustment) => adjustment.category === "unsupported"))
    exceptions.push({
      code: "ADJUSTMENT_GROUP_UNSUPPORTED",
      severity: "follow_up",
      blocksReviewCompletion: false,
      blocksFuturePosting: true,
    });

  return {
    reportedPaymentCents,
    claimCount: input.claims.length,
    chargeCents,
    claimPaymentCents,
    patientResponsibilityCents,
    claimAdjustmentCents,
    serviceLineAdjustmentCents,
    providerAdjustmentCents,
    balance,
    claims: input.claims.map((claim, claimIndex) => {
      const charge = claim.totalCharge === null ? null : decimalDollarsToCents(claim.totalCharge);
      const payment =
        claim.totalPayment === null ? null : decimalDollarsToCents(claim.totalPayment);
      const status =
        claim.statusCode === 4
          ? "payer_denied"
          : claim.statusCode === 22
            ? "reversal"
            : charge === null || payment === null
              ? "insufficient_data"
              : payment === 0
                ? "zero_payment"
                : payment < charge
                  ? "partial_payment"
                  : "payment_reported";
      return {
        claimIndex,
        status,
        chargeCents: charge,
        paymentCents: payment,
        patientResponsibilityCents:
          claim.patientResponsibility === null
            ? null
            : decimalDollarsToCents(claim.patientResponsibility),
        adjustments: projectAdjustments("claim", claim.adjustments),
        lineEvidence: claim.serviceLines.some((line) => line.payerLineReference)
          ? ("original_line_evidence_unavailable" as const)
          : ("payer_line_reference_missing" as const),
      };
    }),
    adjustments,
    providerAdjustments,
    exceptions,
    canCompleteNonpostingReview: !exceptions.some((exception) => exception.blocksReviewCompletion),
    financialPostingAuthorized: false,
  };
}
