// apps/backend/src/modules/06-admission/seams/admission-census-summary-for-org.ts — the org-explicit census
// summary M5's patient-census KPI strip pulls (GAP-119). The strip shows four admission-owned figures
// (admissions today, discharges today, patients on GIP, recertifications due) that M5 cannot compute: every
// one is derived from M6 tables, and M5 may not read another module's tables. M6 owns the tables, so M6
// publishes the read; the composition root injects it into M5 as a locally-declared PORT (the
// `patientIdsPageForOrg` / `patientDisplayLabelsForOrg` shape — M5 never imports this file).
//
// COUNTS ONLY. No patient identity crosses this seam. The read runs under `withOrgContext` (RLS is the wall)
// with the explicit `organization_id` predicate behind it, uses the NULL system actor (a pure aggregate, no
// acting human), and takes "today" in the ORG's timezone — the same calendar day the clinicians see — never
// the server's.
import { type DbClient, organizationTimezone, schema } from "@chartwarden/db";
import { localDateInTimeZone } from "@chartwarden/shared/dates";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, gte, isNull, lt, lte, sql } from "drizzle-orm";

const ADM = schema.admissions;
const DE = schema.dischargeEvents;
const LCP = schema.levelOfCarePeriods;
const EP = schema.electionPeriods;

/** An empty acting-user sentinel: the M4 audit trigger maps "" to NULL (a system read). */
const SYSTEM_USER_ID = "";

/** A benefit period whose last day falls within this many days is "due for recertification". */
export const RECERT_DUE_WITHIN_DAYS = 14;

export interface AdmissionCensusSummary {
  /** Admissions whose admission instant falls on the org's local date. */
  readonly admissionsToday: number;
  /** Completed discharges effective on the org's local date. */
  readonly dischargesToday: number;
  /** Patients currently in an ACTIVE general-inpatient-care level-of-care period. */
  readonly gipActive: number;
  /** Active election periods ending within {@link RECERT_DUE_WITHIN_DAYS} days (the next period needs a recert). */
  readonly recertsDue: number;
  /** The org-local calendar date the "today" figures were computed for. */
  readonly asOfDate: string;
}

const addDays = (isoDate: string, days: number): string => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const countOf = (rows: ReadonlyArray<{ n: number | string }>): number => Number(rows[0]?.n ?? 0);

export async function admissionCensusSummaryForOrg(
  db: DbClient,
  organizationId: string,
  now: Date = new Date(),
): Promise<AdmissionCensusSummary> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const t = tx as unknown as DbClient;
    const zone = await organizationTimezone(t, organizationId);
    const today = localDateInTimeZone(now, zone);
    const tomorrow = addDays(today, 1);
    // The org-local day as an instant range, computed in SQL so DST days are 23/25 hours, not 24.
    const dayStart = sql`(${today}::date)::timestamp AT TIME ZONE ${zone}`;
    const dayEnd = sql`(${tomorrow}::date)::timestamp AT TIME ZONE ${zone}`;

    const admissions = await t
      .select({ n: sql<number>`count(*)::int` })
      .from(ADM)
      .where(
        and(
          eq(ADM.organizationId, organizationId),
          gte(ADM.admissionAt, dayStart as never),
          lt(ADM.admissionAt, dayEnd as never),
        ),
      );
    const discharges = await t
      .select({ n: sql<number>`count(*)::int` })
      .from(DE)
      .where(
        and(
          eq(DE.organizationId, organizationId),
          eq(DE.status, "completed"),
          eq(DE.effectiveAt, today),
        ),
      );
    const gip = await t
      .select({ n: sql<number>`count(distinct ${LCP.admissionId})::int` })
      .from(LCP)
      .where(
        and(
          eq(LCP.organizationId, organizationId),
          eq(LCP.levelOfCare, "general_inpatient_care"),
          eq(LCP.status, "active"),
          isNull(LCP.endedAt),
        ),
      );
    const recerts = await t
      .select({ n: sql<number>`count(*)::int` })
      .from(EP)
      .where(
        and(
          eq(EP.organizationId, organizationId),
          eq(EP.status, "active"),
          gte(EP.scheduledEndAt, today),
          lte(EP.scheduledEndAt, addDays(today, RECERT_DUE_WITHIN_DAYS)),
        ),
      );

    return {
      admissionsToday: countOf(admissions),
      dischargesToday: countOf(discharges),
      gipActive: countOf(gip),
      recertsDue: countOf(recerts),
      asOfDate: today,
    };
  });
}
