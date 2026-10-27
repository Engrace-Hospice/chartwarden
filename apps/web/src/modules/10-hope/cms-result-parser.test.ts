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
  it("does not treat a headerless first line mentioning 'assessment' as a header (f, i)", () => {
    const r = parseCmsReport("a1,rejected,E1,assessment incomplete\na2,accepted");
    expect(r.rows.map((x) => x.assessmentId)).toEqual(["a1", "a2"]);
    expect(r.rows[0]?.message).toBe("assessment incomplete");
  });
  it("reports (not drops) a first line with an 'assessment' cell but no status header (i)", () => {
    const r = parseCmsReport("assessment,notes\na1,x");
    expect(r.rows).toEqual([]);
    expect(r.errors).toHaveLength(2);
  });
  it("sniffs the delimiter by the most frequent one outside quotes (g)", () => {
    const r = parseCmsReport('a1|rejected|E1|"bad, really, very"\na2|accepted');
    expect(r.rows.map((x) => [x.assessmentId, x.status, x.message])).toEqual([
      ["a1", "rejected", "bad, really, very"],
      ["a2", "accepted", ""],
    ]);
  });
  it("keeps newlines inside quoted cells in one record (h)", () => {
    const r = parseCmsReport(
      'assessmentId,status,message\na1,rejected,"line one\nline two"\na2,accepted,',
    );
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]?.message).toBe("line one\nline two");
  });
  it("reports an unterminated quote instead of swallowing the rest silently", () => {
    const r = parseCmsReport('a1,accepted\na2,rejected,"oops\na3,accepted');
    expect(r.rows.map((x) => x.assessmentId)).toEqual(["a1"]);
    expect(r.errors.join(" ")).toMatch(/Unterminated quote.*remaining lines were not parsed/);
  });
  it("parses CRLF line endings", () => {
    const r = parseCmsReport("assessmentId,status\r\na1,accepted\r\na2,rejected\r\n");
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => x.status)).toEqual(["accepted", "rejected"]);
  });
  it("tolerates a BOM-prefixed paste", () => {
    const r = parseCmsReport("\uFEFFassessmentId,status\na1,accepted");
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(1);
  });
  it("accepts an Assessment_ID header and numbers errors by data row", () => {
    const r = parseCmsReport("Assessment_ID,Status\na1,accepted\na2,maybe");
    expect(r.rows[0]?.assessmentId).toBe("a1");
    expect(r.errors).toEqual(["Data row 2: unrecognised status"]);
  });
});
