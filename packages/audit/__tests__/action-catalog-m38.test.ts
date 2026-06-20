// M38-T10 — the §8.1 terminology event surface lands in the action catalog under the D9 `m38.*`
// namespace (architecture's catalog convention wins over the spec's `terminology.*` names).
//
// Accept: the nine §8.1 events are present, all owned by `m38`, carry no PHI denylist (terminology
// is reference data, §8.3), are not Part 2 eligible, and the consolidated catalog still validates.
import { describe, expect, it } from "vitest";
import { ACTION_CATALOG, M38_ACTION_CATALOG, validateActionCatalog } from "../src/actions";

describe("M38-T10 action catalog (§8.1)", () => {
  it("declares the nine §8.1 terminology events under m38", () => {
    expect(M38_ACTION_CATALOG.map((e) => e.action)).toEqual([
      "m38.version.loaded",
      "m38.version.load_failed",
      "m38.deprecation.detected",
      "m38.tenant_deprecation_scan.completed",
      "m38.value_set_extension.added",
      "m38.value_set_extension.removed",
      "m38.embedding.refreshed",
      "m38.expansion.staleness_exceeded",
      "m38.external_lookup.recorded",
    ]);
  });

  it("every m38 event is owned by m38, PHI-free, and not Part 2 eligible (reference data, §8.3)", () => {
    for (const e of M38_ACTION_CATALOG) {
      expect(e.moduleOwner).toBe("m38");
      expect(e.denylistCategories).toEqual([]);
      expect(e.isPartTwoEligible).toBe(false);
    }
  });

  it("keeps the consolidated catalog valid after M38 is merged in", () => {
    expect(validateActionCatalog()).toEqual([]);
    for (const e of M38_ACTION_CATALOG) expect(ACTION_CATALOG).toContainEqual(e);
  });
});
