// apps/backend/src/modules/06-admission/seams/level-of-care-period-reader.ts — the DEDICATED Drizzle
// reader backing M6's `LevelOfCarePeriodReader` seam (M30 HCI indicator 1: Continuous Home Care or
// General Inpatient provided). Mirrors `death-discharge-reader.ts`'s shape exactly: a SEPARATE org-scoped
// aggregate port the M30 `m30.measure_recompute` worker consumes, self-scoping its own `withOrgContext`
// envelope (HARD RULE 3 — the M30 worker's envelope is on a different connection and does not reach here).
//
// CMS criterion: an election period counts toward the numerator when it had AT LEAST ONE day of
// `continuous_home_care` or `general_inpatient_care` level of care overlapping the period's own window.
// `level_of_care_period` is keyed on ADMISSION, not election period (an admission can span several
// elections), so this reads both tables and computes the overlap in application code rather than a single
// SQL join — the per-org row counts here are small (hundreds, not millions), and an explicit overlap
// predicate in TypeScript is far more auditable than a correlated-subquery EXISTS for a compliance measure.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { LevelOfCarePeriodReader } from "@wardenx/types";
import { and, eq, gte, inArray, lt } from "drizzle-orm";

const EP = schema.electionPeriods;
const LOC = schema.levelOfCarePeriods;

/** LOC levels that satisfy HCI indicator 1's "CHC or GIP provided" criterion. */
const CHC_OR_GIP_LEVELS = ["continuous_home_care", "general_inpatient_care"] as const;

/** Same empty-acting-user sentinel {@link createDeathDischargeReader} uses for an aggregate census read. */
const SYSTEM_USER_ID = "";

/** Parse a `date` column value (Drizzle returns it as a `yyyy-mm-dd` string) to a `Date` at UTC midnight. */
const toDate = (d: string): Date => new Date(`${d}T00:00:00.000Z`);

/**
 * The production {@link LevelOfCarePeriodReader} over M6's `election_period` / `level_of_care_period`
 * tables. Closes over the pooled `DbClient`; each call opens its OWN per-org `withOrgContext` envelope
 * with a belt-and-suspenders `organization_id = $org` predicate (mirrors `createDeathDischargeReader`).
 */
export function createLevelOfCarePeriodReader(db: DbClient): LevelOfCarePeriodReader {
  return {
    chcOrGipCoverageCounts(organizationId, period) {
      return withOrgContext(
        db,
        { organizationId, userId: SYSTEM_USER_ID },
        async (tx) => {
          const t = tx as unknown as DbClient;
          const periods = await t
            .select({
              admissionId: EP.admissionId,
              effectiveAt: EP.effectiveAt,
              actualEndAt: EP.actualEndAt,
              scheduledEndAt: EP.scheduledEndAt,
            })
            .from(EP)
            .where(
              and(
                eq(EP.organizationId, organizationId),
                gte(EP.effectiveAt, period.from),
                lt(EP.effectiveAt, period.to),
              ),
            );
          if (periods.length === 0) return { numerator: 0, denominator: 0 };

          const admissionIds = [...new Set(periods.map((p) => p.admissionId))];
          const locRows = await t
            .select({
              admissionId: LOC.admissionId,
              effectiveAt: LOC.effectiveAt,
              endedAt: LOC.endedAt,
            })
            .from(LOC)
            .where(
              and(
                eq(LOC.organizationId, organizationId),
                inArray(LOC.admissionId, admissionIds),
                inArray(LOC.levelOfCare, CHC_OR_GIP_LEVELS),
              ),
            );

          let numerator = 0;
          for (const p of periods) {
            // `effectiveAt`/`actualEndAt`/`scheduledEndAt` are `date` columns (string); a still-open period
            // (no actualEndAt, no scheduledEndAt) has no upper bound — treat it as open-ended, not "already over".
            if (p.effectiveAt === null) continue; // defensive: a period always carries an effectiveAt in practice
            const periodStart = toDate(p.effectiveAt);
            const endSource = p.actualEndAt ?? p.scheduledEndAt;
            const periodEnd = endSource === null ? null : toDate(endSource);
            const hasChcOrGipDay = locRows.some((loc) => {
              if (loc.admissionId !== p.admissionId) return false;
              const startsBeforePeriodEnds = periodEnd === null || loc.effectiveAt < periodEnd;
              const endsAfterPeriodStarts = loc.endedAt === null || loc.endedAt > periodStart;
              return startsBeforePeriodEnds && endsAfterPeriodStarts;
            });
            if (hasChcOrGipDay) numerator += 1;
          }
          return { numerator, denominator: periods.length };
        },
      );
    },
  };
}
