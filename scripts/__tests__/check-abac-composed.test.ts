/**
 * The ABAC composition gate (GAP-067): a predicate that is registered but never composed by a guard.
 *
 * Uses the real repo scan for the baseline and for the two regressions that matter (the scanner must keep
 * SEEING the real code shapes, or the gate dies quietly), and synthetic scans for the failure modes.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ABAC_UNCOMPOSED_ALLOWLIST } from "../abac-uncomposed-allowlist";
import { blankComments, findViolations, scanAbacComposition } from "../check-abac-composed";

const REPO_ROOT = join(__dirname, "../..");
const scan = scanAbacComposition(REPO_ROOT);

const synthetic = (declared: string[], composed: string[]) => ({
  declared: new Map(declared.map((n) => [n, "x.ts"])),
  composed: new Map(composed.map((n) => [n, ["y.ts:1"]])),
});

describe("ABAC composition gate", () => {
  it("the repo is clean", () => {
    expect(findViolations(scan)).toEqual([]);
  });

  it("flags a predicate that is registered but composed by nothing", () => {
    expect(findViolations(synthetic(["orphan_predicate"], []), {})).toEqual([
      { kind: "uncomposed", name: "orphan_predicate", declaredIn: "x.ts" },
    ]);
  });

  it("accepts an uncomposed predicate that is allowlisted with a reason", () => {
    expect(
      findViolations(synthetic(["orphan_predicate"], []), { orphan_predicate: "because" }),
    ).toEqual([]);
  });

  it("flags an allowlist entry without a reason", () => {
    expect(findViolations(synthetic(["p"], []), { p: "  " })).toContainEqual({
      kind: "allowlist-without-reason",
      name: "p",
    });
  });

  it("flags an allowlist entry that is now composed — the list can only shrink", () => {
    expect(findViolations(synthetic(["p"], ["p"]), { p: "was open" })).toEqual([
      { kind: "stale-allowlist-composed", name: "p" },
    ]);
  });

  it("flags an allowlist entry for a predicate nothing declares any more", () => {
    expect(findViolations(synthetic([], []), { gone: "was open" })).toEqual([
      { kind: "stale-allowlist-undeclared", name: "gone" },
    ]);
  });

  it("sees admission_intake_scope composed by requireAnyAbac on the M6 and M23 readmission routes", () => {
    const sites = scan.composed.get("admission_intake_scope") ?? [];
    expect(sites.some((s) => s.includes("06-admission/routes/admission-routes.ts"))).toBe(true);
    expect(sites.some((s) => s.includes("23-billing-medicare/routes/guards.ts"))).toBe(true);
    // the other names in the same requireAnyAbac list are composed too
    expect(
      (scan.composed.get("caseload_or_scope") ?? []).some((s) =>
        s.includes("23-billing-medicare/routes/guards.ts"),
      ),
    ).toBe(true);
  });

  it("sees sud_consent_present composed by the DocLens review routes — the GAP-067 regression", () => {
    const sites = scan.composed.get("sud_consent_present") ?? [];
    expect(
      sites.some((s) => s.includes("22-documents/extraction/review-workspace-routes.ts")),
    ).toBe(true);
    expect(Object.hasOwn(ABAC_UNCOMPOSED_ALLOWLIST, "sud_consent_present")).toBe(false);
  });

  it("sees step_up_recent composed by requireStepUp despite an apostrophe in a nearby comment", () => {
    expect(scan.composed.has("step_up_recent")).toBe(true);
  });

  it("every allowlist entry carries a reason", () => {
    for (const [name, reason] of Object.entries(ABAC_UNCOMPOSED_ALLOWLIST)) {
      expect(reason.trim().length, name).toBeGreaterThan(0);
    }
  });
});

describe("blankComments", () => {
  it("blanks line and block comments but keeps offsets, newlines and string contents", () => {
    const src = `a("x//y") // it's\n/* don't */ b('z')`;
    const out = blankComments(src);
    expect(out).toHaveLength(src.length);
    expect(out).toContain(`a("x//y")`);
    expect(out).toContain(`b('z')`);
    expect(out).not.toMatch(/it's|don't/);
    expect(out.split("\n")).toHaveLength(2);
  });
});
