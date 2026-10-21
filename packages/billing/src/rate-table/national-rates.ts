// @chartwarden/billing — the CMS NATIONAL hospice per-diem base rates, as a platform REFERENCE (FY2027 workstream E).
// PURE data + pure checks. No IO.
//
// The rate table stays TENANT-ENTERED (F-210): claim assembly prices only from `hospice_rate_table`, never from
// here. This module is the published reference the entry screen can PREFILL from and the rate-table service
// SANITY-CHECKS a keyed version against — a typo, or rates keyed for the wrong HQRP status, surfaces as a
// warning on the version instead of as a mispriced claim months later. It is a warning, never a block: CMS
// corrects its tables (FY2027 was corrected once, below), and a tenant must be able to key the corrected value
// before this file catches up.
//
// HQRP: a hospice that failed its Hospice Quality Reporting Program requirements is paid the national rates
// reduced by 4 percentage points of the annual update (42 CFR 418.306(b)(2)). FY2027: compliant = +2.3%,
// non-compliant = 2.3 - 4 = -1.7% (factor 0.983). Each provider entity declares its status per fiscal year on
// the rate-table version (`hqrpCompliant`), and the check compares against that column of the table.
//
// Only rates confirmed against a primary source live here. Add a fiscal year by appending a reference with
// its Federal Register citation — never by extrapolating an update factor onto a prior year.
import type { Cents } from "../domain/money";

/** The six PRE-wage-index national amounts a rate-table version carries (whole cents). */
export interface NationalRateSet {
  readonly rhcDays1to60PerDiemCents: Cents;
  readonly rhcDays61PlusPerDiemCents: Cents;
  readonly chcPerDiemCents: Cents;
  readonly chcHourlyRateCents: Cents;
  readonly ircPerDiemCents: Cents;
  readonly gipPerDiemCents: Cents;
}

/** One primary-source citation behind a reference. */
export interface RateSourceCitation {
  readonly cite: string;
  readonly url: string;
}

/** The national rates for one federal fiscal year, both HQRP columns, with their sources. */
export interface NationalRateReference {
  /** The fiscal year's STARTING calendar year (the `hospice_rate_table.fiscal_year_starting` key): 2026 = FY2027. */
  readonly fiscalYearStarting: number;
  readonly fiscalYearLabel: string;
  /** The annual payment update for an HQRP-compliant hospice, percent. */
  readonly paymentUpdatePct: number;
  /** The HQRP non-compliance reduction, percentage points. */
  readonly hqrpReductionPctPoints: number;
  readonly hqrpCompliant: NationalRateSet;
  readonly hqrpNonCompliant: NationalRateSet;
  readonly sources: readonly RateSourceCitation[];
  readonly note: string;
}

/**
 * FY2027 (Oct 1 2026 - Sep 30 2027) — the CORRECTED national rates. The final rule's Tables 1-4 were superseded
 * by the 2026-09-30 correction (a wage-index standardization fix after hospital CCN 250078 was wrongly
 * excluded as a rural emergency hospital); the 2.3% update and the cap were unchanged by it. The SIA is paid at
 * the CHC hourly rate. See docs/research/FY2027_HOSPICE_COP_RESEARCH.md §6.
 */
export const CMS_NATIONAL_RATES_FY2027: NationalRateReference = {
  fiscalYearStarting: 2026,
  fiscalYearLabel: "FY2027",
  paymentUpdatePct: 2.3,
  hqrpReductionPctPoints: 4,
  hqrpCompliant: {
    rhcDays1to60PerDiemCents: 23_633,
    rhcDays61PlusPerDiemCents: 18_633,
    chcPerDiemCents: 172_616,
    chcHourlyRateCents: 7_192,
    ircPerDiemCents: 54_593,
    gipPerDiemCents: 123_151,
  },
  hqrpNonCompliant: {
    rhcDays1to60PerDiemCents: 22_709,
    rhcDays61PlusPerDiemCents: 17_904,
    chcPerDiemCents: 165_866,
    chcHourlyRateCents: 6_911,
    ircPerDiemCents: 52_458,
    gipPerDiemCents: 118_335,
  },
  sources: [
    {
      cite: "CMS-1851-CN, 91 FR 61791 (2026-09-30), corrected rate tables at 91 FR 61792-61793",
      url: "https://www.federalregister.gov/documents/2026/09/30/2026-20067",
    },
    {
      cite: "CMS-1851-F, 91 FR 49118 (2026-08-03) — 2.3% update; HQRP reduction 4 percentage points",
      url: "https://www.federalregister.gov/d/2026-15686",
    },
  ],
  note: "Corrected rates (CMS-1851-CN). The final rule's original Tables 1-4 ($236.35 / $186.35 / $1,726.50 / $545.98 / $1,231.63 compliant) are superseded.",
};

/** Every confirmed reference, keyed by `fiscalYearStarting`. */
export const CMS_NATIONAL_RATE_REFERENCES: Readonly<Record<number, NationalRateReference>> = {
  [CMS_NATIONAL_RATES_FY2027.fiscalYearStarting]: CMS_NATIONAL_RATES_FY2027,
};

/** The national reference for a fiscal year (by its STARTING calendar year), or null when none is on file. */
export function nationalRateReferenceFor(fiscalYearStarting: number): NationalRateReference | null {
  return CMS_NATIONAL_RATE_REFERENCES[fiscalYearStarting] ?? null;
}

const RATE_FIELDS: ReadonlyArray<readonly [keyof NationalRateSet, string]> = [
  ["rhcDays1to60PerDiemCents", "RHC days 1-60"],
  ["rhcDays61PlusPerDiemCents", "RHC days 61+"],
  ["chcPerDiemCents", "CHC per diem"],
  ["chcHourlyRateCents", "CHC hourly"],
  ["ircPerDiemCents", "IRC"],
  ["gipPerDiemCents", "GIP"],
];

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function mismatches(entered: NationalRateSet, expected: NationalRateSet): string[] {
  return RATE_FIELDS.filter(([key]) => entered[key] !== expected[key]).map(
    ([key, label]) =>
      `${label}: entered ${dollars(entered[key])}, CMS national ${dollars(expected[key])}`,
  );
}

/**
 * Compare a keyed rate set against the national reference for its fiscal year and DECLARED HQRP status.
 * Returns human-readable warnings (empty = matches, or no reference is on file for that year). Pure.
 *
 * - `hqrpCompliant` null/undefined: the status is undeclared, so the set is checked against BOTH columns and a
 *   warning asks for the declaration (unless it matches one column exactly, which the warning then names).
 * - A set that matches the OTHER column exactly gets one pointed warning (the classic mistake: keying the
 *   compliant rates for an entity under the 4-point reduction, or the reverse).
 */
export function checkRatesAgainstNationalReference(
  entry: NationalRateSet & { readonly fiscalYearStarting: number },
  hqrpCompliant: boolean | null | undefined,
): readonly string[] {
  const ref = nationalRateReferenceFor(entry.fiscalYearStarting);
  if (ref === null) return [];
  const asCompliant = mismatches(entry, ref.hqrpCompliant);
  const asNonCompliant = mismatches(entry, ref.hqrpNonCompliant);
  const nonCompliantUpdate = Number((ref.paymentUpdatePct - ref.hqrpReductionPctPoints).toFixed(2));

  if (hqrpCompliant === null || hqrpCompliant === undefined) {
    if (asCompliant.length === 0)
      return [
        `HQRP status is not declared; the rates match the ${ref.fiscalYearLabel} HQRP-compliant national rates (+${ref.paymentUpdatePct}% update). Declare hqrpCompliant.`,
      ];
    if (asNonCompliant.length === 0)
      return [
        `HQRP status is not declared; the rates match the ${ref.fiscalYearLabel} HQRP NON-compliant national rates (${nonCompliantUpdate}% update, a ${ref.hqrpReductionPctPoints}-point reduction). Declare hqrpCompliant.`,
      ];
    return [
      `HQRP status is not declared and the rates match neither ${ref.fiscalYearLabel} national column; declare hqrpCompliant and check the entry.`,
      ...asCompliant,
    ];
  }

  const [expectedLabel, own, other] = hqrpCompliant
    ? ["HQRP-compliant", asCompliant, asNonCompliant]
    : ["HQRP non-compliant", asNonCompliant, asCompliant];
  if (own.length === 0) return [];
  if (other.length === 0) {
    return [
      hqrpCompliant
        ? `Declared HQRP-compliant, but the rates are the ${ref.fiscalYearLabel} NON-compliant national rates (${nonCompliantUpdate}% update). Either the HQRP status or the rates are wrong.`
        : `Declared HQRP non-compliant, but the rates are the ${ref.fiscalYearLabel} compliant national rates (+${ref.paymentUpdatePct}%). A non-compliant hospice is paid ${ref.hqrpReductionPctPoints} percentage points less.`,
    ];
  }
  return [
    `The rates differ from the ${ref.fiscalYearLabel} ${expectedLabel} national rates (${ref.sources[0]?.cite ?? "CMS"}):`,
    ...own,
  ];
}
