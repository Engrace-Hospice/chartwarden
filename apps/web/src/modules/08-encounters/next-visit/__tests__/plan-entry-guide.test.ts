// The guide of what a plan entry covers: every item says where it comes from, and what kind of source that is, so a rule is never passed
// off as a habit or a habit as a rule.
import { describe, expect, it } from "vitest";
import {
  type GuideBasis,
  PLAN_ENTRY_GUIDE,
  PLAN_ENTRY_GUIDE_BASIS_LABEL,
} from "../plan-entry-guide";

describe("PLAN_ENTRY_GUIDE", () => {
  it("has a unique id, a statement and a source for every item", () => {
    const ids = PLAN_ENTRY_GUIDE.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of PLAN_ENTRY_GUIDE) {
      expect(item.text.trim().length, item.id).toBeGreaterThan(0);
      expect(item.source.trim().length, item.id).toBeGreaterThan(0);
    }
  });

  it("labels every basis it uses", () => {
    const used = new Set<GuideBasis>(PLAN_ENTRY_GUIDE.map((item) => item.basis));
    for (const basis of used) expect(PLAN_ENTRY_GUIDE_BASIS_LABEL[basis]).toBeTruthy();
  });

  it("calls an item a Medicare rule only when it cites the regulation", () => {
    for (const item of PLAN_ENTRY_GUIDE.filter((i) => i.basis === "regulation")) {
      expect(item.source, item.id).toMatch(/42 CFR 418\.\d+/);
    }
  });

  it("never presents the next-visit item as required: no rule asks for it in each note", () => {
    const next = PLAN_ENTRY_GUIDE.find((item) => item.id === "next-visit");
    expect(next?.basis).toBe("practice");
    expect(next?.source).toMatch(/no rule requires it/);
  });
});
