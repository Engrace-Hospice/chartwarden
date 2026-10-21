// apps/backend/src/modules/06-admission/seams/loc-periods-for-patient.ts — org-explicit "every real
// level-of-care period for this PATIENT overlapping a date range" read for BACKGROUND consumers (GAP-071;
// the `cap-election-context.ts` / `claimAssemblyRangeContextForOrg` precedent). M24's rb_day daily sweep
// needs the per-day LOC-of-day AND the period id to snapshot (`rb_day.loc_of_day` /
// `loc_period_id_snapshot`); M6's published `LevelOfCareReader` is per-ADMISSION and returns only the
// current period or aggregate day counts, never the period list. M24 does not list `6` in its manifest
// `dependsOn`, so the composition root injects this function as a typed port.
//
// `assigning` periods (an IRC/GIP awaiting bed confirmation) are NOT real periods of care and are excluded,
// the same rule `LevelOfCareReader` applies. Returned oldest-first.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, asc, eq, gt, isNull, lte, ne, or } from "drizzle-orm";

const LOC = schema.levelOfCarePeriods;
const ADM = schema.admissions;

/** The seam envelope's actor id — a cross-module identity read has no acting membership. */
const LOC_READER_SYSTEM_USER_ID = "";

export interface PatientLevelOfCarePeriod {
  readonly periodId: string;
  readonly levelOfCare:
    | "routine_home_care"
    | "continuous_home_care"
    | "inpatient_respite_care"
    | "general_inpatient_care";
  readonly effectiveAt: Date;
  /** null = still open. */
  readonly endedAt: Date | null;
  /** M40 facility the period is sited at (IRC/GIP), else null. */
  readonly facilityId: string | null;
}

/** Every non-`assigning` LOC period on any of the patient's admissions overlapping `[from, to]`. */
export function levelOfCarePeriodsForPatientForOrg(
  db: DbClient,
  organizationId: string,
  patientId: string,
  range: { readonly from: Date; readonly to: Date },
): Promise<readonly PatientLevelOfCarePeriod[]> {
  return withOrgContext(db, { organizationId, userId: LOC_READER_SYSTEM_USER_ID }, async (tx) => {
    const rows = await tx
      .select({
        periodId: LOC.id,
        levelOfCare: LOC.levelOfCare,
        effectiveAt: LOC.effectiveAt,
        endedAt: LOC.endedAt,
        facilityId: LOC.facilityId,
      })
      .from(LOC)
      .innerJoin(ADM, eq(ADM.id, LOC.admissionId))
      .where(
        and(
          eq(ADM.organizationId, organizationId),
          eq(ADM.patientId, patientId),
          ne(LOC.status, "assigning"),
          lte(LOC.effectiveAt, range.to),
          or(isNull(LOC.endedAt), gt(LOC.endedAt, range.from)),
        ),
      )
      .orderBy(asc(LOC.effectiveAt));
    return rows;
  });
}
