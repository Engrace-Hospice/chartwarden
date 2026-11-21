// M39's `ConsentEvaluator.evaluate({ historical: true })` answers "was the record in force at that instant", from the row's own end and
// entry instants rather than its status today. It exists to READ what was on file at a past visit (ADR-0114 S2b, VN-D36), and it must never
// authorize a disclosure or any access happening now: a revoked consent would still allow. The seam is opaque to the type checker (callers
// reach it through a local structural port), so this pins the ONE source file that mentions the flag in code outside the evaluator; a second
// file fails here and has to be argued. It looks for every way a flag reaches a call: `historical: x`, shorthand `{ historical }`, a quoted key,
// a forwarded `args.historical` and an optional `historical?:` (a spread is caught where the spread source is typed with the flag).
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

/** Every code form in which the flag is set, forwarded or declared (comments are already stripped). */
const HISTORICAL_USE = /["']?\bhistorical["']?\s*(?::|\?\s*:|,|\})|\.historical\b/;

function mentionsHistoricalFlag(code: string): boolean {
  return HISTORICAL_USE.test(code);
}

function filesPassingHistorical(): string[] {
  // Server code only: the web app, the generated client and docs never evaluate a consent (the UI package holds the generated schema).
  const roots = [join(REPO_ROOT, "apps", "backend", "src"), join(REPO_ROOT, "packages")];
  const found: string[] = [];
  for (const root of roots) {
    for (const file of sourceFilesUnder(root)) {
      const rel = relative(REPO_ROOT, file);
      if (rel === DEFINITION || rel.startsWith(`${join("packages", "ui")}/`)) continue;
      if (mentionsHistoricalFlag(withoutComments(readFileSync(file, "utf8")))) found.push(rel);
    }
  }
  return found.sort();
}

describe("the consent evaluator's `historical` flag", () => {
  it("is passed by the visit-note draft's advance directive read and by no other source file", () => {
    expect(filesPassingHistorical()).toEqual(PERMITTED_CALLERS);
  });

  it.each([
    ["a literal", "evaluate({ historical: true })"],
    ["a variable value", "evaluate({ historical: wanted })"],
    ["shorthand", "evaluate({ historical })"],
    ["shorthand before another key", "evaluate({ historical, asOf })"],
    ["a quoted key", 'evaluate({ "historical": true })'],
    ["a forwarded request field", "evaluate({ historical: body.historical })"],
    ["a forwarded field alone", "const h = args.historical;"],
    ["an optional declaration", "readonly historical?: boolean;"],
  ])("the matcher sees %s", (_label, code) => {
    expect(mentionsHistoricalFlag(code)).toBe(true);
  });

  it("the matcher ignores prose and unrelated words", () => {
    expect(mentionsHistoricalFlag('const label = "historical data";')).toBe(false);
    expect(mentionsHistoricalFlag("const historicalVisits = [];")).toBe(false);
  });

  it("is still defined and honoured by the evaluator (the scan would pass vacuously if the flag were renamed)", () => {
    const definition = readFileSync(join(REPO_ROOT, DEFINITION), "utf8");
    expect(definition).toMatch(/historical\?:\s*boolean/);
    expect(definition).toMatch(/args\.historical === true/);
  });
});
