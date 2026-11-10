import { describe, expect, it } from "vitest";
import {
  checkEraPaymentBalance,
  classifyEraClaimIdentity,
  decimalDollarsToCents,
  isIdempotentMatchDecisionRetry,
} from "../era-match-review";

describe("Claim.MD ERA matching review", () => {
  it("accepts only an exact upstream verified claim identity", () => {
    expect(
      classifyEraClaimIdentity({
        outcome: "verified",
        claimId: "claim-a",
        patientControlNumber: "pcn",
        expectedPatientControlNumber: "pcn",
        transactionSetControlNumber: "12",
        expectedTransactionSetControlNumber: "12",
      }),
    ).toBe("verified");
    expect(
      classifyEraClaimIdentity({
        outcome: "verified",
        claimId: "claim-a",
        patientControlNumber: "pcn-other",
        expectedPatientControlNumber: "pcn",
        transactionSetControlNumber: "12",
        expectedTransactionSetControlNumber: "12",
      }),
    ).toBe("conflict");
    expect(
      classifyEraClaimIdentity({
        outcome: "ambiguous",
        claimId: null,
        patientControlNumber: "pcn",
        expectedPatientControlNumber: "pcn",
        transactionSetControlNumber: "12",
        expectedTransactionSetControlNumber: "12",
      }),
    ).toBe("ambiguous");
  });

  it("treats only an identical immediate reviewer retry against the same source as idempotent", () => {
    const retry = {
      currentVersion: 2,
      expectedVersion: 1,
      currentOutcome: "confirmed" as const,
      requestedOutcome: "confirmed" as const,
      currentReason: "Checked source",
      requestedReason: "Checked source",
      currentActorMembershipId: "reviewer-a",
      actorMembershipId: "reviewer-a",
      currentSourceDigest: "a".repeat(64),
      sourceDigest: "a".repeat(64),
    };
    expect(isIdempotentMatchDecisionRetry(retry)).toBe(true);
    expect(isIdempotentMatchDecisionRetry({ ...retry, actorMembershipId: "reviewer-b" })).toBe(
      false,
    );
    expect(isIdempotentMatchDecisionRetry({ ...retry, requestedReason: "Different reason" })).toBe(
      false,
    );
    expect(isIdempotentMatchDecisionRetry({ ...retry, sourceDigest: "b".repeat(64) })).toBe(false);
  });

  it("uses integer cents for claim and provider adjustment balance checks", () => {
    expect(decimalDollarsToCents(10.01)).toBe(1001);
    expect(
      checkEraPaymentBalance({
        claimPayments: [10.01, 2.34],
        providerAdjustments: [1.25],
        reportedPayment: 11.1,
      }),
    ).toMatchObject({
      status: "balanced",
      claimPaymentsCents: 1235,
      providerAdjustmentsCents: 125,
      reportedPaymentCents: 1110,
      differenceCents: 0,
    });
    expect(
      checkEraPaymentBalance({
        claimPayments: [10],
        providerAdjustments: [],
        reportedPayment: 9.99,
      }),
    ).toMatchObject({ status: "discrepancy", differenceCents: 1 });
    expect(
      checkEraPaymentBalance({
        claimPayments: [Number.NaN],
        providerAdjustments: [],
        reportedPayment: 0,
      }),
    ).toEqual({ status: "unavailable", reason: "invalid_money_value" });
  });
});
