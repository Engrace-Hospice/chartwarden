// @chartwarden/billing — the ONE mapper from a persisted `sia_calculation` row to the `SiaView` the claim detail publishes
// (`pricing.sia`). The claim read service AND the write service (assemble / replace / void responses) both call it, so the
// two read sites cannot drift apart again. PURE: no I/O, never mutates the row. No PHI / MBI (D13): encounter ids, dates,
// minutes and units only.
import type { SiaCalculation } from "@chartwarden/db/schema";
import type { SiaView, SiaVisitView } from "./claim-read";

const visitViewOf = (
  outcome: NonNullable<SiaCalculation["visitOutcomes"]>[number],
): SiaVisitView => ({
  id: outcome.encounterId,
  date: outcome.serviceDate,
  discipline: outcome.discipline,
  minutes: outcome.durationMinutes,
  timeSource: outcome.timeSource ?? null,
  units: outcome.units,
  paidUnits: outcome.paidUnits,
  counted: outcome.counted,
  reason: outcome.excluded,
});

/**
 * Project a `sia_calculation` row onto {@link SiaView}. A `units_v2` row maps field for field; a legacy `minutes_v1` row has
 * no units snapshot, so its unit totals, rate, wage index and policy are null and `visits` is empty (its price and minutes stay).
 */
export function siaViewOf(row: SiaCalculation): SiaView {
  return {
    basis: row.basis,
    revision: row.revision,
    windowStart: row.windowStart,
    windowEnd: row.patientDeceasedDate,
    paidUnits: row.paidUnits,
    eligibleUnits: row.eligibleUnits,
    truncatedUnits: row.truncatedUnits,
    chcHourlyRateCents: row.chcHourlyRateCents,
    wageIndexFiscalYear: row.wageIndexFiscalYear,
    amountCents: row.siaAddOnCents,
    totalQualifyingMinutes: row.totalQualifyingMinutes,
    calculatedAt: row.calculatedAt.toISOString(),
    policy: row.policy ? { ...row.policy } : null,
    visits: (row.visitOutcomes ?? []).map(visitViewOf),
    priorClaimAdvisory: row.priorClaimAdvisory ? { ...row.priorClaimAdvisory } : null,
  };
}
