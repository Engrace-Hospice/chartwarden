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
import { selectNewestContract } from "./contract-select";

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

/** `YYYY-MM-DD` of the UTC day containing `at`. */
export const utcDateOf = (at: Date): string => at.toISOString().slice(0, 10);

export async function recordDailyCensusForOrg(
  deps: DailyCensusDeps,
  organizationId: string,
): Promise<DailyCensusResult> {
  const at = (deps.now ?? (() => new Date()))();
  // M5's own count, read under the org's RLS before the platform write. A failure throws and fails this org's pass (the fan-out reports
  // it and retries on the next sweep); it is never recorded as zero.
  const count = await deps.census.activePatientCount(organizationId);
  const censusDate = utcDateOf(at);
  return deps.platformRunner(async (tx) => {
    // One transaction: only an org with a live contract is recorded. The sweep passes only those; this is the backstop, and it asks
    // the same shared question (a canceled contract is not "a contract": see contract-select.ts).
    if (!(await selectNewestContract(tx, "live", at, organizationId))) return { recorded: false };
    await tx
      .insert(PCD)
      .values({ organizationId, censusDate, activePatientCount: count, observedAt: at })
      .onConflictDoUpdate({
        target: [PCD.organizationId, PCD.censusDate],
        set: { activePatientCount: count, observedAt: at },
        // The latest observation of the day wins; a late retry of an older one changes nothing.
        setWhere: sql`${PCD.observedAt} < ${at}`,
      });
    return { recorded: true, censusDate, count };
  });
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
