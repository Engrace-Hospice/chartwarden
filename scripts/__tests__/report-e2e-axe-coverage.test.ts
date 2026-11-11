import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface CoverageRow {
  readonly id: string;
  readonly e2eReached: boolean;
  readonly axeReached: boolean;
}

interface CoverageReport {
  readonly e2eReachedCount: number;
  readonly axeReachedCount: number;
  readonly rows: readonly CoverageRow[];
}

describe("the generated E2E/axe coverage report", () => {
  const report = JSON.parse(
    readFileSync(join(process.cwd(), "audit/e2e-coverage/e2e-coverage.json"), "utf8"),
  ) as CoverageReport;

  it("counts every axe-scanned screen as E2E-reached", () => {
    const contradictions = report.rows
      .filter((row) => row.axeReached && !row.e2eReached)
      .map((row) => row.id);

    expect(contradictions).toEqual([]);
    expect(report.e2eReachedCount).toBeGreaterThanOrEqual(report.axeReachedCount);
  });
});
