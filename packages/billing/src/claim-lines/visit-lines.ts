// @wardenx/billing — derive the hospice visit claim lines (CMS Pub. 100-04 ch. 11 §30.3) from the claim's
// billable encounters. One dated line per visit, in 15-minute units, riding the level-of-care period that covers
// the visit date (the claim_line model requires one). Nothing is guessed: a visit with no documented duration, or
// outside every level-of-care period, is reported back as `unresolved` for the caller to fail on, and visits
// whose reporting rule is not implemented are reported as `deferred`. PURE: no I/O, no clock.
import type { IsoDate, LevelOfCare } from "../contracts";
import type { BillabilityState } from "../rules/types";
import type { VisitChargeDiscipline } from "../visit-charges";
import { type VisitRevenueCode, visitCodeFor, visitUnitsForMinutes } from "./visit-codes";

export interface VisitEncounterInput {
  readonly encounterId: string;
  readonly serviceDate: IsoDate;
  readonly billability: BillabilityState;
  readonly discipline: string;
  readonly encounterType: string | null;
  /** Documented visit minutes (start-to-end bracket); `null`/`0` = not documented. */
  readonly durationMinutes: number | null;
}

export interface VisitLevelOfCarePeriod {
  readonly levelOfCarePeriodId: string;
  readonly levelOfCare: LevelOfCare;
  readonly from: IsoDate;
  readonly to: IsoDate;
}

export interface VisitLineSpec {
  readonly revenueCode: VisitRevenueCode;
  readonly hcpcsCode: string;
  /** The discipline the visit charge is keyed by. */
  readonly discipline: VisitChargeDiscipline;
  readonly serviceDate: IsoDate;
  readonly unitCount: number;
  /** The covering period's level of care (the repository maps it to the DB code at its boundary). */
  readonly levelOfCare: LevelOfCare;
  readonly levelOfCarePeriodId: string;
  readonly backingEncounterIds: readonly string[];
}

export interface UnresolvedVisit {
  readonly encounterId: string;
  readonly reason: "duration_missing" | "no_level_of_care_period";
}

export interface DeferredVisit {
  readonly encounterId: string;
  readonly reason: "inpatient_hospice_facility_weekly_reporting";
}

export interface VisitLinesResult {
  readonly lines: readonly VisitLineSpec[];
  readonly unresolved: readonly UnresolvedVisit[];
  readonly deferred: readonly DeferredVisit[];
}

export interface BuildVisitLinesInput {
  readonly encounters: readonly VisitEncounterInput[];
  readonly levelOfCarePeriods: readonly VisitLevelOfCarePeriod[];
  /**
   * True when care is at a hospice's own inpatient facility (Q5006). CMS reports those visits weekly
   * (Sunday-Saturday) with therapy, social-work phone calls and post-mortem visits excluded — a different
   * shape than per-visit lines, not implemented here, so every visit is deferred rather than mis-reported.
   */
  readonly inpatientHospiceFacility: boolean;
}

const byDateThenId = (a: VisitEncounterInput, b: VisitEncounterInput): number =>
  a.serviceDate === b.serviceDate
    ? a.encounterId.localeCompare(b.encounterId)
    : a.serviceDate.localeCompare(b.serviceDate);

export function buildVisitLines(input: BuildVisitLinesInput): VisitLinesResult {
  const lines: VisitLineSpec[] = [];
  const unresolved: UnresolvedVisit[] = [];
  const deferred: DeferredVisit[] = [];

  const candidates = input.encounters.filter((e) => e.billability === "billable");
  for (const encounter of [...candidates].sort(byDateThenId)) {
    const code = visitCodeFor({
      discipline: encounter.discipline,
      encounterType: encounter.encounterType,
    });
    if (code === null) continue;
    if (input.inpatientHospiceFacility) {
      deferred.push({
        encounterId: encounter.encounterId,
        reason: "inpatient_hospice_facility_weekly_reporting",
      });
      continue;
    }
    const units = visitUnitsForMinutes(encounter.durationMinutes ?? 0);
    if (units === null) {
      unresolved.push({ encounterId: encounter.encounterId, reason: "duration_missing" });
      continue;
    }
    const period = input.levelOfCarePeriods.find(
      (p) => encounter.serviceDate >= p.from && encounter.serviceDate <= p.to,
    );
    if (period === undefined) {
      unresolved.push({ encounterId: encounter.encounterId, reason: "no_level_of_care_period" });
      continue;
    }
    lines.push({
      revenueCode: code.revenueCode,
      hcpcsCode: code.hcpcsCode,
      discipline: code.discipline,
      serviceDate: encounter.serviceDate,
      unitCount: units,
      levelOfCare: period.levelOfCare,
      levelOfCarePeriodId: period.levelOfCarePeriodId,
      backingEncounterIds: [encounter.encounterId],
    });
  }
  return { lines, unresolved, deferred };
}
