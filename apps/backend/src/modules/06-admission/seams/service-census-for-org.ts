// apps/backend/src/modules/06-admission/seams/service-census-for-org.ts — GAP-080.
//
// The org-explicit SERVICE-SIDE census M27's Worksheet S-3 statistics refresh aggregates (M27 spec D6 / §4.5: "the
// M6 reader is the source of truth for 'the patient was on RHC for these dates'", independent of M23's billed days).
// For ONE provider entity and a fiscal window it returns, per calendar month: the days each patient spent at each
// level of care, plus the admission and discharge (incl. death-setting) events with the level of care in force.
//
// `admission` / `level_of_care_period` / `discharge_event` are M6's tables, so the read lives here and M27 receives it as
// a locally-declared PORT at the composition root (M27's manifest `dependsOn` carries 6 for the seam, but the F-160
// shape keeps the table read inside the owning module). The rows carry a patient id so the caller can attach the payer
// program (an M5 fact) — the caller aggregates immediately and what it persists is AGGREGATE-ONLY (spec D18).
//
// DAYS. A level-of-care period `[effective_at, ended_at)` counts the calendar days it covers, in UTC dates, clipped to
// the window; an OPEN period runs to `asOf` (today, inclusive) so a report in progress is not credited days that have
// not happened. A day on which the level changed counts once, under the NEW level (the CMS
// day-of-care convention is one level per day).
//
// Not a request: opens its own `withOrgContext` envelope (empty acting user, the seam-read convention) with explicit
// `organization_id` predicates behind RLS.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, gte, isNull, lt, or, sql } from "drizzle-orm";

const LOC = schema.levelOfCarePeriods;
const ADM = schema.admissions;
const DE = schema.dischargeEvents;

/** A consumer-driven read names no acting membership (the F-102 convention). */
const SEAM_READER_SYSTEM_USER_ID = "";
const MS_PER_DAY = 86_400_000;

export interface ServiceCensusWindow {
  readonly providerEntityId: string;
  /** Inclusive first day, `YYYY-MM-DD`. */
  readonly from: string;
  /** Inclusive last day, `YYYY-MM-DD`. */
  readonly to: string;
  /** "Today" — an open level-of-care period runs through this day (inclusive). Defaults to now. */
  readonly asOf?: Date;
}

export interface ServiceCensusDayRow {
  readonly patientId: string;
  readonly levelOfCare: string;
  /** `YYYY-MM`. */
  readonly month: string;
  readonly patientDays: number;
}

export interface ServiceCensusEventRow {
  readonly kind: "admission" | "discharge";
  readonly patientId: string;
  readonly month: string;
  /** The level of care in force at the event (falls back to routine home care when none is on file). */
  readonly levelOfCare: string;
  /** Set on a death discharge only. */
  readonly deathSetting?: "home" | "facility" | "unknown";
}

export interface ServiceCensus {
  readonly days: ReadonlyArray<ServiceCensusDayRow>;
  readonly events: ReadonlyArray<ServiceCensusEventRow>;
}

const dayNumber = (d: Date): number => Math.floor(d.getTime() / MS_PER_DAY);
const monthOfDayNumber = (n: number): string => new Date(n * MS_PER_DAY).toISOString().slice(0, 7);
const isoDayNumber = (iso: string): number => dayNumber(new Date(`${iso}T00:00:00.000Z`));

/**
 * Pure: split one level-of-care period into per-month day counts, clipped to `[windowFrom, windowToExclusive)` (day
 * numbers). `endExclusive` is the day AFTER the last covered day.
 */
export function splitSpanByMonth(
  startDay: number,
  endExclusiveDay: number,
  windowFrom: number,
  windowToExclusive: number,
): ReadonlyArray<{ month: string; days: number }> {
  const from = Math.max(startDay, windowFrom);
  const to = Math.min(endExclusiveDay, windowToExclusive);
  const out = new Map<string, number>();
  for (let d = from; d < to; d++) {
    const month = monthOfDayNumber(d);
    out.set(month, (out.get(month) ?? 0) + 1);
  }
  return [...out.entries()].map(([month, days]) => ({ month, days }));
}

interface PeriodRow {
  readonly admissionId: string;
  readonly patientId: string;
  readonly levelOfCare: string;
  readonly startDay: number;
  /** Exclusive. */
  readonly endDay: number;
}

/** The level of care in force on `day` for an admission, else the closest earlier period, else routine. */
export function levelOnDay(
  periods: ReadonlyArray<PeriodRow>,
  admissionId: string,
  day: number,
): string {
  const mine = periods.filter((p) => p.admissionId === admissionId);
  const covering = mine.find((p) => p.startDay <= day && day < p.endDay);
  if (covering) return covering.levelOfCare;
  const earlier = mine.filter((p) => p.startDay <= day).sort((a, b) => b.startDay - a.startDay)[0];
  return earlier?.levelOfCare ?? "routine_home_care";
}

export function serviceCensusForOrg(
  db: DbClient,
  organizationId: string,
  window: ServiceCensusWindow,
): Promise<ServiceCensus> {
  const windowFrom = isoDayNumber(window.from);
  const windowToExclusive = isoDayNumber(window.to) + 1;
  const asOf = window.asOf ?? new Date();
  const openEnd = dayNumber(asOf) + 1;
  const fromTs = new Date(`${window.from}T00:00:00.000Z`);
  const toTsExclusive = new Date(windowToExclusive * MS_PER_DAY);

  return withOrgContext(
    db,
    { organizationId, userId: SEAM_READER_SYSTEM_USER_ID },
    async (scoped) => {
      const tx = scoped as DbClient;
      const periodRows = await tx
        .select({
          admissionId: LOC.admissionId,
          patientId: ADM.patientId,
          levelOfCare: LOC.levelOfCare,
          effectiveAt: LOC.effectiveAt,
          endedAt: LOC.endedAt,
        })
        .from(LOC)
        .innerJoin(ADM, eq(ADM.id, LOC.admissionId))
        .where(
          and(
            eq(LOC.organizationId, organizationId),
            eq(ADM.providerEntityId, window.providerEntityId),
            // overlaps the window: starts before its end and (open or ends after its start)
            lt(LOC.effectiveAt, toTsExclusive),
            or(isNull(LOC.endedAt), gte(LOC.endedAt, fromTs)),
          ),
        );
      const periods: PeriodRow[] = periodRows.map((r) => ({
        admissionId: r.admissionId,
        patientId: r.patientId,
        levelOfCare: r.levelOfCare,
        startDay: dayNumber(r.effectiveAt),
        endDay: r.endedAt ? Math.max(dayNumber(r.endedAt), dayNumber(r.effectiveAt)) : openEnd,
      }));

      const dayTotals = new Map<string, ServiceCensusDayRow>();
      for (const p of periods) {
        for (const { month, days } of splitSpanByMonth(
          p.startDay,
          p.endDay,
          windowFrom,
          windowToExclusive,
        )) {
          const key = `${p.patientId}|${p.levelOfCare}|${month}`;
          const prior = dayTotals.get(key);
          dayTotals.set(key, {
            patientId: p.patientId,
            levelOfCare: p.levelOfCare,
            month,
            patientDays: (prior?.patientDays ?? 0) + days,
          });
        }
      }

      const events: ServiceCensusEventRow[] = [];
      const admissions = await tx
        .select({ id: ADM.id, patientId: ADM.patientId, admissionAt: ADM.admissionAt })
        .from(ADM)
        .where(
          and(
            eq(ADM.organizationId, organizationId),
            eq(ADM.providerEntityId, window.providerEntityId),
            gte(ADM.admissionAt, fromTs),
            lt(ADM.admissionAt, toTsExclusive),
          ),
        );
      for (const a of admissions) {
        if (!a.admissionAt) continue;
        const day = dayNumber(a.admissionAt);
        events.push({
          kind: "admission",
          patientId: a.patientId,
          month: monthOfDayNumber(day),
          levelOfCare: levelOnDay(periods, a.id, day),
        });
      }

      const discharges = await tx
        .select({
          admissionId: DE.admissionId,
          patientId: ADM.patientId,
          effectiveAt: DE.effectiveAt,
          dischargeType: DE.dischargeType,
          placeOfDeath: DE.placeOfDeath,
        })
        .from(DE)
        .innerJoin(ADM, eq(ADM.id, DE.admissionId))
        .where(
          and(
            eq(DE.organizationId, organizationId),
            eq(ADM.providerEntityId, window.providerEntityId),
            sql`${DE.effectiveAt} >= ${window.from}::date`,
            sql`${DE.effectiveAt} <= ${window.to}::date`,
          ),
        );
      for (const d of discharges) {
        const day = isoDayNumber(d.effectiveAt);
        events.push({
          kind: "discharge",
          patientId: d.patientId,
          month: monthOfDayNumber(day),
          levelOfCare: levelOnDay(periods, d.admissionId, day),
          ...(d.dischargeType === "death"
            ? { deathSetting: (d.placeOfDeath ?? "unknown") as "home" | "facility" | "unknown" }
            : {}),
        });
      }

      return { days: [...dayTotals.values()], events };
    },
  );
}
