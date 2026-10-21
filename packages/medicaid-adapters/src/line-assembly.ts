// @chartwarden/medicaid-adapters — the per-line hospice claim-line segment builder (WX-PR-011 follow-up). PURE
// DOMAIN: no Fastify, Drizzle, BullMQ, clock, PHI — every date is an already-resolved ISO string, every rate
// comes from an injected resolver function, so this is deterministic and unit-testable without a database.
//
// SCOPE (mirrors the M23 `calculatePerDiemClass` precedent, simplified): a hospice level-of-care (LOC) period is
// walked and clipped to the claim's [serviceFrom, serviceTo] window, then collapsed into ONE claim line per
// contiguous same-LOC run (not one line per calendar day — a 12-day RHC stretch is one line with units=12).
// Unlike M23's HIPPS math (day-1-7 vs day-8+ RHC rate buckets from the hospice admission date, wage-index
// adjustment), Medicaid per-diem billing here is flat-rate-per-LOC-per-segment — no day-bucket split.
//
// Q-CODE — real place-of-service resolution (WX-PR-011 follow-up #2): `resolvePlaceOfServiceQCode` maps
// the CMS hospice Q5001-Q5009 place-of-service space from real facts (M6 LOC-period facility/IPU-bed, M5
// patient-address kind/facility, M40 facility.kind), NOT level-of-care alone — a GIP patient in a
// contracted hospital bed is Q5005, not Q5006; an RHC patient living in an ALF is Q5002, not Q5001. Facts
// are OPTIONAL per period (`LevelOfCarePeriodInput.placeOfService`): a caller that cannot supply them
// (no facility/residence data wired) falls back to the original coarse LOC-based default, preserving every
// existing caller/test. Still a documented simplification: only ONE place-of-service snapshot per period
// (the period's start date) — an address/facility change mid-period does not split the line.
import type { Cents, IsoDate, MedicaidLevelOfCare } from "./contracts";

/** M40 `facility.kind`, mirrored without a cross-package import (leaf-typed, matches packages/db/src/enums.ts). */
export type PlaceOfServiceFacilityKind =
  | "hospital"
  | "alf"
  | "snf"
  | "nf"
  | "ipu"
  | "ltch"
  | "psych"
  | "clinic"
  | "other";

/** M5 `patient_address.kind`, mirrored without a cross-package import. */
export type PlaceOfServiceResidenceKind = "home" | "facility" | "mailing" | "temporary" | "prior";

export type PlaceOfServiceQCode =
  | "Q5001"
  | "Q5002"
  | "Q5003"
  | "Q5004"
  | "Q5005"
  | "Q5006"
  | "Q5007"
  | "Q5008"
  | "Q5009";

/** The real facts a caller resolves (M6/M5/M40 reads) before invoking `buildHospiceLines`. */
export interface PlaceOfServiceFacts {
  /** True when the LOC period's `ipu_bed_assignment_id` is set — a CONFIRMED bed in the hospice's OWN
   *  IPU (M37), unambiguously Q5006 regardless of any facility-kind lookup. */
  readonly ownIpuBed: boolean;
  /** `facility.kind` for the LOC period's own `facility_id`, when set (M6 §2.3.5 — IRC/GIP's inpatient
   *  site, or any LOC's documented delivery site). Takes priority over the patient's residence. */
  readonly locPeriodFacilityKind: PlaceOfServiceFacilityKind | null;
  /** The patient's primary-address kind as of the period's anchor date, or null if unresolvable. */
  readonly residenceKind: PlaceOfServiceResidenceKind | null;
  /** `facility.kind` for the residence's `facility_id`, only meaningful when `residenceKind === "facility"`. */
  readonly residenceFacilityKind: PlaceOfServiceFacilityKind | null;
}

const Q_CODE_BY_FACILITY_KIND: Record<PlaceOfServiceFacilityKind, PlaceOfServiceQCode> = {
  hospital: "Q5005",
  alf: "Q5002",
  nf: "Q5003",
  snf: "Q5004",
  ipu: "Q5006",
  ltch: "Q5007",
  psych: "Q5008",
  clinic: "Q5009",
  other: "Q5009",
};

/**
 * Resolve the real CMS Q5001-Q5009 place-of-service code from facts, falling back to a LOC-based default
 * only when NO fact resolves a place — GIP defaults to Q5006 (the hospice's own inpatient facility is the
 * common case); IRC has no honest single default (inpatient respite is, by definition, never "home") so
 * it falls to Q5009 (NOS) rather than fabricating a specific facility kind; RHC/CHC default to Q5001
 * (home is the overwhelming common case for routine/continuous levels absent contrary evidence).
 */
export function resolvePlaceOfServiceQCode(
  levelOfCare: Exclude<MedicaidLevelOfCare, "NF_RB">,
  facts: PlaceOfServiceFacts,
): PlaceOfServiceQCode {
  if (facts.ownIpuBed) return "Q5006";
  const facilityKind =
    facts.locPeriodFacilityKind ??
    (facts.residenceKind === "facility" ? facts.residenceFacilityKind : null);
  if (facilityKind) return Q_CODE_BY_FACILITY_KIND[facilityKind];
  if (facts.residenceKind === "home") return "Q5001";
  if (levelOfCare === "GIP") return "Q5006";
  if (levelOfCare === "IRC") return "Q5009";
  return "Q5001";
}

export interface LevelOfCarePeriodInput {
  readonly levelOfCarePeriodId: string;
  readonly levelOfCare: Exclude<MedicaidLevelOfCare, "NF_RB">;
  /** Inclusive. */
  readonly from: IsoDate;
  /** Inclusive; null = still open (clipped to the claim's serviceTo). */
  readonly to: IsoDate | null;
  /** Caller-resolved place-of-service facts for this period (the anchor date is the period's own `from`,
   *  resolved by the caller BEFORE clipping). Absent = fall back to the coarse LOC-based Q-code default —
   *  every pre-existing caller/test that doesn't supply this keeps its original behavior. */
  readonly placeOfService?: PlaceOfServiceFacts;
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
      qCode: period.placeOfService
        ? resolvePlaceOfServiceQCode(period.levelOfCare, period.placeOfService)
        : Q_CODE_BY_LOC[period.levelOfCare],
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
