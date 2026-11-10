// The claims-billing census (ADR-0110 D8) records one job-level audit event per org per pass. It is registered under the
// D9 `m35.*` namespace, owned by m35, PHI-free (no denylist: counts only) and kept as a compliance record.
import { describe, expect, it } from "vitest";
import { ACTION_CATALOG, M35_ACTION_CATALOG, validateActionCatalog } from "../src/actions";

describe("M35 action catalog (ADR-0110 D8 census audit)", () => {
  it("declares the census run event, owned by m35, compliance retention, not Part 2 eligible", () => {
    expect(M35_ACTION_CATALOG.map((e) => e.action)).toEqual(["m35.patient_census.run"]);
    for (const e of M35_ACTION_CATALOG) {
      expect(e.moduleOwner).toBe("m35");
      expect(e.defaultRetentionClass).toBe("compliance");
      expect(e.denylistCategories).toEqual([]);
      expect(e.isPartTwoEligible).toBe(false);
    }
  });

  it("keeps the consolidated catalog valid after M35 is merged in", () => {
    expect(validateActionCatalog()).toEqual([]);
    for (const e of M35_ACTION_CATALOG) expect(ACTION_CATALOG).toContainEqual(e);
  });
});
