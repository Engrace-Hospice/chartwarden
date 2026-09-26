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
import { and, eq, gte, inArray, isNotNull, lt, or, sql } from "drizzle-orm";

const EP = schema.electionPeriods;
const LOC = schema.levelOfCarePeriods;

/** LOC levels that satisfy HCI indicator 1's "CHC or GIP provided" criterion. */
const CHC_OR_GIP_LEVELS = ["continuous_home_care", "general_inpatient_care"] as const;

/** Same empty-acting-user sentinel {@link createDeathDischargeReader} uses for an aggregate census read. */
const SYSTEM_USER_ID = "";

/** Parse a `date` column value (Drizzle returns it as a `yyyy-mm-dd` string) to a `Date` at UTC midnight. */
const toDate = (d: string): Date => new Date(`${d}T00:00:00.000Z`);

const MS_PER_DAY = 86_400_000;

/** A `Date` (or a `date`-column string) as the UTC `yyyy-mm-dd` the window bounds are expressed in. */
const toIsoDay = (d: Date | string): string =>
  typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10);

/** The day AFTER `isoDay` — turns M6's INCLUSIVE `scheduled_end_at`/`actual_end_at` into a half-open bound. */
const dayAfter = (isoDay: string): string =>
  new Date(toDate(isoDay).getTime() + MS_PER_DAY).toISOString().slice(0, 10);

/** The later of two `yyyy-mm-dd` strings (lexicographic order IS chronological order for ISO dates). */
const maxDay = (a: string, b: string): string => (a >= b ? a : b);

/** The earlier of two `yyyy-mm-dd` strings. */
const minDay = (a: string, b: string): string => (a <= b ? a : b);

/**
 * The production {@link LevelOfCarePeriodReader} over M6's `election_period` / `level_of_care_period`
 * tables. Closes over the pooled `DbClient`; each call opens its OWN per-org `withOrgContext` envelope
 * with a belt-and-suspenders `organization_id = $org` predicate (mirrors `createDeathDischargeReader`).
 */
export function createLevelOfCarePeriodReader(db: DbClient): LevelOfCarePeriodReader {
  return {
    chcOrGipCoverageCounts(organizationId, period) {
      return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
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
          // `scheduled_end_at`/`actual_end_at` are the period's INCLUSIVE last day (a 90-day period
          // effective 2026-01-01 ends 2026-03-31 — the date that goes on the NOE). Comparing a LOC start
          // against midnight OF that day would drop a level of care begun on the period's final day.
          const periodEnd = endSource === null ? null : toDate(dayAfter(endSource));
          const hasChcOrGipDay = locRows.some((loc) => {
            if (loc.admissionId !== p.admissionId) return false;
            const startsBeforePeriodEnds = periodEnd === null || loc.effectiveAt < periodEnd;
            const endsAfterPeriodStarts = loc.endedAt === null || loc.endedAt > periodStart;
            return startsBeforePeriodEnds && endsAfterPeriodStarts;
          });
          if (hasChcOrGipDay) numerator += 1;
        }
        return { numerator, denominator: periods.length };
      });
    },

    levelOfCareDaySpans(organizationId, period) {
      return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
        const t = tx as unknown as DbClient;
        const rows = await t
          .select({
            admissionId: LOC.admissionId,
            levelOfCare: LOC.levelOfCare,
            effectiveAt: LOC.effectiveAt,
            endedAt: LOC.endedAt,
          })
          .from(LOC)
          .where(
            and(
              eq(LOC.organizationId, organizationId),
              // Overlap, not containment: a level of care that began before the window and is still
              // running inside it contributes days to the window and must not be filtered out.
              lt(LOC.effectiveAt, toDate(period.to)),
              or(sql`${LOC.endedAt} is null`, gte(LOC.endedAt, toDate(period.from))),
            ),
          );

        const spans: {
          admissionId: string;
          levelOfCare: string;
          from: string;
          to: string;
        }[] = [];
        for (const r of rows) {
          // The day a level of care ENDS belongs to whatever level follows it, not to this one — so the
          // span is half-open at the end. Without that the changeover day would be counted twice (once as
          // routine home care, once as general inpatient), and HCI indicator 8's denominator would exceed
          // the patient's actual days on service.
          const startDay = toIsoDay(r.effectiveAt);
          const endDayExclusive = r.endedAt === null ? period.to : toIsoDay(r.endedAt);
          const from = maxDay(startDay, period.from);
          const to = minDay(endDayExclusive, period.to);
          if (from >= to) continue; // clipped away entirely, or a same-instant open/close
          spans.push({ admissionId: r.admissionId, levelOfCare: r.levelOfCare, from, to });
        }
        return spans;
      });
    },

    electionPeriodSpans(organizationId, period) {
      return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
        const t = tx as unknown as DbClient;
        const rows = await t
          .select({
            id: EP.id,
            admissionId: EP.admissionId,
            effectiveAt: EP.effectiveAt,
            scheduledEndAt: EP.scheduledEndAt,
            actualEndAt: EP.actualEndAt,
          })
          .from(EP)
          .where(
            and(
              eq(EP.organizationId, organizationId),
              isNotNull(EP.effectiveAt),
              lt(EP.effectiveAt, period.to),
            ),
          );

        const spans: {
          admissionId: string;
          electionPeriodId: string;
          from: string;
          to: string;
        }[] = [];
        for (const r of rows) {
          if (r.effectiveAt === null) continue; // narrowed by the SQL predicate; kept for the type
          // `actual_end_at` wins over `scheduled_end_at`: a period completed early by discharge, death or
          // revocation really did end then, and scoring a gap against the days after it would penalise the
          // agency for not visiting a patient who was no longer on service.
          const endInclusive = r.actualEndAt ?? r.scheduledEndAt;
          const endExclusive = endInclusive === null ? period.to : dayAfter(endInclusive);
          const from = maxDay(toIsoDay(r.effectiveAt), period.from);
          const to = minDay(endExclusive, period.to);
          if (from >= to) continue;
          spans.push({ admissionId: r.admissionId, electionPeriodId: r.id, from, to });
        }
        return spans;
      });
    },
  };
}
