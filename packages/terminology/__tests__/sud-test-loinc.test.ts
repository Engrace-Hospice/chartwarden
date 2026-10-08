// GAP-086 — the `sud_test_loinc` seed: content, hygiene, and parity with migration 0500.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PLATFORM_VALUE_SETS,
  PLATFORM_VALUE_SET_MEMBERS,
  SUD_TEST_LOINC_ENTRIES,
  SUD_TEST_LOINC_VALUE_SET_ID,
  createInMemoryTerminologyStore,
  createTerminologyProvider,
  toInMemorySeed,
} from "../src";

const MIGRATION = resolve(
  __dirname,
  "../../db/migrations/0500_terminology_sud_test_loinc_value_set.sql",
);
const LOINC_NUM = /^\d{1,7}-\d$/;

/** Codes that MUST be in the set, with the LOINC long-common-name fragment each was verified against. */
const EXPECTED: ReadonlyArray<readonly [code: string, nameFragment: string]> = [
  ["3426-4", "Tetrahydrocannabinol [Presence] in Urine"],
  ["8222-2", "Opiates [Presence] in Urine by SAMHSA screen method"],
  ["8152-1", "Amphetamines [Presence] in Urine by SAMHSA screen method"],
  ["8238-8", "Phencyclidine [Presence] in Urine by SAMHSA screen method"],
  ["14267-9", "Methylenedioxymethamphetamine [Presence] in Urine"],
  ["94117-9", "Benzodiazepines panel"],
  ["69739-1", "Drugs of abuse panel - Urine by Screen method"],
  ["24349-3", "Drugs of abuse 5 panel - Urine"],
  ["87428-9", "Drugs of abuse screen W Reflex confirm panel - Urine"],
  ["55419-6", "Home drug screening panel - Urine"],
  ["93705-2", "Ethyl sulfate and Ethyl glucuronide panel - Urine"],
  ["67822-7", "fentaNYL and Norfentanyl panel - Urine"],
  ["76660-0", "Phosphatidylethanol [Presence] in Blood by Screen method"],
  ["12554-2", "Narcotics [Identifier] in Urine"],
  ["12286-1", "Drugs identified in Urine by Screen method Nominal"],
];

/** Analyte components that must each be represented by at least one code. */
const REQUIRED_COMPONENTS = [
  "Amphetamines",
  "Methamphetamine",
  "Barbiturates",
  "Benzodiazepines",
  "Cannabinoids",
  "Tetrahydrocannabinol",
  "Cocaine",
  "Benzoylecgonine",
  "Opiates",
  "Morphine",
  "Codeine",
  "oxyCODONE",
  "Methadone",
  "Buprenorphine",
  "fentaNYL",
  "Phencyclidine",
  "Methylenedioxymethamphetamine",
  "Ethyl glucuronide",
  "Ethanol",
];

/** Components the specs / this seed deliberately leave out (tobacco is not SUD here). */
const FORBIDDEN_COMPONENT = /^(Cotinine|Nicotine|Trans-3-Hydroxycotinine|Glucose)/;

const codes = SUD_TEST_LOINC_ENTRIES.map(([c]) => c);
const nameOf = new Map(SUD_TEST_LOINC_ENTRIES);

describe("sud_test_loinc seed — content", () => {
  it("is registered as a platform value set whose members are all LOINC", () => {
    const def = PLATFORM_VALUE_SETS.find((v) => v.id === SUD_TEST_LOINC_VALUE_SET_ID);
    expect(def).toBeDefined();
    expect(def?.scope).toBe("platform");
    const members = PLATFORM_VALUE_SET_MEMBERS.filter(
      (m) => m.valueSetId === SUD_TEST_LOINC_VALUE_SET_ID,
    );
    expect(members).toHaveLength(SUD_TEST_LOINC_ENTRIES.length);
    expect(members.every((m) => m.systemId === "loinc")).toBe(true);
  });

  it("matches the slug M29 reads", () => {
    expect(SUD_TEST_LOINC_VALUE_SET_ID).toBe("sud_test_loinc");
  });

  it("contains each expected verified code with its LOINC long common name", () => {
    for (const [code, fragment] of EXPECTED) {
      expect(nameOf.get(code), `missing ${code}`).toContain(fragment);
    }
  });

  it("represents every requested analyte family", () => {
    for (const component of REQUIRED_COMPONENTS) {
      const hit = SUD_TEST_LOINC_ENTRIES.some(([, n]) => n.startsWith(`${component} [`));
      expect(hit, `no code for component ${component}`).toBe(true);
    }
  });

  it("has no duplicate codes, only well-formed LOINC_NUMs, and a non-empty name for each", () => {
    expect(new Set(codes).size).toBe(codes.length);
    for (const [code, name] of SUD_TEST_LOINC_ENTRIES) {
      expect(code).toMatch(LOINC_NUM);
      expect(name.trim().length).toBeGreaterThan(0);
    }
  });

  it("excludes non-SUD analytes (tobacco/glucose) and an unrelated lab code", () => {
    expect(nameOf.has("2345-7")).toBe(false); // Glucose [Mass/volume] in Serum or Plasma
    for (const [, name] of SUD_TEST_LOINC_ENTRIES) {
      expect(name.replace(/^Deprecated /, "")).not.toMatch(FORBIDDEN_COMPONENT);
    }
  });
});

describe("sud_test_loinc seed — provider over the in-memory seed", () => {
  const { store } = createInMemoryTerminologyStore(toInMemorySeed());
  const provider = createTerminologyProvider(store);

  it("classifies a seeded code as a member and a glucose code as a non-member", async () => {
    expect(await provider.isMemberOf(SUD_TEST_LOINC_VALUE_SET_ID, "loinc", "3426-4")).toEqual({
      isMember: true,
      source: "platform",
    });
    expect(await provider.isMemberOf(SUD_TEST_LOINC_VALUE_SET_ID, "loinc", "2345-7")).toEqual({
      isMember: false,
      source: null,
    });
  });
});

describe("sud_test_loinc seed — migration 0500 parity", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const rowRe = /^\s+\('((?:[^']|'')+)', '((?:[^']|'')*)', (true|false)\),?$/gm;
  const rows = [...sql.matchAll(rowRe)].map((m) => ({
    code: m[1] ?? "",
    name: (m[2] ?? "").replace(/''/g, "'"),
    deprecated: m[3] === "true",
  }));

  it("inserts exactly the TS list, code-for-code and name-for-name", () => {
    expect(rows).toHaveLength(SUD_TEST_LOINC_ENTRIES.length);
    const tsOrder = SUD_TEST_LOINC_ENTRIES.map(([c, n]) => `${c}\t${n}`);
    expect(rows.map((r) => `${r.code}\t${r.name}`)).toEqual(tsOrder);
  });

  it("flags deprecated exactly where LOINC marks the name deprecated", () => {
    for (const r of rows) expect(r.deprecated).toBe(r.name.startsWith("Deprecated "));
  });

  it("is idempotent (ON CONFLICT DO NOTHING on both inserts) and DDL-free", () => {
    expect(sql.match(/^ON CONFLICT .* DO NOTHING;/gm)).toHaveLength(2);
    expect(sql).not.toMatch(/\b(CREATE|ALTER|DROP)\s+(TABLE|TYPE|POLICY|INDEX|FUNCTION)\b/i);
  });
});
