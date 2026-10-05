// apps/backend/src/modules/06-admission/seams/patient-siting-reader.ts — the Drizzle reader backing M6's
// `PatientSitingReader` seam: the DISTINCT location ids of a patient's ACTIVE admission(s), straight from the
// admission's own siting column (the same column `AdmissionStatusReader.getAdmissionSiting` reports per
// admission id, here keyed by patient). Not a request: it opens its OWN org-scoped `withOrgContext` envelope
// (empty acting user, the seam-read convention) with an explicit `organization_id` predicate behind RLS.
// Fail-closed shape: unknown / inactive patient, or an unsited admission, yields `[]`.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { PatientSitingReader } from "@wardenx/types";
import { and, eq } from "drizzle-orm";

const ADM = schema.admissions;

/** Same empty-acting-user sentinel the other M6 seam readers use (the audit trigger maps "" to NULL). */
const SYSTEM_USER_ID = "";

export function createPatientSitingReader(db: DbClient): PatientSitingReader {
  return {
    getPatientLocationIds({ organizationId, patientId }) {
      return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
        const rows = await (tx as unknown as DbClient)
          .select({ locationId: ADM.locationId })
          .from(ADM)
          .where(
            and(
              eq(ADM.organizationId, organizationId),
              eq(ADM.patientId, patientId),
              eq(ADM.status, "active"),
            ),
          );
        const ids = new Set<string>();
        for (const r of rows) {
          if (r.locationId !== null) ids.add(r.locationId);
        }
        return [...ids];
      });
    },
  };
}
