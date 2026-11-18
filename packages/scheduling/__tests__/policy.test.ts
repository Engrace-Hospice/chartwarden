import { describe, expect, it } from "vitest";
import { VISIT_PURPOSE_DISCIPLINES } from "../src/policy";

describe("HOPE scheduling purposes", () => {
  it("matches the M10 author-discipline floors without completing an assessment", () => {
    expect(VISIT_PURPOSE_DISCIPLINES.huv1).toEqual(["rn", "np", "md"]);
    expect(VISIT_PURPOSE_DISCIPLINES.huv2).toEqual(["rn", "np", "md"]);
    expect(VISIT_PURPOSE_DISCIPLINES.sfv).toEqual(["rn", "np", "lpn"]);
  });
});
