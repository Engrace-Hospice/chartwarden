// apps/backend/src/modules/30-quality/jobs/ssvi-resolvers.ts — the `m30.measure_recompute` input resolvers for the
// FY2027 Service and Spending Variation Index (SSVI) family (CMS-1851-F §III.B.2, Table 9).
//
// Kept out of m30-jobs.ts (already the module's largest file); m30-jobs.ts routes every `ssvi_*` code here via
// `resolveSsviMeasureInput`. Same posture as the HCI resolvers: aggregate seam reads in, a calculator input out,
// never a cross-module SQL join, never a fabricated zero.
//
//   metric 1        M6 LevelOfCarePeriodReader.chcOrGipCoverageCounts (the HCI-1 aggregate)
//   metric 2        M23 ClaimLineReader (via the M30 billing consumer) — billed RHC days by site-of-service Q-code
//   metric 3        M6 death census + level-of-care spans × M8 skilled-visit days
//   metrics 4/5/8   M6 DischargeReader.ssviDischargeCounts
//   metric 6        M6 level-of-care spans × M8 skilled-nursing minutes (the HCI-8 reduction)
//   metric 7        M6 level-of-care spans × M8 skilled-visit days
//   metric 9        declared UNAVAILABLE (other providers' Medicare claims — SSVI_UNAVAILABLE_METRICS)
//   composite       the nine persisted metric values (quality_measure_value), like the HCI composite
//
// Every value is an INTERNAL ESTIMATE; CMS computes and publishes the official SSVI. Thresholds: the latest
// published SSVI cut table at or before the reporting period's fiscal year (`ssviThresholdsFor`).
import {
  type MeasureRegistration,
  type QualityBillingConsumer,
  SSVI_METRIC_MEASURE_CODES,
  type SsviMetricKey,
  type SsviMetricResults,
  type SsviThresholdTable,
  skilledNursingMinutesOnRhcDays,
  ssviLastTwoDaysRhcWithVisit,
  ssviThresholdsFor,
  ssviUnavailabilityFor,
  ssviWeekendRhcDaysWithSkilledVisit,
} from "@chartwarden/quality";
import type {
  DeathDischargeReader,
  DischargeReader,
  LevelOfCarePeriodReader,
  SignedEncountersReader,
} from "@chartwarden/types";

/** The recompute request every resolver receives (the worker's `resolveInput` request shape). */
export interface SsviResolveRequest {
  readonly registration: MeasureRegistration;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
}

/** The seams the SSVI resolvers read (all already bound for the HCI/HVLDL paths, plus the billing consumer). */
export interface SsviResolveSeams {
  readonly levelOfCarePeriodReader: LevelOfCarePeriodReader;
  readonly dischargeReader: DischargeReader;
  readonly deathDischargeReader: DeathDischargeReader;
  readonly encounters: SignedEncountersReader;
  readonly billing: QualityBillingConsumer;
  /** The persisted-value ledger the composite reads its nine inputs from. */
  readonly values: {
    findCurrent(
      measureCode: string,
      providerEntityId: string,
      periodStart: Date,
      periodEnd: Date,
    ): Promise<{
      numerator: number;
      denominator: number;
      ratio: string | null;
      thresholdMet: boolean | null;
      computationSnapshot: Record<string, unknown> | null;
    } | null>;
  };
}

const MS_PER_DAY = 86_400_000;

/** `yyyy-mm-dd` of an ISO instant/date shifted by `days`. */
function shiftDay(iso: string, days: number): string {
  return new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00.000Z`) + days * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/** The federal fiscal year a period END falls in (Oct 1 starts the next FY). */
export function ssviFiscalYearOf(periodEnd: string): number {
  const d = new Date(periodEnd);
  return d.getUTCMonth() >= 9 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
}

/** The cut table for a period: the latest published at or before the period's fiscal year. */
export function ssviThresholdsForPeriod(periodEnd: string): SsviThresholdTable {
  return ssviThresholdsFor(ssviFiscalYearOf(periodEnd));
}

/** Whether a measure code belongs to the SSVI family (the worker's routing predicate). */
export function isSsviMeasureCode(code: string): boolean {
  return code.startsWith("ssvi_");
}

/** Resolve any `ssvi_*` measure's calculator input. Throws on an unknown SSVI code (a catalog drift). */
export async function resolveSsviMeasureInput(
  request: SsviResolveRequest,
  seams: SsviResolveSeams,
): Promise<unknown> {
  const { organizationId, providerEntityId, periodStart, periodEnd } = request;
  const code = request.registration.code;
  const base = { organizationId, providerEntityId, periodStart, periodEnd };
  const thresholds = ssviThresholdsForPeriod(periodEnd);
  const window = { from: periodStart, to: periodEnd };
  const rule = (key: Exclude<SsviMetricKey, "metric_09">) => thresholds.metrics[key];

  const declared = ssviUnavailabilityFor(code);
  if (declared !== null) {
    return {
      ...base,
      nonHospiceSpendingCents: 0,
      octileUpperBoundsCents: thresholds.spendingOctileUpperBoundsCents,
      unavailable: { reason: declared.reason, requires: declared.requires },
    };
  }

  switch (code) {
    case "ssvi_metric_01": {
      const c = await seams.levelOfCarePeriodReader.chcOrGipCoverageCounts(organizationId, window);
      return {
        ...base,
        totalElectionPeriods: c.denominator,
        periodsWithChcOrGipDay: c.numerator,
        rule: rule("metric_01"),
      };
    }
    case "ssvi_metric_02": {
      const r = await seams.billing.claimLineRollup(organizationId, {
        from: periodStart.slice(0, 10),
        to: shiftDay(periodEnd, -1),
      });
      // An unregistered M23 seam SUPPRESSES (0/0), never scores a zero share.
      if (r.isForwardSeamDenyStub) {
        return { ...base, totalRhcDays: 0, rhcDaysInNursingFacility: 0, rule: rule("metric_02") };
      }
      return {
        ...base,
        totalRhcDays: r.rhcDays,
        rhcDaysInNursingFacility: r.rhcNursingFacilityDays,
        rule: rule("metric_02"),
      };
    }
    case "ssvi_metric_03": {
      const deaths = await seams.deathDischargeReader.listDeathDischargesInPeriod(
        organizationId,
        window,
      );
      // One day before the window so a death on its first day still sees the day before.
      const wide = { from: shiftDay(periodStart, -1), to: shiftDay(periodEnd, 1) };
      const [spans, visits] = await Promise.all([
        seams.levelOfCarePeriodReader.levelOfCareDaySpans(organizationId, wide),
        seams.encounters.skilledVisitDaysForOrg(organizationId, wide),
      ]);
      const counts = ssviLastTwoDaysRhcWithVisit(
        deaths.map((d) => ({ admissionId: d.admissionId, deathDate: d.deathAt.slice(0, 10) })),
        spans,
        visits,
      );
      return { ...base, ...counts, rule: rule("metric_03") };
    }
    case "ssvi_metric_04":
    case "ssvi_metric_05":
    case "ssvi_metric_08": {
      const c = await seams.dischargeReader.ssviDischargeCounts(organizationId, window);
      if (code === "ssvi_metric_04")
        return {
          ...base,
          totalDischarges: c.totalDischarges,
          liveDischarges: c.liveDischarges,
          rule: rule("metric_04"),
        };
      if (code === "ssvi_metric_05")
        return {
          ...base,
          totalDischarges: c.totalDischarges,
          dischargesWithLosOver180: c.dischargesWithLosOver180,
          rule: rule("metric_05"),
        };
      return {
        ...base,
        liveDischarges: c.liveDischarges,
        liveDischargesReadmittedWithin7Days: c.liveDischargesReadmittedWithin7Days,
        rule: rule("metric_08"),
      };
    }
    case "ssvi_metric_06": {
      const [spans, dayTotals] = await Promise.all([
        seams.levelOfCarePeriodReader.levelOfCareDaySpans(organizationId, window),
        seams.encounters.skilledNursingDayTotalsForOrg(organizationId, window),
      ]);
      const totals = skilledNursingMinutesOnRhcDays(spans, dayTotals, window);
      return {
        ...base,
        totalRhcDays: totals.totalRhcDays,
        skilledNursingMinutesOnRhcDays: totals.skilledNursingMinutes,
        rule: rule("metric_06"),
      };
    }
    case "ssvi_metric_07": {
      const [spans, visits] = await Promise.all([
        seams.levelOfCarePeriodReader.levelOfCareDaySpans(organizationId, window),
        seams.encounters.skilledVisitDaysForOrg(organizationId, window),
      ]);
      return {
        ...base,
        ...ssviWeekendRhcDaysWithSkilledVisit(spans, visits, window),
        rule: rule("metric_07"),
      };
    }
    case "ssvi_composite":
      return resolveSsviCompositeInput(request, seams.values, thresholds);
    default:
      throw new Error(`resolveSsviMeasureInput: no SSVI resolver for measure code '${code}'`);
  }
}

/** The nine PERSISTED metric values for the same (provider entity, period) → the composite's input. */
async function resolveSsviCompositeInput(
  request: SsviResolveRequest,
  values: SsviResolveSeams["values"],
  thresholds: SsviThresholdTable,
): Promise<unknown> {
  const start = new Date(request.periodStart);
  const end = new Date(request.periodEnd);
  const metrics = {} as Record<SsviMetricKey, unknown>;
  for (const [key, measureCode] of SSVI_METRIC_MEASURE_CODES) {
    const row = await values.findCurrent(measureCode, request.providerEntityId, start, end);
    metrics[key] =
      row === null
        ? null
        : {
            numerator: row.numerator,
            denominator: row.denominator,
            rate: row.ratio === null ? null : Number(row.ratio),
            thresholdMet: row.thresholdMet,
            thresholdValue: null,
            bandColor: row.denominator <= 0 ? "insufficient_n" : "green",
            computationSnapshot: row.computationSnapshot ?? {},
          };
  }
  return {
    organizationId: request.organizationId,
    providerEntityId: request.providerEntityId,
    periodStart: request.periodStart,
    periodEnd: request.periodEnd,
    metrics: metrics as SsviMetricResults,
    thresholds,
  };
}
