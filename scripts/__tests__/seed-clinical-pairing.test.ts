// db:seed:clinical pairs its DETAIL and ADDR rows with the demo patients by last-name order, so a patient
// added out of that order silently mis-pairs every row after it (and the seed cannot import: it runs on load).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PATIENTS } from "../db/seed-patients";

const source = readFileSync(new URL("../db/seed-clinical.ts", import.meta.url), "utf8");
const block = (start: string): string => {
  const from = source.indexOf(start);
  return source.slice(from, source.indexOf("\n];", from));
};
const byLastName = [...PATIENTS].sort((a, b) => a.lastName.localeCompare(b.lastName));

describe("db:seed:clinical row pairing", () => {
  it("has one DETAIL row per demo patient", () => {
    expect([...block("const DETAIL = [").matchAll(/\n {4}gi: /g)]).toHaveLength(PATIENTS.length);
  });

  it("lists ADDR in the patients' last-name order, with the address db:seed:patients admits", () => {
    const addressLines = [...block("const ADDR = [").matchAll(/line1: "([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(addressLines).toEqual(byLastName.map((p) => p.primaryAddress.line1));
  });
});
