// @chartwarden/subscription-billing — the contracted census-banded pricing model (slice 2). PURE: no IO, no clock.
//
//   platform fee = the GREATER of (active staff accounts x per-user price) and the flat monthly fee of the census band
//                  the average daily census (ADC) falls in
//   billing fee  = net collections x the plan's rate for the subscription's billing service mode (none => 0)
//   total        = platform fee + billing fee + a one-time fee (the first statement only) + any top-up to the plan minimum
//
// Money is INTEGER CENTS, rates are INTEGER BASIS POINTS, ADC is integer HUNDREDTHS of a patient. Nothing here knows a
// price: every figure arrives on a plan row (the owner edits plans; the platform never hardcodes a dollar amount).
//
// A census band is a THRESHOLD, not a range: it starts at `minAdc` and runs until the next band starts. Thresholds
// cannot overlap or leave a gap (the 25-to-30 gap the owner's "26+/30+" note would have left is impossible by
// construction), and a fractional ADC such as 16.4 needs no rounding rule: it is below 17, so it is in the 10 band.
import type { BillingServiceMode } from "@chartwarden/types";

/** The owner's bands: 0-9, 10-16, 17-25, 26+ patients. A default for a new plan form only; a plan stores its own. */
export const DEFAULT_CENSUS_BAND_THRESHOLDS: readonly number[] = [0, 10, 17, 26];

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

export interface StatementInputs {
  readonly staffCount: number;
  /** Average daily census in hundredths of a patient (1_699 = 16.99). */
  readonly adcHundredths: number;
  readonly netCollectionsCents: number;
  readonly mode: BillingServiceMode;
  /** The plan's implementation fee on the first statement of a contract, else 0. */
  readonly oneTimeFeeCents: number;
}

export interface StatementAmounts {
  /** Both sides of the greater-of comparison. */
  readonly perUserSubtotalCents: number;
  readonly bandMinAdc: number;
  readonly bandFeeCents: number;
  readonly platformFeeCents: number;
  /** Which side won. A tie is `census_band` (the flat fee), so the answer is deterministic. */
  readonly platformFeeBasis: "per_user" | "census_band";
  readonly billingBps: number;
  readonly billingFeeCents: number;
  readonly oneTimeFeeCents: number;
  readonly minimumAdjustmentCents: number;
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
  const band = selectCensusBand(plan.bands, inputs.adcHundredths);
  const perUserSubtotalCents = inputs.staffCount * plan.perUserPriceCents;
  const perUserWins = perUserSubtotalCents > band.monthlyFeeCents;
  const platformFeeCents = perUserWins ? perUserSubtotalCents : band.monthlyFeeCents;
  const billingBps = rateFor(plan, inputs.mode);
  const billingFee = billingFeeCents(inputs.netCollectionsCents, billingBps);
  const recurring = platformFeeCents + billingFee;
  const minimumAdjustmentCents = Math.max(0, (plan.minimumMonthlyCents ?? 0) - recurring);
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
    totalCents: recurring + minimumAdjustmentCents + inputs.oneTimeFeeCents,
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

/** Every problem with a plan's prices, so an editor can show them all at once. Empty = the plan can be published. */
export function validatePlanPricing(
  plan: PlanPricing & {
    readonly contractTermMonths: number;
    readonly implementationFeeCents: number;
  },
): PricingIssue[] {
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
  const bands = [...plan.bands].sort((a, b) => a.minAdc - b.minAdc);
  if (bands[0]?.minAdc !== 0) {
    issues.push(issue("bands", "BAND_ZERO_REQUIRED", "a band must start at 0 patients"));
  }
  bands.forEach((band, i) => {
    if (!isCount(band.minAdc))
      issues.push(
        issue(
          `bands[${i}].minAdc`,
          "BAND_THRESHOLD_INVALID",
          "a band starts at a whole number of patients, 0 or more",
        ),
      );
    if (!isCount(band.monthlyFeeCents))
      issues.push(
        issue(
          `bands[${i}].monthlyFeeCents`,
          "MONEY_INVALID",
          "a band fee is whole cents, 0 or more",
        ),
      );
    const previous = bands[i - 1];
    if (!previous) return;
    if (previous.minAdc === band.minAdc) {
      issues.push(
        issue(
          `bands[${i}].minAdc`,
          "BAND_THRESHOLD_DUPLICATE",
          `two bands start at ${band.minAdc}`,
        ),
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
  });
  return issues;
}
