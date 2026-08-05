// @wardenx/medicaid-adapters — the per-line hospice claim-line segment builder (WX-PR-011 follow-up). PURE
// DOMAIN: no Fastify, Drizzle, BullMQ, clock, PHI — every date is an already-resolved ISO string, every rate
// comes from an injected resolver function, so this is deterministic and unit-testable without a database.
//
// SCOPE (mirrors the M23 `calculateHipps` precedent, simplified): a hospice level-of-care (LOC) period is
// walked and clipped to the claim's [serviceFrom, serviceTo] window, then collapsed into ONE claim line per
// contiguous same-LOC run (not one line per calendar day — a 12-day RHC stretch is one line with units=12).
// Unlike M23's HIPPS math (day-1-7 vs day-8+ RHC rate buckets from the hospice admission date, wage-index
// adjustment), Medicaid per-diem billing here is flat-rate-per-LOC-per-segment — no day-bucket split.
//
// Q-CODE SIMPLIFICATION (documented, Phase-1): M24 does not yet model "place of service" the way M23 does
// (no `mdmResolution.placeOfService` equivalent), so the Q-code is derived directly from level of care
// rather than from an independently-tracked place-of-service fact. RHC/CHC/IRC default to Q5001 (home —
// correct for the common case; an LOC delivered at a different site needs place-of-service modeling to
// override, a follow-up). GIP defaults to Q5006 (inpatient hospice facility).
import type { Cents, IsoDate, MedicaidLevelOfCare } from "./contracts";

export interface LevelOfCarePeriodInput {
  readonly levelOfCarePeriodId: string;
  readonly levelOfCare: Exclude<MedicaidLevelOfCare, "NF_RB">;
  /** Inclusive. */
  readonly from: IsoDate;
  /** Inclusive; null = still open (clipped to the claim's serviceTo). */
  readonly to: IsoDate | null;
}

export interface EncounterInput {
  readonly encounterId: string;
  readonly serviceDate: IsoDate;
}

export interface RateResolution {
  readonly rateCents: Cents;
  readonly scheduleId: string;
}

/** Resolve a per-diem rate for one LOC on one date; null = no rate is loaded (a hard stop, not a zero-fill). */
export type RateResolver = (
  levelOfCare: Exclude<MedicaidLevelOfCare, "NF_RB">,
  serviceDate: IsoDate,
) => RateResolution | null;

export interface HospiceLineInput {
  readonly lineNumber: number;
  readonly serviceDate: IsoDate; // the segment's first day (the line's anchor date)
  readonly serviceDateTo: IsoDate; // the segment's last day
  readonly levelOfCare: Exclude<MedicaidLevelOfCare, "NF_RB">;
  readonly locPeriodId: string;
  readonly revenueCode: string;
  readonly qCode: string;
  readonly units: number;
  readonly rateCents: Cents;
  readonly stateRateScheduleId: string;
  readonly chargesCents: Cents;
  readonly backingEncounterIds: readonly string[];
}

export interface BuildHospiceLinesResult {
  readonly lines: readonly HospiceLineInput[];
  /** One entry per segment whose rate could not be resolved — the caller decides whether that blocks. */
  readonly missingRateSegments: ReadonlyArray<{
    levelOfCare: MedicaidLevelOfCare;
    from: IsoDate;
    to: IsoDate;
  }>;
}

const REVENUE_BY_LOC: Record<Exclude<MedicaidLevelOfCare, "NF_RB">, string> = {
  RHC: "0651",
  CHC: "0652",
  IRC: "0655",
  GIP: "0656",
};
const Q_CODE_BY_LOC: Record<Exclude<MedicaidLevelOfCare, "NF_RB">, string> = {
  RHC: "Q5001",
  CHC: "Q5001",
  IRC: "Q5001",
  GIP: "Q5006",
};

const dayMs = 24 * 60 * 60 * 1000;
const toDate = (iso: IsoDate): number => Date.parse(`${iso}T00:00:00.000Z`);
const fromDate = (ms: number): IsoDate => new Date(ms).toISOString().slice(0, 10);
const addDays = (iso: IsoDate, n: number): IsoDate => fromDate(toDate(iso) + n * dayMs);
const dayCountInclusive = (from: IsoDate, to: IsoDate): number =>
  Math.round((toDate(to) - toDate(from)) / dayMs) + 1;
const maxDate = (a: IsoDate, b: IsoDate): IsoDate => (toDate(a) >= toDate(b) ? a : b);
const minDate = (a: IsoDate, b: IsoDate): IsoDate => (toDate(a) <= toDate(b) ? a : b);

/**
 * Clip each LOC period to [serviceFrom, serviceTo], drop periods with no overlap, then build one claim line
 * per surviving (already-non-overlapping, caller-guaranteed) clipped period — LOC periods don't need
 * additional same-LOC merging here because M6 already enforces at most one OPEN period per admission and
 * periods are stored as discrete non-overlapping ranges.
 */
export function buildHospiceLines(input: {
  readonly serviceFrom: IsoDate;
  readonly serviceTo: IsoDate;
  readonly locPeriods: readonly LevelOfCarePeriodInput[];
  readonly rateFor: RateResolver;
  readonly encounters: readonly EncounterInput[];
  readonly startingLineNumber: number;
}): BuildHospiceLinesResult {
  const lines: HospiceLineInput[] = [];
  const missingRateSegments: Array<{
    levelOfCare: MedicaidLevelOfCare;
    from: IsoDate;
    to: IsoDate;
  }> = [];
  let lineNumber = input.startingLineNumber;

  const sorted = [...input.locPeriods].sort((a, b) => toDate(a.from) - toDate(b.from));
  for (const period of sorted) {
    const from = maxDate(period.from, input.serviceFrom);
    const to = minDate(period.to ?? input.serviceTo, input.serviceTo);
    if (toDate(from) > toDate(to)) continue; // no overlap with the claim window

    const rate = input.rateFor(period.levelOfCare, from);
    if (!rate) {
      missingRateSegments.push({ levelOfCare: period.levelOfCare, from, to });
      continue;
    }
    const units = dayCountInclusive(from, to);
    const backingEncounterIds = input.encounters
      .filter((e) => toDate(e.serviceDate) >= toDate(from) && toDate(e.serviceDate) <= toDate(to))
      .map((e) => e.encounterId);

    lines.push({
      lineNumber: lineNumber++,
      serviceDate: from,
      serviceDateTo: to,
      levelOfCare: period.levelOfCare,
      locPeriodId: period.levelOfCarePeriodId,
      revenueCode: REVENUE_BY_LOC[period.levelOfCare],
      qCode: Q_CODE_BY_LOC[period.levelOfCare],
      units,
      rateCents: rate.rateCents,
      stateRateScheduleId: rate.scheduleId,
      chargesCents: rate.rateCents * units,
      backingEncounterIds,
    });
  }
  return { lines, missingRateSegments };
}

// exported for callers that need to advance a day without re-deriving the arithmetic locally
export const addDaysIso = addDays;
