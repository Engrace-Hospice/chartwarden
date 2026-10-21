// apps/backend/src/modules/37-ipu/seams/inpatient-facilities-for-periods-for-org.ts
//
// An org-explicit, worker-callable read of WHERE inpatient hospice care was delivered, keyed by the M6
// level-of-care period that authorised it. M23 needs it for the claim's value code G8 (the CBSA of the facility
// where general-inpatient / inpatient-respite care was delivered — CMS Pub. 100-04 ch. 11 §30.3): a patient who lives
// in a nursing home and has a GIP stay at a hospital has NO M5 facility-residence span for the hospital, so M5 alone
// cannot answer. M37's `ipu_admission` is the system of record for the stay: `level_of_care_period_id` (unique) links
// it to the M6 period, and the facility is either the owned unit's facility (`inpatient_unit.facility_id`) or the
// arranged `remote_facility_id` (M40).
//
// Unlike `IpuAdmissionReader.bedAssignmentForDate` (the CURRENT live bed only, date ignored), this is historical and
// exact. A period M37 does not know is simply absent — the caller falls back or leaves G8 unresolved. Returns ids
// only (no PHI). Same cross-module precedent as `restraintAdmissionSitingForOrg`: an org-explicit `…ForOrg` function
// in M37's own `seams/` directory IS the seam surface a consumer imports.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, inArray } from "drizzle-orm";

const ADMISSION = schema.ipuAdmission;
const UNIT = schema.inpatientUnit;
const IPU_READER_SYSTEM_USER_ID = "";

/** `levelOfCarePeriodId` → M40 facility id where that inpatient period's care was delivered. */
export async function inpatientFacilityIdsForPeriodsForOrg(
  db: DbClient,
  organizationId: string,
  levelOfCarePeriodIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  if (levelOfCarePeriodIds.length === 0) return out;
  return withOrgContext(db, { organizationId, userId: IPU_READER_SYSTEM_USER_ID }, async (tx) => {
    const rows = await (tx as DbClient)
      .select({
        levelOfCarePeriodId: ADMISSION.levelOfCarePeriodId,
        remoteFacilityId: ADMISSION.remoteFacilityId,
        unitFacilityId: UNIT.facilityId,
      })
      .from(ADMISSION)
      .leftJoin(UNIT, eq(UNIT.id, ADMISSION.unitId))
      .where(
        and(
          eq(ADMISSION.organizationId, organizationId),
          inArray(ADMISSION.levelOfCarePeriodId, [...levelOfCarePeriodIds]),
        ),
      );
    for (const row of rows) {
      const facilityId = row.unitFacilityId ?? row.remoteFacilityId;
      if (facilityId) out.set(row.levelOfCarePeriodId, facilityId);
    }
    return out;
  });
}
