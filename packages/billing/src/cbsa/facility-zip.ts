// @wardenx/billing — which facility's ZIP backs value code G8 (pure).
//
// G8 is the CBSA of the facility where the INPATIENT care (revenue 0655 / 0656 — general inpatient, inpatient
// respite) was delivered (CMS Pub. 100-04 ch. 11 §30.3), so it comes from the facility residence span that overlaps
// the inpatient level-of-care dates — not from whichever facility the patient lived in last (a nursing-home resident
// admitted to a hospital for GIP must be priced at the hospital). Nothing is guessed: if two overlapping spans carry
// different ZIPs, or an overlapping span has no ZIP, the answer is unresolved and the claim is blocked.
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

export function facilityPostalCodeForInpatientDates(
  inpatientRanges: readonly InpatientDateRange[],
  spans: readonly FacilitySpan[],
): FacilityZipResult {
  const overlapping = spans.filter((span) => inpatientRanges.some((r) => overlaps(span, r)));
  if (overlapping.length === 0) return { status: "unresolved", reason: "no_facility_stay" };
  const zips = overlapping.map((span) => zip5Of(span.postalCode));
  const known = [...new Set(zips.filter((z): z is string => z !== null))];
  if (known.length === 0) return { status: "unresolved", reason: "no_zip_recorded" };
  // A facility with no ZIP next to one with a ZIP cannot be told apart from "the same place": do not trust either.
  if (known.length > 1 || zips.some((z) => z === null)) {
    return { status: "unresolved", reason: "ambiguous_facility" };
  }
  return { status: "found", postalCode: known[0] as string };
}
