// apps/backend/src/modules/24-billing-medicaid/jobs/rb-day-sweep.ts — GAP-071: the real stores behind the M24
// §4.9 `rb-day-daily-sweep` and `medicaid-eligibility-stale-watchdog` crons. Before this file NO production
// code inserted an `rb_day` row (the only writes were UPDATEs), so Medicaid room-and-board could never be
// billed: claim assembly selects `rb_day.status = 'billable'` and found nothing.
//
// SEAM PULL, not outbox push (checked against the spec): §2.2 says an rb_day is "created by daily-r-and-b-
// sweep cron when patient is NF-resident on that date", and §4.9 lists the cron `rb-day-daily-sweep` (daily
// 01:30) as the producer. The M6 LOC-of-day is PULLED through an injected port (`RbLocPeriodsPort`) because
// M24 does not list M6 in `dependsOn`; the composition root binds it over M6's org-explicit
// `levelOfCarePeriodsForPatientForOrg`. Reads/writes on M24-owned tables run under `withOrgContext` (a cron
// tick is not a request).
//
// Day derivation (§2.2 lifecycle + §1.1 D6): for each ACTIVE arrangement, for every UTC calendar day from
// `effective_from` through min(asOf, `effective_to`) that has NO rb_day yet for the patient (any status — a
// `voided`/`excluded` day is terminal-until-corrected and is never regenerated):
//   - the M6 LOC period covering the day (latest effective wins; end exclusive) gives `loc_of_day` +
//     `loc_period_id_snapshot`; a day no LOC period covers is NOT materialised (the snapshot columns are NOT
//     NULL and a LOC-less day is not a hospice day),
//   - RHC/CHC -> `billable`, per diem = arrangement routine rate,
//   - IRC -> `excluded` ("respite at non-arranged facility", or "respite day" at the arranged NF — the
//     shipped medicaid_rb_day_loc_coherence rule fails any billable IRC day),
//   - GIP -> `excluded` ("general inpatient day"; the IPU, not the NF, is the place of service).
// The sweep writes `billable`/`excluded` directly (the transient `pending` state is only meaningful where the
// LOC is not yet known, and a day without a LOC period is skipped rather than parked).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { EligibilityWatchdogStore, RbDaySweepStore } from "./m24-jobs";

const RB = schema.rbArrangement;
const RD = schema.rbDay;
const EC = schema.medicaidEligibilityCheck;

/** A cron tick has no acting membership (the seam-envelope convention). */
const M24_SWEEP_SYSTEM_USER_ID = "";
export const MS_PER_DAY = 86_400_000;

/** The exclusion reasons the SYSTEM writes. A re-evaluation may flip a day carrying one of these; any other
 * reason on an `excluded` day is a Billing Manager override and is terminal-until-corrected (§2.2). */
export const RB_EXCLUSION_GIP = "general inpatient day (IPU is the place of service)";
export const RB_EXCLUSION_RESPITE_AT_NF = "respite day (not a routine NF day)";
export const RB_EXCLUSION_RESPITE_ELSEWHERE = "respite at non-arranged facility";
export const RB_SYSTEM_EXCLUSION_REASONS: ReadonlySet<string> = new Set([
  RB_EXCLUSION_GIP,
  RB_EXCLUSION_RESPITE_AT_NF,
  RB_EXCLUSION_RESPITE_ELSEWHERE,
]);

export interface RbSweepLocPeriod {
  readonly periodId: string;
  readonly levelOfCare:
    | "routine_home_care"
    | "continuous_home_care"
    | "inpatient_respite_care"
    | "general_inpatient_care";
  readonly effectiveAt: Date;
  readonly endedAt: Date | null;
  readonly facilityId: string | null;
}

/** M6 LOC periods for a patient overlapping a range (bound at the composition root; org-explicit). */
export interface RbLocPeriodsPort {
  periodsForPatient(
    organizationId: string,
    patientId: string,
    range: { readonly from: Date; readonly to: Date },
  ): Promise<readonly RbSweepLocPeriod[]>;
}

export interface RbSweepArrangement {
  readonly nfFacilityMdmId: string;
  readonly nfPerDiemRoutineCents: number;
  readonly nfPerDiemRespCents: number;
  readonly nfPerDiemGipCents: number;
}

export interface DerivedRbDay {
  readonly serviceDate: Date;
  readonly locOfDay: "RHC" | "CHC" | "IRC" | "GIP";
  readonly locPeriodIdSnapshot: string;
  readonly perDiemCentsSnapshot: number;
  readonly status: "billable" | "excluded";
  readonly exclusionReason: string | null;
}

export function utcDayStart(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function coveringPeriod(
  periods: readonly RbSweepLocPeriod[],
  dayStart: number,
): RbSweepLocPeriod | undefined {
  let best: RbSweepLocPeriod | undefined;
  for (const p of periods) {
    const startsOn = utcDayStart(p.effectiveAt);
    const endsOn = p.endedAt ? utcDayStart(p.endedAt) : Number.POSITIVE_INFINITY;
    if (startsOn <= dayStart && dayStart < endsOn) {
      if (!best || p.effectiveAt >= best.effectiveAt) best = p;
    }
  }
  return best;
}

/**
 * Pure derivation of the rb_day rows for `[fromDay, toDay]` (UTC midnights, inclusive) minus `existingDays`
 * (UTC-midnight epoch ms already holding a row). Deterministic and DB-free so the status rules are unit-tested.
 *
 * DECIDED RULES (recorded, not behaviour changes):
 *   - Per diem is used AS STORED on the arrangement (`nf_per_diem_*_cents`): the 95% room-and-board payment
 *     factor is NOT applied here; any such factor lives in the arrangement's rate, never in this derivation.
 *   - The discharge day is NOT billable: the `m6.admission.discharged` consumer voids rb_days from the
 *     `dischargeDate` forward, inclusive (`voidRbDaysFrom`, rb-day-lifecycle.ts).
 *   - The day of DEATH IS billable: the `m5.patient.deceased` consumer voids from the day AFTER `deceasedDate`.
 */
export function deriveRbDays(input: {
  readonly arrangement: RbSweepArrangement;
  readonly periods: readonly RbSweepLocPeriod[];
  readonly fromDay: number;
  readonly toDay: number;
  readonly existingDays: ReadonlySet<number>;
}): readonly DerivedRbDay[] {
  const { arrangement, periods, fromDay, toDay, existingDays } = input;
  const out: DerivedRbDay[] = [];
  for (let day = fromDay; day <= toDay; day += MS_PER_DAY) {
    if (existingDays.has(day)) continue;
    const period = coveringPeriod(periods, day);
    if (!period) continue;
    const base = { serviceDate: new Date(day), locPeriodIdSnapshot: period.periodId };
    switch (period.levelOfCare) {
      case "routine_home_care":
      case "continuous_home_care":
        out.push({
          ...base,
          locOfDay: period.levelOfCare === "routine_home_care" ? "RHC" : "CHC",
          perDiemCentsSnapshot: arrangement.nfPerDiemRoutineCents,
          status: "billable",
          exclusionReason: null,
        });
        break;
      case "inpatient_respite_care": {
        const atNf = period.facilityId === arrangement.nfFacilityMdmId;
        out.push({
          ...base,
          locOfDay: "IRC",
          perDiemCentsSnapshot: arrangement.nfPerDiemRespCents,
          // The shipped `medicaid_rb_day_loc_coherence` rule fails ANY billable IRC day, so a respite day is
          // excluded even at the arranged NF; the reason records which spec case applied.
          status: "excluded",
          exclusionReason: atNf ? RB_EXCLUSION_RESPITE_AT_NF : RB_EXCLUSION_RESPITE_ELSEWHERE,
        });
        break;
      }
      case "general_inpatient_care":
        out.push({
          ...base,
          locOfDay: "GIP",
          perDiemCentsSnapshot: arrangement.nfPerDiemGipCents,
          status: "excluded",
          exclusionReason: RB_EXCLUSION_GIP,
        });
        break;
    }
  }
  return out;
}

export interface RbDaySweepStoreDeps {
  readonly db: DbClient;
  readonly locPeriods: RbLocPeriodsPort;
}

/** The real `RbDaySweepStore`: materialises missing rb_day rows for every ACTIVE arrangement of one org. */
export function buildDrizzleRbDaySweepStore(deps: RbDaySweepStoreDeps): RbDaySweepStore {
  return {
    async sweepPendingDays(organizationId, asOf) {
      const asOfDay = utcDayStart(new Date(`${asOf}T00:00:00.000Z`));
      const ctx = { organizationId, userId: M24_SWEEP_SYSTEM_USER_ID };
      const arrangements = await withOrgContext(deps.db, ctx, (tx) =>
        tx
          .select()
          .from(RB)
          .where(and(eq(RB.organizationId, organizationId), eq(RB.state, "ACTIVE"))),
      );

      let swept = 0;
      for (const arr of arrangements) {
        const fromDay = utcDayStart(arr.effectiveFrom);
        const toDay = Math.min(asOfDay, arr.effectiveTo ? utcDayStart(arr.effectiveTo) : asOfDay);
        if (fromDay > toDay) continue;
        // M6 read on its own org-scoped tx, never held open across the M24 write below.
        const periods = await deps.locPeriods.periodsForPatient(organizationId, arr.patientId, {
          from: new Date(fromDay),
          to: new Date(toDay + MS_PER_DAY - 1),
        });
        if (periods.length === 0) continue;
        swept += await withOrgContext(deps.db, ctx, async (tx) => {
          const existing = await tx
            .select({ serviceDate: RD.serviceDate })
            .from(RD)
            .where(
              and(
                eq(RD.organizationId, organizationId),
                eq(RD.patientId, arr.patientId),
                gte(RD.serviceDate, new Date(fromDay)),
                lte(RD.serviceDate, new Date(toDay)),
              ),
            );
          const derived = deriveRbDays({
            arrangement: arr,
            periods,
            fromDay,
            toDay,
            existingDays: new Set(existing.map((r) => utcDayStart(r.serviceDate))),
          });
          if (derived.length === 0) return 0;
          const inserted = await tx
            .insert(RD)
            .values(
              derived.map((d) => ({
                organizationId,
                providerEntityId: arr.providerEntityId,
                locationId: arr.locationId,
                patientId: arr.patientId,
                rbArrangementId: arr.id,
                serviceDate: d.serviceDate,
                locOfDay: d.locOfDay,
                locPeriodIdSnapshot: d.locPeriodIdSnapshot,
                perDiemCentsSnapshot: d.perDiemCentsSnapshot,
                status: d.status,
                exclusionReason: d.exclusionReason,
              })),
            )
            .onConflictDoNothing()
            .returning({ id: RD.id });
          return inserted.length;
        });
      }
      return swept;
    },
  };
}

/** Bound on findings (alerts) per org per tick — a runaway backlog must not flood M36 in one pass. */
const MAX_STALE_FINDINGS_PER_TICK = 500;

/** The real `EligibilityWatchdogStore`: patients whose LATEST eligibility check is past its 30-day `stale_at`. */
export function buildDrizzleEligibilityWatchdogStore(db: DbClient): EligibilityWatchdogStore {
  const staleRows = (organizationId: string, asOf: string, limit?: number) =>
    withOrgContext(db, { organizationId, userId: M24_SWEEP_SYSTEM_USER_ID }, async (tx) => {
      const asOfIso = new Date(`${asOf}T00:00:00.000Z`).toISOString();
      const query = tx
        .select({
          patientId: EC.patientId,
          lastCheckedAt: sql<Date>`max(${EC.checkedAt})`,
          // The PE of the patient's LATEST check (the row is nullable, §3.3) scopes the biller audience.
          providerEntityId: sql<
            string | null
          >`(array_agg(${EC.providerEntityId} ORDER BY ${EC.checkedAt} DESC))[1]`,
        })
        .from(EC)
        .where(eq(EC.organizationId, organizationId))
        .groupBy(EC.patientId)
        .having(sql`max(${EC.staleAt}) < ${asOfIso}::timestamptz`);
      return limit === undefined ? query : query.limit(limit);
    });
  return {
    async staleEligibilityCount(organizationId, asOf) {
      return (await staleRows(organizationId, asOf)).length;
    },
    async staleEligibilityFindings(organizationId, asOf) {
      const rows = await staleRows(organizationId, asOf, MAX_STALE_FINDINGS_PER_TICK);
      return rows.map((r) => ({
        patientId: r.patientId,
        lastCheckedAt: new Date(r.lastCheckedAt).toISOString(),
        providerEntityId: r.providerEntityId,
      }));
    },
  };
}
