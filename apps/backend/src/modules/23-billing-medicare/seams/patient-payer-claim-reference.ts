import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, ne } from "drizzle-orm";

/** M23-owned half of M5's payer-row void guard (#874). Runs inside M5's caller transaction. */
export async function hasNonVoidMedicareClaimForPatientPayer(
  tx: DbClient,
  organizationId: string,
  patientPayerId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: schema.claim.id })
    .from(schema.claim)
    .where(
      and(
        eq(schema.claim.organizationId, organizationId),
        eq(schema.claim.patientPayerId, patientPayerId),
        ne(schema.claim.state, "VOIDED"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
