import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, ne } from "drizzle-orm";

/** M24-owned half of M5's payer-row void guard (#874). Runs inside M5's caller transaction. */
export async function hasNonVoidMedicaidClaimForPatientPayer(
  tx: DbClient,
  organizationId: string,
  patientPayerId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: schema.medicaidClaim.id })
    .from(schema.medicaidClaim)
    .where(
      and(
        eq(schema.medicaidClaim.organizationId, organizationId),
        eq(schema.medicaidClaim.patientPayerId, patientPayerId),
        ne(schema.medicaidClaim.state, "VOIDED"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
