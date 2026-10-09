// @wardenx/billing · repositories — the M27 cost-report read aggregates (§4.4 PatientDaysProvider source).
//
// AGGREGATE-ONLY, PHI-FREE (D13/D18): the cost-report Worksheet-D statistical census reconciliation reads
// billed-and-accepted hospice patient-DAYS for a fiscal year — a single count, never a patient row. This
// repo issues the one grouped sum the M23 `PatientDaysProvider` seam wraps; the service layer wraps the call
// in `withOrgContext` so Postgres RLS scopes it to `app.org_id` (the repos never set GUCs — see ./db.ts).
//
// "Billed-and-accepted" = per-diem days on claims the MAC has acknowledged-accepted or paid
// (`ACK_ACCEPTED` / `ACK_PARTIAL` / `PAID`); DRAFT/SUBMITTED/ACK_PENDING are not yet accepted, and
// ACK_REJECTED/DENIED/REPLACED/VOIDED don't count. Only the four per-diem revenue codes carry billed DAYS:
// `unit_count` for 0651 RHC / 0655 IRC / 0656 GIP and, for CHC (0652, billed in 15-minute units), the line's
// service-date span. Visit / physician / ancillary lines carry visits or units and are excluded so the sum is a
// true patient-day census.
import * as schema from "@wardenx/db/schema";
import { and, between, eq, inArray, sql } from "drizzle-orm";
import type { BillingDb } from "./db";

const C = schema.claim;
const L = schema.claimLine;

/**
 * Billed days on one per-diem line. `unit_count` is a DAY count for 0651/0655/0656, but CHC (0652) is billed one
 * dated line per day in 15-minute units (CMS Pub. 100-04 ch. 11 §30.3), so a CHC line's days are its inclusive
 * service-date span (one day) — never its quarter-hour units.
 */
const BILLED_DAYS_PER_LINE = sql`CASE WHEN ${L.revenueCode} = '0652' THEN (${L.serviceDateTo} - ${L.serviceDateFrom} + 1) ELSE ${L.unitCount} END`;

/** MAC-accepted claim states — the only claims whose days count toward the billed census. */
const ACCEPTED_STATES = ["ACK_ACCEPTED", "ACK_PARTIAL", "PAID"] as const;

/** The four per-diem revenue codes that carry billed DAYS (see {@link BILLED_DAYS_PER_LINE}); others are excluded. */
const PER_DIEM_REVENUE_CODES = ["0651", "0652", "0655", "0656"] as const;

/** Per-diem revenue code → level-of-care label for the breakdown. */
const LEVEL_BY_REVENUE_CODE: Record<string, keyof BilledDaysByLevel> = {
  "0651": "rhc",
  "0652": "chc",
  "0655": "irc",
  "0656": "gip",
};

export interface BilledDaysByLevel {
  rhc: number;
  chc: number;
  irc: number;
  gip: number;
}

export interface BilledDaysAggregate {
  /** Total billed-and-accepted per-diem patient-days across all levels for the FY. */
  readonly totalPatientDays: number;
  readonly byLevelOfCare: BilledDaysByLevel;
}

/** The windowed claim-line rollup the M30 `ClaimLineReader` seam exposes — the FY aggregate plus the
 *  per-diem LINE count, which M30 needs as a population denominator (see `claimLineRollupForPeriod`). */
export interface ClaimLineRollup extends BilledDaysAggregate {
  /** Per-diem claim LINES summed into this rollup (the population, not the day total). */
  readonly claimLineCount: number;
  /**
   * FY2027 SSVI metric 2 — of `byLevelOfCare.rhc`, the RHC (0651) days whose site of service is a nursing
   * facility / LTC (Q5003) or a skilled nursing facility (Q5004).
   */
  readonly rhcNursingFacilityDays: number;
}

/** Site-of-service Q-codes CMS's SSVI metric 2 counts as "a nursing home or skilled nursing facility". */
const NURSING_FACILITY_Q_CODES: ReadonlySet<string> = new Set(["Q5003", "Q5004"]);

/** Read port for the M27 cost-report billing aggregates (PatientDaysProvider). No write surface. */
export class CostReportAggregateRepository {
  constructor(private readonly db: BillingDb) {}

  /**
   * Billed-and-accepted hospice patient-days for the fiscal year `[fyStartIso, fyEndIso]` (inclusive ISO
   * dates). Sums `claim_line.unit_count` over per-diem lines on accepted claims whose service date falls in
   * the FY, grouped by level of care. Returns zeros when no accepted claims exist (a fail-soft empty census).
   */
  async billedDaysForFiscalYear(
    organizationId: string,
    fyStartIso: string,
    fyEndIso: string,
  ): Promise<BilledDaysAggregate> {
    const rows = await this.db
      .select({
        revenueCode: L.revenueCode,
        days: sql<number>`coalesce(sum(${BILLED_DAYS_PER_LINE}), 0)::int`,
      })
      .from(L)
      .innerJoin(C, eq(L.claimId, C.id))
      .where(
        and(
          eq(L.organizationId, organizationId),
          inArray(C.state, [...ACCEPTED_STATES]),
          inArray(L.revenueCode, [...PER_DIEM_REVENUE_CODES]),
          between(L.serviceDateFrom, fyStartIso, fyEndIso),
        ),
      )
      .groupBy(L.revenueCode);

    const byLevelOfCare: BilledDaysByLevel = { rhc: 0, chc: 0, irc: 0, gip: 0 };
    let totalPatientDays = 0;
    for (const r of rows) {
      const level = LEVEL_BY_REVENUE_CODE[r.revenueCode];
      const days = Number(r.days) || 0;
      if (level) byLevelOfCare[level] += days;
      totalPatientDays += days;
    }
    return { totalPatientDays, byLevelOfCare };
  }

  /**
   * The same per-diem day rollup over an ARBITRARY window — the M30 `ClaimLineReader` seam's source for the
   * HCI claims-derived indicators (HCI-1 continuous-or-GIP, HCI-5/6 burdensome transitions read the CHC/GIP
   * days directly; the composite reads the level mix). Identical accepted-state + per-diem filters as the FY
   * census above, so the two can never disagree about what "a billed day" is.
   *
   * Additionally returns `claimLineCount` — the number of per-diem lines the rollup summed. M30's measure
   * kernel suppresses a rate whose DENOMINATOR is below the CMS reportable floor, so a rollup that carries
   * only a day total (and not the population it came from) cannot drive a reportable measure honestly.
   */
  async claimLineRollupForPeriod(
    organizationId: string,
    fromIso: string,
    toIso: string,
  ): Promise<ClaimLineRollup> {
    const rows = await this.db
      .select({
        revenueCode: L.revenueCode,
        qCode: L.qCode,
        days: sql<number>`coalesce(sum(${BILLED_DAYS_PER_LINE}), 0)::int`,
        lineCount: sql<number>`count(*)::int`,
      })
      .from(L)
      .innerJoin(C, eq(L.claimId, C.id))
      .where(
        and(
          eq(L.organizationId, organizationId),
          inArray(C.state, [...ACCEPTED_STATES]),
          inArray(L.revenueCode, [...PER_DIEM_REVENUE_CODES]),
          between(L.serviceDateFrom, fromIso, toIso),
        ),
      )
      .groupBy(L.revenueCode, L.qCode);

    const byLevelOfCare: BilledDaysByLevel = { rhc: 0, chc: 0, irc: 0, gip: 0 };
    let totalPatientDays = 0;
    let claimLineCount = 0;
    let rhcNursingFacilityDays = 0;
    for (const r of rows) {
      const level = LEVEL_BY_REVENUE_CODE[r.revenueCode];
      const days = Number(r.days) || 0;
      if (level) byLevelOfCare[level] += days;
      if (level === "rhc" && NURSING_FACILITY_Q_CODES.has(r.qCode)) rhcNursingFacilityDays += days;
      totalPatientDays += days;
      claimLineCount += Number(r.lineCount) || 0;
    }
    return { totalPatientDays, byLevelOfCare, claimLineCount, rhcNursingFacilityDays };
  }
}
