import { describe, expect, it } from "vitest";
import { searchWords, snippetSegments } from "./search-snippet";

describe("searchWords", () => {
  it("lower-cases, splits and de-duplicates", () => {
    expect(searchWords("  Pain  PAIN knee ")).toEqual(["pain", "knee"]);
  });
});

describe("snippetSegments", () => {
  it("marks every hit, case-insensitively", () => {
    const segments = snippetSegments("Pain in the knee, pain again", ["pain"]);
    expect(segments.filter((s) => s.hit).map((s) => s.text)).toEqual(["Pain", "pain"]);
    expect(segments.map((s) => s.text).join("")).toBe("Pain in the knee, pain again");
  });
  it("windows a long body around the first hit with ellipses", () => {
    const body = `${"x".repeat(300)} needle ${"y".repeat(300)}`;
    const text = snippetSegments(body, ["needle"])
      .map((s) => s.text)
      .join("");
    expect(text.startsWith("…")).toBe(true);
    expect(text.endsWith("…")).toBe(true);
    expect(text).toContain("needle");
    expect(text.length).toBeLessThan(200);
  });
  it("shows the start unmarked when nothing matches (an attachment-only filter result)", () => {
    expect(snippetSegments("hello world", [])).toEqual([{ text: "hello world", hit: false }]);
    expect(snippetSegments("   ", ["a"])).toEqual([]);
  });
});
