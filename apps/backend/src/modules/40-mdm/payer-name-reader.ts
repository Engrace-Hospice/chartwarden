// apps/backend/src/modules/40-mdm/payer-name-reader.ts — M40's read of a canonical payer's name by X12 5010 payer id,
// for M23's 837I payer loop (2010BB) (see `buildClaim837iPartiesPort`).
//
// `payer` is the CANONICAL, org-less M40 table (NON_ORG_SCOPED, no PHI), so there is no organization_id predicate. Only an
// `active` row answers: a `merged` row's id redirects to a survivor (§2.4.1) and an inactive payer is not one to bill.
// Two payers never share an X12 id (UNIQUE `payer_x12_idx`), so the read is unambiguous; absent is null, never a default.
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq } from "drizzle-orm";

export function buildPayerNameByX12IdReader(): (
  tx: DbClient,
  x12PayerId: string,
) => Promise<string | null> {
  const t = schema.payers;
  return async (tx, x12PayerId) => {
    const [row] = await tx
      .select({ name: t.name })
      .from(t)
      .where(and(eq(t.payerId, x12PayerId), eq(t.status, "active")))
      .limit(1);
    return row?.name ?? null;
  };
}
