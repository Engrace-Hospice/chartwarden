/** Safe, nonposting interpretation of upstream Claim.MD ownership correlation. */
export type EraIdentityOutcome =
  | "verified"
  | "ambiguous"
  | "conflict"
  | "unmatched"
  | "unsupported";

export function isIdempotentMatchDecisionRetry(input: {
  readonly currentVersion: number | null;
  readonly expectedVersion: number;
  readonly currentOutcome: "confirmed" | "cleared" | null;
  readonly requestedOutcome: "confirmed" | "cleared";
  readonly currentReason: string | null;
  readonly requestedReason: string;
  readonly currentActorMembershipId: string | null;
  readonly actorMembershipId: string;
  readonly currentSourceDigest: string | null;
  readonly sourceDigest: string;
}): boolean {
  return (
    input.currentVersion === input.expectedVersion + 1 &&
    input.currentOutcome === input.requestedOutcome &&
    input.currentReason === input.requestedReason &&
    input.currentActorMembershipId === input.actorMembershipId &&
    input.currentSourceDigest === input.sourceDigest
  );
}

export function classifyEraClaimIdentity(input: {
  readonly outcome: unknown;
  readonly claimId: unknown;
  readonly patientControlNumber: unknown;
  readonly expectedPatientControlNumber: unknown;
  readonly transactionSetControlNumber: unknown;
  readonly expectedTransactionSetControlNumber: unknown;
}): EraIdentityOutcome {
  if (input.outcome === "conflict") return "conflict";
  if (input.outcome === "ambiguous") return "ambiguous";
  if (input.outcome === "unmatched") return "unmatched";
  if (input.outcome !== "verified") return "unsupported";
  if (typeof input.claimId !== "string" || !input.claimId) return "conflict";
  if (
    input.patientControlNumber !== input.expectedPatientControlNumber ||
    input.transactionSetControlNumber !== input.expectedTransactionSetControlNumber
  )
    return "conflict";
  return "verified";
}

export type EraBalanceResult =
  | { readonly status: "unavailable"; readonly reason: "invalid_money_value" }
  | {
      readonly status: "balanced" | "discrepancy";
      readonly claimPaymentsCents: number;
      readonly providerAdjustmentsCents: number;
      readonly reportedPaymentCents: number;
      readonly expectedPaymentCents: number;
      readonly differenceCents: number;
    };

/** Convert an X12 decimal amount into integer cents without floating-point arithmetic. */
export function decimalDollarsToCents(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const text = String(value);
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const fraction = (match[3] ?? "").padEnd(2, "0");
  const cents = Number(match[2]) * 100 + Number(fraction || "0");
  if (!Number.isSafeInteger(cents)) return null;
  return match[1] ? -cents : cents;
}

/** Read-only ERA BPR reconciliation: sum(CLP04) - sum(PLB) = BPR02 (parser sign convention). */
export function checkEraPaymentBalance(input: {
  readonly claimPayments: readonly (number | null)[];
  readonly providerAdjustments: readonly (number | null)[];
  readonly reportedPayment: number;
}): EraBalanceResult {
  const payments = input.claimPayments.map((value) =>
    value === null ? null : decimalDollarsToCents(value),
  );
  const adjustments = input.providerAdjustments.map((value) =>
    value === null ? null : decimalDollarsToCents(value),
  );
  const reported = decimalDollarsToCents(input.reportedPayment);
  if (
    payments.some((value) => value === null) ||
    adjustments.some((value) => value === null) ||
    reported === null
  )
    return { status: "unavailable", reason: "invalid_money_value" };
  const claimPaymentsCents = (payments as number[]).reduce((sum, value) => sum + value, 0);
  const providerAdjustmentsCents = (adjustments as number[]).reduce((sum, value) => sum + value, 0);
  const expectedPaymentCents = claimPaymentsCents - providerAdjustmentsCents;
  const differenceCents = expectedPaymentCents - reported;
  return {
    status: differenceCents === 0 ? "balanced" : "discrepancy",
    claimPaymentsCents,
    providerAdjustmentsCents,
    reportedPaymentCents: reported,
    expectedPaymentCents,
    differenceCents,
  };
}
