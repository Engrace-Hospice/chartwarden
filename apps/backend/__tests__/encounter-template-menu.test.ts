// S1 rollout (ADR-0114, design §3.2): the authoring MENU of a tenant with the draft switch off is exactly what it was before the
// 2026.11.0 corpus: none of the unreviewed draft phrases, and the RN routine visit's three formerly uncategorized sections as WF09 left
// them (the visit reasons for the Reason for Visit, no preset statements for the Vital Signs Review and the Plan, which are prose).
// With the switch on, the menu offers the draft wording through the routine visit's wired categories.
import { DRAFT_VOCAB_CODES, entriesFor } from "@chartwarden/narrative-vocab";
import { describe, expect, it } from "vitest";
import { buildTemplateMenu } from "../src/modules/08-encounters/routes/service";

const menuCodes = (
  menu: ReturnType<typeof buildTemplateMenu>,
  sectionId: string,
): readonly string[] =>
  menu.sections.find((s) => s.sectionId === sectionId)?.entries.map((e) => e.code) ?? [];

const PROSE_SECTIONS = ["vitals_review", "plan"] as const;

describe("buildTemplateMenu: draft wording off (the default)", () => {
  const menu = buildTemplateMenu("routine_visit", "rn");

  it("offers none of the unreviewed draft phrases in any section", () => {
    for (const section of menu.sections) {
      for (const entry of section.entries) {
        expect(DRAFT_VOCAB_CODES.has(entry.code), `${section.sectionId}/${entry.code}`).toBe(false);
      }
    }
  });

  it("leaves the three formerly uncategorized sections as WF09 made them: the visit reasons for the reason, prose only for the rest", () => {
    // Not the whole pre-existing catalog (a note's stated reason was once a cardiovascular finding): the draft switch does not undo WF09.
    const reason = menu.sections.find((s) => s.sectionId === "chief_concern");
    expect(reason?.allowedCategories).toEqual(["visit_reason"]);
    expect(menuCodes(menu, "chief_concern").length).toBeGreaterThan(0);
    for (const code of menuCodes(menu, "chief_concern")) expect(code).toMatch(/^nv\.reason\./);
    for (const id of PROSE_SECTIONS) {
      expect(menuCodes(menu, id), id).toEqual([]);
      expect(menu.sections.find((s) => s.sectionId === id)?.allowedCategories, id).toEqual([]);
    }
  });

  it("keeps the three already-categorized sections as they were", () => {
    expect(menu.sections.find((s) => s.sectionId === "assessment")?.allowedCategories).toEqual([
      "observation",
    ]);
    expect(menu.sections.find((s) => s.sectionId === "interventions")?.allowedCategories).toEqual([
      "care_plan_element",
    ]);
  });

  it("is the same menu for every other template whichever way the flag goes", () => {
    // The recertification and face-to-face visits are wired by S2 (below), so they differ with the flag on.
    for (const [type, discipline] of [
      ["routine_visit", "lpn"],
      ["admission_visit", "rn"],
      ["chha_visit", "chha"],
      ["telephonic", "rn"],
    ] as const) {
      expect(buildTemplateMenu(type, discipline, { draftWording: true })).toEqual(
        buildTemplateMenu(type, discipline),
      );
    }
  });
});

// S2 (design §3.3): the recertification visit and the face-to-face visit's prognosis. The draft wording of 2026.11.0 and 2026.12.0 is
// unreviewed, so a tenant with the switch off sees neither; with it on, the sections drafted from structured records take free text only.
const S2_DRAFTED_SECTIONS = {
  recert: ["pps", "esas", "prognosis", "recert_summary"],
  faceToFace: ["prognosis"],
} as const;

describe("buildTemplateMenu: the recertification and face-to-face visits (S2)", () => {
  const recertOff = buildTemplateMenu("recert_visit", "rn");
  const recertOn = buildTemplateMenu("recert_visit", "rn", { draftWording: true });

  it("switch off: none of the draft phrases in any section, and the drafted sections are wired to no category", () => {
    for (const [type, discipline] of [
      ["recert_visit", "rn"],
      ["face_to_face", "md"],
      ["face_to_face", "np"],
    ] as const) {
      const menu = buildTemplateMenu(type, discipline);
      for (const section of menu.sections) {
        for (const entry of section.entries) {
          expect(DRAFT_VOCAB_CODES.has(entry.code), `${type}/${section.sectionId}`).toBe(false);
        }
      }
      const drafted =
        type === "recert_visit" ? S2_DRAFTED_SECTIONS.recert : S2_DRAFTED_SECTIONS.faceToFace;
      for (const id of drafted) {
        expect(menuCodes(menu, id), `${type}/${id}`).toEqual([]);
        expect(menu.sections.find((s) => s.sectionId === id)?.allowedCategories).toEqual([]);
      }
    }
    expect(recertOff.vocabVersion).toBe(recertOn.vocabVersion);
  });

  it("switch on: the recertification's four drafted sections and the face-to-face prognosis have an empty menu, so no reading is typed by hand", () => {
    for (const id of S2_DRAFTED_SECTIONS.recert) expect(menuCodes(recertOn, id), id).toEqual([]);
    for (const discipline of ["md", "np"] as const) {
      const f2f = buildTemplateMenu("face_to_face", discipline, { draftWording: true });
      expect(menuCodes(f2f, "prognosis"), discipline).toEqual([]);
    }
  });

  it("switch on: draft phrases appear only in the sections wired to their category, and chief_concern offers the visit reasons alone", () => {
    expect(menuCodes(recertOn, "vitals_review").some((c) => DRAFT_VOCAB_CODES.has(c))).toBe(true);
    expect(menuCodes(recertOn, "plan").some((c) => DRAFT_VOCAB_CODES.has(c))).toBe(true);
    const wired = new Set(["vitals_review", "plan", "interventions"]);
    for (const section of recertOn.sections) {
      for (const code of menuCodes(recertOn, section.sectionId)) {
        // The phrases that carry a reading, a weight or a date are never in a menu a clinician types into.
        expect(code.startsWith("nv.rc."), `${section.sectionId}/${code}`).toBe(false);
        expect(code.startsWith("nv.scale."), `${section.sectionId}/${code}`).toBe(false);
        if (!wired.has(section.sectionId)) {
          expect(DRAFT_VOCAB_CODES.has(code), `${section.sectionId}/${code}`).toBe(false);
        }
      }
    }
    // chief_concern is not wired for the recertification's draft: it offers the visit reasons and no draft phrase.
    const reasons = menuCodes(recertOn, "chief_concern");
    expect(reasons.length).toBeGreaterThan(0);
    for (const code of reasons) expect(code.startsWith("nv.reason."), code).toBe(true);
  });

  it("switch on: the face-to-face visit's menu is the one it has with the switch off (S2 adds no preset phrase to it)", () => {
    for (const discipline of ["md", "np"] as const) {
      const on = buildTemplateMenu("face_to_face", discipline, { draftWording: true });
      const off = buildTemplateMenu("face_to_face", discipline);
      for (const section of on.sections) {
        expect(menuCodes(on, section.sectionId), `${discipline}/${section.sectionId}`).toEqual(
          menuCodes(off, section.sectionId),
        );
      }
    }
  });

  it("offers a draft phrase only in a section wired to its category: an unwired or free-text-only section offers none", () => {
    for (const section of recertOn.sections)
      for (const entry of section.entries)
        if (DRAFT_VOCAB_CODES.has(entry.code)) {
          expect(section.allowedCategories, section.sectionId).toContain(entry.category);
        }
    // pps, esas, prognosis and recert_summary are wired to no category: nothing in them is a preset phrase of any kind.
    for (const id of ["pps", "esas", "prognosis", "recert_summary"])
      expect(menuCodes(recertOn, id), id).toEqual([]);
  });
});

describe("buildTemplateMenu: draft wording on (the tenant's switch is on)", () => {
  const menu = buildTemplateMenu("routine_visit", "rn", { draftWording: true });

  it("offers the draft phrases through the routine visit's wired categories", () => {
    expect(menuCodes(menu, "chief_concern").some((c) => DRAFT_VOCAB_CODES.has(c))).toBe(true);
    expect(menuCodes(menu, "vitals_review").some((c) => DRAFT_VOCAB_CODES.has(c))).toBe(true);
    expect(menuCodes(menu, "plan").some((c) => DRAFT_VOCAB_CODES.has(c))).toBe(true);
    expect(menuCodes(menu, "interventions").some((c) => DRAFT_VOCAB_CODES.has(c))).toBe(true);
  });

  it("offers a draft phrase only in a section wired to its category", () => {
    for (const section of menu.sections)
      for (const entry of section.entries)
        if (DRAFT_VOCAB_CODES.has(entry.code)) {
          expect(section.allowedCategories, section.sectionId).toContain(entry.category);
        }
  });
});
