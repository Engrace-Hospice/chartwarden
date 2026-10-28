/**
 * Narrative readiness claims must not contradict the generated evidence (#862, CW-QA-0018).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("M41 status narrative", () => {
  it("the generated matrix reports M41 implemented", () => {
    const row = read("audit/implementation-status/IMPLEMENTATION_STATUS.md")
      .split("\n")
      .find((l) => l.startsWith("| M41 "));
    expect(row).toMatch(/Implemented/);
  });

  it("CLAUDE.md does not call M41 a placeholder while the matrix says implemented", () => {
    const guide = read("CLAUDE.md");
    expect(guide).not.toMatch(/M41[^.\n]{0,60}placeholder/i);
    expect(guide).toMatch(/M41 commercial billing .*included, has real implementation/);
  });

  it("AGENTS.md is a verbatim copy of CLAUDE.md", () => {
    expect(read("AGENTS.md")).toBe(read("CLAUDE.md"));
  });
});

describe("e2e/specs/billing.spec.ts header", () => {
  const spec = read("e2e/specs/billing.spec.ts");
  const header = spec.slice(0, spec.indexOf("import "));
  const suites = [
    "apps/backend/__tests__/m23-claim-assembly-seams.live.test.ts",
    "apps/backend/__tests__/m23-visit-lines-assembly.live.test.ts",
  ];

  it("does not claim Medicare assembly is unconditionally unreachable", () => {
    expect(header).not.toMatch(/unconditionally\s+unreachable/i);
    expect(spec).not.toMatch(/assemble unreachable/i);
  });

  it.each(suites)("names the live suite %s and that suite exists", (suite) => {
    expect(header).toContain(suite.split("/").pop()!);
    expect(existsSync(join(ROOT, suite))).toBe(true);
  });

  it("names the wall the live suite actually asserts", () => {
    expect(header).toContain("RATE_TABLE_MISSING");
    expect(read(suites[0]!)).toContain("RATE_TABLE_MISSING");
  });
});
