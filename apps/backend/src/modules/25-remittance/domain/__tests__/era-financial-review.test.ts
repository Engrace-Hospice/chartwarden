import { describe, expect, it } from "vitest";
import { projectEraFinancialReview } from "../era-financial-review";

const base = {
  stageState: "staged" as const,
  duplicateClassification: "none" as const,
  reportedPayment: 60.25,
  claims: [
    {
      statusCode: 1,
      totalCharge: 100,
      totalPayment: 60.25,
      patientResponsibility: 10,
      adjustments: [{ groupCode: "CO", reasonCode: "45", amount: 29.75 }],
      serviceLines: [
        {
          chargeAmount: 100,
          paidAmount: 60.25,
          payerLineReference: null,
          adjustments: [{ groupCode: "PR", reasonCode: "2", amount: 10 }],
        },
      ],
    },
  ],
  providerAdjustments: [],
  identityOutcomes: ["verified"],
};

describe("ERA nonposting financial review projection", () => {
  it("uses integer cents and keeps claim, service-line and provider adjustments separate", () => {
    const projection = projectEraFinancialReview({
      ...base,
      providerAdjustments: [{ reason: "WO", reference: "synthetic", amount: 0 }],
    });
    expect(projection).toMatchObject({
      reportedPaymentCents: 6025,
      chargeCents: 10000,
      claimPaymentCents: 6025,
      patientResponsibilityCents: 1000,
      claimAdjustmentCents: 2975,
      serviceLineAdjustmentCents: 1000,
      providerAdjustmentCents: 0,
      balance: { status: "balanced", differenceCents: 0 },
      financialPostingAuthorized: false,
    });
    expect(projection.claims[0]?.status).toBe("partial_payment");
    expect(projection.adjustments.map((item) => item.scope)).toEqual(["claim", "service_line"]);
  });

  it("distinguishes denial, zero payment, reversal and incomplete source amounts", () => {
    const projection = projectEraFinancialReview({
      ...base,
      reportedPayment: 0,
      claims: [
        { ...base.claims[0]!, statusCode: 4, totalPayment: 0 },
        { ...base.claims[0]!, statusCode: 22, totalPayment: 0 },
        { ...base.claims[0]!, statusCode: 1, totalPayment: 0 },
        { ...base.claims[0]!, statusCode: 1, totalCharge: null, totalPayment: null },
      ],
    });
    expect(projection.claims.map((claim) => claim.status)).toEqual([
      "payer_denied",
      "reversal",
      "zero_payment",
      "insufficient_data",
    ]);
    expect(projection.exceptions.map((exception) => exception.code)).toContain(
      "REVERSAL_REQUIRES_INVESTIGATION",
    );
    expect(projection.financialPostingAuthorized).toBe(false);
  });

  it("blocks completion for held, duplicate and discrepant sources without implying posting authority", () => {
    expect(
      projectEraFinancialReview({ ...base, stageState: "held" }).canCompleteNonpostingReview,
    ).toBe(false);
    expect(
      projectEraFinancialReview({ ...base, duplicateClassification: "possible" })
        .canCompleteNonpostingReview,
    ).toBe(false);
    expect(
      projectEraFinancialReview({ ...base, reportedPayment: 70 }).canCompleteNonpostingReview,
    ).toBe(false);
    expect(
      projectEraFinancialReview({ ...base, identityOutcomes: ["conflict"] })
        .canCompleteNonpostingReview,
    ).toBe(false);
    expect(
      projectEraFinancialReview({ ...base, identityOutcomes: ["ambiguous"] })
        .canCompleteNonpostingReview,
    ).toBe(false);
    expect(projectEraFinancialReview(base).financialPostingAuthorized).toBe(false);
  });

  it("preserves unfamiliar CAS groups without inventing an accounting description", () => {
    const projection = projectEraFinancialReview({
      ...base,
      claims: [
        { ...base.claims[0]!, adjustments: [{ groupCode: "ZZ", reasonCode: "999", amount: 1 }] },
      ],
    });
    expect(projection.adjustments[0]).toMatchObject({
      groupCode: "ZZ",
      category: "unsupported",
      reasonCode: "999",
      amountCents: 100,
      description: "Description unavailable",
    });
    expect(projection.exceptions.map((exception) => exception.code)).toContain(
      "ADJUSTMENT_GROUP_UNSUPPORTED",
    );
  });
});
