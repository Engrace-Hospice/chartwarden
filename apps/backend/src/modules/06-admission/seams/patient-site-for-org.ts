// apps/backend/src/modules/06-admission/seams/patient-site-for-org.ts — GAP-092.
//
// The provider entity (+ location) a patient's care is sited under, read from the patient's most recent SITED admission.
// M31's patient-bearing rows (`portal_invitation`, `portal_document_upload`, `portal_access_grant`) must carry the
// ARCH-011 `provider_entity_id`; the admission is where that fact lives, and `admission` is M6's table, so the read
// lives here and is injected into M31 as a locally-declared PORT at the composition root (M31's manifest `dependsOn`
// excludes 6). A patient with no sited admission has no site: the caller refuses rather than guess one.
//
// Not a request: opens its own `withOrgContext` envelope (empty acting user, the seam-read convention) with an explicit
// `organization_id` predicate behind RLS, so a cross-tenant patient is simply absent.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, desc, eq, isNotNull } from "drizzle-orm";

const ADM = schema.admissions;

/** A consumer-driven read names no acting membership (the F-102 convention). */
const SEAM_READER_SYSTEM_USER_ID = "";

export interface PatientSite {
  readonly providerEntityId: string;
  readonly locationId: string | null;
}

export function patientSiteForOrg(
  db: DbClient,
  organizationId: string,
  patientId: string,
): Promise<PatientSite | null> {
  return withOrgContext(db, { organizationId, userId: SEAM_READER_SYSTEM_USER_ID }, async (tx) => {
    const [row] = await (tx as DbClient)
      .select({ providerEntityId: ADM.providerEntityId, locationId: ADM.locationId })
      .from(ADM)
      .where(
        and(
          eq(ADM.organizationId, organizationId),
          eq(ADM.patientId, patientId),
          isNotNull(ADM.providerEntityId),
        ),
      )
      .orderBy(desc(ADM.createdAt))
      .limit(1);
    if (!row?.providerEntityId) return null;
    return { providerEntityId: row.providerEntityId, locationId: row.locationId ?? null };
  });
}
