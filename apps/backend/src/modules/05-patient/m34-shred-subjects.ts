import { type DbClient, schema } from "@chartwarden/db";
import { eq } from "drizzle-orm";

/** M5-owned patient enumeration used only by the certified whole-tenant eraser fan-out. */
export async function m34TenantPatientIds(tx: DbClient, orgId: string): Promise<readonly string[]> {
  const rows = await tx
    .select({ id: schema.patients.id })
    .from(schema.patients)
    .where(eq(schema.patients.organizationId, orgId));
  return rows.map((row) => row.id).sort();
}
