// packages/hope/__tests__/assessment-input.test.ts — F-057. The `hope_assessment.data` → validator-input
// projection: the bridge whose absence is why the CMS rule engine had no caller. These are the shape
// decisions the payload contract rests on, pinned so a later edit has to mean them.
import { describe, expect, it } from "vitest";
import {
  presentSectionsOf,
  projectHopeSections,
  sectionIOf,
  sectionJOf,
  sectionNOf,
} from "../src/validation/assessment-input";

describe("presentSectionsOf", () => {
  it("returns recognised section letters in the canonical A→Z roster order, not key order", () => {
    expect(presentSectionsOf({ Z: { a: 1 }, J: { a: 1 }, A: { a: 1 } })).toEqual(["A", "J", "Z"]);
  });

  it("treats an EMPTY section as absent — an opened tab is not a completed section", () => {
    expect(presentSectionsOf({ A: {}, B: [], C: "", D: null, E: false })).toEqual([]);
  });

  it("counts a section documented with a scalar, a non-empty array, or `true`", () => {
    expect(presentSectionsOf({ A: "done", B: [1], C: true })).toEqual(["A", "B", "C"]);
  });

  it("ignores keys that are not CMS-used section letters instead of rejecting them", () => {
    // L/P/R/S/T/U/V/W/Y are not part of the HOPE instrument; client scratch keys are not either.
    expect(presentSectionsOf({ A: { x: 1 }, L: { x: 1 }, _draftId: "abc" })).toEqual(["A"]);
  });

  it("is total over a malformed payload — null, a string, an array all read as no sections", () => {
    expect(presentSectionsOf(null)).toEqual([]);
    expect(presentSectionsOf("A")).toEqual([]);
    expect(presentSectionsOf([{ A: 1 }])).toEqual([]);
  });
});

describe("sectionIOf", () => {
  it("reads the platform-wide `primaryDiagnosisIcd10` spelling and trims it", () => {
    expect(sectionIOf({ I: { primaryDiagnosisIcd10: "  C34.90 " } }).primaryDiagnosisIcd10).toBe(
      "C34.90",
    );
  });

  it("reads a blank or absent diagnosis as null, so the value-set rule has nothing to check", () => {
    expect(sectionIOf({ I: { primaryDiagnosisIcd10: "   " } }).primaryDiagnosisIcd10).toBeNull();
    expect(sectionIOf({ I: {} }).primaryDiagnosisIcd10).toBeNull();
    expect(sectionIOf({}).primaryDiagnosisIcd10).toBeNull();
  });
});

describe("sectionJOf", () => {
  it("accepts the three spellings a Yes/No item realistically carries", () => {
    for (const yes of [true, "yes", "Yes", "y", "1"]) {
      expect(sectionJOf({ J: { J2030: { screened: yes } } }).painScreenedYes).toBe(true);
    }
    for (const no of [false, "no", "", undefined, 0]) {
      expect(sectionJOf({ J: { J2030: { screened: no } } }).painScreenedYes).toBe(false);
    }
  });

  it("reads an EMPTY characteristics container as not documented — the half-filled-form case", () => {
    expect(
      sectionJOf({ J: { J2050: { screened: "yes", characteristics: {} } } })
        .dyspneaCharacteristicsPresent,
    ).toBe(false);
    expect(
      sectionJOf({ J: { J2050: { screened: "yes", characteristics: ["persistent"] } } })
        .dyspneaCharacteristicsPresent,
    ).toBe(true);
  });

  it("draws jCodes from the Section-J ITEM identifiers, not the J2051 symptom answers (F-059)", () => {
    const j = sectionJOf({
      J: {
        J2030: { screened: "yes", characteristics: "burning" },
        J2050: { screened: "no" },
        J2051: { entries: [{ symptomCode: "pain", severity: "severe" }] },
      },
    });
    // The instrument's QUESTIONS. `pain` is an answer drawn from a ChartWarden-internal vocabulary that
    // M10's route boundary already closes; re-checking it against a terminology service would be a
    // weaker asynchronous copy of a synchronous absolute check, incapable of failing.
    expect(j.jCodes).toEqual(["J2030", "J2050", "J2051"]);
    expect(j.jCodes).not.toContain("pain");
  });

  it("reports an UNRECOGNISED J item, which is what the §86 value-set rule exists to catch", () => {
    // A transposed item number — you transpose the digits of J2050, not the letters of a symptom name.
    expect(sectionJOf({ J: { J2005: { screened: "no" } } }).jCodes).toEqual(["J2005"]);
  });

  it("ignores non-item keys and EMPTY items — an opened item is not a recorded one", () => {
    const j = sectionJOf({ J: { J2030: { screened: "no" }, J2050: {}, notes: "free text" } });
    expect(j.jCodes).toEqual(["J2030"]);
  });

  it("survives a J2051 payload that is not an array", () => {
    expect(sectionJOf({ J: { J2051: { entries: "pain" } } }).jCodes).toEqual(["J2051"]);
  });
});

describe("sectionNOf", () => {
  it("reads the opioid / bowel-regimen triple", () => {
    expect(sectionNOf({ N: { opioidPrescribed: true, scheduledBowelRegimen: "yes" } })).toEqual({
      opioidPrescribed: true,
      scheduledBowelRegimenPresent: true,
      bowelRegimenContraindicationDocumented: false,
    });
  });

  it("counts a written contraindication as documented and a blank one as not", () => {
    expect(
      sectionNOf({ N: { bowelRegimenContraindication: "obstruction" } })
        .bowelRegimenContraindicationDocumented,
    ).toBe(true);
    expect(
      sectionNOf({ N: { bowelRegimenContraindication: "  " } })
        .bowelRegimenContraindicationDocumented,
    ).toBe(false);
  });
});

describe("projectHopeSections", () => {
  it("never throws on an arbitrary payload — a report is not worth a 500", () => {
    for (const payload of [undefined, null, 0, "x", [], { J: 5 }, { I: [] }]) {
      expect(() => projectHopeSections(payload)).not.toThrow();
    }
  });
});
