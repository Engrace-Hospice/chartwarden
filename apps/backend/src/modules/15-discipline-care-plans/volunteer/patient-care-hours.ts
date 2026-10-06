import { fiscalYearFor } from "@wardenx/discipline-plans";
// apps/backend/src/modules/15-discipline-care-plans/volunteer/patient-care-hours.ts — §7.6 / M15-F04.
//
// The 418.78(e) DENOMINATOR: total patient-care HOURS delivered by paid + contract staff. The spec names no
// discipline list beyond "paid employees and contract staff", so the DECIDED definition (batch 9) is the
// hands-on clinical disciplines M8 signs visits for: RN, LPN, hospice aide (chha), MSW and chaplain. Not
// counted: `volunteer` (that is the numerator), `md`/`np` (physician/NP time is not part of the staff
// hands-on hours basis the spec describes and is billed under separate professional-fee rules) and
// `bereavement_contact` encounters (post-death family support, not patient care). M8 has no therapy
// discipline today; one added later joins CARE_DISCIPLINES.
//
// Pure: the digests are read through M8's SignedEncountersReader seam by `../consumers/patient-care-hours`.
import type { EncounterDiscipline, SignedEncounterDigest } from "@wardenx/types";

/** Hands-on clinical disciplines whose signed visit minutes form the 418.78(e) denominator. */
export const PATIENT_CARE_DISCIPLINES: ReadonlySet<EncounterDiscipline> = new Set([
  "rn",
  "lpn",
  "chha",
  "msw",
  "chaplain",
]);

export interface PatientCareHoursTally {
  /** Sum of the resolved durations of qualifying signed encounters served in the fiscal year. */
  readonly minutes: number;
  /** Qualifying encounters whose duration resolved (counted). */
  readonly resolvedCount: number;
  /** Qualifying encounters with `durationMinutes === null` — EXCLUDED from `minutes`, never counted as 0. */
  readonly unresolvedCount: number;
}

/** Fold one patient's signed-encounter digests into a tally for the fiscal year (by SERVICE date). */
export function tallyPatientCareMinutes(
  digests: ReadonlyArray<SignedEncounterDigest>,
  fiscalYear: number,
): PatientCareHoursTally {
  let minutes = 0;
  let resolvedCount = 0;
  let unresolvedCount = 0;
  for (const d of digests) {
    if (d.encounterType === "bereavement_contact") continue;
    if (!PATIENT_CARE_DISCIPLINES.has(d.discipline)) continue;
    if (fiscalYearFor(`${d.serviceDate}T00:00:00.000Z`) !== fiscalYear) continue;
    if (d.durationMinutes === null) {
      unresolvedCount += 1;
      continue;
    }
    minutes += d.durationMinutes;
    resolvedCount += 1;
  }
  return { minutes, resolvedCount, unresolvedCount };
}

/** Add two tallies (per-patient results rolled up to the provider entity). */
export function addTallies(
  a: PatientCareHoursTally,
  b: PatientCareHoursTally,
): PatientCareHoursTally {
  return {
    minutes: a.minutes + b.minutes,
    resolvedCount: a.resolvedCount + b.resolvedCount,
    unresolvedCount: a.unresolvedCount + b.unresolvedCount,
  };
}

/**
 * The denominator the ratio takes: `null` (⇒ `unavailable`) when NO qualifying encounter has a resolved
 * duration — there is nothing to divide by and a fabricated 0 would read as a breach — else the minutes.
 */
export function denominatorFromTally(tally: PatientCareHoursTally): number | null {
  return tally.resolvedCount === 0 ? null : tally.minutes;
}
