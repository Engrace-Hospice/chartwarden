// packages/hearthnote/__tests__/templates-draft-wiring.test.ts — VN-D15: phrase categories for the RN routine
// visit's uncategorized sections (`chief_concern`, `vitals_review`, `plan`), and nothing else changing.
import { ENCOUNTER_DISCIPLINE_RULES, type EncounterType } from "@chartwarden/types";
import { entriesFor } from "@chartwarden/narrative-vocab";
import { describe, expect, it } from "vitest";
import { TEMPLATES, resolveTemplate } from "../src/index";

/** The `allowedCategories` every catalog section carried before S1 PR B (undefined = uncategorized). */
const LEGACY_CATEGORIES: Readonly<Record<string, readonly string[] | undefined>> = {
  chief_concern: undefined,
  vitals_review: undefined,
  assessment: ["observation"],
  symptom_management: ["symptom_impact"],
  interventions: ["care_plan_element"],
  plan: undefined,
  adl: ["adl"],
  psychosocial: ["psychosocial"],
  family_dynamics: undefined,
  spiritual: ["spiritual"],
  med_reconciliation: ["care_plan_element"],
  advance_directive: undefined,
  caregiver_overview: undefined,
  baseline_symptoms: ["symptom_impact"],
  pps: undefined,
  esas: undefined,
  prognosis: undefined,
  recert_summary: undefined,
  f2f_attestation: ["attestation"],
  idg_followup: undefined,
};

const ROUTINE_RN = "routine_visit:rn";

describe("RN routine visit category wiring", () => {
  const sectionById = (id: string) =>
    resolveTemplate("routine_visit", "rn")?.sections.find((s) => s.id === id);

  it("gives chief_concern, vitals_review and plan their categories", () => {
    expect(sectionById("chief_concern")?.allowedCategories).toEqual(["chief_concern"]);
    expect(sectionById("vitals_review")?.allowedCategories).toEqual(["vitals_review"]);
    expect(sectionById("plan")?.allowedCategories).toEqual(["plan", "care_plan_element"]);
  });

  it("leaves the three already-categorized sections as they were", () => {
    expect(sectionById("assessment")?.allowedCategories).toEqual(["observation"]);
    expect(sectionById("symptom_management")?.allowedCategories).toEqual(["symptom_impact"]);
    expect(sectionById("interventions")?.allowedCategories).toEqual(["care_plan_element"]);
  });

  it("keeps the section order, headings and required flags", () => {
    const sections = resolveTemplate("routine_visit", "rn")?.sections ?? [];
    expect(sections.map((s) => [s.id, s.heading, s.required])).toEqual([
      ["chief_concern", "Reason for Visit", true],
      ["vitals_review", "Vital Signs Review", true],
      ["assessment", "Assessment", true],
      ["symptom_management", "Symptom Management", false],
      ["interventions", "Interventions", false],
      ["plan", "Plan and Next Visit", true],
    ]);
  });

  it("every wired section has at least one menu entry for the RN routine visit", () => {
    const eligible = entriesFor("routine_visit", "rn");
    for (const id of ["chief_concern", "vitals_review", "plan"]) {
      const allowed = sectionById(id)?.allowedCategories ?? [];
      expect(eligible.some((e) => allowed.includes(e.category)), id).toBe(true);
    }
  });
});

describe("every other template is unchanged", () => {
  it("keeps the pre-S1 allowedCategories on each section of each other template", () => {
    for (const type of Object.keys(ENCOUNTER_DISCIPLINE_RULES) as EncounterType[]) {
      for (const discipline of ENCOUNTER_DISCIPLINE_RULES[type]) {
        const key = `${type}:${discipline}`;
        if (key === ROUTINE_RN) continue;
        for (const section of TEMPLATES.get(key)?.sections ?? []) {
          expect(section.allowedCategories, `${key}/${section.id}`).toEqual(
            LEGACY_CATEGORIES[section.id],
          );
        }
      }
    }
  });
});
