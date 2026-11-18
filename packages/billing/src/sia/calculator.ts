// @chartwarden/billing — M23 SIA (Service Intensity Add-on) calculator (D6, spec §1.1 / §3.3 `sia_calculation`).
// The decision of WHICH visits count and for how many 15-minute units lives in the shared engine
// (`evaluateSiaUnits`, ./sia-units.ts); this file prices that result at the wage-adjusted CHC hourly rate
// (units x hourly / 4, rounded once on the total). The add-on is paid IN ADDITION to the RHC per-diem and only when
// the patient died: a not-deceased patient, or a deceased patient with no payable visit, yields `present: false`.
// The CHC hourly rate is the wage-index-ADJUSTED amount and is INJECTED by the caller (F-210 tenant-entered rate
// table, F-211 wage index on the CHC labor share); nothing is fabricated here.
// PURE DOMAIN: no Fastify, no Drizzle/DB, no BullMQ, no `@chartwarden/db`, no `getSeam`, no clock. No PHI (D13).
import type { IsoDate } from "../contracts";
import type { Cents } from "../domain/money";
import {
  type SiaDateSpan,
  type SiaPolicy,
  type SiaUnitsResult,
  type SiaVisitInput,
  evaluateSiaUnits,
  siaAmountCents,
} from "./sia-units";

/** The pure SIA calculator input — all plain data; nothing is read from a seam or clock. */
export interface SiaCalculationInput {
  /** The patient's date of death; `null` ⇒ not deceased ⇒ no SIA. */
  readonly deceasedDate: IsoDate | null;
  /** The visits in (or around) the window, from M8's billable-encounter read. */
  readonly visits: readonly SiaVisitInput[];
  /** Spans of ROUTINE HOME CARE only. */
  readonly rhcPeriods: readonly SiaDateSpan[];
  /** The claim's own service dates; visits on other claims are not counted here. */
  readonly claimWindow?: SiaDateSpan;
  /** The wage-index-adjusted CHC HOURLY rate in whole cents (injected). */
  readonly chcHourlyRateCents: Cents;
  readonly policy?: Partial<SiaPolicy>;
}

/** One counted visit captured in the result (mirrors `sia_calculation.qualifying_visits`). */
export interface SiaQualifyingVisitResult {
  readonly encounterId: string;
  readonly visitDate: IsoDate;
  readonly discipline: string;
  readonly durationMinutes: number;
  readonly units: number;
  readonly paidUnits: number;
}

/** The pure SIA calculation result — the caller persists this onto `sia_calculation`. */
export interface SiaCalculationResult {
  /** True iff the SIA is payable: the patient died and at least one unit is payable. */
  readonly present: boolean;
  /** True iff an RN/MSW visit sat in the window, payable or not (a snapshot explaining a zero is still worth keeping). */
  readonly hasCandidateVisits: boolean;
  readonly patientDeceasedDate: IsoDate | null;
  /** `deceasedDate − 6` (inclusive window start); `null` when not deceased. */
  readonly windowStart: IsoDate | null;
  /** `deceasedDate` (inclusive window end); `null` when not deceased. */
  readonly windowEnd: IsoDate | null;
  readonly qualifyingVisits: readonly SiaQualifyingVisitResult[];
  /** Documented minutes of the counted visits (clinical time, before rounding and the daily cap). */
  readonly totalQualifyingMinutes: number;
  readonly eligibleUnits: number;
  readonly paidUnits: number;
  readonly truncatedUnits: number;
  readonly siaAddOnCents: Cents;
  /** The full per-visit / per-day evaluation, for the snapshot and the claim-editor table. */
  readonly evaluation: SiaUnitsResult;
}

const CANDIDATE_DISCIPLINES: ReadonlySet<string> = new Set(["rn", "msw"]);

/**
 * Compute the SIA add-on (D6): evaluate the visits through the shared engine, then price the payable units.
 * Pure + deterministic.
 */
export function calculateSia(input: SiaCalculationInput): SiaCalculationResult {
  const evaluation = evaluateSiaUnits({
    visits: input.visits,
    deathDate: input.deceasedDate,
    rhcPeriods: input.rhcPeriods,
    claimWindow: input.claimWindow,
    policy: input.policy,
  });
  const counted = evaluation.visits.filter((v) => v.counted);
  return {
    present: evaluation.paidUnits > 0,
    hasCandidateVisits: evaluation.visits.some((v) => CANDIDATE_DISCIPLINES.has(v.discipline)),
    patientDeceasedDate: input.deceasedDate,
    windowStart: evaluation.window?.from ?? null,
    windowEnd: evaluation.window?.to ?? null,
    qualifyingVisits: counted.map((v) => ({
      encounterId: v.encounterId,
      visitDate: v.serviceDate,
      discipline: v.discipline,
      durationMinutes: v.durationMinutes ?? 0,
      units: v.units ?? 0,
      paidUnits: v.paidUnits,
    })),
    // Informational whole minutes for the `integer` column (the paid amount comes from the UNITS). The reader hands
    // over exact, fractional bracket minutes (an EVV bracket has seconds) and the per-visit exact values are kept
    // in the snapshot's visit_outcomes, so the one rounding happens here on the sum, never per visit.
    totalQualifyingMinutes: Math.round(
      counted.reduce((sum, v) => sum + (v.durationMinutes ?? 0), 0),
    ),
    eligibleUnits: evaluation.eligibleUnits,
    paidUnits: evaluation.paidUnits,
    truncatedUnits: evaluation.truncatedUnits,
    siaAddOnCents: siaAmountCents(evaluation.paidUnits, input.chcHourlyRateCents),
    evaluation,
  };
}
