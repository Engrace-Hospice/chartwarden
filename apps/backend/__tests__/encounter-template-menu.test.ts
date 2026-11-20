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
    for (const [type, discipline] of [
      ["routine_visit", "lpn"],
      ["admission_visit", "rn"],
      ["face_to_face", "md"],
      ["telephonic", "rn"],
    ] as const) {
      expect(buildTemplateMenu(type, discipline, { draftWording: true })).toEqual(
        buildTemplateMenu(type, discipline),
      );
    }
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

  it("offers every code the write path accepts in a section it lists (menu and write rules agree)", () => {
    const eligible = new Set(entriesFor("routine_visit", "rn").map((e) => e.code));
    for (const section of menu.sections)
      for (const entry of section.entries) expect(eligible.has(entry.code)).toBe(true);
  });
});
