// @wardenx/billing — M23 tenant-entered WAGE INDEX domain (F-211). PURE: no Fastify, no Drizzle, no clock (the caller passes
// `today`).
//
// The CMS hospice wage index for a CCN + federal fiscal year is TENANT-ENTERED into the org-scoped `tenant_wage_index`
// (migration 0280); the platform-shared `wage_index_factor` has no loader and only non-authoritative placeholders. This
// module holds the rules that keep a hand-keyed financial input honest (migration CHECKs are the belt to this braces) and
// the lookup PRECEDENCE the claim-assembly adapter applies: tenant row, then an AUTHORITATIVE platform row, else nothing —
// a non-authoritative placeholder never prices a claim.
import type { IsoDate } from "../contracts";
import { hospiceFiscalYearStartingOf } from "../rate-table";

/** Plausibility band for a wage-index factor (a ratio near 1; the real hospice index spans roughly 0.7-2.0). */
export const WAGE_INDEX_MIN = 0.5;
export const WAGE_INDEX_MAX = 2.5;

const FACTOR_SHAPE = /^\d(\.\d{1,4})?$/;
const CCN_SHAPE = /^[0-9A-Za-z]{6}$/;
const CBSA_SHAPE = /^[0-9]{5}$/;

/** The keyed wage-index entry. */
export interface WageIndexEntry {
  readonly ccn: string;
  /** The federal fiscal year's STARTING calendar year (2025 = FY2026, Oct 2025 - Sep 2026). */
  readonly fiscalYearStarting: number;
  readonly cbsaCode?: string | null;
  /** Decimal string, at most four places (e.g. `"1.0342"`) — never a float. */
  readonly factorDecimal: string;
  readonly sourceReference: string;
}

export type WageIndexValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Validate a keyed wage-index entry. `today` bounds the fiscal-year window: a wage index is published for the CURRENT fiscal
 * year or (in advance, from the final rule in August) the NEXT one, and any historical year for re-billing; a year beyond
 * next fiscal year is a typo (`2205`) and is refused.
 */
export function validateWageIndexEntry(entry: WageIndexEntry, today: IsoDate): WageIndexValidation {
  const errors: string[] = [];
  if (!CCN_SHAPE.test(entry.ccn))
    errors.push("ccn must be the 6-character CMS Certification Number");
  if (entry.cbsaCode !== undefined && entry.cbsaCode !== null && !CBSA_SHAPE.test(entry.cbsaCode)) {
    errors.push("cbsaCode must be a 5-digit CBSA code");
  }
  if (!Number.isInteger(entry.fiscalYearStarting) || entry.fiscalYearStarting < 2000) {
    errors.push(
      "fiscalYearStarting must be a four-digit year (2025 = FY2026, Oct 2025 - Sep 2026)",
    );
  } else {
    const latest = hospiceFiscalYearStartingOf(today) + 1;
    if (entry.fiscalYearStarting > latest) {
      errors.push(
        `fiscalYearStarting ${entry.fiscalYearStarting} is beyond next fiscal year (${latest}); a wage index is not published that far ahead`,
      );
    }
  }
  if (typeof entry.factorDecimal !== "string" || !FACTOR_SHAPE.test(entry.factorDecimal)) {
    errors.push('factorDecimal must be a decimal string with at most four places, e.g. "1.0342"');
  } else if (
    Number(entry.factorDecimal) < WAGE_INDEX_MIN ||
    Number(entry.factorDecimal) > WAGE_INDEX_MAX
  ) {
    errors.push(
      `factorDecimal (${entry.factorDecimal}) is outside the plausible band ${WAGE_INDEX_MIN}-${WAGE_INDEX_MAX}`,
    );
  }
  if (typeof entry.sourceReference !== "string" || entry.sourceReference.trim().length === 0) {
    errors.push(
      "sourceReference is required (cite the CMS wage-index table / Federal Register notice keyed from)",
    );
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

/** Where a resolved wage index came from. */
export type WageIndexSource = "tenant" | "platform";

export interface ResolvedWageIndex {
  readonly factorDecimal: string;
  readonly cbsaCode: string | null;
  readonly source: WageIndexSource;
}

/**
 * The lookup precedence (F-211): the tenant's own live row wins; else a platform row ONLY if it is authoritative; else
 * `null` (the caller fails closed with `WAGE_INDEX_UNAVAILABLE`). A non-authoritative placeholder is never a fallback.
 */
export function resolveWageIndex(candidates: {
  readonly tenant: { readonly factorDecimal: string; readonly cbsaCode: string | null } | null;
  readonly platform: {
    readonly factorDecimal: string;
    readonly cbsaCode: string | null;
    readonly isAuthoritative: boolean;
  } | null;
}): ResolvedWageIndex | null {
  if (candidates.tenant) {
    return {
      factorDecimal: candidates.tenant.factorDecimal,
      cbsaCode: candidates.tenant.cbsaCode,
      source: "tenant",
    };
  }
  if (candidates.platform?.isAuthoritative) {
    return {
      factorDecimal: candidates.platform.factorDecimal,
      cbsaCode: candidates.platform.cbsaCode,
      source: "platform",
    };
  }
  return null;
}
