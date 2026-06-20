// M40-T10 — the §8.1.1 MDM audit actions land in the action catalog under the D9 `m40.*` namespace.
//
// Accept: the five §8.1.1 actions are present, all owned by `m40`, carry no PHI denylist (MDM is
// directory-style reference data, §8.3), are not Part 2 eligible, all `operational` retention, and
// the consolidated catalog still validates.
import { describe, expect, it } from "vitest";
import { ACTION_CATALOG, M40_ACTION_CATALOG, validateActionCatalog } from "../src/actions";

describe("M40-T10 action catalog (§8.1.1)", () => {
  it("declares the five §8.1.1 MDM actions under m40", () => {
    expect(M40_ACTION_CATALOG.map((e) => e.action)).toEqual([
      "m40.nppes.provider_synced.applied",
      "m40.nppes.deactivation_observed_no_canonical",
      "m40.legacy_nightly.skipping_m29_recent",
      "m40.legacy_nightly.firing_fallback",
      "m40.baa_status.cache_miss",
    ]);
  });

  it("every m40 action is owned by m40, PHI-free, operational, not Part 2 eligible (§8.3)", () => {
    for (const e of M40_ACTION_CATALOG) {
      expect(e.moduleOwner).toBe("m40");
      expect(e.denylistCategories).toEqual([]);
      expect(e.isPartTwoEligible).toBe(false);
      expect(e.defaultRetentionClass).toBe("operational");
    }
  });

  it("keeps the consolidated catalog valid after M40 is merged in", () => {
    expect(validateActionCatalog()).toEqual([]);
    for (const e of M40_ACTION_CATALOG) expect(ACTION_CATALOG).toContainEqual(e);
  });
});
