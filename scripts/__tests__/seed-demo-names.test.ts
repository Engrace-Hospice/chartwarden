// Demo seed names: no physician shares a name with a patient / COP27 patient / staff persona, and no
// seeded legal name looks like a marker (the DEMO-COP27-NN marker lives in identifiers, not names).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COP27_NAMES } from "../db/cop27/names";
import { PHYSICIANS } from "../db/seed-mdm";
import { PATIENTS } from "../db/seed-patients";

const norm = (s: string): string => s.trim().toLowerCase();

const personaNames = [
  ...readFileSync(new URL("../db/seed-staff-personas.ts", import.meta.url), "utf8").matchAll(
    /^\s+name: "([^"]+)",$/gm,
  ),
].map((m) => m[1] as string);
// "Dr. Sam Harris" / "Rita Alvarez, RN" -> { first, last }
const personas = personaNames.map((n) => {
  const parts = n
    .replace(/^Dr\.\s+/, "")
    .replace(/,.*$/, "")
    .split(/\s+/);
  return { first: norm(parts[0] ?? ""), last: norm(parts[parts.length - 1] ?? "") };
});

const physicians = PHYSICIANS.map((p) => ({ first: norm(p[2]), last: norm(p[3]) }));
const patientLastNames = [
  ...PATIENTS.map((p) => norm(p.lastName)),
  ...Object.values(COP27_NAMES).map(([, last]) => norm(last)),
];

describe("demo seed names", () => {
  it("found the persona names", () => {
    expect(personas.length).toBeGreaterThan(5);
  });

  it("no physician last name equals a patient or COP27 patient last name", () => {
    for (const p of physicians) expect(patientLastNames).not.toContain(p.last);
  });

  it("only the hospice MD shares a name with a staff persona (Sam Harris)", () => {
    const shared = physicians.filter((p) => personas.some((s) => s.last === p.last));
    expect(shared).toEqual([{ first: "samuel", last: "harris" }]);
  });

  it("physician #1 is Samuel Harris, MD", () => {
    expect(PHYSICIANS[0].slice(2, 5)).toEqual(["Samuel", "Harris", "MD"]);
  });

  it("COP27 last names are unique and distinct from the other patients", () => {
    const last = Object.values(COP27_NAMES).map(([, l]) => norm(l));
    expect(new Set(last).size).toBe(last.length);
    for (const p of PATIENTS) expect(last).not.toContain(norm(p.lastName));
  });

  it("no seeded legal name contains DEMO-", () => {
    const names = [
      ...PATIENTS.flatMap((p) => [p.firstName, p.lastName]),
      ...Object.values(COP27_NAMES).flat(),
      ...PHYSICIANS.flatMap((p) => [p[2], p[3]]),
    ];
    for (const n of names) expect(n).not.toMatch(/DEMO-/i);
  });
});
