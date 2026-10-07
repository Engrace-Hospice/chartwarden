// @wardenx/billing — the 837I Loop 2300 occurrence-span HI segment (UB-04 FL 35-36): `HI*BI:<code>:RD8:<from>-<thru>~`.
import { buildOccurrenceSpanSegments } from "@wardenx/billing";
import { describe, expect, it } from "vitest";

describe("837I occurrence-span segments", () => {
  it("renders an OSC 77 span as a BI composite with an RD8 range", () => {
    expect(
      buildOccurrenceSpanSegments([{ code: "77", from: "2026-03-01", through: "2026-03-06" }]),
    ).toEqual(["HI*BI:77:RD8:20260301-20260306~"]);
  });

  it("renders nothing when there are no spans", () => {
    expect(buildOccurrenceSpanSegments([])).toEqual([]);
  });

  it("refuses an inverted range or a malformed code", () => {
    expect(() =>
      buildOccurrenceSpanSegments([{ code: "77", from: "2026-03-06", through: "2026-03-01" }]),
    ).toThrow(/inverted/);
    expect(() =>
      buildOccurrenceSpanSegments([{ code: "7", from: "2026-03-01", through: "2026-03-01" }]),
    ).toThrow(/occurrence span/);
  });
});
