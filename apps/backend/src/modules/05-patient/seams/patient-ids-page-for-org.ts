// apps/backend/src/modules/05-patient/seams/patient-ids-page-for-org.ts — the org-explicit, KEYSET-paged
// patient-id enumeration M28's bulk-export worker needs (GAP-084). `$export` is an all-patient operation and
// no registered seam enumerates an org's patients (`PatientReader` is lookup-only), so the worker would have
// had no way to know which patients to project.
//
// Same shape as `patientDisplayLabelsForOrg`: it lives in M5's directory because `patient` is M5's table and is
// injected into M28 as a locally-declared PORT at the composition root — M28 never imports M5 code or schema.
//
// IDS ONLY. Nothing about the patient crosses this seam beyond its identity; the clinical/demographic content
// still comes from the owner-module readers through the D3 consent gate. Merged-away duplicates
// (`merged_into_id IS NOT NULL`) are skipped: their surviving record is the one an export must carry, and
// emitting both would hand the consumer the same person twice under two ids.
//
// Bounded (a page is at most {@link PATIENT_IDS_PAGE_MAX}), ordered by id so `afterId` is a stable cursor, and
// run under `withOrgContext` so RLS is the wall; the explicit `organization_id` predicate is the belt behind it.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, asc, eq, gt, isNull } from "drizzle-orm";

const P = schema.patients;

/** A read with no acting human (the `SEAM_SYSTEM_USER_ID` convention — the M4 audit trigger maps "" to NULL). */
const PATIENT_IDS_SYSTEM_USER_ID = "";

/** The largest page a caller may ask for; a bigger request is clamped, never honoured. */
export const PATIENT_IDS_PAGE_MAX = 500;

/**
 * One page of the org's (non-merged) patient ids, ascending, strictly after `afterId` (null = first page).
 * An empty result means the enumeration is complete.
 */
export async function patientIdsPageForOrg(
  db: DbClient,
  organizationId: string,
  afterId: string | null,
  limit: number,
): Promise<readonly string[]> {
  const pageSize = Math.min(Math.max(Math.trunc(limit), 1), PATIENT_IDS_PAGE_MAX);
  const rows = await withOrgContext(
    db,
    { organizationId, userId: PATIENT_IDS_SYSTEM_USER_ID },
    async (tx) =>
      (tx as unknown as DbClient)
        .select({ id: P.id })
        .from(P)
        .where(
          and(
            eq(P.organizationId, organizationId),
            isNull(P.mergedIntoId),
            afterId === null ? undefined : gt(P.id, afterId),
          ),
        )
        .orderBy(asc(P.id))
        .limit(pageSize),
  );
  return rows.map((r) => r.id);
}
