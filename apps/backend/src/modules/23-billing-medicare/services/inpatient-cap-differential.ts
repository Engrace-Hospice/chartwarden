// M23 -> M26 (GAP-038): the per-day recoupment differential for the 20% inpatient cap overage. Inpatient days
// above the allowance are reimbursed at the routine-home-care rate (42 CFR 418.302(f)), so each overage day
// recoups (inpatient per-diem - RHC per-diem). The rates are M23's tenant-entered `hospice_rate_table`
// (pre-wage-index whole cents); M26 receives this as an injected function and never reads the table.
//
// Approximation, stated plainly: the figure is the national (pre-wage-index) per-diem difference, averaged over
// the org's provider entities, weighted by the period's actual GIP/IRC day mix. The settlement worksheet is a
// reviewed-then-finalised document; the wage-adjusted cents are a reviewer correction until the claim-level
// paid-per-day source is wired. No rate row => `null` and the cents overage stays days-only (0), never a guess.
import { type DbClient, schema } from "@wardenx/db";
import { and, desc, eq, isNull } from "drizzle-orm";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export interface InpatientDayMix {
  readonly gipDays: number;
  readonly ircDays: number;
}

export interface PerDiemRates {
  readonly rhcDays1to60PerDiemCents: number;
  readonly ircPerDiemCents: number;
  readonly gipPerDiemCents: number;
}

const arithmeticMean = (xs: readonly number[]): number =>
  xs.reduce((sum, x) => sum + x, 0) / xs.length;

/** Pure: the mix-weighted (inpatient - RHC) cents per day, or null when there is no rate or no inpatient day. */
export function inpatientDifferentialCentsPerDay(
  rates: readonly PerDiemRates[],
  mix: InpatientDayMix,
): number | null {
  const inpatientDays = mix.gipDays + mix.ircDays;
  if (rates.length === 0 || inpatientDays <= 0) return null;
  const rhc = arithmeticMean(rates.map((r) => r.rhcDays1to60PerDiemCents));
  const gip = arithmeticMean(rates.map((r) => r.gipPerDiemCents));
  const irc = arithmeticMean(rates.map((r) => r.ircPerDiemCents));
  const weightedInpatient = (gip * mix.gipDays + irc * mix.ircDays) / inpatientDays;
  return Math.max(0, Math.round(weightedInpatient - rhc));
}

/** `FY2026` (Oct 2025 - Sep 2026) -> the rate table's `fiscal_year_starting` 2025. */
export function fiscalYearStartingForCapYear(capYear: string): number | null {
  const m = /^FY(\d{4})$/.exec(capYear);
  return m ? Number(m[1]) - 1 : null;
}

/** Latest live rate version per provider entity for the cap year's federal fiscal year, then the differential. */
export async function resolveInpatientCapDifferential(
  tx: Tx,
  organizationId: string,
  capYear: string,
  mix: InpatientDayMix,
): Promise<number | null> {
  const fiscalYearStarting = fiscalYearStartingForCapYear(capYear);
  if (fiscalYearStarting === null) return null;
  const R = schema.hospiceRateTable;
  const rows = await tx
    .select({
      providerEntityId: R.providerEntityId,
      rhcDays1to60PerDiemCents: R.rhcDays1to60PerDiemCents,
      ircPerDiemCents: R.ircPerDiemCents,
      gipPerDiemCents: R.gipPerDiemCents,
    })
    .from(R)
    .where(
      and(
        eq(R.organizationId, organizationId),
        eq(R.fiscalYearStarting, fiscalYearStarting),
        isNull(R.supersededAt),
      ),
    )
    .orderBy(desc(R.effectiveFrom));
  const latestPerEntity = new Map<string, PerDiemRates>();
  for (const row of rows) {
    if (!latestPerEntity.has(row.providerEntityId)) latestPerEntity.set(row.providerEntityId, row);
  }
  return inpatientDifferentialCentsPerDay([...latestPerEntity.values()], mix);
}
