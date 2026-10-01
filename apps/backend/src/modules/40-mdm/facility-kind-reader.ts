// apps/backend/src/modules/40-mdm/facility-kind-reader.ts — F-213 (#252): M40's merge-resolved read of
// `facility.kind` (the migration-0183 site-of-care taxonomy), for M23's place-of-service binding.
//
// `facility` is the CANONICAL, org-less M40 table (NON_ORG_SCOPED, no PHI - a public facility's type), so
// there is no organization_id predicate to apply; the read is by facility id only and projects `kind` and
// nothing else. It chases `merged_into_id` (§7.2) so a facility merged after an address pointed at it
// answers with the SURVIVOR's kind, not a dead row's (the reason M40's own `resolveFacility` exists; that
// canonical projection carries no `kind`, so the chase is repeated here over the same columns). Bounded hops
// (a merge cycle is impossible by the CHECK but a bound keeps a corrupt chain from looping).
import { type DbClient, schema } from "@wardenx/db";
import { inArray } from "drizzle-orm";

export type FacilityKindValue = (typeof schema.facilities.$inferSelect)["kind"];

const MAX_MERGE_HOPS = 5;

/** `facility.kind` for each requested id (merge-resolved); ids that resolve to no row are absent. */
export async function facilityKindsForIds(
  db: DbClient,
  facilityIds: readonly string[],
): Promise<ReadonlyMap<string, FacilityKindValue>> {
  const result = new Map<string, FacilityKindValue>();
  if (facilityIds.length === 0) return result;
  const F = schema.facilities;
  // requested id -> the id currently being resolved (follows merges)
  const pending = new Map<string, string>(facilityIds.map((id) => [id, id]));
  for (let hop = 0; hop <= MAX_MERGE_HOPS && pending.size > 0; hop++) {
    const rows = await db
      .select({ id: F.id, kind: F.kind, mergedIntoId: F.mergedIntoId })
      .from(F)
      .where(inArray(F.id, [...new Set(pending.values())]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const [requested, current] of [...pending]) {
      const row = byId.get(current);
      if (!row) {
        pending.delete(requested); // dangling reference -> absent (never a guessed kind)
      } else if (row.mergedIntoId) {
        pending.set(requested, row.mergedIntoId);
      } else {
        result.set(requested, row.kind);
        pending.delete(requested);
      }
    }
  }
  return result;
}
