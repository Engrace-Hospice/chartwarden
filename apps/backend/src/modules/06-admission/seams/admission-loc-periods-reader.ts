// apps/backend/src/modules/06-admission/seams/admission-loc-periods-reader.ts — M6's read of one admission's
// level-of-care periods, for M24's per-LOC-period claim-line walk (the composition root binds it onto M24's
// `LevelOfCarePeriodReaderPort`, so neither module imports the other).
//
// The read used to live inline in `apps/backend/src/index.ts` as a bare `db.select` with no org context.
// `level_of_care_period` is RLS-scoped on `app.org_id`, and M24's `assembleClaim` calls this OUTSIDE its own
// org-context transaction, so the unset GUC made the policy's `::uuid` cast fail and every Medicaid claim
// assembly 500'd. Like `level-of-care-period-reader.ts`, each call opens its own `withOrgContext`.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, ne } from "drizzle-orm";

const LOC = schema.levelOfCarePeriods;

/** Same empty-acting-user sentinel `level-of-care-period-reader.ts` uses for a system read. */
const SYSTEM_USER_ID = "";

export interface AdmissionLocPeriod {
  readonly id: string;
  readonly levelOfCare: (typeof LOC.$inferSelect)["levelOfCare"];
  readonly effectiveAt: Date;
  readonly endedAt: Date | null;
  readonly facilityId: string | null;
  readonly ipuBedAssignmentId: string | null;
}

export interface AdmissionLocPeriodsReader {
  periodsForAdmission(organizationId: string, admissionId: string): Promise<AdmissionLocPeriod[]>;
}

/**
 * An admission's level-of-care periods in effective order. Excludes `status='assigning'`
 * (confirm-handshake fix, 2026-08-05): an IRC/GIP period awaiting M37 bed confirmation is not yet a real
 * period of care and must never generate a billable claim line.
 */
export function createAdmissionLocPeriodsReader(db: DbClient): AdmissionLocPeriodsReader {
  return {
    periodsForAdmission(organizationId, admissionId) {
      return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, (tx) =>
        (tx as unknown as DbClient)
          .select({
            id: LOC.id,
            levelOfCare: LOC.levelOfCare,
            effectiveAt: LOC.effectiveAt,
            endedAt: LOC.endedAt,
            facilityId: LOC.facilityId,
            ipuBedAssignmentId: LOC.ipuBedAssignmentId,
          })
          .from(LOC)
          .where(
            and(
              eq(LOC.organizationId, organizationId),
              eq(LOC.admissionId, admissionId),
              ne(LOC.status, "assigning"),
            ),
          )
          .orderBy(LOC.effectiveAt),
      );
    },
  };
}
