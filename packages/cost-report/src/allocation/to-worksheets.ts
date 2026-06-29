// @wardenx/cost-report — the PURE allocation-RESULT → derived-worksheet mapper (§3.1 `allocation/`, D8). The
// inverse of `assemble-inputs`: it turns the four deterministic chain RESULTS (`StepDownAllocateResult` →
// Worksheet B, `AncillaryApportionResult` → C, `ProgramApportionResult` → D, `SettlementResult` → E-1) back
// into the TypeBox-typed `data` jsonb the `cost_report_worksheet` rows persist, so a `cost-allocation-recompute`
// run materializes the derived worksheets. Total, deterministic functions over already-computed results — no
// DB, no clock, no recomputation. Money is INTEGER CENTS; no PHI (D18).
//
// The cross-worksheet TIE flags are stamped from the facts available to a single recompute: B ties to A (the
// step-down conserves the Worksheet-A pool, `tiesOut`); D ties to B only when the (currently-unmodeled) per-LOC
// allowable cost has been apportioned to equal B's total; E-1 carries the Medicare settlement (the report is
// single-program today) and the Worksheet-S settlement-summary tie stays false until that worksheet is computed.
import type { AncillaryApportionResult, CostReportProgram } from "./ancillary-apportionment";
import type { LevelOfCare, ProgramApportionResult } from "./program-apportionment";
import type { SettlementInput, SettlementResult } from "./settlement";
import type { StepDownAllocateResult } from "./step-down";
import type { WorksheetBData } from "../worksheets/b";
import type { WorksheetCData } from "../worksheets/c";
import type { WorksheetDData } from "../worksheets/d";
import type { WorksheetE1Data } from "../worksheets/e-1";

/** The derived-worksheet `data` payloads a full recompute materializes, keyed by worksheet code. */
export interface DerivedWorksheetPayloads {
  readonly B: WorksheetBData;
  readonly C: WorksheetCData;
  readonly D: WorksheetDData;
  readonly "E-1": WorksheetE1Data;
}

/** `StepDownAllocateResult` → Worksheet B. The persisted `costCenters` are the DIRECT centers (each overhead
 *  center steps to zero and is folded into them); `allocationColumns` records each step's allocated pool. */
export function stepDownToWorksheetB(result: StepDownAllocateResult): WorksheetBData {
  return {
    allocationColumns: result.steps.map((s) => ({
      generalServiceCostCenterCode: s.allocatingCenterCode,
      // The statistical-basis LABEL is not carried on the step result (the weight model is not yet wired);
      // recorded empty until the per-receiving-center basis lands. TODO(CMS-fixture).
      allocationBasis: "",
      poolAmountCents: s.amountAllocatedCents,
    })),
    costCenters: result.centers
      .filter((c) => !c.isOverhead)
      .map((c) => ({
        code: c.code,
        name: c.name,
        directCostCents: c.directCostCents,
        allocatedOverheadCents: c.allocatedInCents,
        fullyAllocatedCostCents: c.totalCostCents,
      })),
    totalFullyAllocatedCostCents: result.totalAllocatedToDirectCents,
    tiesToWorksheetAGrandTotal: result.tiesOut,
    stepDownPreservesTotalExactly: result.tiesOut,
  };
}

/** `AncillaryApportionResult` → Worksheet C. The Medicare program line drives the persisted RCC columns (the
 *  report apportions ancillary cost to Medicare today); a zero-charge basis is flagged, never silently zeroed. */
export function ancillaryToWorksheetC(result: AncillaryApportionResult): WorksheetCData {
  const medicareOf = (lines: AncillaryApportionResult["centers"][number]["programLines"]) =>
    lines.find((l) => l.program === ("medicare" as CostReportProgram));

  const ancillaryCostCenters = result.centers.map((c) => {
    const medicare = medicareOf(c.programLines);
    return {
      code: c.code,
      name: c.name,
      fullyAllocatedCostCents: c.totalCostCents,
      totalChargesCents: c.totalChargesCents,
      ratioOfCostToCharges: Number(c.costToChargeRatio),
      medicareChargesCents: medicare?.chargesCents ?? 0,
      medicareCostCents: medicare?.apportionedCostCents ?? 0,
    };
  });

  return {
    ancillaryCostCenters,
    totalMedicareAncillaryCostCents: ancillaryCostCenters.reduce((s, c) => s + c.medicareCostCents, 0),
    // A center with charges-of-zero but a non-zero cost cannot drive an RCC — surfaced for the worklist (D8).
    hasZeroChargeBasisFlag: result.centers.some((c) => c.totalChargesCents === 0 && c.totalCostCents > 0),
  };
}

/** `ProgramApportionResult` → Worksheet D. The (program × level-of-care) cells roll up into the per-program
 *  level-of-care columns; the apportionment ties to B only when the per-LOC allowable cost equals B's total. */
export function programToWorksheetD(
  result: ProgramApportionResult,
  bTotalFullyAllocatedCostCents: number,
): WorksheetDData {
  const programColumn = (program: CostReportProgram): WorksheetDData["medicare"] => {
    const cells = result.cells.filter((c) => c.program === program);
    const loc = (l: LevelOfCare) =>
      cells.filter((c) => c.levelOfCare === l).reduce((s, c) => s + c.apportionedCostCents, 0);
    const rhcCostCents = loc("rhc");
    const chcCostCents = loc("chc");
    const ircCostCents = loc("irc");
    const gipCostCents = loc("gip");
    return {
      rhcCostCents,
      chcCostCents,
      ircCostCents,
      gipCostCents,
      totalCostCents: rhcCostCents + chcCostCents + ircCostCents + gipCostCents,
      totalDays: cells.reduce((s, c) => s + c.patientDays, 0),
    };
  };

  const medicare = programColumn("medicare");
  const medicaid = programColumn("medicaid");
  const other = programColumn("other");
  const grandTotalApportionedCostCents =
    medicare.totalCostCents + medicaid.totalCostCents + other.totalCostCents;

  return {
    medicare,
    medicaid,
    other,
    grandTotalApportionedCostCents,
    tiesToWorksheetBTotal: grandTotalApportionedCostCents === bTotalFullyAllocatedCostCents,
    // The largest-remainder apportionment conserves its input exactly (`allocateProportional`, D8).
    apportionmentPreservesTotalExactly: true,
  };
}

/** `SettlementResult` (+ its input) → Worksheet E-1. The settlement is single-program (Medicare) today, so the
 *  Medicaid column is zero and the net balance is the Medicare balance; the Worksheet-S settlement-summary tie
 *  stays false until that summary worksheet is computed. */
export function settlementToWorksheetE1(result: SettlementResult, input: SettlementInput): WorksheetE1Data {
  const zeroProgram: WorksheetE1Data["medicaid"] = {
    allowablePaymentCents: 0,
    capOverpaymentCents: 0,
    sequestrationAdjustmentCents: 0,
    reimbursableBadDebtCents: 0,
    interimPaymentsReceivedCents: 0,
    balanceDueProviderCents: 0,
  };

  const medicare: WorksheetE1Data["medicare"] = {
    allowablePaymentCents: input.medicareAllowableCostCents,
    capOverpaymentCents: result.aggregateCap?.overageCents ?? 0,
    sequestrationAdjustmentCents: result.sequestrationReductionCents,
    // Reimbursable bad debt is added at the bad-debt worksheet seam, not the settlement input → 0 here.
    reimbursableBadDebtCents: 0,
    interimPaymentsReceivedCents: input.interimPaymentsCents,
    balanceDueProviderCents: result.balanceDueToProviderCents,
  };

  return {
    medicare,
    medicaid: zeroProgram,
    totalBalanceDueProviderCents: result.balanceDueToProviderCents,
    tiesToWorksheetSSettlementSummary: false,
  };
}

/** Map a full chain run (B → C → D → E-1) to its four derived-worksheet payloads. */
export function allocationResultsToWorksheets(input: {
  readonly stepDown: StepDownAllocateResult;
  readonly ancillary: AncillaryApportionResult;
  readonly program: ProgramApportionResult;
  readonly settlement: SettlementResult;
  readonly settlementInput: SettlementInput;
}): DerivedWorksheetPayloads {
  const B = stepDownToWorksheetB(input.stepDown);
  return {
    B,
    C: ancillaryToWorksheetC(input.ancillary),
    D: programToWorksheetD(input.program, B.totalFullyAllocatedCostCents),
    "E-1": settlementToWorksheetE1(input.settlement, input.settlementInput),
  };
}
