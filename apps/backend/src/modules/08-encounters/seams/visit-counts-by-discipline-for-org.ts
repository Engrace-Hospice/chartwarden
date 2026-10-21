// apps/backend/src/modules/08-encounters/seams/visit-counts-by-discipline-for-org.ts — GAP-080.
//
// The org-explicit, aggregate-only visit count M27's Worksheet S-3 Part III (visits by discipline) needs (M27 spec §4.5:
// "`EncounterStatisticsProvider` … the projection is aggregate counts only, no PHI"). For ONE provider entity and a
// fiscal window it counts the COMPLETED visits per clinical discipline: an encounter counts once it is finalized
// (finalized / signed / cosign_pending / cosigned); a draft was never completed and a voided one is recorded-in-error.
//
// `encounter` is M8's table, so the read lives here and M27 receives it as a locally-declared PORT at the composition
// root. Nothing patient-identifying leaves: the result is `{ discipline: count }`.
//
// Not a request: opens its own `withOrgContext` envelope (empty acting user, the seam-read convention) with an explicit
// `organization_id` predicate behind RLS.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";

const ENC = schema.encounters;

/** A consumer-driven read names no acting membership (the F-102 convention). */
const SEAM_READER_SYSTEM_USER_ID = "";

/** The encounter states that mean "the visit happened and was documented". */
export const COMPLETED_ENCOUNTER_STATUSES = [
  "finalized",
  "signed",
  "cosign_pending",
  "cosigned",
] as const;

export function visitCountsByDisciplineForOrg(
  db: DbClient,
  organizationId: string,
  window: { readonly providerEntityId: string; readonly from: string; readonly to: string },
): Promise<Readonly<Record<string, number>>> {
  return withOrgContext(db, { organizationId, userId: SEAM_READER_SYSTEM_USER_ID }, async (tx) => {
    const rows = await (tx as DbClient)
      .select({ discipline: ENC.discipline, n: sql<number>`count(*)::int` })
      .from(ENC)
      .where(
        and(
          eq(ENC.organizationId, organizationId),
          eq(ENC.providerEntityId, window.providerEntityId),
          inArray(ENC.status, [...COMPLETED_ENCOUNTER_STATUSES]),
          gte(ENC.serviceDate, window.from),
          lte(ENC.serviceDate, window.to),
        ),
      )
      .groupBy(ENC.discipline);
    return Object.fromEntries(rows.map((r) => [r.discipline, r.n]));
  });
}
