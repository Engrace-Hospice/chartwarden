// @chartwarden/billing — continuous home care (revenue code 0652) line units. CMS Pub. 100-04 ch. 11 §30.3: "report
// a separately dated line item for each day that continuous home care is provided, reporting the number of
// hours, or parts of hours rounded to 15-minute increments"; units for 0652 are 15-minute increments (payment
// needs 32 or more units in the day). The HIPPS calculator prices a CHC day as hours x the wage-adjusted HOURLY
// rate; this converts that single-day segment into the claim line's quarter-hour unit model. PURE.
import type { Cents } from "../domain/money";
import { lineChargeCents } from "../domain/money";

/** A CHC hour is four 15-minute units. */
export const CHC_UNITS_PER_HOUR = 4;

export interface ChcSegmentInput {
  /** The documented hours the day was priced on (`PerDiemClassSegmentResult.chcHours`). */
  readonly chcHours: number | null;
  /** The wage-adjusted hourly rate the day was priced at (`chcAdjustedHourlyRateCents`). */
  readonly chcAdjustedHourlyRateCents: Cents | null;
}

export interface ChcLineUnits {
  readonly unitCount: number;
  readonly unitRateCents: Cents;
  readonly lineChargeCents: Cents;
}

/**
 * The 0652 line for one CHC day: `unitCount` quarter-hours at a quarter of the hourly rate rounded half-up to
 * whole cents, so `line_charge = unit_count x unit_rate` holds (the table CHECK). The billed charge can differ
 * from the exact `hours x hourly` payment basis by under a cent per unit; the expected-payment figure keeps the
 * exact basis, and charges are informational on a hospice claim (ch. 11 §30.3 "Total Charges").
 */
export function chcLineFromSegment(segment: ChcSegmentInput): ChcLineUnits {
  const { chcHours, chcAdjustedHourlyRateCents } = segment;
  if (chcHours === null || !Number.isFinite(chcHours)) {
    throw new RangeError("chcLineFromSegment: a CHC segment needs its documented hours");
  }
  if (chcAdjustedHourlyRateCents === null) {
    throw new RangeError("chcLineFromSegment: a CHC segment needs its adjusted hourly rate");
  }
  const units = chcHours * CHC_UNITS_PER_HOUR;
  if (!Number.isInteger(units) || units <= 0) {
    throw new RangeError(
      `chcLineFromSegment: ${chcHours} hours is not a whole number of 15-minute units`,
    );
  }
  const unitRateCents = lineChargeCents(1 / CHC_UNITS_PER_HOUR, chcAdjustedHourlyRateCents);
  return {
    unitCount: units,
    unitRateCents,
    lineChargeCents: lineChargeCents(units, unitRateCents),
  };
}
