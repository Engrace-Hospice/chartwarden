// @wardenx/billing — HIPPS pricing across a federal fiscal-year boundary (pure).
//
// The hospice rates and the wage index change on Oct 1 (CMS publishes both per fiscal year). A claim whose
// from-through range crosses Oct 1 therefore prices each day with ITS OWN fiscal year's rate table and wage index —
// never the whole claim at the first day's year. `calculateHipps` stays single-year; this splits the range at Oct 1,
// prices each part with that year's inputs, and merges the parts. The RHC day-of-stay count is computed from the
// admission date inside each part, so it runs on across the boundary (day 60 -> 61 is unaffected by the split).
import type { IsoDate } from "../contracts";
import { addDaysIso } from "../domain/dates";
import { hospiceFiscalYearStartingOf } from "../rate-table";
import {
  type HippsCalculationInput,
  type HippsCalculationResult,
  type HippsRateTable,
  type HippsSegmentResult,
  calculateHipps,
  derivePerDiemClassCode,
} from "./calculator";
import type { WageIndexAreaFactors } from "./wage-index-area";

export interface FiscalYearPart {
  readonly fiscalYearStarting: number;
  readonly from: IsoDate;
  readonly to: IsoDate;
}

/** The claim range cut at each Oct 1, oldest first (one part when it stays inside a fiscal year). */
export function splitAtFiscalYears(from: IsoDate, to: IsoDate): readonly FiscalYearPart[] {
  const parts: FiscalYearPart[] = [];
  let cursor = from;
  while (cursor <= to) {
    const fiscalYearStarting = hospiceFiscalYearStartingOf(cursor);
    const yearEnd = `${fiscalYearStarting + 1}-09-30`;
    const partTo = yearEnd < to ? yearEnd : to;
    parts.push({ fiscalYearStarting, from: cursor, to: partTo });
    cursor = addDaysIso(partTo, 1);
  }
  return parts;
}

/** Everything that varies with the fiscal year. */
export interface FiscalYearPricing {
  readonly fiscalYearStarting: number;
  readonly rateTable: HippsRateTable;
  /** The provider's wage index for the year (used when no area factors are bound). */
  readonly wageIndexFactorDecimal: string;
  readonly wageIndexAreaFactors?: WageIndexAreaFactors;
}

export type FiscalYearClaimInput = Omit<
  HippsCalculationInput,
  "rateTable" | "wageIndexFiscalYear" | "wageIndexFactorDecimal" | "wageIndexAreaFactors"
>;

export function calculateHippsByFiscalYear(
  input: FiscalYearClaimInput,
  pricingFor: (fiscalYearStarting: number) => FiscalYearPricing,
): HippsCalculationResult {
  const parts = splitAtFiscalYears(input.claimServiceFrom, input.claimServiceTo);
  const results = parts.map((part) => {
    const pricing = pricingFor(part.fiscalYearStarting);
    return calculateHipps({
      ...input,
      claimServiceFrom: part.from,
      claimServiceTo: part.to,
      rateTable: pricing.rateTable,
      wageIndexFiscalYear: part.fiscalYearStarting,
      wageIndexFactorDecimal: pricing.wageIndexFactorDecimal,
      ...(pricing.wageIndexAreaFactors
        ? { wageIndexAreaFactors: pricing.wageIndexAreaFactors }
        : {}),
    });
  });
  const [first] = results;
  if (first === undefined) throw new RangeError("calculateHippsByFiscalYear: empty claim range");
  if (results.length === 1) return first;

  const segments: HippsSegmentResult[] = results
    .flatMap((r) => r.segments)
    .map((segment, index) => ({ ...segment, hippsCharPosition: index + 1 }));
  return {
    perDiemClassCode: derivePerDiemClassCode(segments),
    perDiemRateCents: segments[0]?.ratePerDiemCents ?? 0,
    wageIndexCcn: first.wageIndexCcn,
    wageIndexFiscalYear: first.wageIndexFiscalYear,
    wageIndexFactorApplied: first.wageIndexFactorApplied,
    segments,
    rhcDays1to60: results.reduce((n, r) => n + r.rhcDays1to60, 0),
    rhcDays61Plus: results.reduce((n, r) => n + r.rhcDays61Plus, 0),
    totalCents: results.reduce((n, r) => n + r.totalCents, 0),
  };
}
