import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError } from "@chartwarden/types";
import { and, eq, gte, isNull, lte, or } from "drizzle-orm";

export function selectEffectiveMedicareProviderRouting<T extends { macJurisdiction: string }>(
  rows: readonly T[],
): T {
  if (rows.length === 0) {
    throw new ChartWardenError(
      "MEDICARE_ROUTING_MISSING",
      "No Medicare provider routing is effective for this provider and service date",
      422,
    );
  }
  if (rows.length > 1) {
    throw new ChartWardenError(
      "MEDICARE_ROUTING_AMBIGUOUS",
      "Medicare provider routing is ambiguous for this provider and service date",
      409,
    );
  }
  return rows[0]!;
}

/** Resolve within an explicit tenant and inclusive effective-date interval. Claims retain the returned snapshot. */
export async function resolveMedicareProviderRouting(
  db: DbClient,
  input: { organizationId: string; providerEntityId: string; effectiveDate: string },
): Promise<{
  macJurisdiction: (typeof schema.medicareProviderRouting.$inferSelect)["macJurisdiction"];
}> {
  const { organizationId, providerEntityId, effectiveDate } = input;
  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)
    ? new Date(`${effectiveDate}T00:00:00.000Z`)
    : null;
  if (
    !parsedDate ||
    !Number.isFinite(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== effectiveDate
  ) {
    throw new ChartWardenError(
      "MEDICARE_ROUTING_DATE_INVALID",
      "Medicare routing date is invalid",
      422,
    );
  }
  return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
    const rows = await tx
      .select({ macJurisdiction: schema.medicareProviderRouting.macJurisdiction })
      .from(schema.medicareProviderRouting)
      .where(
        and(
          eq(schema.medicareProviderRouting.organizationId, organizationId),
          eq(schema.medicareProviderRouting.providerEntityId, providerEntityId),
          lte(schema.medicareProviderRouting.effectiveFrom, effectiveDate),
          or(
            isNull(schema.medicareProviderRouting.effectiveTo),
            gte(schema.medicareProviderRouting.effectiveTo, effectiveDate),
          ),
        ),
      )
      .limit(2);
    return selectEffectiveMedicareProviderRouting(rows);
  });
}
