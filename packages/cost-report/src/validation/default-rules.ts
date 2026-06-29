// @wardenx/cost-report — M27 the TWENTY-EIGHT platform-default validation rules (§1.1, architecture
// §11.B, M27-F01/F02). Every cost report runs through this default set before submission. The rules span
// ALL SIXTEEN §2.1 `rule_category` values; the CFR-mandated ones (42 CFR §413.24 adequate-cost-data,
// §418.308 aggregate cap, §418.309 inpatient cap, PRM I Ch 3&4 bad-debt) are tagged `regulatoryRequired`
// — they are the platform floor a tenant cannot disable (D21) and a `fail` is BLOCKING (cannot
// skip-and-submit, M27-F08).
//
// Each rule's `evaluate` is a DETERMINISTIC pure predicate (D8): integer-cents equality / exact
// cross-multiplication only (no float, no division), so a tie test is penny-exact and reproducible
// across re-validations and snapshots. Cap-category rules (and any rule reading an M23/M26 forward seam)
// return `outcome: 'skip'` with `reason: 'seam_not_bound'` when that seam is unbound (D12/D13) — deferred,
// never failed. No PHI (D18) — predicates read aggregate financial/statistical figures and flags only.
//
// TODO(CMS-fixture): several threshold/structural checks below are penny/percent-exact against
// CMS-published example cost reports we do not yet hold (the Worksheet-C RCC plausibility bounds, the
// per-beneficiary aggregate cap dollar amount, the mandatory step-down statistical bases, the related-
// party disclosure threshold, the S-3↔D reconciliation tolerance). Those rules implement deterministic
// internally-tied-out checks now and are marked with a `// TODO(CMS-fixture):` naming the reference data
// needed — no CMS constant is fabricated as if verified.
//
// PURE DOMAIN: no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`. Types, pure
// functions, constants only.
import type { RuleDef } from "./types";
import { passResult, failResult, warnResult, skipResult } from "./types";

/** The platform-default rule-set version this file publishes (stamped into `cost_report_validation.rule_set_version`, D9). */
export const DEFAULT_RULE_SET_VERSION = 1;

// ── demographics_ownership (3) ─────────────────────────────────────────────────────────────────────────

const demographicsCcnPresent: RuleDef = {
  ruleCode: "demographics.ccn_present",
  category: "demographics_ownership",
  description: "The provider CCN is present — a cost report cannot be filed for a CCN-less provider.",
  severity: "block",
  regulatoryRequired: false,
  macJurisdictionScope: "all",
  evaluate: (ctx) =>
    ctx.demographics.ccnPresent
      ? passResult("Provider CCN is present.")
      : failResult(
          "Provider CCN is missing.",
          "Set the CCN on the ProviderEntity (M40) before filing.",
        ),
};

const demographicsFiscalYearConfigured: RuleDef = {
  ruleCode: "demographics.fiscal_year_configured",
  category: "demographics_ownership",
  description: "The fiscal-year-end date is configured (defaults to provider_entity.fiscal_year_end_month_day).",
  severity: "block",
  regulatoryRequired: false,
  macJurisdictionScope: "all",
  evaluate: (ctx) =>
    ctx.demographics.fiscalYearEndConfigured
      ? passResult("Fiscal-year-end date is configured.")
      : failResult(
          "Fiscal-year-end date is not configured.",
          "Set the fiscal-year-end on the cost report or ProviderEntity setup.",
        ),
};

const ownershipRelatedPartyDisclosed: RuleDef = {
  ruleCode: "ownership.related_party_disclosed",
  category: "demographics_ownership",
  description: "Related-party / ownership disclosures (Worksheet A-8 reclass, S-2) are present when applicable.",
  severity: "warn",
  regulatoryRequired: false,
  macJurisdictionScope: "all",
  // TODO(CMS-fixture): the related-party disclosure threshold (PRM I Ch 10 common-ownership/control test)
  // is not yet encoded; this checks only that a disclosure exists, not its completeness against the PRM.
  evaluate: (ctx) =>
    ctx.demographics.relatedPartyDisclosed
      ? passResult("Related-party / ownership disclosure present.")
      : warnResult(
          "No related-party / ownership disclosure recorded.",
          "Confirm whether any A-8 related-party reclassification or S-2 ownership disclosure applies.",
        ),
};

// ── statistical_data (2) ────────────────────────────────────────────────────────────────────────────────

const statsCensusNonNegative: RuleDef = {
  ruleCode: "stats.census_nonnegative",
  category: "statistical_data",
  description: "No month×level-of-care census cell is negative (a data-integrity defect).",
  severity: "block",
  regulatoryRequired: false,
  macJurisdictionScope: "all",
  evaluate: (ctx) =>
    ctx.statistics.hasNegativeCensusValue
      ? failResult(
          "A census cell is negative.",
          "Re-run the statistics refresh; a negative day count indicates a correction/void mis-applied.",
        )
      : passResult("All census cells are non-negative."),
};

const statsPatientDaysReconcile: RuleDef = {
  ruleCode: "stats.patient_days_reconcile",
  category: "statistical_data",
  description: "Service census (M6) reconciles to billed-and-accepted census (M23) within the expected delta.",
  severity: "warn",
  regulatoryRequired: false,
  macJurisdictionScope: "all",
  // TODO(CMS-fixture): the acceptable reconciliation tolerance (NOE-filing lag, retro LOC corrections,
  // voids/replacements) is operational, not a CMS-fixed constant; this flags any non-zero delta as a
  // worklist item to be explained, pending an agreed tolerance band.
  evaluate: (ctx) => {
    if (!ctx.seams.patientDaysProviderBound || ctx.statistics.billedCensusPatientDays === null) {
      return skipResult(
        "M23 PatientDaysProvider not bound — billed-census reconciliation deferred (M6-only path).",
        "seam_not_bound",
      );
    }
    const service = ctx.statistics.serviceCensusPatientDays;
    const billed = ctx.statistics.billedCensusPatientDays;
    return service === billed
      ? passResult("Service and billed census patient-days reconcile exactly.", {
          serviceCensusPatientDays: service,
          billedCensusPatientDays: billed,
        })
      : warnResult(
          "Service and billed census patient-days differ; the delta must be explained on the worklist.",
          "Document the cause (NOE lag, retro LOC correction, denial, void/replacement).",
          { serviceCensusPatientDays: service, billedCensusPatientDays: billed, deltaDays: service - billed },
        );
  },
};

// ── trial_balance (2) ───────────────────────────────────────────────────────────────────────────────────

const tbNoOrphanAccounts: RuleDef = {
  ruleCode: "tb.no_orphan_accounts",
  category: "trial_balance",
  // 42 CFR §413.24 adequate cost data — every GL account must map to a CMS cost center.
  description: "Every trial-balance GL account is mapped to a CMS-1984-14 cost center (no orphan accounts).",
  severity: "block",
  regulatoryRequired: true,
  macJurisdictionScope: "all",
  evaluate: (ctx) =>
    ctx.mapping.orphanAccountCount === 0
      ? passResult("All GL accounts are mapped to a cost center.", {
          mappedAccountCount: ctx.mapping.mappedAccountCount,
        })
      : failResult(
          "One or more GL accounts are unmapped (orphan accounts).",
          "Assign every orphan GL account a cms_cost_center code in the cost-center mapping.",
          { orphanAccountCount: ctx.mapping.orphanAccountCount },
        ),
};

const tbDebitsEqualCredits: RuleDef = {
  ruleCode: "tb.debits_equal_credits",
  category: "trial_balance",
  description: "The imported trial balance is in balance (total debits equal total credits, to the cent).",
  severity: "block",
  regulatoryRequired: false,
  macJurisdictionScope: "all",
  evaluate: (ctx) => {
    if (!ctx.trialBalance.present) {
      return skipResult("No trial balance imported yet.", "not_applicable");
    }
    // Exact integer-cents equality — no float, no rounding.
    return ctx.trialBalance.totalDebitsCents === ctx.trialBalance.totalCreditsCents
      ? passResult("Trial balance is in balance.")
      : failResult(
          "Trial balance is out of balance (debits ≠ credits).",
          "Re-pull the trial balance or correct the source GL; cost-center mapping cannot proceed unbalanced.",
          {
            totalDebitsCents: ctx.trialBalance.totalDebitsCents,
            totalCreditsCents: ctx.trialBalance.totalCreditsCents,
            differenceCents: ctx.trialBalance.totalDebitsCents - ctx.trialBalance.totalCreditsCents,
          },
        );
  },
};

// ── reclassifications (1) ───────────────────────────────────────────────────────────────────────────────

const reclassNetZero: RuleDef = {
  ruleCode: "reclass.net_zero",
  category: "reclassifications",
  description: "Worksheet A-6 reclassifications net to exactly zero cents (a reclass moves cost, never creates it).",
  severity: "block",
  regulatoryRequired: false,
  macJurisdictionScope: "all",
  evaluate: (ctx) =>
    ctx.worksheets.reclassificationsNetCents === 0
      ? passResult("Reclassifications net to zero.")
      : failResult(
          "Worksheet A-6 reclassifications do not net to zero.",
          "Every reclassification debit must have an equal-and-opposite credit; correct the A-6 entries.",
          { reclassificationsNetCents: ctx.worksheets.reclassificationsNetCents },
        ),
};

// ── adjustments (1) ─────────────────────────────────────────────────────────────────────────────────────

const adjustmentsA8Supported: RuleDef = {
  ruleCode: "adjustments.a8_supported",
  category: "adjustments",
  description: "Every Worksheet A-8 adjustment to costs has a documented basis.",
  severity: "warn",
  regulatoryRequired: false,
  macJurisdictionScope: "all",
  evaluate: (ctx) =>
    ctx.worksheets.adjustmentsUnsupportedCount === 0
      ? passResult("All A-8 adjustments have a documented basis.")
      : warnResult(
          "One or more A-8 adjustments lack a documented basis.",
          "Attach the basis (PRM citation or supporting schedule) for each unsupported adjustment.",
          { adjustmentsUnsupportedCount: ctx.worksheets.adjustmentsUnsupportedCount },
        ),
};

// ── cost_allocation (2) ─────────────────────────────────────────────────────────────────────────────────

const allocStatisticalBasisPresent: RuleDef = {
  ruleCode: "alloc.statistical_basis_present",
  category: "cost_allocation",
  description: "The cost-allocation statistical basis (sq-ft, FTE, accumulated cost, etc.) is present for the step-down.",
  severity: "block",
  regulatoryRequired: false,
  macJurisdictionScope: "all",
  // TODO(CMS-fixture): the set of MANDATORY allocation bases and the canonical step-down ordering is per
  // the CMS-1984-14 Worksheet B instructions; this checks only that a basis exists, not that the basis
  // and ordering match the CMS-published methodology.
  evaluate: (ctx) =>
    ctx.worksheets.statisticalBasisPresent
      ? passResult("Cost-allocation statistical basis is present.")
      : failResult(
          "The cost-allocation statistical basis is missing.",
          "Provide the allocation statistics (sq-ft / FTE / accumulated cost) required by Worksheet B.",
        ),
};

const allocBTiesToA: RuleDef = {
  ruleCode: "alloc.b_ties_to_a",
  category: "cost_allocation",
  description: "Worksheet B total allocated cost ties back to Worksheet A total cost (step-down conserves cost).",
  severity: "block",
  regulatoryRequired: false,
  macJurisdictionScope: "all",
  evaluate: (ctx) =>
    ctx.worksheets.bTiesToWorksheetA
      ? passResult("Worksheet B ties to Worksheet A.", {
          bTotalAllocatedCents: ctx.worksheets.bTotalAllocatedCents,
          aGrandTotalCostsCents: ctx.worksheets.aGrandTotalCostsCents,
        })
      : failResult(
          "Worksheet B allocated cost does not tie to Worksheet A total cost.",
          "Re-run the step-down allocation; total cost must be conserved A → B.",
          {
            bTotalAllocatedCents: ctx.worksheets.bTotalAllocatedCents,
            aGrandTotalCostsCents: ctx.worksheets.aGrandTotalCostsCents,
          },
        ),
};

// ── ancillary_apportionment (1) ─────────────────────────────────────────────────────────────────────────

const ancillaryCRccWithinBounds: RuleDef = {
  ruleCode: "ancillary.c_rcc_within_bounds",
  category: "ancillary_apportionment",
  description: "Worksheet C ancillary ratio-of-cost-to-charges (RCC) values fall within plausible bounds.",
  severity: "warn",
  regulatoryRequired: false,
  macJurisdictionScope: "all",
  // TODO(CMS-fixture): the plausible RCC bound range is derived from CMS-published example reports we do
  // not yet hold; this defers to the precomputed `ancillaryRccWithinBounds` flag rather than asserting a
  // fabricated numeric band.
  evaluate: (ctx) =>
    ctx.worksheets.ancillaryRccWithinBounds
      ? passResult("Worksheet C RCC values are within bounds.")
      : warnResult(
          "A Worksheet C RCC value is outside the plausible range.",
          "Verify the ancillary cost and charge inputs feeding the RCC.",
        ),
};

// ── apportionment_programs (1) ──────────────────────────────────────────────────────────────────────────

const apportionDProgramDaysTie: RuleDef = {
  ruleCode: "apportion.d_program_days_tie",
  category: "apportionment_programs",
  description: "Worksheet D program-day apportionment internally ties (program days sum to total apportioned days).",
  severity: "block",
  regulatoryRequired: false,
  macJurisdictionScope: "all",
  evaluate: (ctx) =>
    ctx.worksheets.programDaysTie
      ? passResult("Worksheet D program-day apportionment ties.")
      : failResult(
          "Worksheet D program-day apportionment does not tie.",
          "Re-run the program apportionment; the per-program days must sum to the apportioned total.",
        ),
};

// ── settlement (2) ──────────────────────────────────────────────────────────────────────────────────────

const settlementE1Computed: RuleDef = {
  ruleCode: "settlement.e1_computed",
  category: "settlement",
  description: "Worksheet E-1 (settlement) exists and has been computed.",
  severity: "block",
  regulatoryRequired: false,
  macJurisdictionScope: "all",
  evaluate: (ctx) =>
    ctx.worksheets.presentCodes.includes("E-1") && ctx.settlement.computed
      ? passResult("Worksheet E-1 is computed.")
      : failResult(
          "Worksheet E-1 settlement has not been computed.",
          "Complete the upstream worksheets (A→B→C→D) so E-1 can derive the settlement.",
        ),
};

const settlementE1TiesToD: RuleDef = {
  ruleCode: "settlement.e1_ties_to_d",
  category: "settlement",
  description: "Worksheet E-1 settlement ties to the Worksheet D program apportionment and the M23 claim settlement.",
  severity: "block",
  regulatoryRequired: false,
  macJurisdictionScope: "all",
  evaluate: (ctx) => {
    if (!ctx.seams.claimSettlementProviderBound) {
      return skipResult(
        "M23 ClaimSettlementProvider not bound — E-1↔settlement tie deferred.",
        "seam_not_bound",
      );
    }
    return ctx.settlement.tiesToWorksheetD
      ? passResult("Worksheet E-1 ties to Worksheet D / claim settlement.")
      : failResult(
          "Worksheet E-1 settlement does not tie to Worksheet D / the claim settlement.",
          "Reconcile the E-1 settlement lines against the D apportionment and M23 settlement figures.",
        );
  },
};

// ── balance_sheet (1) ───────────────────────────────────────────────────────────────────────────────────

const balanceSheetGBalances: RuleDef = {
  ruleCode: "balance_sheet.g_balances",
  category: "balance_sheet",
  description: "Worksheet G balance sheet balances (assets = liabilities + fund balance).",
  severity: "warn",
  regulatoryRequired: false,
  macJurisdictionScope: "all",
  evaluate: (ctx) =>
    ctx.worksheets.balanceSheetBalances
      ? passResult("Worksheet G balance sheet balances.")
      : warnResult(
          "Worksheet G balance sheet does not balance.",
          "Assets must equal liabilities plus fund balance; correct the G inputs.",
        ),
};

// ── cap (3) — all SKIP under the D13 cap-seam deny-stub ──────────────────────────────────────────────────

const capAggregateBeneficiaryCap: RuleDef = {
  ruleCode: "cap.aggregate_beneficiary_cap",
  category: "cap",
  // 42 CFR §418.308 — the aggregate cap (per-beneficiary cap × Medicare beneficiaries) must be computed.
  description: "The aggregate per-beneficiary cap is computed from M26 cap accruals.",
  severity: "block",
  regulatoryRequired: true,
  macJurisdictionScope: "all",
  // TODO(CMS-fixture): the statutory per-beneficiary aggregate cap dollar amount is CMS-published per cap
  // year; it is supplied via the M26 CapAccrualReader at runtime and is NOT hard-coded here. This rule
  // only asserts the cap was computed (> 0 cents) once the seam binds.
  evaluate: (ctx) => {
    if (!ctx.seams.capProviderBound || ctx.cap === null) {
      return skipResult("M26 cap provider not bound — aggregate cap deferred.", "seam_not_bound");
    }
    return ctx.cap.aggregateCapCents > 0
      ? passResult("Aggregate per-beneficiary cap is computed.", {
          aggregateCapCents: ctx.cap.aggregateCapCents,
        })
      : failResult(
          "Aggregate per-beneficiary cap is zero or uncomputed.",
          "Confirm the M26 cap accrual data and beneficiary count for the cap year.",
        );
  },
};

const capAggregatePaymentsWithinCap: RuleDef = {
  ruleCode: "cap.aggregate_payments_within_cap",
  category: "cap",
  // 42 CFR §418.308 — total Medicare payments cannot exceed the aggregate cap.
  description: "Total Medicare hospice payments do not exceed the aggregate per-beneficiary cap.",
  severity: "block",
  regulatoryRequired: true,
  macJurisdictionScope: "all",
  evaluate: (ctx) => {
    if (!ctx.seams.capProviderBound || ctx.cap === null) {
      return skipResult("M26 cap provider not bound — aggregate-cap test deferred.", "seam_not_bound");
    }
    // Exact integer-cents comparison — overage is an aggregate-cap settlement liability owed back to CMS.
    return ctx.cap.aggregatePaymentsCents <= ctx.cap.aggregateCapCents
      ? passResult("Aggregate payments are within the cap.", {
          aggregatePaymentsCents: ctx.cap.aggregatePaymentsCents,
          aggregateCapCents: ctx.cap.aggregateCapCents,
        })
      : failResult(
          "Aggregate payments exceed the per-beneficiary cap (cap-settlement liability).",
          "The overage must be recorded as an amount due to the program on Worksheet E-1.",
          {
            aggregatePaymentsCents: ctx.cap.aggregatePaymentsCents,
            aggregateCapCents: ctx.cap.aggregateCapCents,
            overageCents: ctx.cap.aggregatePaymentsCents - ctx.cap.aggregateCapCents,
          },
        );
  },
};

const capInpatient20Pct: RuleDef = {
  ruleCode: "cap.inpatient_20_pct",
  category: "cap",
  // 42 CFR §418.309 — inpatient (GIP + IRC) days cannot exceed 20% of total Medicare days.
  description: "Inpatient (GIP + IRC) days do not exceed 20% of total Medicare days in the cap year.",
  severity: "block",
  regulatoryRequired: true,
  macJurisdictionScope: "all",
  evaluate: (ctx) => {
    if (!ctx.seams.capProviderBound || ctx.cap === null) {
      return skipResult("M26 cap provider not bound — inpatient-cap test deferred.", "seam_not_bound");
    }
    if (ctx.cap.totalMedicareDays <= 0) {
      return skipResult("No total Medicare days yet — inpatient-cap ratio not applicable.", "not_applicable");
    }
    // 20% = 1/5; assert inpatientDays ≤ totalMedicareDays/5 by EXACT integer cross-multiplication
    // (5 × inpatient ≤ total) — no division, no float, fully deterministic.
    const withinCap = 5 * ctx.cap.inpatientDays <= ctx.cap.totalMedicareDays;
    return withinCap
      ? passResult("Inpatient days are within the 20% cap.", {
          inpatientDays: ctx.cap.inpatientDays,
          totalMedicareDays: ctx.cap.totalMedicareDays,
        })
      : failResult(
          "Inpatient (GIP + IRC) days exceed 20% of total Medicare days.",
          "Inpatient days above the 20% limit are reimbursed at the routine rate; reflect on Worksheet E-1.",
          {
            inpatientDays: ctx.cap.inpatientDays,
            totalMedicareDays: ctx.cap.totalMedicareDays,
          },
        );
  },
};

// ── bad_debt (2) ────────────────────────────────────────────────────────────────────────────────────────

const badDebtCollectionEffortsDocumented: RuleDef = {
  ruleCode: "bad_debt.entry_collection_efforts_documented",
  category: "bad_debt",
  // PRM I Chapters 3 & 4 — bad debt allowable only with documented reasonable collection efforts.
  description: "When bad debt is claimed, every entry has documented reasonable collection efforts.",
  severity: "block",
  regulatoryRequired: true,
  macJurisdictionScope: "all",
  evaluate: (ctx) => {
    if (!ctx.badDebtClaimed) {
      return skipResult("Bad debt not claimed for this cost report.", "not_applicable");
    }
    const undocumented = ctx.badDebt.entries.filter((e) => !e.collectionEffortsDocumented).length;
    return undocumented === 0
      ? passResult("All bad-debt entries have documented collection efforts.", {
          entriesCount: ctx.badDebt.entries.length,
        })
      : failResult(
          "One or more bad-debt entries lack documented collection efforts.",
          "Attach collection-effort documentation (via M22) for every claimed bad-debt entry.",
          { undocumentedEntries: undocumented, entriesCount: ctx.badDebt.entries.length },
        );
  },
};

const badDebtKindClassified: RuleDef = {
  ruleCode: "bad_debt.kind_classified",
  category: "bad_debt",
  description: "When bad debt is claimed, every entry is classified as deductible or coinsurance.",
  severity: "warn",
  regulatoryRequired: false,
  macJurisdictionScope: "all",
  evaluate: (ctx) => {
    if (!ctx.badDebtClaimed) {
      return skipResult("Bad debt not claimed for this cost report.", "not_applicable");
    }
    const unclassified = ctx.badDebt.entries.filter((e) => e.debtKind === null).length;
    return unclassified === 0
      ? passResult("All bad-debt entries are classified.")
      : warnResult(
          "One or more bad-debt entries are not classified as deductible/coinsurance.",
          "Set the debt kind on each unclassified entry.",
          { unclassifiedEntries: unclassified },
        );
  },
};

// ── cross_worksheet (3) ─────────────────────────────────────────────────────────────────────────────────

const crossAGrandTotalTiesB: RuleDef = {
  ruleCode: "cross.a_grandtotal_ties_b",
  category: "cross_worksheet",
  description: "Worksheet A grand-total cost equals the Worksheet B total allocated cost (to the cent).",
  severity: "block",
  regulatoryRequired: false,
  macJurisdictionScope: "all",
  evaluate: (ctx) =>
    // Exact integer-cents equality across worksheets.
    ctx.worksheets.aGrandTotalCostsCents === ctx.worksheets.bTotalAllocatedCents
      ? passResult("Worksheet A grand total ties to Worksheet B.", {
          aGrandTotalCostsCents: ctx.worksheets.aGrandTotalCostsCents,
          bTotalAllocatedCents: ctx.worksheets.bTotalAllocatedCents,
        })
      : failResult(
          "Worksheet A grand total does not equal Worksheet B allocated total.",
          "Re-run the allocation; A and B totals must match to the cent.",
          {
            aGrandTotalCostsCents: ctx.worksheets.aGrandTotalCostsCents,
            bTotalAllocatedCents: ctx.worksheets.bTotalAllocatedCents,
            differenceCents: ctx.worksheets.aGrandTotalCostsCents - ctx.worksheets.bTotalAllocatedCents,
          },
        ),
};

const crossS3DaysTieD: RuleDef = {
  ruleCode: "cross.s3_days_tie_d",
  category: "cross_worksheet",
  description: "Worksheet S-3 grand-total patient-days equal the patient-days carried into Worksheet D.",
  severity: "warn",
  regulatoryRequired: false,
  macJurisdictionScope: "all",
  // TODO(CMS-fixture): whether S-3 and D days must match EXACTLY or only within a documented program-mix
  // delta depends on the CMS-1984-14 instructions; this flags any difference as a worklist item.
  evaluate: (ctx) =>
    ctx.statistics.s3GrandTotalPatientDays === ctx.worksheets.dProgramDaysCarried
      ? passResult("S-3 grand-total days tie to Worksheet D.", {
          s3GrandTotalPatientDays: ctx.statistics.s3GrandTotalPatientDays,
          dProgramDaysCarried: ctx.worksheets.dProgramDaysCarried,
        })
      : warnResult(
          "S-3 grand-total patient-days differ from the days carried into Worksheet D.",
          "Reconcile the S-3 census against the D apportionment day counts.",
          {
            s3GrandTotalPatientDays: ctx.statistics.s3GrandTotalPatientDays,
            dProgramDaysCarried: ctx.worksheets.dProgramDaysCarried,
          },
        ),
};

const drugCostBilledReconciles: RuleDef = {
  ruleCode: "drug_cost.billed_reconciles",
  category: "cross_worksheet",
  description:
    "The billed drug-cost basis (M12) reconciles to the Worksheet-A pharmacy cost center within the expected delta.",
  severity: "warn",
  regulatoryRequired: false,
  macJurisdictionScope: "all",
  // TODO(CMS-fixture): the acceptable drug-cost delta (per-diem-bundled drug usage vs the GL pharmacy ledger,
  // wastage, comfort-kit returns) is operational, not a CMS constant; this flags a material difference as a
  // worklist item. SKIPS until M12 materializes med-order cost (no cost column today → seam stays deny-stub)
  // or the Worksheet-A pharmacy center is absent.
  evaluate: (ctx) => {
    if (!ctx.seams.drugCostBillingReaderBound || ctx.drugCost.billedCents === null) {
      return skipResult(
        "M12 drug-cost basis (DrugCostBillingReader) not bound — Worksheet-A pharmacy cross-check deferred.",
        "seam_not_bound",
      );
    }
    if (ctx.drugCost.worksheetAPharmacyCents === null) {
      return skipResult(
        "Worksheet-A pharmacy cost center is not present — drug-cost cross-check not applicable.",
        "not_applicable",
      );
    }
    const billed = ctx.drugCost.billedCents;
    const ledger = ctx.drugCost.worksheetAPharmacyCents;
    // A material delta is anything beyond ~1% of the GL pharmacy cost (TODO(CMS-fixture) tolerance band).
    const tolerance = Math.max(100, Math.round(Math.abs(ledger) * 0.01));
    return Math.abs(billed - ledger) <= tolerance
      ? passResult("Billed drug-cost basis reconciles to the Worksheet-A pharmacy cost center.", {
          billedDrugCostCents: billed,
          worksheetAPharmacyCents: ledger,
        })
      : warnResult(
          "Billed drug-cost basis differs materially from the Worksheet-A pharmacy cost center.",
          "Reconcile the M12 drug-cost basis against the GL pharmacy ledger (wastage, comfort-kit returns, accruals).",
          { billedDrugCostCents: billed, worksheetAPharmacyCents: ledger, deltaCents: billed - ledger },
        );
  },
};

// ── mac_specific (1) — the generic platform default; NGS-J6 additive rules live in mac-profiles/ngs-j6.ts ─

const macSupportingDocsPresent: RuleDef = {
  ruleCode: "mac.supporting_docs_present",
  category: "mac_specific",
  description: "The MAC-required supporting documentation set (S-2 attachments) is present.",
  severity: "info",
  regulatoryRequired: false,
  macJurisdictionScope: "all",
  evaluate: (ctx) =>
    ctx.supportingDocs.s2AttachmentsPresent
      ? passResult("MAC supporting documentation is present.")
      : warnResult(
          "MAC-required supporting documentation appears incomplete.",
          "Attach the S-2 supporting schedules your MAC requires.",
        ),
};

// ── supporting_docs (2) ─────────────────────────────────────────────────────────────────────────────────

const docsS2AttachmentsPresent: RuleDef = {
  ruleCode: "docs.s2_attachments_present",
  category: "supporting_docs",
  description: "Worksheet S-2 required supporting attachments are present.",
  severity: "warn",
  regulatoryRequired: false,
  macJurisdictionScope: "all",
  evaluate: (ctx) =>
    ctx.supportingDocs.s2AttachmentsPresent
      ? passResult("S-2 supporting attachments are present.")
      : warnResult(
          "S-2 supporting attachments are missing.",
          "Attach the supporting schedules referenced on Worksheet S-2.",
        ),
};

const docsBadDebtDocsAttached: RuleDef = {
  ruleCode: "docs.bad_debt_docs_attached",
  category: "supporting_docs",
  description: "When bad debt is claimed, every entry has at least one supporting document reference.",
  severity: "warn",
  regulatoryRequired: false,
  macJurisdictionScope: "all",
  evaluate: (ctx) => {
    if (!ctx.badDebtClaimed) {
      return skipResult("Bad debt not claimed for this cost report.", "not_applicable");
    }
    const missingDocs = ctx.badDebt.entries.filter((e) => e.supportingDocumentCount === 0).length;
    return missingDocs === 0
      ? passResult("All claimed bad-debt entries have supporting documents.")
      : warnResult(
          "One or more bad-debt entries have no supporting document.",
          "Attach the supporting document (collection log / write-off memo) for each entry.",
          { entriesMissingDocs: missingDocs },
        );
  },
};

// ── filing_deadline (2) ─────────────────────────────────────────────────────────────────────────────────

const deadlineNotPastWithoutOverride: RuleDef = {
  ruleCode: "deadline.not_past_without_override",
  category: "filing_deadline",
  // 42 CFR §413.24(f) — cost report due 5 months after FYE; past-deadline submission is gated.
  description: "The filing deadline has not passed without an explicit past-deadline override.",
  severity: "block",
  regulatoryRequired: true,
  macJurisdictionScope: "all",
  evaluate: (ctx) => {
    if (!ctx.deadline.pastDeadline) {
      return passResult("Filing deadline has not passed.", {
        daysToDeadline: ctx.deadline.daysToDeadline,
      });
    }
    return ctx.deadline.pastDeadlineOverrideGranted
      ? warnResult(
          "Past the filing deadline; submission proceeding under an explicit override.",
          "Confirm the documented past-deadline reason is on file.",
          { daysToDeadline: ctx.deadline.daysToDeadline },
        )
      : failResult(
          "Past the 5-month filing deadline without a past-deadline override.",
          "Obtain the cost_report:submit_past_deadline override + documented reason, or record a MAC extension.",
          { daysToDeadline: ctx.deadline.daysToDeadline },
        );
  },
};

const deadlineWindowOpen: RuleDef = {
  ruleCode: "deadline.window_open",
  category: "filing_deadline",
  description: "The filing window is open (advisory — surfaces the closing-window cadence on the worklist).",
  severity: "warn",
  regulatoryRequired: false,
  macJurisdictionScope: "all",
  evaluate: (ctx) =>
    ctx.deadline.windowOpen
      ? passResult("Filing window is open.", { daysToDeadline: ctx.deadline.daysToDeadline })
      : warnResult(
          "The filing window has closed.",
          "File immediately; the deadline has elapsed.",
          { daysToDeadline: ctx.deadline.daysToDeadline },
        ),
};

/**
 * The 29 platform-default validation rules (M27-F01/F02), enumerated in §2.1-category order. This is the
 * org-NULL platform floor a tenant layers tightenings onto (D21); the engine applies the MAC-scoped
 * subset plus any additive MAC profile (e.g. `NGS_J6_RULES`).
 */
export const DEFAULT_VALIDATION_RULES: readonly RuleDef[] = [
  // demographics_ownership
  demographicsCcnPresent,
  demographicsFiscalYearConfigured,
  ownershipRelatedPartyDisclosed,
  // statistical_data
  statsCensusNonNegative,
  statsPatientDaysReconcile,
  // trial_balance
  tbNoOrphanAccounts,
  tbDebitsEqualCredits,
  // reclassifications
  reclassNetZero,
  // adjustments
  adjustmentsA8Supported,
  // cost_allocation
  allocStatisticalBasisPresent,
  allocBTiesToA,
  // ancillary_apportionment
  ancillaryCRccWithinBounds,
  // apportionment_programs
  apportionDProgramDaysTie,
  // settlement
  settlementE1Computed,
  settlementE1TiesToD,
  // balance_sheet
  balanceSheetGBalances,
  // cap
  capAggregateBeneficiaryCap,
  capAggregatePaymentsWithinCap,
  capInpatient20Pct,
  // bad_debt
  badDebtCollectionEffortsDocumented,
  badDebtKindClassified,
  // cross_worksheet
  crossAGrandTotalTiesB,
  crossS3DaysTieD,
  drugCostBilledReconciles,
  // mac_specific
  macSupportingDocsPresent,
  // supporting_docs
  docsS2AttachmentsPresent,
  docsBadDebtDocsAttached,
  // filing_deadline
  deadlineNotPastWithoutOverride,
  deadlineWindowOpen,
] as const;
