// packages/hearthnote/__tests__/templates-draft-wiring.test.ts — VN-D15: phrase categories for the RN routine
// visit's uncategorized sections (`chief_concern`, `vitals_review`, `plan`), and nothing else changing.

import { entriesFor } from "@chartwarden/narrative-vocab";
import { ENCOUNTER_DISCIPLINE_RULES, type EncounterType } from "@chartwarden/types";
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
/** The templates with draft-wording category wiring: S1's RN routine visit, and S2's recertification and face-to-face visits. */
const WIRED = new Set([ROUTINE_RN, "recert_visit:rn", "face_to_face:md", "face_to_face:np"]);

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

  it("is the same template as the default for every unwired pair", () => {
    for (const type of Object.keys(ENCOUNTER_DISCIPLINE_RULES) as EncounterType[]) {
      for (const discipline of ENCOUNTER_DISCIPLINE_RULES[type]) {
        if (WIRED.has(`${type}:${discipline}`)) continue;
        expect(resolveTemplate(type, discipline, { draftWording: false })).toEqual(
          resolveTemplate(type, discipline),
        );
      }
    }
  });

  it("is every wired template as it was before S1 and S2: each section's pre-S1 categories (a switch that is off sees no change)", () => {
    for (const key of WIRED) {
      const [type, discipline] = key.split(":") as [EncounterType, never];
      const plain = resolveTemplate(type, discipline, { draftWording: false });
      for (const section of plain?.sections ?? []) {
        expect(section.allowedCategories, `${key}/${section.id}`).toEqual(
          LEGACY_CATEGORIES[section.id],
        );
      }
    }
  });

  it("is still wired when draftWording is true or unsaid", () => {
    expect(
      resolveTemplate("routine_visit", "rn", { draftWording: true })?.sections[0]
        ?.allowedCategories,
    ).toEqual(["chief_concern"]);
    expect(resolveTemplate("routine_visit", "rn")?.sections[0]?.allowedCategories).toEqual([
      "chief_concern",
    ]);
  });
});

describe("every other template is unchanged", () => {
  it("keeps the pre-S1 allowedCategories on each section of each other template", () => {
    for (const type of Object.keys(ENCOUNTER_DISCIPLINE_RULES) as EncounterType[]) {
      for (const discipline of ENCOUNTER_DISCIPLINE_RULES[type]) {
        const key = `${type}:${discipline}`;
        if (WIRED.has(key)) continue;
        for (const section of TEMPLATES.get(key)?.sections ?? []) {
          expect(section.allowedCategories, `${key}/${section.id}`).toEqual(
            LEGACY_CATEGORIES[section.id],
          );
        }
      }
    }
  });
});

describe("S2 wiring: the recertification and face-to-face visits (design §3.3)", () => {
  const sectionOf = (type: EncounterType, discipline: "rn" | "md" | "np", id: string) =>
    resolveTemplate(type, discipline)?.sections.find((s) => s.id === id);

  it("the recertification's four drafted sections take free text only: an empty menu, never a phrase typed with a reading", () => {
    for (const id of ["pps", "esas", "prognosis", "recert_summary"]) {
      expect(sectionOf("recert_visit", "rn", id)?.allowedCategories, id).toEqual([]);
      const allowed = sectionOf("recert_visit", "rn", id)?.allowedCategories ?? [];
      const menu = entriesFor("recert_visit", "rn").filter((e) => allowed.includes(e.category));
      expect(menu, id).toEqual([]);
    }
  });

  it("the recertification's vitals_review and plan use the routine visit's categories, and its other sections stay as they were", () => {
    expect(sectionOf("recert_visit", "rn", "vitals_review")?.allowedCategories).toEqual([
      "vitals_review",
    ]);
    expect(sectionOf("recert_visit", "rn", "plan")?.allowedCategories).toEqual([
      "plan",
      "care_plan_element",
    ]);
    for (const id of ["chief_concern", "assessment", "symptom_management", "interventions"]) {
      expect(sectionOf("recert_visit", "rn", id)?.allowedCategories, id).toEqual(
        LEGACY_CATEGORIES[id],
      );
    }
  });

  it("the face-to-face prognosis takes free text only for a physician and a nurse practitioner, and its other sections stay as they were", () => {
    for (const discipline of ["md", "np"] as const) {
      expect(sectionOf("face_to_face", discipline, "prognosis")?.allowedCategories).toEqual([]);
      for (const id of ["chief_concern", "med_reconciliation", "f2f_attestation", "plan"]) {
        expect(sectionOf("face_to_face", discipline, id)?.allowedCategories, id).toEqual(
          LEGACY_CATEGORIES[id],
        );
      }
    }
  });
});
