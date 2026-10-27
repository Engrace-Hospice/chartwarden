import {
  WORKSHEET_CODES,
  WORKSHEET_SCHEMAS,
  emptyWorksheetData,
  resolveWorksheetSchema,
} from "@chartwarden/cost-report";
import { Value } from "@sinclair/typebox/value";
// @chartwarden/cost-report — M27 worksheet-schema registry/resolver pure-domain unit tests (§4.2 / D3).
//
// Covers the previously-untested `worksheets/` surface the §4.2 service layer (and the ECR writer) depend
// on: the `WORKSHEET_SCHEMAS` registry is exhaustive over the 17 `WORKSHEET_CODES`; `resolveWorksheetSchema`
// is total and returns a TypeBox schema for every code; `emptyWorksheetData` produces a payload that VALIDATES
// against its own code's schema (the §2.2 lazy-create default) and is deterministic. PURE DOMAIN only — no
// DB, no Fastify, no network. No PHI (D18).
import { describe, expect, it } from "vitest";

describe("WORKSHEET_CODES + registry exhaustiveness (§4.2 / D3)", () => {
  it("declares exactly the 17 CMS-1984-14 worksheet codes", () => {
    expect(WORKSHEET_CODES).toHaveLength(17);
    // No duplicates.
    expect(new Set(WORKSHEET_CODES).size).toBe(17);
  });

  it("WORKSHEET_SCHEMAS registers a schema for every code (registry is exhaustive)", () => {
    for (const code of WORKSHEET_CODES) {
      expect(code in WORKSHEET_SCHEMAS).toBe(true);
      expect(WORKSHEET_SCHEMAS[code]).toBeDefined();
    }
    // And carries no extra keys beyond the 21 codes.
    expect(Object.keys(WORKSHEET_SCHEMAS).sort()).toEqual([...WORKSHEET_CODES].sort());
  });
});

describe("resolveWorksheetSchema is total over the code union", () => {
  it("returns the registered schema object for each code", () => {
    for (const code of WORKSHEET_CODES) {
      expect(resolveWorksheetSchema(code)).toBe(WORKSHEET_SCHEMAS[code]);
    }
  });
});

describe("emptyWorksheetData (§2.2 lazy-create default)", () => {
  it("produces a payload that validates against its own code's schema, for all 17 codes", () => {
    for (const code of WORKSHEET_CODES) {
      const data = emptyWorksheetData(code);
      const schema = resolveWorksheetSchema(code);
      expect(Value.Check(schema, data)).toBe(true);
    }
  });

  it("is deterministic — the same code yields a structurally-equal default each call", () => {
    for (const code of WORKSHEET_CODES) {
      expect(emptyWorksheetData(code)).toEqual(emptyWorksheetData(code));
    }
  });
});
