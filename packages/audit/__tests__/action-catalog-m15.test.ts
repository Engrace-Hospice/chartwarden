// Workflow 06 audit D-15 — M15's explicit audit actions land in the action catalog under the D9 `m15.*`
// namespace (they used to fall back to the default retention with no denylist or Part 2 entry).
import { describe, expect, it } from "vitest";
import { ACTION_CATALOG, M15_ACTION_CATALOG, validateActionCatalog } from "../src/actions";

describe("M15 action catalog (audit D-15)", () => {
  it("declares the three explicit M15 audit actions under m15", () => {
    expect(M15_ACTION_CATALOG.map((e) => e.action)).toEqual([
      "m15.plan.discharged",
      "m15.idg_decision.applied",
      "m15.idg_decision.refused",
    ]);
  });

  it("every m15 action is owned by m15, kept on the compliance class, and Part 2 eligible", () => {
    for (const e of M15_ACTION_CATALOG) {
      expect(e.moduleOwner).toBe("m15");
      expect(e.defaultRetentionClass).toBe("compliance");
      expect(e.isPartTwoEligible).toBe(true);
    }
  });

  it("scrubs the discharge reason as free text", () => {
    const discharged = M15_ACTION_CATALOG.find((e) => e.action === "m15.plan.discharged");
    expect(discharged?.denylistCategories).toEqual(["narrative_free_text"]);
  });

  it("keeps the consolidated catalog valid after M15 is merged in", () => {
    expect(validateActionCatalog()).toEqual([]);
    for (const e of M15_ACTION_CATALOG) expect(ACTION_CATALOG).toContainEqual(e);
  });
});
