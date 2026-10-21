// @chartwarden/billing — which facility's ZIP backs value code G8 (pure).
//
// G8 is the CBSA of the facility where the INPATIENT care (revenue 0655 / 0656 — general inpatient, inpatient
// respite) was delivered (CMS Pub. 100-04 ch. 11 §30.3), so it comes from the facility residence span that overlaps
// the inpatient level-of-care dates — not from whichever facility the patient lived in last (a nursing-home resident
// admitted to a hospital for GIP must be priced at the hospital). When inpatient care spans several facilities the
// LATEST one wins (the manual's rule). Nothing is guessed: two facilities covering the last inpatient day with
// different ZIPs, or one with no ZIP, leave the answer unresolved and the claim is blocked.
import type { IsoDate } from "../contracts";

export interface FacilitySpan {
  readonly effectiveFrom: IsoDate;
  /** `null` = still open. */
  readonly effectiveTo: IsoDate | null;
  /** The facility's postal code (M40 `facility.primary_address.postalCode`); `null` = none recorded. */
  readonly postalCode: string | null;
}

export interface InpatientDateRange {
  readonly from: IsoDate;
  readonly to: IsoDate;
}

export type FacilityZipResult =
  | { readonly status: "found"; readonly postalCode: string }
  | {
      readonly status: "unresolved";
      readonly reason: "no_facility_stay" | "ambiguous_facility" | "no_zip_recorded";
    };

const overlaps = (span: FacilitySpan, range: InpatientDateRange): boolean =>
  span.effectiveFrom <= range.to && (span.effectiveTo === null || span.effectiveTo >= range.from);

const zip5Of = (postalCode: string | null): string | null => {
  const zip5 = postalCode?.trim().slice(0, 5) ?? "";
  return zip5 === "" ? null : zip5;
};

/** The last inpatient date this span covers (`null` when it covers none of them). */
const lastCoveredDay = (
  span: FacilitySpan,
  ranges: readonly InpatientDateRange[],
): IsoDate | null => {
  let last: IsoDate | null = null;
  for (const r of ranges) {
    if (!overlaps(span, r)) continue;
    const day = span.effectiveTo !== null && span.effectiveTo < r.to ? span.effectiveTo : r.to;
    if (last === null || day > last) last = day;
  }
  return last;
};

export function facilityPostalCodeForInpatientDates(
  inpatientRanges: readonly InpatientDateRange[],
  spans: readonly FacilitySpan[],
): FacilityZipResult {
  const covering = spans.flatMap((span) => {
    const last = lastCoveredDay(span, inpatientRanges);
    return last === null ? [] : [{ span, last }];
  });
  if (covering.length === 0) return { status: "unresolved", reason: "no_facility_stay" };
  // CMS: "report the CBSA of the latest facility that served the beneficiary" (Pub. 100-04 ch. 11 s30.3), so the
  // facility covering the LAST inpatient day wins. Only a tie on that day between different ZIPs is ambiguous.
  const latest = covering.reduce(
    (max, c) => (c.last > max ? c.last : max),
    covering[0]?.last as IsoDate,
  );
  const zips = covering.filter((c) => c.last === latest).map((c) => zip5Of(c.span.postalCode));
  const known = [...new Set(zips.filter((z): z is string => z !== null))];
  if (known.length === 0) return { status: "unresolved", reason: "no_zip_recorded" };
  // A facility with no ZIP next to one with a ZIP cannot be told apart from "the same place": do not trust either.
  if (known.length > 1 || zips.some((z) => z === null)) {
    return { status: "unresolved", reason: "ambiguous_facility" };
  }
  return { status: "found", postalCode: known[0] as string };
}
