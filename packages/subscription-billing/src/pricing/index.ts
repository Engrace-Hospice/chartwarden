// @chartwarden/subscription-billing — the contracted census-banded pricing model (slice 2). PURE: no IO, no clock.
//
//   platform fee = the GREATER of (active staff accounts x per-user price) and the flat monthly fee of the census band
//                  the average daily census (ADC) falls in, prorated by the days the tenant was live in the month
//   minimum      = the plan's monthly minimum floors the PLATFORM FEE ONLY (prorated the same way); the billing fee is added on top
//   billing fee  = net collections x the plan's rate for the subscription's billing service mode (none => 0); naturally partial
//   total        = platform fee + minimum top-up + billing fee + prior-period billing fee + a one-time fee (the first statement only)
//
// Money is INTEGER CENTS, rates are INTEGER BASIS POINTS, ADC is integer HUNDREDTHS of a patient. Nothing here knows a
// price: every figure arrives on a plan row (the owner edits plans; the platform never hardcodes a dollar amount).
//
// A census band is a THRESHOLD, not a range: it starts at `minAdc` and runs until the next band starts. Thresholds
// cannot overlap or leave a gap, and a fractional ADC such as 16.4 needs no rounding rule: it is below 17, so it is in the 10 band.
import type { BillingServiceMode } from "@chartwarden/types";

/** The owner's five bands: 0-9, 10-16, 17-25, 26-29 and 30+ patients (ADC). A default for a new plan form only; a plan stores its own. */
export const DEFAULT_CENSUS_BAND_THRESHOLDS: readonly number[] = [0, 10, 17, 26, 30];

export const BASIS_POINTS_PER_UNIT = 10_000;
const HUNDREDTHS = 100;

export interface CensusBand {
  /** The band starts at this many patients (whole number, inclusive). */
  readonly minAdc: number;
  readonly monthlyFeeCents: number;
}

export interface PlanPricing {
  readonly perUserPriceCents: number;
  readonly bands: readonly CensusBand[];
  readonly billingSoftwareBps: number;
  readonly managedBillingBps: number;
  /** An optional floor on the month's recurring charge; null = none. */
  readonly minimumMonthlyCents: number | null;
}

/** How much of the month the tenant was live: the platform fee and the minimum are charged by days. */
export interface Proration {
  /** Days of the month the subscription was live and billable, 0 to daysInPeriod (the go-live day counts). */
  readonly daysLive: number;
  /** Days in the calendar month. */
  readonly daysInPeriod: number;
}

export interface StatementInputs {
  readonly staffCount: number;
  /** Average daily census in hundredths of a patient (1_699 = 16.99). */
  readonly adcHundredths: number;
  readonly netCollectionsCents: number;
  readonly mode: BillingServiceMode;
  /** The plan's implementation fee on the first statement of a contract, else 0. */
  readonly oneTimeFeeCents: number;
  /**
   * The census the ADC was averaged from. When given, the BAND is chosen on the exact mean (`dailySum >= threshold x days`, integers),
   * not on the rounded `adcHundredths`: rounding to hundredths can lift a mean just under a threshold onto it. `adcHundredths` is
   * then only what is shown. Absent: the band follows `adcHundredths` (a price preview, where the operator types an ADC).
   */
  readonly census?: { readonly dailySum: number; readonly days: number };
  /** Absent = the whole month. */
  readonly proration?: Proration;
  /** Billing fee on net collections that posted after their own month closed (already computed per source month); default 0. */
  readonly priorPeriodFeeCents?: number;
}

export interface StatementAmounts {
  /** Both sides of the greater-of comparison, for a FULL month. */
  readonly perUserSubtotalCents: number;
  readonly bandMinAdc: number;
  readonly bandFeeCents: number;
  /** The greater side, prorated by `daysLive / daysInPeriod`. */
  readonly platformFeeCents: number;
  /** Which side won. A tie is `census_band` (the flat fee), so the answer is deterministic. */
  readonly platformFeeBasis: "per_user" | "census_band";
  readonly billingBps: number;
  readonly billingFeeCents: number;
  readonly oneTimeFeeCents: number;
  /** The top-up that lifts the platform fee to the (prorated) plan minimum; 0 without a minimum or above it. */
  readonly minimumAdjustmentCents: number;
  readonly priorPeriodFeeCents: number;
  readonly totalCents: number;
}

export interface PricingIssue {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

const isCount = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

function assertCount(name: string, n: number): void {
  if (!isCount(n)) throw new RangeError(`${name} must be a non-negative whole number, got ${n}`);
}

/** The band whose threshold is the highest one at or below `adcHundredths`. Throws when no band starts at 0. */
export function selectCensusBand(bands: readonly CensusBand[], adcHundredths: number): CensusBand {
  assertCount("adcHundredths", adcHundredths);
  const ascending = [...bands].sort((a, b) => a.minAdc - b.minAdc);
  if (ascending[0]?.minAdc !== 0) {
    throw new RangeError("a plan needs a census band that starts at 0 patients");
  }
  let chosen = ascending[0];
  for (const band of ascending) {
    if (band.minAdc * HUNDREDTHS <= adcHundredths) chosen = band;
  }
  return chosen as CensusBand;
}

/**
 * The band for an EXACT census: the highest band whose threshold the mean reaches, decided in integers (`dailySum >= minAdc x days`, so
 * no rounding can move a mean across a threshold). No observed day is an ADC of 0. Throws when no band starts at 0.
 */
export function selectCensusBandExact(
  bands: readonly CensusBand[],
  dailySum: number,
  days: number,
): CensusBand {
  assertCount("dailySum", dailySum);
  assertCount("days", days);
  const ascending = [...bands].sort((a, b) => a.minAdc - b.minAdc);
  if (ascending[0]?.minAdc !== 0) {
    throw new RangeError("a plan needs a census band that starts at 0 patients");
  }
  let chosen = ascending[0];
  for (const band of ascending) {
    if (days > 0 && band.minAdc * days <= dailySum) chosen = band;
  }
  return chosen as CensusBand;
}

/**
 * `netCollectionsCents x bps / 10_000`, rounded half up to the cent, in BigInt so a large month cannot drift. A month
 * that nets to zero or less (refunds and takebacks exceeded payments) is never a credit: the fee is 0.
 */
export function billingFeeCents(netCollectionsCents: number, bps: number): number {
  if (!Number.isSafeInteger(netCollectionsCents)) {
    throw new RangeError(
      `netCollectionsCents must be a whole number of cents, got ${netCollectionsCents}`,
    );
  }
  assertCount("bps", bps);
  if (netCollectionsCents <= 0 || bps === 0) return 0;
  const unit = BigInt(BASIS_POINTS_PER_UNIT);
  return Number((BigInt(netCollectionsCents) * BigInt(bps) + unit / 2n) / unit);
}

/**
 * `cents x daysLive / daysInPeriod`, rounded half up to the cent, in BigInt (a large fee times a day count must not drift). A whole
 * month (`daysLive === daysInPeriod`) is the amount unchanged. The go-live day counts as a live day; see the statement service.
 */
export function prorateCents(cents: number, daysLive: number, daysInPeriod: number): number {
  assertCount("cents", cents);
  assertCount("daysLive", daysLive);
  if (!Number.isSafeInteger(daysInPeriod) || daysInPeriod < 1) {
    throw new RangeError(
      `daysInPeriod must be a whole number of days, 1 or more, got ${daysInPeriod}`,
    );
  }
  if (daysLive > daysInPeriod) throw new RangeError("daysLive cannot exceed daysInPeriod");
  const days = BigInt(daysInPeriod);
  return Number((BigInt(cents) * BigInt(daysLive) * 2n + days) / (days * 2n));
}

/**
 * Net collections of a CLOSED month that were not on its final statement and not yet carried onto a later one: what the month
 * collected now, minus what its statement billed, minus what earlier prior-period lines already carried. Never negative (a
 * correction downward is not a credit on a later statement; the closed month stays as it was finalized).
 */
export function lateCollectionsCents(
  currentNetCents: number,
  billedNetCents: number,
  alreadyCarriedCents: number,
): number {
  for (const [name, value] of [
    ["currentNetCents", currentNetCents],
    ["billedNetCents", billedNetCents],
    ["alreadyCarriedCents", alreadyCarriedCents],
  ] as const) {
    if (!Number.isSafeInteger(value))
      throw new RangeError(`${name} must be a whole number of cents`);
  }
  return Math.max(0, currentNetCents - billedNetCents - alreadyCarriedCents);
}

function rateFor(plan: PlanPricing, mode: BillingServiceMode): number {
  if (mode === "billing_software") return plan.billingSoftwareBps;
  if (mode === "managed_billing") return plan.managedBillingBps;
  return 0;
}

export function computeStatementAmounts(
  plan: PlanPricing,
  inputs: StatementInputs,
): StatementAmounts {
  assertCount("staffCount", inputs.staffCount);
  assertCount("oneTimeFeeCents", inputs.oneTimeFeeCents);
  const priorPeriodFeeCents = inputs.priorPeriodFeeCents ?? 0;
  assertCount("priorPeriodFeeCents", priorPeriodFeeCents);
  const { daysLive, daysInPeriod } = inputs.proration ?? { daysLive: 1, daysInPeriod: 1 };
  const band = inputs.census
    ? selectCensusBandExact(plan.bands, inputs.census.dailySum, inputs.census.days)
    : selectCensusBand(plan.bands, inputs.adcHundredths);
  const perUserSubtotalCents = inputs.staffCount * plan.perUserPriceCents;
  if (!Number.isSafeInteger(perUserSubtotalCents)) {
    throw new RangeError(
      "staff x per-user price is beyond the exact range of a whole number of cents",
    );
  }
  const perUserWins = perUserSubtotalCents > band.monthlyFeeCents;
  const fullMonthFeeCents = perUserWins ? perUserSubtotalCents : band.monthlyFeeCents;
  const platformFeeCents = prorateCents(fullMonthFeeCents, daysLive, daysInPeriod);
  const billingBps = rateFor(plan, inputs.mode);
  const billingFee = billingFeeCents(inputs.netCollectionsCents, billingBps);
  // The minimum floors the PLATFORM FEE only, prorated like it; the billing fee is added on top of the floored fee.
  const minimumAdjustmentCents = Math.max(
    0,
    prorateCents(plan.minimumMonthlyCents ?? 0, daysLive, daysInPeriod) - platformFeeCents,
  );
  return {
    perUserSubtotalCents,
    bandMinAdc: band.minAdc,
    bandFeeCents: band.monthlyFeeCents,
    platformFeeCents,
    platformFeeBasis: perUserWins ? "per_user" : "census_band",
    billingBps,
    billingFeeCents: billingFee,
    oneTimeFeeCents: inputs.oneTimeFeeCents,
    minimumAdjustmentCents,
    priorPeriodFeeCents,
    totalCents:
      platformFeeCents +
      minimumAdjustmentCents +
      billingFee +
      priorPeriodFeeCents +
      inputs.oneTimeFeeCents,
  };
}

/**
 * The mean of the daily active-patient counts, in hundredths, rounded half up. `days` is how many days it is the mean
 * of, so a caller can show how much of the month the figure covers; no days is no census (`days: 0`), which is not the
 * same as a month of zeros.
 */
export function averageDailyCensusHundredths(dailyCounts: readonly number[]): {
  readonly adcHundredths: number;
  readonly days: number;
} {
  for (const count of dailyCounts) assertCount("a daily census count", count);
  const days = dailyCounts.length;
  if (days === 0) return { adcHundredths: 0, days: 0 };
  const sum = dailyCounts.reduce((a, b) => a + b, 0);
  // round(sum x 100 / days) half up, in integers.
  return { adcHundredths: Math.floor((sum * HUNDREDTHS * 2 + days) / (days * 2)), days };
}

const issue = (field: string, code: string, message: string): PricingIssue => ({
  field,
  code,
  message,
});

const isBps = (n: number): boolean =>
  Number.isSafeInteger(n) && n >= 0 && n <= BASIS_POINTS_PER_UNIT;

type PlanToValidate = PlanPricing & {
  readonly contractTermMonths: number;
  readonly implementationFeeCents: number;
};

/** Money fields are whole cents, 0 or more; the term is 1 or more months. */
function validateMoneyAndTerm(plan: PlanToValidate): PricingIssue[] {
  const issues: PricingIssue[] = [];
  const money = (field: string, value: number): void => {
    if (!isCount(value))
      issues.push(issue(field, "MONEY_INVALID", `${field} must be whole cents, 0 or more`));
  };
  money("perUserPriceCents", plan.perUserPriceCents);
  money("implementationFeeCents", plan.implementationFeeCents);
  if (plan.minimumMonthlyCents !== null) money("minimumMonthlyCents", plan.minimumMonthlyCents);
  if (!Number.isSafeInteger(plan.contractTermMonths) || plan.contractTermMonths < 1) {
    issues.push(
      issue("contractTermMonths", "TERM_INVALID", "contractTermMonths must be 1 or more"),
    );
  }
  return issues;
}

/** Both billing rates are 0 to 10000 basis points, and managed billing never costs less than billing software. */
function validateRates(plan: PlanToValidate): PricingIssue[] {
  const issues: PricingIssue[] = [];
  for (const [field, bps] of [
    ["billingSoftwareBps", plan.billingSoftwareBps],
    ["managedBillingBps", plan.managedBillingBps],
  ] as const) {
    if (!isBps(bps))
      issues.push(issue(field, "BPS_INVALID", `${field} must be 0 to 10000 basis points`));
  }
  if (
    isBps(plan.billingSoftwareBps) &&
    isBps(plan.managedBillingBps) &&
    plan.managedBillingBps < plan.billingSoftwareBps
  ) {
    issues.push(
      issue(
        "managedBillingBps",
        "MANAGED_RATE_BELOW_SOFTWARE",
        "managed billing cannot cost less than billing software",
      ),
    );
  }
  return issues;
}

/** One band against the one below it (bands arrive sorted by threshold). */
function validateBand(
  band: CensusBand,
  previous: CensusBand | undefined,
  i: number,
): PricingIssue[] {
  const issues: PricingIssue[] = [];
  if (!isCount(band.minAdc)) {
    issues.push(
      issue(
        `bands[${i}].minAdc`,
        "BAND_THRESHOLD_INVALID",
        "a band starts at a whole number of patients, 0 or more",
      ),
    );
  }
  if (!isCount(band.monthlyFeeCents)) {
    issues.push(
      issue(`bands[${i}].monthlyFeeCents`, "MONEY_INVALID", "a band fee is whole cents, 0 or more"),
    );
  }
  if (!previous) return issues;
  if (previous.minAdc === band.minAdc) {
    issues.push(
      issue(`bands[${i}].minAdc`, "BAND_THRESHOLD_DUPLICATE", `two bands start at ${band.minAdc}`),
    );
  } else if (band.monthlyFeeCents < previous.monthlyFeeCents) {
    issues.push(
      issue(
        `bands[${i}].monthlyFeeCents`,
        "BAND_FEE_NOT_ASCENDING",
        "a higher census band cannot cost less than a lower one",
      ),
    );
  }
  return issues;
}

/** A band starts at 0, thresholds are strictly ascending, and a higher census never costs less. */
function validateBands(plan: PlanToValidate): PricingIssue[] {
  const bands = [...plan.bands].sort((a, b) => a.minAdc - b.minAdc);
  const issues: PricingIssue[] = [];
  if (bands[0]?.minAdc !== 0) {
    issues.push(issue("bands", "BAND_ZERO_REQUIRED", "a band must start at 0 patients"));
  }
  bands.forEach((band, i) => {
    issues.push(...validateBand(band, bands[i - 1], i));
  });
  return issues;
}

/** Every problem with a plan's prices, so an editor can show them all at once. Empty = the plan can be published. */
export function validatePlanPricing(plan: PlanToValidate): PricingIssue[] {
  return [...validateMoneyAndTerm(plan), ...validateRates(plan), ...validateBands(plan)];
}
