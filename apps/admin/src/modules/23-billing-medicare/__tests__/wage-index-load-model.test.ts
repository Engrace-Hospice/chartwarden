// apps/admin/src/modules/23-billing-medicare — the pure half of the platform wage-index load: turning a pasted or
// uploaded CMS table into the `rows[]` POST /api/v1/admin/billing/wage-indexes/load accepts, the client-side preview
// (the route has no dry run, so the console checks the same per-row patterns the route's schema does BEFORE sending),
// and the error-envelope → operator-copy mapping. The server still validates every row and loads all or nothing.
import { describe, expect, it } from "vitest";
import {
  WAGE_INDEX_LOAD_MAX_ROWS,
  fiscalYearLabel,
  fiscalYearStartingOf,
  loadErrorView,
  parseWageIndexTable,
} from "../wage-index-load-model";

describe("parseWageIndexTable", () => {
  it("reads CCN, CBSA, factor rows (comma or tab) and skips a header and blank lines", () => {
    const parsed = parseWageIndexTable(
      ["CCN,CBSA,Wage Index", "", "381588,38900,1.0342", "a1b2c3\t\t0.9876"].join("\n"),
    );
    expect(parsed.rows).toEqual([
      { ccn: "381588", cbsaCode: "38900", factorDecimal: "1.0342" },
      { ccn: "A1B2C3", factorDecimal: "0.9876" },
    ]);
    expect(parsed.problems).toEqual([]);
    expect(parsed.sourceLines).toEqual([3, 4]);
  });

  it("reads a two-column CCN, factor table", () => {
    const parsed = parseWageIndexTable("381588, 1.1\n381589;0.85");
    expect(parsed.rows).toEqual([
      { ccn: "381588", factorDecimal: "1.1" },
      { ccn: "381589", factorDecimal: "0.85" },
    ]);
  });

  it("names every bad line by number instead of guessing", () => {
    const parsed = parseWageIndexTable(
      ["38158,1.0", "381588,3890,1.0", "381589,1.03421", "381590,abc", "381591"].join("\n"),
    );
    expect(parsed.rows).toEqual([]);
    expect(parsed.problems.map((p) => p.line)).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.problems[0]?.message).toMatch(/CCN/);
    expect(parsed.problems[1]?.message).toMatch(/CBSA/);
    expect(parsed.problems[2]?.message).toMatch(/four decimal places/);
  });

  it("flags a CCN that appears twice (the route refuses the whole file for it)", () => {
    const parsed = parseWageIndexTable("381588,1.0\n381588,1.1");
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.problems).toEqual([
      { line: 2, message: "CCN 381588 appears more than once (first on line 1)" },
    ]);
  });

  it("refuses more rows than one load accepts", () => {
    const text = Array.from(
      { length: WAGE_INDEX_LOAD_MAX_ROWS + 1 },
      (_, i) => `${String(100000 + i)},1.0`,
    ).join("\n");
    const parsed = parseWageIndexTable(text);
    expect(parsed.problems.at(-1)?.message).toMatch(/at most 7,000 rows/);
  });
});

describe("fiscal year helpers", () => {
  it("labels the FY by its ending year and derives the starting year from a date", () => {
    expect(fiscalYearLabel(2025)).toBe("FY2026");
    expect(fiscalYearStartingOf(new Date(2026, 9, 7))).toBe(2026);
    expect(fiscalYearStartingOf(new Date(2026, 8, 30))).toBe(2025);
  });
});

describe("loadErrorView — the standard error envelope → what the operator can do", () => {
  it("STEP_UP_REQUIRED is a re-verify, not a permission problem", () => {
    const v = loadErrorView(403, { error: { code: "STEP_UP_REQUIRED", message: "x" } }, [1]);
    expect(v.title).toMatch(/Re-verify/);
  });

  it("a plain 403 names the platform-admin permission", () => {
    expect(loadErrorView(403, { error: { code: "FORBIDDEN", message: "x" } }, []).message).toMatch(
      /billing\.rule_config\.platform_admin/,
    );
  });

  it("a 409 is an idempotency conflict (same key, different file)", () => {
    expect(
      loadErrorView(409, { error: { code: "IDEMPOTENCY_CONFLICT", message: "x" } }, []).title,
    ).toMatch(/already used/);
  });

  it("a 422 maps rows[i] details back to the operator's line numbers", () => {
    const v = loadErrorView(
      422,
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "2 problem(s) in the wage-index file; nothing was loaded",
          details: [
            { field: "rows[0]", code: "INVALID", message: "factor out of range" },
            { field: "rows[1].ccn", code: "DUPLICATE", message: "CCN X appears more than once" },
          ],
        },
      },
      [4, 9],
    );
    expect(v.message).toBe("2 problem(s) in the wage-index file; nothing was loaded");
    expect(v.details).toEqual([
      "Line 4: factor out of range",
      "Line 9: CCN X appears more than once",
    ]);
  });
});
