// packages/hearthnote/__tests__/templates-draft-wiring.test.ts — VN-D15: phrase categories for the RN routine
// visit's uncategorized sections (`chief_concern`, `vitals_review`, `plan`), and nothing else changing.

import { entriesFor } from "@chartwarden/narrative-vocab";
import { ENCOUNTER_DISCIPLINE_RULES, type EncounterType } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { TEMPLATES, resolveTemplate } from "../src/index";

/**
 * The `allowedCategories` every catalog section carries without draft wording: what it carried before S1 PR B, with the
 * WF09 declarations on top (Reason for Visit offers the visit reasons, a prose section declares `[]`).
 */
const LEGACY_CATEGORIES: Readonly<Record<string, readonly string[] | undefined>> = {
  chief_concern: ["visit_reason"],
  vitals_review: [],
  assessment: ["observation"],
  symptom_management: ["symptom_impact"],
  interventions: ["care_plan_element"],
  plan: [],
  functional_status: [],
  nutrition: [],
  skin_wounds: [],
  adl: ["adl"],
  psychosocial: ["psychosocial"],
  family_dynamics: [],
  spiritual: ["spiritual"],
  med_reconciliation: ["care_plan_element"],
  advance_directive: [],
  caregiver_overview: [],
  baseline_symptoms: ["symptom_impact"],
  pps: [],
  esas: [],
  prognosis: [],
  recert_summary: [],
  f2f_attestation: ["attestation"],
  idg_followup: [],
};

const ROUTINE_RN = "routine_visit:rn";

describe("RN routine visit category wiring", () => {
  const sectionById = (id: string) =>
    resolveTemplate("routine_visit", "rn")?.sections.find((s) => s.id === id);

  it("gives chief_concern, vitals_review and plan their categories (chief_concern keeps the visit reasons)", () => {
    expect(sectionById("chief_concern")?.allowedCategories).toEqual([
      "visit_reason",
      "chief_concern",
    ]);
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
      ["functional_status", "Functional Status", false],
      ["nutrition", "Nutrition and Hydration", false],
      ["skin_wounds", "Skin and Wounds", false],
      ["symptom_management", "Symptom Management", false],
      ["interventions", "Interventions", false],
      ["plan", "Plan and Next Visit", true],
    ]);
  });

  it("every wired section has at least one menu entry for the RN routine visit", () => {
    const eligible = entriesFor("routine_visit", "rn");
    for (const id of ["chief_concern", "vitals_review", "plan"]) {
      const allowed = sectionById(id)?.allowedCategories ?? [];
      expect(
        eligible.some((e) => allowed.includes(e.category)),
        id,
      ).toBe(true);
    }
  });
});

describe("a template resolved without draft wording", () => {
  it("is the RN routine visit exactly as it was before S1 PR B: every section's pre-S1 categories", () => {
    const template = resolveTemplate("routine_visit", "rn", { draftWording: false });
    expect(template?.sections.map((s) => [s.id, s.allowedCategories])).toEqual(
      resolveTemplate("routine_visit", "rn")?.sections.map((s) => [s.id, LEGACY_CATEGORIES[s.id]]),
    );
  });

  it("keeps the section order, headings and required flags of the wired template", () => {
    const plain = resolveTemplate("routine_visit", "rn", { draftWording: false });
    const wired = resolveTemplate("routine_visit", "rn");
    expect(plain?.sections.map((s) => [s.id, s.heading, s.required])).toEqual(
      wired?.sections.map((s) => [s.id, s.heading, s.required]),
    );
  });

  it("is the same template as the default for every other pair", () => {
    for (const type of Object.keys(ENCOUNTER_DISCIPLINE_RULES) as EncounterType[]) {
      for (const discipline of ENCOUNTER_DISCIPLINE_RULES[type]) {
        if (`${type}:${discipline}` === ROUTINE_RN) continue;
        expect(resolveTemplate(type, discipline, { draftWording: false })).toEqual(
          resolveTemplate(type, discipline),
        );
      }
    }
  });

  it("is still wired when draftWording is true or unsaid", () => {
    expect(
      resolveTemplate("routine_visit", "rn", { draftWording: true })?.sections[0]
        ?.allowedCategories,
    ).toEqual(["visit_reason", "chief_concern"]);
    expect(resolveTemplate("routine_visit", "rn")?.sections[0]?.allowedCategories).toEqual([
      "visit_reason",
      "chief_concern",
    ]);
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
