/**
 * Guard: the redesign uses sentence-case labels (GAP-207). A new `text-transform: uppercase` /
 * `textTransform: "uppercase"` / `uppercase` utility class in a UI source tree fails here unless it
 * is listed in ALLOWLIST with a reason (e.g. an acronym or code display).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "../..");
const ROOTS = ["apps", "packages/ui/src"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo", "coverage"]);
const SOURCE_EXT = /\.(css|tsx?|jsx?)$/;
const TEST_FILE = /\.(test|spec)\.[tj]sx?$/;
const UPPERCASE_TREATMENT =
  /text-transform\s*:\s*uppercase|textTransform\s*:\s*["'`]uppercase["'`]|class(?:Name)?\s*=\s*["'`{][^"'`]*\buppercase\b/;

/** repo-relative path -> reason the uppercase treatment is legitimate. Empty by design. */
const ALLOWLIST: Readonly<Record<string, string>> = {};

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (SOURCE_EXT.test(name) && !TEST_FILE.test(name)) yield full;
  }
}

function isUiSource(path: string): boolean {
  return path.startsWith("packages/ui/src") || /^apps\/[^/]+\/src\//.test(path);
}

describe("sentence-case label guard", () => {
  it("has no uppercase text treatment outside the allowlist", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(join(REPO_ROOT, root))) {
        const rel = relative(REPO_ROOT, file);
        if (!isUiSource(rel) || rel in ALLOWLIST) continue;
        if (UPPERCASE_TREATMENT.test(readFileSync(file, "utf8"))) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("flags the treatments it is meant to catch", () => {
    expect(UPPERCASE_TREATMENT.test("a { text-transform: uppercase; }")).toBe(true);
    expect(UPPERCASE_TREATMENT.test('{ textTransform: "uppercase" }')).toBe(true);
    expect(UPPERCASE_TREATMENT.test('<span className="text-xs uppercase">')).toBe(true);
    expect(UPPERCASE_TREATMENT.test('{ textTransform: "capitalize" }')).toBe(false);
  });
});
