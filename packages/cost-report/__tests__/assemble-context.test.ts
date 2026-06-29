// @wardenx/cost-report — the pure ValidationContext assembler (§11.B) unit tests. No DB / no registry:
// proves the worksheet-jsonb → context field extraction, the cap/MAC composition, the deadline math, and the
// seam-gating (M23 fields unavailable → the dependent rules SKIP; cap bound vs null flips the cap rules).
// Aligned to Form CMS-1984-14: Worksheets B-1 (statistical basis), C (per-diem), F (balance sheet) — no D/E-1.
import { describe, expect, it } from "vitest";
import {
  type RawValidationInputs,
  DEFAULT_VALIDATION_RULES,
  assembleValidationContext,
  normalizeMacJurisdiction,
  runValidation,
} from "../src/index";

function rawInputs(over: Partial<RawValidationInputs> = {}): RawValidationInputs {
  return {
    fiscalYearEndDate: "2026-09-30",
    badDebtClaimed: false,
    wageSource: "manual",
    macJurisdictionCode: "ngs_j6",
    worksheets: [
      { worksheetCode: "S", data: { providerCcn: "123456" } },
      { worksheetCode: "A", data: { grandTotalCostsCents: 5_000_000 } },
      { worksheetCode: "B", data: { totalFullyAllocatedCostCents: 5_000_000, tiesToWorksheetAGrandTotal: true } },
      { worksheetCode: "B-1", data: { columns: [{ generalServiceCostCenterCode: "AG", allocationBasis: "sqft" }] } },
      { worksheetCode: "C", data: { tiesToWorksheetBTotal: true } },
      { worksheetCode: "F", data: {} },
      { worksheetCode: "S-2", data: {} },
    ],
    statistic: { monthlyBreakdown: { "2026-01": { rhc: { medicare: { patientDays: 200 } }, gip: { medicare: { patientDays: 165 } } } } },
    mappings: [{ cmsCostCenterCode: "00100" }, { cmsCostCenterCode: "00200" }, { cmsCostCenterCode: null }],
    trialBalanceAccounts: [{ debitCents: 5_000_000, creditCents: 5_000_000 }],
    badDebt: [],
    complianceWindow: { currentEffectiveDeadlineDate: "2027-02-28", closedAt: null },
    deadlineOverrideGranted: false,
    cap: { capContext: null, capProviderBound: false },
    now: new Date("2026-12-01T00:00:00Z"),
    ...over,
  };
}

describe("normalizeMacJurisdiction", () => {
  it("maps the M40 code to the rule-scope token; unknown → raw; absent → all", () => {
    expect(normalizeMacJurisdiction("ngs_j6")).toBe("NGS-J6");
    expect(normalizeMacJurisdiction("NGS_J6")).toBe("NGS-J6");
    expect(normalizeMacJurisdiction("some_future_mac")).toBe("some_future_mac");
    expect(normalizeMacJurisdiction(null)).toBe("all");
    expect(normalizeMacJurisdiction(undefined)).toBe("all");
  });
});

describe("assembleValidationContext", () => {
  it("extracts the worksheet totals from the data jsonb + composes the aggregate context", () => {
    const ctx = assembleValidationContext(rawInputs());
    expect(ctx.fiscalYearInt).toBe(2026);
    expect(ctx.macJurisdiction).toBe("NGS-J6");
    expect(ctx.demographics.ccnPresent).toBe(true);
    expect(ctx.demographics.relatedPartyDisclosed).toBe(true); // S-2 present
    expect(ctx.trialBalance).toEqual({ present: true, totalDebitsCents: 5_000_000, totalCreditsCents: 5_000_000 });
    expect(ctx.mapping).toEqual({ mappedAccountCount: 2, orphanAccountCount: 1 });
    expect(ctx.statistics.serviceCensusPatientDays).toBe(365);
    expect(ctx.statistics.hasNegativeCensusValue).toBe(false);
    expect(ctx.worksheets.aGrandTotalCostsCents).toBe(5_000_000);
    expect(ctx.worksheets.bTotalAllocatedCents).toBe(5_000_000);
    expect(ctx.worksheets.bTiesToWorksheetA).toBe(true);
    expect(ctx.worksheets.statisticalBasisPresent).toBe(true); // Worksheet B-1 columns present
    expect(ctx.worksheets.cTiesToWorksheetB).toBe(true); // Worksheet C per-diem ties B
    expect(ctx.worksheets.balanceSheetBalances).toBe(true); // Worksheet F present
    expect(ctx.worksheets.presentCodes).toContain("C");
  });

  it("computes the filing deadline from the window + now", () => {
    const ctx = assembleValidationContext(rawInputs());
    expect(ctx.deadline.windowOpen).toBe(true);
    expect(ctx.deadline.pastDeadline).toBe(false);
    expect(ctx.deadline.daysToDeadline).toBe(89); // 2026-12-01 → 2027-02-28
    const past = assembleValidationContext(rawInputs({ now: new Date("2027-06-01T00:00:00Z") }));
    expect(past.deadline.pastDeadline).toBe(true);
    expect(past.deadline.daysToDeadline).toBeLessThan(0);
  });

  it("a negative census cell is flagged (data-integrity defect)", () => {
    const ctx = assembleValidationContext(
      rawInputs({ statistic: { monthlyBreakdown: { "2026-01": { rhc: { medicare: { patientDays: -5 } } } } } }),
    );
    expect(ctx.statistics.hasNegativeCensusValue).toBe(true);
  });

  it("cap bound vs null: the seam flag + cap context flip; M23 fields stay unavailable", () => {
    const unbound = assembleValidationContext(rawInputs());
    expect(unbound.cap).toBeNull();
    expect(unbound.seams.capProviderBound).toBe(false);
    expect(unbound.statistics.billedCensusPatientDays).toBeNull();
    expect(unbound.seams.patientDaysProviderBound).toBe(false);

    const bound = assembleValidationContext(
      rawInputs({ cap: { capContext: { aggregateCapCents: 6_893_068, aggregatePaymentsCents: 5_000_000, inpatientDays: 7, totalMedicareDays: 100 }, capProviderBound: true } }),
    );
    expect(bound.cap).toEqual({ aggregateCapCents: 6_893_068, aggregatePaymentsCents: 5_000_000, inpatientDays: 7, totalMedicareDays: 100 });
    expect(bound.seams.capProviderBound).toBe(true);
  });
});

describe("assembled context drives runValidation seam-gating", () => {
  const outcomeOf = (ctx: ReturnType<typeof assembleValidationContext>, code: string) =>
    runValidation(DEFAULT_VALIDATION_RULES, ctx).results.find((r) => r.ruleCode === code)?.result.outcome;

  it("M23-gated + cap rules SKIP when unbound; cap rules EVALUATE once cap binds", () => {
    const unbound = assembleValidationContext(rawInputs());
    expect(outcomeOf(unbound, "stats.patient_days_reconcile")).toBe("skip"); // M23 PatientDaysProvider unbound
    expect(outcomeOf(unbound, "drug_cost.billed_reconciles")).toBe("skip"); // M12 DrugCostBillingReader unbound
    expect(outcomeOf(unbound, "cap.aggregate_beneficiary_cap")).toBe("skip"); // M26 cap null

    const bound = assembleValidationContext(
      rawInputs({ cap: { capContext: { aggregateCapCents: 6_893_068, aggregatePaymentsCents: 5_000_000, inpatientDays: 7, totalMedicareDays: 100 }, capProviderBound: true } }),
    );
    expect(outcomeOf(bound, "cap.aggregate_beneficiary_cap")).not.toBe("skip"); // M26 bound → the rule runs
  });
});

describe("the live M23/M12 cost-report binds drive their rules live", () => {
  const outcomeOf = (ctx: ReturnType<typeof assembleValidationContext>, code: string) =>
    runValidation(DEFAULT_VALIDATION_RULES, ctx).results.find((r) => r.ruleCode === code)?.result.outcome;

  // A report whose worksheets + billing binds all tie out cleanly.
  function boundInputs(over: Partial<RawValidationInputs> = {}): RawValidationInputs {
    return rawInputs({
      worksheets: [
        { worksheetCode: "S", data: { providerCcn: "123456" } },
        { worksheetCode: "A", data: { grandTotalCostsCents: 5_000_000, costCenters: [{ code: "drugs", totalCostCents: 250_000 }] } },
      ],
      billing: {
        billedCensusPatientDays: 365,
        patientDaysProviderBound: true,
        interimPaymentsActualCents: 4_000_000,
        claimSettlementProviderBound: true,
        billedDrugChargesCents: 250_000,
        drugCostBillingReaderBound: true,
      },
      ...over,
    });
  }

  it("M23 billed census + flag flip — the reconcile rule evaluates against the live billed days", () => {
    const ctx = assembleValidationContext(boundInputs());
    expect(ctx.statistics.billedCensusPatientDays).toBe(365);
    expect(ctx.seams.patientDaysProviderBound).toBe(true);
    // service census (365 from the default statistic) == billed (365) → the reconcile passes (not skip).
    expect(outcomeOf(ctx, "stats.patient_days_reconcile")).toBe("pass");
  });

  it("M12 drug cross-check — reconciles to the Worksheet-A pharmacy center; SKIPS if the center is absent", () => {
    const ctx = assembleValidationContext(boundInputs());
    expect(ctx.drugCost.billedCents).toBe(250_000);
    expect(ctx.drugCost.worksheetAPharmacyCents).toBe(250_000);
    expect(outcomeOf(ctx, "drug_cost.billed_reconciles")).toBe("pass");
    // Bound seam but no pharmacy cost center on Worksheet A → the cross-check is not applicable (skip).
    const noPharmacy = assembleValidationContext(
      boundInputs({ worksheets: [{ worksheetCode: "A", data: { grandTotalCostsCents: 5_000_000, costCenters: [] } }] }),
    );
    expect(noPharmacy.drugCost.worksheetAPharmacyCents).toBeNull();
    expect(outcomeOf(noPharmacy, "drug_cost.billed_reconciles")).toBe("skip");
  });
});
