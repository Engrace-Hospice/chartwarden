// M39's `ConsentEvaluator.evaluate({ historical: true })` answers "was the record in force at that instant", from the row's own end and
// entry instants rather than its status today. It exists to READ what was on file at a past visit (ADR-0114 S2b, VN-D36), and it must never
// authorize a disclosure or any access happening now: a revoked consent would still allow. The seam is opaque to the type checker (callers
// reach it through a local structural port), so this pins the ONE source file that passes it; a second caller fails here and has to be argued.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..");
/** The one module that reads a consent as it was: the visit-note draft's advance directive acknowledgment (M8). */
const PERMITTED_CALLERS = ["apps/backend/src/modules/08-encounters/drafting/default-ports.ts"];
/** Where the flag is defined and honoured (the evaluator and its contract), not a caller. */
const DEFINITION = "packages/consent/src/seams/consent-evaluator.ts";
const SKIPPED_DIRS = new Set(["node_modules", "dist", "__tests__", ".turbo", "coverage"]);

function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFilesUnder(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** The file's code with block and line comments removed (a doc comment that names the flag is not a caller). */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function filesPassingHistorical(): string[] {
  const roots = [join(REPO_ROOT, "apps"), join(REPO_ROOT, "packages")];
  const found: string[] = [];
  for (const root of roots) {
    for (const file of sourceFilesUnder(root)) {
      const rel = relative(REPO_ROOT, file);
      if (rel === DEFINITION) continue;
      const code = withoutComments(readFileSync(file, "utf8"));
      if (/\bhistorical\s*:\s*(true|boolean)\b/.test(code)) found.push(rel);
    }
  }
  return found.sort();
}

describe("the consent evaluator's `historical` flag", () => {
  it("is passed by the visit-note draft's advance directive read and by no other source file", () => {
    expect(filesPassingHistorical()).toEqual(PERMITTED_CALLERS);
  });

  it("is still defined and honoured by the evaluator (the scan would pass vacuously if the flag were renamed)", () => {
    const definition = readFileSync(join(REPO_ROOT, DEFINITION), "utf8");
    expect(definition).toMatch(/historical\?:\s*boolean/);
    expect(definition).toMatch(/args\.historical === true/);
  });
});
