// @chartwarden/billing — M23 tenant-entered SEQUESTRATION POLICY entry rules (F-212). PURE: no Fastify, no Drizzle; the clock is a parameter.
//
// The Medicare FFS sequestration reduction is a statutory payment cut, not a tenant preference, but the platform has no
// bundled CMS schedule (it would silently go stale, the F-210 lesson) and `POST /claims/assemble` deliberately fails
// closed when no policy covers the service date. So a billing administrator keys the schedule per provider entity, and this
// module is the single home of the rules that keep that hand-keyed input honest before it reaches the database (whose CHECK /
// EXCLUDE constraints in migration 0281 are the belt to this braces):
//   * the percentage is a decimal STRING (D11, never a float) in [0, 2]: the statutory Medicare cap is 2%; 0 is legitimate
//     (the CARES Act moratorium, service dates 2020-05-01..2022-03-31) and 1 is the Apr-Jun 2022 step-down. Anything above 2 is a
//     typo ("20", "2.0" keyed as "20") or a statutory change the platform must be consciously taught (a migration).
//   * a percentage other than exactly 2 requires a `setReason`, so a moratorium/step-down row is a documented decision and a
//     stray "0" cannot silently zero out every claim's withhold.
//   * the window: not before 2013-04-01 (first sequestered Medicare payments), `effectiveTo >= effectiveFrom`, and `effectiveFrom`
//     no more than two years ahead (a typo guard - the year 2062 is never intended).
import type { IsoDate } from "../contracts";
import { toEpochDay } from "../domain/dates";

/** The first date a sequestration reduction applied to Medicare payments (BCA of 2011, effective for claims from Apr 1 2013). */
export const SEQUESTRATION_EARLIEST_EFFECTIVE_FROM: IsoDate = "2013-04-01";
/** Statutory Medicare FFS cap, percent. */
export const SEQUESTRATION_MAX_PERCENT = 2;
/** `effectiveFrom` may be at most this many days after the clock's today (typo guard). */
export const SEQUESTRATION_MAX_FORWARD_DAYS = 730;
/** The percentage every non-moratorium period carries; any other value needs a documented reason. */
export const SEQUESTRATION_STANDARD_PERCENT = 2;

/** A decimal string: up to three integer digits (so "20"/"200" get the band message), up to four fractional digits. */
const PERCENT_SHAPE = /^[0-9]{1,3}(\.[0-9]{1,4})?$/;

export interface SequestrationPolicyEntry {
  /** Decimal STRING, never a float. */
  readonly percentage: string;
  readonly effectiveFrom: IsoDate;
  /** Omitted/null = open-ended (the current schedule). */
  readonly effectiveTo?: IsoDate | null;
  readonly setReason?: string | null;
}

export type SequestrationPolicyValidation =
  | { readonly ok: true; readonly effectiveTo: IsoDate | null }
  | { readonly ok: false; readonly errors: readonly string[] };

function isDate(s: string): boolean {
  try {
    toEpochDay(s);
    return true;
  } catch {
    return false;
  }
}

/** Validate a keyed policy entry against the plausibility band and effective window. `todayIso` is the clock's date (YYYY-MM-DD). */
export function validateSequestrationPolicyEntry(
  entry: SequestrationPolicyEntry,
  todayIso: IsoDate,
): SequestrationPolicyValidation {
  const errors: string[] = [];

  if (!PERCENT_SHAPE.test(entry.percentage)) {
    errors.push(
      `percentage "${entry.percentage}" must be a decimal string with at most four fractional digits, e.g. "2.00"`,
    );
  } else {
    const n = Number(entry.percentage);
    if (n < 0 || n > SEQUESTRATION_MAX_PERCENT) {
      errors.push(
        `percentage ${entry.percentage} is outside the plausible band 0-${SEQUESTRATION_MAX_PERCENT} (the Medicare FFS sequestration reduction is capped at ${SEQUESTRATION_MAX_PERCENT}%; a percent is keyed as "2.00", not "200" or "0.02")`,
      );
    } else if (
      n !== SEQUESTRATION_STANDARD_PERCENT &&
      (entry.setReason ?? "").trim().length === 0
    ) {
      errors.push(
        `a percentage other than ${SEQUESTRATION_STANDARD_PERCENT}% (e.g. the 2020-2022 moratorium 0% / 1% periods) requires a setReason documenting why`,
      );
    }
  }

  let effectiveTo: IsoDate | null = entry.effectiveTo ?? null;
  if (!isDate(entry.effectiveFrom)) {
    errors.push("effectiveFrom must be a valid YYYY-MM-DD date");
  } else {
    if (entry.effectiveFrom < SEQUESTRATION_EARLIEST_EFFECTIVE_FROM) {
      errors.push(
        `effectiveFrom ${entry.effectiveFrom} precedes ${SEQUESTRATION_EARLIEST_EFFECTIVE_FROM}, when sequestration first applied to Medicare payments`,
      );
    }
    if (
      isDate(todayIso) &&
      toEpochDay(entry.effectiveFrom) - toEpochDay(todayIso) > SEQUESTRATION_MAX_FORWARD_DAYS
    ) {
      errors.push(
        `effectiveFrom ${entry.effectiveFrom} is more than ${SEQUESTRATION_MAX_FORWARD_DAYS} days in the future; check the year`,
      );
    }
    if (effectiveTo !== null) {
      if (!isDate(effectiveTo)) {
        errors.push("effectiveTo must be a valid YYYY-MM-DD date");
        effectiveTo = null;
      } else if (effectiveTo < entry.effectiveFrom) {
        errors.push("effectiveTo must not precede effectiveFrom");
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, effectiveTo };
}
