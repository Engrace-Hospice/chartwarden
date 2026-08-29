// F-098 — the test-tree typecheck coverage gate.
//
// Every workspace tsconfig here is `"include": ["src"]` and the convention puts a suite in a sibling
// `__tests__/` directory, so 631 files vitest runs were compiled by NOTHING. The gate's job is to keep
// that from coming back, which needs two things to hold: the glob matcher has to resolve the runner's
// own include/exclude the way the runner does, and the coverage rule has to actually fire.
import { describe, expect, it } from "vitest";
import {
  type VitestProject,
  findCoverageViolations,
  globToRegExp,
  projectFiles,
  vitestProjects,
} from "../check-test-typecheck-coverage";

const NODE: VitestProject = {
  name: "node",
  include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
  exclude: ["**/node_modules/**", "apps/**/*.dom.test.tsx"],
};

describe("globToRegExp", () => {
  it("matches `**` across path segments and `*` within one", () => {
    expect(globToRegExp("apps/**/*.test.ts").test("apps/backend/__tests__/auth.test.ts")).toBe(
      true,
    );
    expect(globToRegExp("apps/**/*.test.ts").test("apps/backend/src/x.ts")).toBe(false);
    // `**/` is zero-or-more segments, so a file directly under `apps/` still matches.
    expect(globToRegExp("apps/**/*.test.ts").test("apps/a.test.ts")).toBe(true);
  });

  it("matches a bare trailing `**` against the rest of the path", () => {
    expect(globToRegExp("**/node_modules/**").test("packages/db/node_modules/x/y.ts")).toBe(true);
  });

  it("REFUSES a glob it cannot represent rather than approximating it", () => {
    // A silently mis-parsed brace expansion would report a covered file as unchecked — or, worse, an
    // unchecked one as covered. Both are wrong answers delivered with a green build.
    expect(() => globToRegExp("apps/**/*.{ts,tsx}")).toThrow(/unsupported glob syntax/);
  });
});

describe("projectFiles", () => {
  it("resolves include minus exclude over the tracked tree", () => {
    const tracked = [
      "apps/backend/__tests__/auth.test.ts",
      "apps/backend/src/index.ts",
      "apps/web/__tests__/screens-smoke.dom.test.tsx",
      "packages/db/migrations/__tests__/rls.test.ts",
      "packages/db/node_modules/dep/x.test.ts",
    ];
    expect(projectFiles(NODE, tracked)).toEqual([
      "apps/backend/__tests__/auth.test.ts",
      "packages/db/migrations/__tests__/rls.test.ts",
    ]);
  });
});

describe("findCoverageViolations", () => {
  it("is GREEN on the repo as it stands", async () => {
    const violations = findCoverageViolations(await vitestProjects(), trackedForTest());
    expect(violations).toEqual([]);
  });

  it("goes RED for a file vitest runs that no tsconfig compiles", () => {
    const planted = [...trackedForTest(), "apps/backend/__tests__/not-a-real-suite.test.ts"];
    const violations = findCoverageViolations(
      [{ name: "node", include: ["apps/**/*.test.ts"], exclude: [] }],
      planted,
    );
    expect(violations.map((v) => v.where)).toContain(
      "apps/backend/__tests__/not-a-real-suite.test.ts",
    );
    expect(violations.find((v) => v.where.endsWith("not-a-real-suite.test.ts"))?.kind).toBe(
      "unchecked",
    );
  });
});

/** The tracked tree, read once. Split out so the two cases above share the `git ls-files` call. */
function trackedForTest(): readonly string[] {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  return execFileSync("git", ["ls-files"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .map((l: string) => l.trim())
    .filter((l: string) => l.length > 0);
}
