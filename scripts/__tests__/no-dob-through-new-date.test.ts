/**
 * Guard (finding 8): a DOB is a date-only value. `new Date("1950-03-15")` is a UTC instant, so any
 * local getter/format then shows the day BEFORE in every US zone. Web/UI source must read a
 * `dob` / `dateOfBirth` through `parseLocalDateOnly` / `ageYears` / `formatDateOnly`
 * (`@wardenx/ui`), never `new Date(...)` / `Date.parse(...)`. No allowlist: there is no legitimate use.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "../..");
const ROOTS = ["apps/web/src", "packages/ui/src"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo", "coverage"]);
const SOURCE_EXT = /\.tsx?$/;
const TEST_FILE = /(\.(test|spec)\.[tj]sx?$)|(__tests__)/;
const DATE_CALL = /(?:new\s+Date|Date\.parse)\s*\(/g;
// A dob-ish segment: `dob` not followed by a lowercase letter (so `patientDobAtReceipt` / `dobAtReceipt`
// match but `adobe` does not), or dateOfBirth / birthDate in any casing.
const DOB_SEGMENT = /(?:[Dd]ob|DOB)(?![a-z])|[Dd]ate[Oo]f[Bb]irth|[Bb]irth[Dd]ate/;
// Explicit local parse (`new Date(`${dob}T00:00:00`)`) is the legitimate, zone-safe shape.
const LOCAL_MIDNIGHT = /T00:00:00(?!Z|\.\d*Z|[+-]\d)/;

/** The argument text of each `new Date(...)` / `Date.parse(...)`, scanned to the balanced close paren. */
function* dateCallArgs(src: string): Generator<string> {
  for (const m of src.matchAll(DATE_CALL)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    yield src.slice(start, i - 1);
  }
}

function passesDobThroughDate(src: string): boolean {
  for (const arg of dateCallArgs(src)) {
    if (DOB_SEGMENT.test(arg) && !LOCAL_MIDNIGHT.test(arg)) return true;
  }
  return false;
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (SOURCE_EXT.test(name) && !TEST_FILE.test(full)) yield full;
  }
}

describe("DOB-through-new-Date guard", () => {
  it("has no dob / dateOfBirth passed to new Date or Date.parse", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(join(REPO_ROOT, root))) {
        if (passesDobThroughDate(readFileSync(file, "utf8"))) {
          offenders.push(relative(REPO_ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("flags the shapes it is meant to catch", () => {
    expect(passesDobThroughDate("const d = new Date(dob);")).toBe(true);
    expect(passesDobThroughDate("new Date(patient.dateOfBirth).getTime()")).toBe(true);
    expect(passesDobThroughDate("new Date(\n  p?.dob,\n)")).toBe(true);
    expect(passesDobThroughDate("Date.parse(row.birthDate)")).toBe(true);
    expect(passesDobThroughDate("new Date(patientDobAtReceipt)")).toBe(true);
    expect(passesDobThroughDate("new Date(r.dobAtReceipt)")).toBe(true);
    expect(passesDobThroughDate("new Date(patient.dob.slice(0, 10))")).toBe(true);
    expect(passesDobThroughDate("new Date(`${dob}T00:00:00Z`)")).toBe(true);
    expect(passesDobThroughDate("new Date(value)")).toBe(false);
    expect(passesDobThroughDate("new Date(adobeStamp)")).toBe(false);
    expect(passesDobThroughDate("ageYears(dob)")).toBe(false);
    expect(passesDobThroughDate("new Date(`${dob}T00:00:00`)")).toBe(false);
    expect(passesDobThroughDate("new Date(`${patient.dobAtReceipt}T00:00:00`)")).toBe(false);
  });
});
