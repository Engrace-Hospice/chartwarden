import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, ne, or } from "drizzle-orm";

/** M41-owned half of M5's payer-row void guard (#874). Runs inside M5's caller transaction. */
export async function hasNonVoidCommercialClaimForPatientPayer(
  tx: DbClient,
  organizationId: string,
  patientPayerId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: schema.commercialClaims.id })
    .from(schema.commercialClaims)
    .where(
      and(
        eq(schema.commercialClaims.organizationId, organizationId),
        or(
          eq(schema.commercialClaims.primaryPatientPayerId, patientPayerId),
          eq(schema.commercialClaims.secondaryPatientPayerId, patientPayerId),
        ),
        ne(schema.commercialClaims.state, "void"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
