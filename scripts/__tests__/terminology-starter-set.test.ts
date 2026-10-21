// Ratchet for the local terminology starter set (`db:seed:terminology`): every ICD-10-CM / LOINC code a
// demo seed script uses must be in the set, so a picker can find what a seeded chart already carries.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { PLATFORM_CODE_SYSTEMS } from "@chartwarden/terminology";
import { describe, expect, it } from "vitest";
import {
  ICD10CM_STARTER_CODES,
  ICD10CM_STARTER_LICENSE,
  LOINC_STARTER_CODES,
  LOINC_STARTER_LICENSE,
  loincCheckDigitOk,
} from "../db/lib/terminology-starter-set";

const DB_DIR = resolve(__dirname, "../db");
const ICD_RE = /\b[A-TV-Z][0-9][0-9AB]\.[0-9A-Z]{1,4}\b/g;
// A LOINC code is only recognised next to the LOINC system URI (race/ethnicity codes look the same).
const LOINC_RE = /loinc\.org["'],?\s*code:\s*["'](\d{1,7}-\d)["']/g;
// Files that talk ABOUT ICD codes (parser docs, the set itself) rather than seeding with them.
const SKIP = new Set([
  "load-icd10cm.ts",
  "lib/icd10cm-release.ts",
  "lib/terminology-starter-set.ts",
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(join(dir, e.name))
      : e.name.endsWith(".ts") && !SKIP.has(relative(DB_DIR, join(dir, e.name)))
        ? [join(dir, e.name)]
        : [],
  );
}

function usedCodes(re: RegExp): string[] {
  const out = new Set<string>();
  for (const f of sourceFiles(DB_DIR))
    for (const m of readFileSync(f, "utf8").matchAll(re)) out.add(m[1] ?? m[0]);
  return [...out];
}

const icdCodes = ICD10CM_STARTER_CODES.map((c) => c.code);
const loincCodes = LOINC_STARTER_CODES.map((c) => c.code);

describe("terminology starter set", () => {
  it("covers every ICD-10-CM code the seed scripts use", () => {
    const used = usedCodes(ICD_RE);
    expect(used.length).toBeGreaterThan(5);
    expect(used.filter((c) => !icdCodes.includes(c))).toEqual([]);
  });

  it("covers every LOINC code the seed scripts use", () => {
    const used = usedCodes(LOINC_RE);
    expect(used).toEqual(expect.arrayContaining(["24323-8", "24320-4"]));
    expect(used.filter((c) => !loincCodes.includes(c))).toEqual([]);
  });

  it("uses well-formed, unique codes with a display", () => {
    expect(new Set(icdCodes).size).toBe(icdCodes.length);
    expect(new Set(loincCodes).size).toBe(loincCodes.length);
    for (const c of ICD10CM_STARTER_CODES) {
      expect(c.code).toMatch(/^[A-Z][0-9][0-9AB](\.[0-9A-Z]{1,4})?$/);
      expect(c.display.trim()).not.toBe("");
    }
    for (const c of LOINC_STARTER_CODES) {
      expect(c.code).toMatch(/^\d{1,7}-\d$/);
      expect(c.display.trim()).not.toBe("");
    }
  });

  it("has a valid LOINC mod-10 check digit on every code", () => {
    expect(loincCodes.filter((c) => !loincCheckDigitOk(c))).toEqual([]);
    expect(loincCheckDigitOk("24323-8")).toBe(true);
    expect(loincCheckDigitOk("24323-9")).toBe(false);
  });

  it("labels licences exactly as the platform code-system catalog does", () => {
    const lic = (id: string) => PLATFORM_CODE_SYSTEMS.find((s) => s.id === id)?.licenseSource;
    expect(ICD10CM_STARTER_LICENSE).toBe(lic("icd10cm"));
    expect(LOINC_STARTER_LICENSE).toBe(lic("loinc"));
  });
});
