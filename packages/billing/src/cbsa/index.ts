// @wardenx/billing — the hospice CBSA for a claim's value codes (CMS Pub. 100-04 ch. 11 s30.3): value code 61 is
// the CBSA (or rural 999NN / transition 5000N code) of the beneficiary's residence at the end of the billing period
// (home levels of care, revenue 0651/0652); value code G8 is the code of the LATEST INPATIENT FACILITY (0655/0656).
// The pricer wage-adjusts with these. Geography data: migration 1058 (sources in
// scripts/data/hospice-cbsa/build_hospice_cbsa_migration.py). PURE: lookups are injected, nothing is guessed — an
// unplaceable ZIP is `unresolved`, never defaulted.
import { hospiceValueCodeForRevenue } from "../claim-lines/value-codes";

export type HospiceAreaKind = "urban" | "rural" | "transition";

export type UnresolvedReason =
  | "invalid_zip"
  | "zip_unknown"
  | "county_unknown"
  | "no_zip_recorded"
  | "no_facility_stay"
  | "ambiguous_facility";

export type HospiceAreaResolution =
  | {
      readonly status: "resolved";
      readonly cbsaCode: string;
      readonly areaKind: HospiceAreaKind;
      /** The county the ZIP's ZCTA falls in; `null` when the ZIP was placed by its 3-digit prefix. */
      readonly countyFips: string | null;
      /** `zip` = the ZIP's own ZCTA; `zip3_unanimous` = a ZIP with no ZCTA (PO box) placed by a prefix every one of
       *  whose ZIPs shares this code. */
      readonly via: "zip" | "zip3_unanimous";
      /** The published hospice wage index for the code and fiscal year; `null` when none is published. */
      readonly wageIndex: string | null;
    }
  | { readonly status: "unresolved"; readonly reason: UnresolvedReason };

/** The two reference reads the resolver needs (backed by `hospice_zip_county` / `hospice_cbsa_county`). */
export interface HospiceAreaInfo {
  readonly cbsaCode: string;
  readonly areaKind: HospiceAreaKind;
  readonly wageIndex?: string | null;
}

export interface HospiceAreaLookup {
  countyForZip(zip5: string): string | undefined;
  areaForCounty(fiscalYearStarting: number, countyFips: string): HospiceAreaInfo | undefined;
  /** Only where every ZCTA sharing the prefix is in the same area for the fiscal year (never a majority guess). */
  areaForZip3?(fiscalYearStarting: number, zip3: string): HospiceAreaInfo | undefined;
}

const ZIP5 = /^\d{5}$/;

export function resolveHospiceArea(
  postalCode: string,
  fiscalYearStarting: number,
  lookup: HospiceAreaLookup,
): HospiceAreaResolution {
  const zip5 = postalCode.trim().slice(0, 5);
  if (!ZIP5.test(zip5)) return { status: "unresolved", reason: "invalid_zip" };
  const countyFips = lookup.countyForZip(zip5);
  if (countyFips === undefined) {
    const byPrefix = lookup.areaForZip3?.(fiscalYearStarting, zip5.slice(0, 3));
    if (byPrefix === undefined) return { status: "unresolved", reason: "zip_unknown" };
    return {
      status: "resolved",
      cbsaCode: byPrefix.cbsaCode,
      areaKind: byPrefix.areaKind,
      countyFips: null,
      via: "zip3_unanimous",
      wageIndex: byPrefix.wageIndex ?? null,
    };
  }
  const area = lookup.areaForCounty(fiscalYearStarting, countyFips);
  if (area === undefined) return { status: "unresolved", reason: "county_unknown" };
  return {
    status: "resolved",
    cbsaCode: area.cbsaCode,
    areaKind: area.areaKind,
    countyFips,
    via: "zip",
    wageIndex: area.wageIndex ?? null,
  };
}

export type ValueCode = "61" | "G8";

export interface ClaimValueCode {
  readonly code: ValueCode;
  readonly cbsaCode: string;
}

export interface MissingValueCode {
  readonly code: ValueCode;
  readonly reason: UnresolvedReason;
}

export interface ClaimValueCodes {
  readonly values: readonly ClaimValueCode[];
  readonly missing: readonly MissingValueCode[];
}

/** The place each value code is read from: `null` = no ZIP was recorded for it. */
export interface ValueCodeAreas {
  readonly residence: HospiceAreaResolution | null;
  readonly facility: HospiceAreaResolution | null;
}

/** The value codes a claim with these revenue codes must carry, resolved from `areas` (each code once). */
export function claimValueCodes(
  revenueCodes: readonly string[],
  areas: ValueCodeAreas,
): ClaimValueCodes {
  const required = new Set<ValueCode>();
  for (const revenue of revenueCodes) {
    const code = hospiceValueCodeForRevenue(revenue);
    if (code) required.add(code);
  }
  const values: ClaimValueCode[] = [];
  const missing: MissingValueCode[] = [];
  for (const code of ["61", "G8"] as const) {
    if (!required.has(code)) continue;
    const area = code === "61" ? areas.residence : areas.facility;
    if (area?.status === "resolved") values.push({ code, cbsaCode: area.cbsaCode });
    else missing.push({ code, reason: area?.reason ?? "no_zip_recorded" });
  }
  return { values, missing };
}
