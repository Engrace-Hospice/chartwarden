// @wardenx/billing — M23 per-diem rate calculator (D7, spec §3.3 `hipps_calculation` row). A PURE
// function that maps M6's `LevelOfCarePeriod` segments within a claim's from-through range to the CMS
// hospice per-diem model: each day of the claim is assigned a level of care (RHC / CHC / IRC / GIP)
// and, for RHC, the **ADR-0001 day-60 two-tier bucket** — RHC-High for election days 1–60, RHC-Low for
// day 61+ (80 FR 47142; the earlier "days 1–7 vs 8+" encoding conflated RHC tiering with the unrelated
// SIA last-7-days window and was struck by ADR-0001). Days are measured from `hospiceAdmissionDate`
// (NOT the claim's from date, so a mid-stay interim claim lands in the right tier).
//
// KNOWN LIMITATION (recorded, not silent): ADR-0001's day counter is the beneficiary's CUMULATIVE
// hospice-election day count across sequential stays and hospices, with a >60-day election-gap reset.
// This calculator anchors to the CURRENT election's admission date — correct for a first/continuous
// election, and under-counts prior-stay days otherwise. Wiring the cumulative count needs beneficiary
// election history (M6 + external eligibility data) that no seam provides yet; when it lands, pass the
// cumulative day-1 anchor as `hospiceAdmissionDate` and this math is already right.
//
// Each resolved per-diem is the wage-index-ADJUSTED CMS base rate; the wage index factor is PASSED IN
// and SNAPSHOTTED into the result (the Phase-3 service persists it onto the `hipps_calculation` row so
// a later wage-index file reload cannot retroactively change historic math).
//
// The exact CMS base per-diem rate table (per FY, per LOC, the RHC two-tier amounts) and the precise
// 5-position HIPPS character encoding are PUBLISHED CMS fixtures — they are NOT fabricated here. The base
// rates are INJECTED via `rateTable` (the caller resolves them from the loaded CMS rate file), and the
// HIPPS code is derived via a deterministic placeholder pending the CMS fixture (see `deriveHippsCode`).
//
// PURE DOMAIN: no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`, no clock. No PHI (D13).
import type { IsoDate, LevelOfCare } from "../contracts";
import { dayOfStay, fromEpochDay, toEpochDay } from "../domain/dates";
import type { Cents } from "../domain/money";
import { applyWageIndexFactor, perDiemAmountCents, sumCents } from "../domain/money";

/** ADR-0001: last election day paid at the RHC-High tier; day 61+ pays RHC-Low (80 FR 47142). */
export const RHC_HIGH_TIER_LAST_DAY = 60;

/** The RHC payment-tier bucket (ADR-0001); `n/a` for non-RHC levels of care, which have a single rate. */
export type RhcDayBucket = "days_1_60" | "days_61_plus" | "n/a";

/** Map a contracts `LevelOfCare` (full name) to the DB `m23_claim_line_level_of_care` 3-letter code. */
export function levelOfCareToCode(loc: LevelOfCare): "RHC" | "CHC" | "IRC" | "GIP" {
  switch (loc) {
    case "routine_home_care":
      return "RHC";
    case "continuous_home_care":
      return "CHC";
    case "inpatient_respite_care":
      return "IRC";
    case "general_inpatient_care":
      return "GIP";
  }
}

/**
 * The INJECTED CMS base per-diem rate table for the claim's FY (whole cents, PRE-wage-index). The caller
 * resolves these from the loaded annual CMS hospice rate file — they are NOT hard-coded here.
 * TODO(CMS-fixture): the published FY per-diem amounts (RHC two-tier, CHC full-day, IRC, GIP) populate
 * this structure at the service layer from the rate file; the calculator applies the wage index to them.
 */
export interface HippsRateTable {
  /** RHC-High per-diem for election days 1-60 (ADR-0001). */
  readonly rhcDays1to60PerDiemCents: Cents;
  /** RHC-Low per-diem for election day 61 and after (ADR-0001). */
  readonly rhcDays61PlusPerDiemCents: Cents;
  /** CHC full-day per-diem (the hourly-derived 24-hour amount). */
  readonly chcPerDiemCents: Cents;
  /** IRC (inpatient respite) per-diem. */
  readonly ircPerDiemCents: Cents;
  /** GIP (general inpatient) per-diem. */
  readonly gipPerDiemCents: Cents;
}

/** One injected level-of-care period (M6 `LevelOfCareReader`), clipped against the claim range below. */
export interface HippsLocPeriodInput {
  readonly levelOfCare: LevelOfCare;
  readonly from: IsoDate;
  readonly to: IsoDate;
}

/** The pure HIPPS calculator input — all plain data; nothing is read from a seam or clock. */
export interface HippsCalculationInput {
  readonly claimServiceFrom: IsoDate;
  readonly claimServiceTo: IsoDate;
  /** The hospice election/admission date — day 1 of the ADR-0001 day-60 tier count (see the header's
   * cumulative-count limitation note). */
  readonly hospiceAdmissionDate: IsoDate;
  readonly levelOfCarePeriods: readonly HippsLocPeriodInput[];
  readonly rateTable: HippsRateTable;
  /** Snapshotted into the result for audit reproducibility (D7 / D12). */
  readonly wageIndexCcn: string;
  readonly wageIndexFiscalYear: number;
  /** The wage index factor as a decimal STRING (e.g. `"0.9234"`) — never a float. */
  readonly wageIndexFactorDecimal: string;
}

/** One contiguous (level-of-care, RHC-bucket) segment of the claim, with its wage-adjusted per-diem. */
export interface HippsSegmentResult {
  readonly levelOfCare: LevelOfCare;
  readonly levelOfCareCode: "RHC" | "CHC" | "IRC" | "GIP";
  readonly dateFrom: IsoDate;
  readonly dateTo: IsoDate;
  readonly days: number;
  /** The CMS base per-diem PRE-wage-index (from `rateTable`). */
  readonly baseRatePerDiemCents: Cents;
  /** The wage-index-ADJUSTED per-diem actually billed for this segment. */
  readonly ratePerDiemCents: Cents;
  readonly rhcDayBucket: RhcDayBucket;
  /** 1-based position of this segment in the HIPPS code (mirrors `hipps_calculation.segments`). */
  readonly hippsCharPosition: number;
  /** `ratePerDiemCents × days` — the segment's total charge. */
  readonly segmentTotalCents: Cents;
}

/** The pure HIPPS calculation result — the caller persists this onto `hipps_calculation`. */
export interface HippsCalculationResult {
  readonly hippsCode: string;
  /** A representative per-diem (the first segment's wage-adjusted rate; 0 when no billable day). */
  readonly perDiemRateCents: Cents;
  readonly wageIndexCcn: string;
  readonly wageIndexFiscalYear: number;
  /** The wage index factor applied, echoed for the row snapshot. */
  readonly wageIndexFactorApplied: string;
  readonly segments: readonly HippsSegmentResult[];
  readonly rhcDays1to60: number;
  readonly rhcDays61Plus: number;
  /** Sum of every segment total — the claim's HIPPS-derived per-diem charge. */
  readonly totalCents: Cents;
}

/** Resolve the CMS base per-diem for a (level-of-care, RHC-bucket) pair from the injected rate table. */
function baseRateFor(rateTable: HippsRateTable, loc: LevelOfCare, bucket: RhcDayBucket): Cents {
  switch (loc) {
    case "routine_home_care":
      return bucket === "days_1_60"
        ? rateTable.rhcDays1to60PerDiemCents
        : rateTable.rhcDays61PlusPerDiemCents;
    case "continuous_home_care":
      return rateTable.chcPerDiemCents;
    case "inpatient_respite_care":
      return rateTable.ircPerDiemCents;
    case "general_inpatient_care":
      return rateTable.gipPerDiemCents;
  }
}

/**
 * Derive the 5-character HIPPS code for the claim. TODO(CMS-fixture): the exact 5-position HIPPS
 * character encoding (CMS Hospice Payment Manual) is a published table — this derives a DETERMINISTIC
 * placeholder from the FIRST segment's level of care + RHC day bucket so the calculator is structurally
 * complete and reproducible. Replace the character map with the CMS fixture before treating the code as
 * billable. A claim with no billable day yields the all-filler placeholder `"00000"`.
 */
export function deriveHippsCode(segments: readonly HippsSegmentResult[]): string {
  const first = segments[0];
  if (first === undefined) return "00000";
  const locChar: Record<LevelOfCare, string> = {
    routine_home_care: "R",
    continuous_home_care: "C",
    inpatient_respite_care: "I",
    general_inpatient_care: "G",
  };
  const bucketDigit =
    first.rhcDayBucket === "days_1_60" ? "1" : first.rhcDayBucket === "days_61_plus" ? "6" : "0";
  // [LOC char][RHC bucket digit][3 filler] — fixed 5 chars; filler positions await the CMS fixture.
  return `${locChar[first.levelOfCare]}${bucketDigit}000`;
}

/** A single resolved billable day, before contiguous days are coalesced into segments. */
interface DayResolution {
  readonly iso: IsoDate;
  readonly levelOfCare: LevelOfCare;
  readonly bucket: RhcDayBucket;
  readonly baseRatePerDiemCents: Cents;
  readonly ratePerDiemCents: Cents;
}

/**
 * Compute the HIPPS per-diem breakdown for a claim (D7). Walks every calendar day of the claim's
 * inclusive from-through range, assigns each day the level of care from the FIRST matching injected LOC
 * period (a day not covered by any period is a gap — no charge, no segment), buckets RHC days by
 * day-of-stay, applies the wage index to the resolved CMS base rate, then coalesces contiguous days that
 * share a (level-of-care, RHC-bucket) pair into segments. Pure + deterministic; throws on an inverted
 * claim range (a caller bug).
 */
export function calculateHipps(input: HippsCalculationInput): HippsCalculationResult {
  const fromDay = toEpochDay(input.claimServiceFrom);
  const toDay = toEpochDay(input.claimServiceTo);
  if (toDay < fromDay) {
    throw new RangeError(
      `calculateHipps: claimServiceTo (${input.claimServiceTo}) precedes claimServiceFrom (${input.claimServiceFrom})`,
    );
  }

  // 1. Resolve each calendar day to a level of care + wage-adjusted per-diem (skip uncovered gap days).
  const days: DayResolution[] = [];
  for (let day = fromDay; day <= toDay; day++) {
    const iso = fromEpochDay(day);
    const period = input.levelOfCarePeriods.find(
      (p) => day >= toEpochDay(p.from) && day <= toEpochDay(p.to),
    );
    if (period === undefined) continue; // gap day — no LOC documented → no per-diem.

    const loc = period.levelOfCare;
    const bucket: RhcDayBucket =
      loc === "routine_home_care"
        ? dayOfStay(input.hospiceAdmissionDate, iso) <= RHC_HIGH_TIER_LAST_DAY
          ? "days_1_60"
          : "days_61_plus"
        : "n/a";
    const baseRatePerDiemCents = baseRateFor(input.rateTable, loc, bucket);
    const ratePerDiemCents = applyWageIndexFactor(
      baseRatePerDiemCents,
      input.wageIndexFactorDecimal,
    );
    days.push({ iso, levelOfCare: loc, bucket, baseRatePerDiemCents, ratePerDiemCents });
  }

  // 2. Coalesce contiguous days sharing (levelOfCare, bucket) into segments.
  const segments: HippsSegmentResult[] = [];
  let position = 0;
  for (const dayRes of days) {
    const open = segments[segments.length - 1];
    const sameAsOpen =
      open !== undefined &&
      open.levelOfCare === dayRes.levelOfCare &&
      open.rhcDayBucket === dayRes.bucket;
    if (sameAsOpen) {
      const grown: HippsSegmentResult = {
        ...open,
        dateTo: dayRes.iso,
        days: open.days + 1,
        segmentTotalCents: perDiemAmountCents(open.ratePerDiemCents, open.days + 1),
      };
      segments[segments.length - 1] = grown;
    } else {
      position += 1;
      segments.push({
        levelOfCare: dayRes.levelOfCare,
        levelOfCareCode: levelOfCareToCode(dayRes.levelOfCare),
        dateFrom: dayRes.iso,
        dateTo: dayRes.iso,
        days: 1,
        baseRatePerDiemCents: dayRes.baseRatePerDiemCents,
        ratePerDiemCents: dayRes.ratePerDiemCents,
        rhcDayBucket: dayRes.bucket,
        hippsCharPosition: position,
        segmentTotalCents: perDiemAmountCents(dayRes.ratePerDiemCents, 1),
      });
    }
  }

  const rhcDays1to60 = days.filter((d) => d.bucket === "days_1_60").length;
  const rhcDays61Plus = days.filter((d) => d.bucket === "days_61_plus").length;
  const totalCents = sumCents(segments.map((s) => s.segmentTotalCents));
  const perDiemRateCents = segments[0]?.ratePerDiemCents ?? 0;

  return {
    hippsCode: deriveHippsCode(segments),
    perDiemRateCents,
    wageIndexCcn: input.wageIndexCcn,
    wageIndexFiscalYear: input.wageIndexFiscalYear,
    wageIndexFactorApplied: input.wageIndexFactorDecimal,
    segments,
    rhcDays1to60,
    rhcDays61Plus,
    totalCents,
  };
}
