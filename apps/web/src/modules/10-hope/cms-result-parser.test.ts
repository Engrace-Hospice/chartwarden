import { describe, expect, it } from "vitest";
import { MAX_REPORT_CHARS, normalizeOutcome, parseCmsReport } from "./cms-result-parser";

describe("normalizeOutcome", () => {
  it.each([
    ["Accepted", "accepted"],
    ["PASS", "accepted"],
    ["Accepted with warnings", "accepted_with_warnings"],
    ["accepted_with_warnings", "accepted_with_warnings"],
    ["warning", "accepted_with_warnings"],
    ["Rejected", "rejected"],
    ["fatal", "rejected"],
    ["Not Accepted", "rejected"],
    ["Unaccepted", "rejected"],
    ["Accepted, 0 errors", "accepted"],
    ["Passed (no errors)", "accepted"],
  ])("maps %s", (raw, want) => expect(normalizeOutcome(raw)).toBe(want));
  it("returns null for junk", () => expect(normalizeOutcome("maybe")).toBeNull());
});

describe("parseCmsReport", () => {
  it("parses a JSON array", () => {
    const r = parseCmsReport(
      JSON.stringify([{ assessmentId: "a1", result: "rejected", code: "-3010", message: "bad" }]),
    );
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { assessmentId: "a1", status: "rejected", code: "-3010", itemCode: "", message: "bad" },
    ]);
  });
  it("parses {results:[...]} and reports bad entries", () => {
    const r = parseCmsReport(
      JSON.stringify({
        results: [{ assessmentId: "a1", status: "accepted" }, 5, { status: "accepted" }],
      }),
    );
    expect(r.rows).toHaveLength(1);
    expect(r.errors).toHaveLength(2);
  });
  it("parses CSV with header, quotes and reordered columns", () => {
    const r = parseCmsReport(
      'status,Assessment ID,code,message\nrejected,a1,E1,"bad, very"\naccepted,a2,,',
    );
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => [x.assessmentId, x.status, x.message])).toEqual([
      ["a1", "rejected", "bad, very"],
      ["a2", "accepted", ""],
    ]);
  });
  it("parses headerless pipe lines positionally", () => {
    const r = parseCmsReport("a1|warning|W9|check item\na2|accepted");
    expect(r.rows.map((x) => [x.assessmentId, x.status, x.code])).toEqual([
      ["a1", "accepted_with_warnings", "W9"],
      ["a2", "accepted", ""],
    ]);
  });
  it("rejects invalid JSON, empty and oversized input", () => {
    expect(parseCmsReport("{nope").errors[0]).toMatch(/not valid JSON/);
    expect(parseCmsReport("  ").rows).toEqual([]);
    expect(parseCmsReport("x".repeat(MAX_REPORT_CHARS + 1)).errors[0]).toMatch(/too large/);
  });
  it("reports lines with unknown status", () => {
    const r = parseCmsReport("a1,maybe");
    expect(r.rows).toEqual([]);
    expect(r.errors[0]).toMatch(/unrecognised status/);
  });
});
