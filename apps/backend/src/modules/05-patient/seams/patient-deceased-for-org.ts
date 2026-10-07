// apps/backend/src/modules/05-patient/seams/patient-deceased-for-org.ts — the org-explicit "is this patient
// deceased" fact M2's funeral-home link needs (GAP-115). `patient.status` is M5's column and M2 may not read
// it, so M5 publishes the read and the composition root injects it into M2 as a locally-declared port (the
// `patientIdsPageForOrg` shape). A boolean only — no identity, no date of death crosses.
//
// FAILS CLOSED: an unknown / cross-tenant / merged-away patient is "not deceased". The funeral link is a
// disposition-access grant; the only safe answer to "I cannot tell" is no.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq } from "drizzle-orm";

const P = schema.patients;
const SYSTEM_USER_ID = "";

export async function patientIsDeceasedForOrg(
  db: DbClient,
  organizationId: string,
  patientId: string,
): Promise<boolean> {
  const rows = await withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) =>
    (tx as unknown as DbClient)
      .select({ status: P.status })
      .from(P)
      .where(and(eq(P.id, patientId), eq(P.organizationId, organizationId)))
      .limit(1),
  );
  return rows[0]?.status === "deceased";
}
