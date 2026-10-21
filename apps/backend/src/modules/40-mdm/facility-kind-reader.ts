// apps/backend/src/modules/40-mdm/facility-kind-reader.ts — F-213 (#252): M40's merge-resolved read of
// `facility.kind` (the migration-0183 site-of-care taxonomy), for M23's place-of-service binding; and the facility's
// postal code, for M23's wage-index value code G8 (the CBSA of the latest inpatient facility).
//
// `facility` is the CANONICAL, org-less M40 table (NON_ORG_SCOPED, no PHI - a public facility's type and address), so
// there is no organization_id predicate to apply; the read is by facility id only and projects one field each. It
// chases `merged_into_id` (§7.2) so a facility merged after an address pointed at it answers with the SURVIVOR's
// value, not a dead row's (the reason M40's own `resolveFacility` exists; that canonical projection carries no `kind`,
// so the chase is repeated here over the same columns). Bounded hops (a merge cycle is impossible by the CHECK but a
// bound keeps a corrupt chain from looping).
import { type DbClient, schema } from "@chartwarden/db";
import { inArray } from "drizzle-orm";

export type FacilityKindValue = (typeof schema.facilities.$inferSelect)["kind"];

const MAX_MERGE_HOPS = 5;

/** `pick(row)` for each requested id, following merges to the survivor; unresolvable ids are absent. */
async function mergeResolved<T>(
  db: DbClient,
  facilityIds: readonly string[],
  pick: (row: { kind: FacilityKindValue; primaryAddress: unknown }) => T | undefined,
): Promise<ReadonlyMap<string, T>> {
  const result = new Map<string, T>();
  if (facilityIds.length === 0) return result;
  const F = schema.facilities;
  // requested id -> the id currently being resolved (follows merges)
  const pending = new Map<string, string>(facilityIds.map((id) => [id, id]));
  for (let hop = 0; hop <= MAX_MERGE_HOPS && pending.size > 0; hop++) {
    const rows = await db
      .select({
        id: F.id,
        kind: F.kind,
        primaryAddress: F.primaryAddress,
        mergedIntoId: F.mergedIntoId,
      })
      .from(F)
      .where(inArray(F.id, [...new Set(pending.values())]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const [requested, current] of [...pending]) {
      const row = byId.get(current);
      if (!row) {
        pending.delete(requested); // dangling reference -> absent (never a guessed value)
      } else if (row.mergedIntoId) {
        pending.set(requested, row.mergedIntoId);
      } else {
        const value = pick(row);
        if (value !== undefined) result.set(requested, value);
        pending.delete(requested);
      }
    }
  }
  return result;
}

/** `facility.kind` for each requested id (merge-resolved); ids that resolve to no row are absent. */
export function facilityKindsForIds(
  db: DbClient,
  facilityIds: readonly string[],
): Promise<ReadonlyMap<string, FacilityKindValue>> {
  return mergeResolved(db, facilityIds, (row) => row.kind);
}

/**
 * `facility.primary_address.postalCode` for each requested id (merge-resolved); a facility with no address or no
 * postal code is absent. The key follows the address-jsonb convention used across the repo (`line1`, `city`,
 * `postalCode`).
 */
export function facilityPostalCodesForIds(
  db: DbClient,
  facilityIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  return mergeResolved(db, facilityIds, (row) => {
    const address = row.primaryAddress as { postalCode?: unknown } | null;
    return typeof address?.postalCode === "string" && address.postalCode.trim() !== ""
      ? address.postalCode
      : undefined;
  });
}
