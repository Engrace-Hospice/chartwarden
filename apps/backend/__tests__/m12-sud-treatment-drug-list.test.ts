// GAP-036 follow-up — the SUD-treatment drug list has ONE home (`@chartwarden/dosespot`), and the 0340 backfill
// migration's SQL list is derived from it. This test is the drift guard: edit the TS list without the SQL
// (or vice versa) and it fails. No database: the migration file is read as text.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SUD_TREATMENT_DRUG_NAMES, isSudTreatmentDrug } from "@chartwarden/dosespot";
import { describe, expect, it } from "vitest";
import { isSudTreatmentDrug as gatesIsSudTreatmentDrug } from "../src/modules/12-dosespot/medication-order-safety-gates";

const MIGRATION = resolve(
  __dirname,
  "../../../packages/db/migrations/0340_m12_medication_order_sud_backfill.sql",
);
const sqlWithComments = readFileSync(MIGRATION, "utf8");
/** Executable SQL only — the header prose mentions UPDATE / false -> true. */
const sql = sqlWithComments
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

/** Every `drug_name ~* '\m(a|b|c)\M'` alternation in the migration, in order of appearance. */
const sqlLists = [...sql.matchAll(/~\*\s*'\\m\(([a-z|]+)\)\\M'/g)].map((m) => m[1]!.split("|"));

describe("SUD-treatment drug list — single source of truth", () => {
  it("is the spec §6 Part 2 table: MAT, AUD and tobacco-UD pharmacotherapy", () => {
    expect([...SUD_TREATMENT_DRUG_NAMES].sort()).toEqual(
      [
        "acamprosate",
        "buprenorphine",
        "disulfiram",
        "lofexidine",
        "methadone",
        "naltrexone",
        "varenicline",
      ].sort(),
    );
  });

  it("is the very predicate M12 uses (no second copy in the module)", () => {
    expect(gatesIsSudTreatmentDrug).toBe(isSudTreatmentDrug);
  });

  it("matches whole words, case-insensitively, through salt and strength decoration", () => {
    expect(isSudTreatmentDrug("NALTREXONE HCl 50 mg")).toBe(true);
    expect(isSudTreatmentDrug("buprenorphine/naloxone 8-2 mg")).toBe(true);
    expect(isSudTreatmentDrug("Morphine")).toBe(false);
    expect(isSudTreatmentDrug("")).toBe(false);
  });

  it("is mirrored exactly by every list in the 0340 backfill migration", () => {
    expect(sqlLists.length).toBeGreaterThan(0);
    for (const list of sqlLists) {
      expect([...list].sort()).toEqual([...SUD_TREATMENT_DRUG_NAMES].sort());
    }
  });
});

describe("0340 backfill migration — shape", () => {
  it("only ever sets the flag to true (forward-only, never clears a flag a prescriber-side write set)", () => {
    expect(sql).toMatch(/SET\s+is_sud_treatment\s*=\s*true/i);
    expect(sql).not.toMatch(/is_sud_treatment\s*=\s*false\s*,/i);
    expect(sql).not.toMatch(/\bDELETE\b|\bDROP\b|\bTRUNCATE\b/i);
  });

  it("is idempotent: every UPDATE filters on the flag still being false", () => {
    const updates = sql.match(/\bUPDATE\b[\s\S]*?;/gi) ?? [];
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) expect(u).toMatch(/is_sud_treatment\s*=\s*false/i);
  });
});
