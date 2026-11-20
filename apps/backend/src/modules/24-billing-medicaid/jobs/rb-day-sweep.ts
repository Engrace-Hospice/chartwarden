// apps/backend/src/modules/24-billing-medicaid/jobs/rb-day-sweep.ts — GAP-071: the real stores behind the M24
// §4.9 `rb-day-daily-sweep` and `medicaid-eligibility-stale-watchdog` crons. Before this file NO production
// code inserted an `rb_day` row (the only writes were UPDATEs), so Medicaid room-and-board could never be
// billed: claim assembly selects `rb_day.status = 'billable'` and found nothing.
//
// SEAM PULL, not outbox push (checked against the spec): §2.2 says an rb_day is "created by daily-r-and-b-
// sweep cron when patient is NF-resident on that date", and §4.9 lists the cron `rb-day-daily-sweep` (daily
// 01:30) as the producer. The M6 LOC-of-day is PULLED through an injected port (`RbLocPeriodsPort`) because
// M24 does not list M6 in `dependsOn`; the composition root binds it over M6's admission-locking LOC snapshot
// seam. The daily materializer holds those M6 admission locks through its M24 arrangement/day writes, matching
// claim assembly's admission -> arrangement -> day order. Reads/writes run under `withOrgContext` (a cron tick
// is not a request); the non-transactional M6 read remains available to read-only consumers.
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
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { DegradedError } from "@chartwarden/types";
import type { PatientCoverageReader } from "@chartwarden/types";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { inclusiveDeathLocPeriodId } from "../claim-hospice-line-snapshot";
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
  readonly ipuBedAssignmentId?: string | null;
}

/** M6 LOC periods for a patient overlapping a range (bound at the composition root; org-explicit). */
export interface RbLocPeriodsPort {
  periodsForPatient(
    organizationId: string,
    patientId: string,
    range: { readonly from: Date; readonly to: Date },
  ): Promise<readonly RbSweepLocPeriod[]>;
  /** Lock every patient admission and read this LOC snapshot on the caller's tenant transaction. */
  periodsForPatientInTransaction(
    transaction: unknown,
    organizationId: string,
    patientId: string,
    range: { readonly from: Date; readonly to: Date },
  ): Promise<readonly RbSweepLocPeriod[]>;
  /** Acquire the M6 admission locks before a transaction-bound M24 arrangement/day read. */
  lockPatientAdmissionsInTransaction(
    transaction: unknown,
    organizationId: string,
    patientId: string,
  ): Promise<void>;
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
  /** Death is the sole M6 terminal-date exception; ordinary LOC end dates remain exclusive. */
  readonly inclusiveEndDate?: string | null;
}): readonly DerivedRbDay[] {
  const { arrangement, periods, fromDay, toDay, existingDays } = input;
  const inclusiveEndDate = input.inclusiveEndDate ?? null;
  const inclusiveEndPeriodId = inclusiveDeathLocPeriodId(
    periods.map((p) => ({
      id: p.periodId,
      levelOfCare: p.levelOfCare,
      effectiveAt: p.effectiveAt,
      endedAt: p.endedAt,
      ipuBedAssignmentId: p.ipuBedAssignmentId,
    })),
    inclusiveEndDate,
  );
  const inclusiveEndDay = inclusiveEndDate ? Date.parse(`${inclusiveEndDate}T00:00:00.000Z`) : null;
  const out: DerivedRbDay[] = [];
  for (let day = fromDay; day <= toDay; day += MS_PER_DAY) {
    if (existingDays.has(day)) continue;
    // Prefer the ordinary half-open owner. If the death date falls exactly on the terminal period's end,
    // the claim snapshot's shared rule allows that one terminal period to own the date.
    const period =
      coveringPeriod(periods, day) ??
      (day === inclusiveEndDay && inclusiveEndPeriodId
        ? periods.find((p) => p.periodId === inclusiveEndPeriodId)
        : undefined);
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
  /** M5's transaction-bound patient lifecycle snapshot; missing or inconsistent death facts block materialization. */
  readonly coverages: Pick<PatientCoverageReader, "coverageSnapshotForRangeInTransaction">;
}

/** The real `RbDaySweepStore`: materialises missing rb_day rows for every ACTIVE arrangement of one org. */
export function buildDrizzleRbDaySweepStore(deps: RbDaySweepStoreDeps): RbDaySweepStore {
  return {
    async sweepPendingDays(organizationId, asOf) {
      if (!deps.locPeriods.periodsForPatientInTransaction) {
        throw new DegradedError(
          "M24_RB_LOC_TRANSACTION_READER_UNBOUND",
          "the R&B day sweep requires M6's admission-locked LOC snapshot on the claim transaction",
        );
      }
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
        swept += await withOrgContext(deps.db, ctx, async (tx) => {
          // M5's stable patient-row lock precedes M6 admission locks in claim assembly. It serializes the
          // sweep against death recording, while also giving us the authoritative death date to cap the
          // materialized range (the day of death remains billable).
          const patientSnapshot = await deps.coverages.coverageSnapshotForRangeInTransaction(tx, {
            organizationId,
            patientId: arr.patientId,
            from: new Date(fromDay).toISOString().slice(0, 10),
            to: new Date(toDay).toISOString().slice(0, 10),
          });
          const lifecycle = patientSnapshot.patientLifecycle;
          if (
            !lifecycle ||
            (lifecycle.deceasedDate !== null && lifecycle.status !== "deceased") ||
            (lifecycle.status === "deceased" && lifecycle.deceasedDate === null)
          ) {
            throw new DegradedError(
              "M24_RB_PATIENT_LIFECYCLE_UNVERIFIED",
              "the R&B day sweep requires a consistent M5 patient lifecycle snapshot",
            );
          }
          const deathDay = lifecycle.deceasedDate
            ? utcDayStart(new Date(`${lifecycle.deceasedDate}T00:00:00.000Z`))
            : null;
          if (deathDay !== null && Number.isNaN(deathDay)) {
            throw new DegradedError(
              "M24_RB_PATIENT_LIFECYCLE_UNVERIFIED",
              "the R&B day sweep received an invalid M5 date of death",
            );
          }
          const safeToDay = deathDay === null ? toDay : Math.min(toDay, deathDay);
          if (safeToDay < fromDay) return 0;

          // Read LOC only after the M5 patient and M6 admission locks, and hold those locks through the
          // M24 write. This prevents death or LOC changes from invalidating the materialization snapshot.
          const periods = await deps.locPeriods.periodsForPatientInTransaction(
            tx,
            organizationId,
            arr.patientId,
            // Include a terminal LOC row that ends exactly at the first arrangement day. It may own the
            // M5 death date under the explicit inclusive-death exception below.
            {
              from: new Date(Math.max(0, fromDay - MS_PER_DAY)),
              to: new Date(safeToDay + MS_PER_DAY - 1),
            },
          );
          if (periods.length === 0) return 0;
          // Serialize materialization with claim assembly and arrangement edits. The initial list/read is
          // only a candidate snapshot; never create days from an arrangement that became inactive or
          // changed while the M6 periods were being fetched.
          const currentRows = await tx
            .select()
            .from(RB)
            .where(and(eq(RB.organizationId, organizationId), eq(RB.id, arr.id)))
            .limit(1)
            .for("update");
          const current = currentRows[0];
          if (!current || current.state !== "ACTIVE" || current.version !== arr.version) return 0;
          const existing = await tx
            .select({ serviceDate: RD.serviceDate })
            .from(RD)
            .where(
              and(
                eq(RD.organizationId, organizationId),
                eq(RD.patientId, arr.patientId),
                gte(RD.serviceDate, new Date(fromDay)),
                lte(RD.serviceDate, new Date(safeToDay)),
              ),
            );
          const derived = deriveRbDays({
            arrangement: current,
            periods,
            fromDay,
            toDay: safeToDay,
            existingDays: new Set(existing.map((r) => utcDayStart(r.serviceDate))),
            inclusiveEndDate: lifecycle.deceasedDate,
          });
          if (derived.length === 0) return 0;
          const inserted = await tx
            .insert(RD)
            .values(
              derived.map((d) => ({
                organizationId,
                providerEntityId: current.providerEntityId,
                locationId: current.locationId,
                patientId: current.patientId,
                rbArrangementId: current.id,
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
