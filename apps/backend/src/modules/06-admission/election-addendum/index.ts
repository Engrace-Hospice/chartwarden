// apps/backend/src/modules/06-admission/election-addendum — the FY2027 election statement addendum
// (42 CFR 418.24(b)(6), (c), (d); CMS-1851-F). See ./service.ts for the entry points.
import type { NonCoveredItemSnapshot, NonCoveredItemsReader } from "@chartwarden/types";

export * from "./due-dates";
export * from "./render-payload";
export * from "./service";
export * from "./compliance";
export {
  ADDENDUM_WINDOW_KINDS,
  type AddendumPrefill,
  type AddendumWindowKind,
  exemptionReasonForDischarge,
  mergeSourceItems,
  openInitialAddendumInTx,
  settleAddendumOnLeavingCareInTx,
  sourceItemsDiffer,
} from "./store";

/**
 * Merge several {@link NonCoveredItemsReader}s (one per source module) into the one M6 reads. The composition
 * root passes M7's problem reader today; workstream B adds M12 medications / M21 DME / supplies / services by
 * appending readers here — nothing else in M6 changes. Each reader is asked independently; one source failing
 * fails the merged read (the caller then keeps the draft's existing lines rather than dropping that source's
 * determinations silently). Duplicate (source, sourceId) pairs keep the first.
 */
export function composeNonCoveredItemsReaders(
  readers: readonly NonCoveredItemsReader[],
): NonCoveredItemsReader {
  return {
    async listForAdmission(orgId, admissionId) {
      const lists = await Promise.all(readers.map((r) => r.listForAdmission(orgId, admissionId)));
      const seen = new Set<string>();
      const merged: NonCoveredItemSnapshot[] = [];
      for (const item of lists.flat()) {
        const key = `${item.source}:${item.sourceId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
      return merged;
    },
  };
}
