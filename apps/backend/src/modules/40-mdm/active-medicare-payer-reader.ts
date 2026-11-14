// Narrow M40 read contract for billing routes: canonical payer id validation without exporting the M40 table shape.
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq } from "drizzle-orm";

export interface ActiveMedicarePayerFacts {
  readonly id: string;
  readonly x12PayerId: string | null;
  readonly name: string;
  readonly updatedAt: Date;
}
export function buildActiveMedicarePayerByIdReader(): (
  tx: DbClient,
  payerId: string,
) => Promise<ActiveMedicarePayerFacts | null> {
  return async (tx, payerId) => {
    const [payer] = await tx
      .select({
        id: schema.payers.id,
        x12PayerId: schema.payers.payerId,
        name: schema.payers.name,
        updatedAt: schema.payers.updatedAt,
      })
      .from(schema.payers)
      .where(
        and(
          eq(schema.payers.id, payerId),
          eq(schema.payers.kind, "medicare"),
          eq(schema.payers.status, "active"),
        ),
      )
      .limit(1);
    return payer ?? null;
  };
}
