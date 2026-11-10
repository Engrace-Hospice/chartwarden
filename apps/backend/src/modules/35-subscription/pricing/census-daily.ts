// apps/backend/src/modules/35-subscription/pricing/census-daily.ts — the DAILY CENSUS behind the average daily census (ADC).
//
// ADC is the meter of the census band, and #952 already built the census: M5's `PatientCensusReader` and the `m35.patient-census`
// sweep (every 6 hours, through the M35 org fan-out). That sweep counts a patient once per MONTH (`patient_active_period`), which is the
// right shape for the claims-billing add-on and the wrong one for an average over days. So this rides the SAME sweep and the SAME reader
// (`activePatientCount`, M5's own count of patients whose status is `active`) and keeps one number per organisation per UTC day: the
// latest observation of the day wins (a 6-hourly sweep makes that the 18:00 UTC reading). No second census, no patient id.
//
//   ADC(month) = the mean of the daily counts of the days observed in the month, in hundredths of a patient (see the pure
//   `averageDailyCensusHundredths`). A day nobody observed is not a zero: it is left out of the mean and reported (`adcDaysObserved`
//   vs `adcDaysInPeriod` on the statement), so a sweep outage shows as thin coverage, not as a falsely low census.
//
// Only organisations with a LIVE census_banded contract (the shared selector, scope "live": a subscription that is neither canceled nor
// paused) are recorded, through the platform runner: a tenant holds SELECT on the table and can never write the census it is billed on.
import { schema } from "@chartwarden/db";
import type { PatientCensusReader } from "@chartwarden/types";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { PlatformRunner, WriteTx } from "../routes/service-drizzle";
import { selectContracts } from "./contract-select";

const PCD = schema.patientCensusDaily;

export interface DailyCensusDeps {
  readonly platformRunner: PlatformRunner;
  readonly census: Pick<PatientCensusReader, "activePatientCount">;
  readonly now?: () => Date;
}

export interface DailyCensusResult {
  readonly recorded: boolean;
  readonly censusDate?: string;
  readonly count?: number;
}

/** One organisation's count as M5 reported it, not yet written. */
export interface DailyCensusObservation {
  readonly organizationId: string;
  readonly count: number;
  readonly observedAt: Date;
}

/** `YYYY-MM-DD` of the UTC day containing `at`. */
export const utcDateOf = (at: Date): string => at.toISOString().slice(0, 10);

/**
 * M5's own count for one org, read under that org's RLS (no platform transaction). A failure throws and fails this org's pass (the
 * fan-out reports it and retries on the next sweep); it is never recorded as zero.
 */
export async function observeDailyCensus(
  deps: Pick<DailyCensusDeps, "census" | "now">,
  organizationId: string,
): Promise<DailyCensusObservation> {
  const observedAt = (deps.now ?? (() => new Date()))();
  return {
    organizationId,
    count: await deps.census.activePatientCount(organizationId),
    observedAt,
  };
}

/**
 * Write the observations in ONE platform transaction (every platform runner call is an audited cross-tenant bypass, so the sweep writes
 * its orgs' counts together instead of one transaction per org). Only an org with a live contract is recorded; the sweep passes only
 * those, and this is the backstop that asks the same shared question (a canceled contract is not "a contract": see contract-select.ts).
 * Results are in the order of `observations`.
 */
export async function recordDailyCensusBatch(
  deps: Pick<DailyCensusDeps, "platformRunner" | "now">,
  observations: readonly DailyCensusObservation[],
): Promise<DailyCensusResult[]> {
  if (observations.length === 0) return [];
  const at = (deps.now ?? (() => new Date()))();
  return deps.platformRunner(async (tx) => {
    const live = new Set(
      (await selectContracts(tx, "live", at)).map((r) => r.contract.organizationId),
    );
    const results: DailyCensusResult[] = [];
    for (const { organizationId, count, observedAt } of observations) {
      if (!live.has(organizationId)) {
        results.push({ recorded: false });
        continue;
      }
      const censusDate = utcDateOf(observedAt);
      await tx
        .insert(PCD)
        .values({ organizationId, censusDate, activePatientCount: count, observedAt })
        .onConflictDoUpdate({
          target: [PCD.organizationId, PCD.censusDate],
          set: { activePatientCount: count, observedAt },
          // The latest observation of the day wins; a late retry of an older one changes nothing.
          setWhere: sql`${PCD.observedAt} < ${observedAt}`,
        });
      results.push({ recorded: true, censusDate, count });
    }
    return results;
  });
}

export async function recordDailyCensusForOrg(
  deps: DailyCensusDeps,
  organizationId: string,
): Promise<DailyCensusResult> {
  const observation = await observeDailyCensus(deps, organizationId);
  const [result] = await recordDailyCensusBatch(deps, [observation]);
  return result ?? { recorded: false };
}

/** The org's daily counts for the UTC days in [window.start, window.end). Platform transaction: explicit org filter. */
export async function readDailyCensus(
  tx: WriteTx,
  organizationId: string,
  window: { readonly start: Date; readonly end: Date },
): Promise<number[]> {
  const rows = await tx
    .select({ n: PCD.activePatientCount })
    .from(PCD)
    .where(
      and(
        eq(PCD.organizationId, organizationId),
        gte(PCD.censusDate, utcDateOf(window.start)),
        lt(PCD.censusDate, utcDateOf(window.end)),
      ),
    );
  return rows.map((r) => r.n);
}
