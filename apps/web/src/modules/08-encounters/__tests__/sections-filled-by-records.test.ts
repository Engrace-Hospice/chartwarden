// Which template sections a SAVED recorded finding (ADLs, nutrition, a wound assessed at this visit) documents in the composer: the
// section that states the record is documented by it, and a section no record states is not. Synthetic template only.
import { describe, expect, it } from "vitest";
import { type TemplateView, sectionsFilledByRecords } from "../encounters-api";

const section = (sectionId: string, recordedPanel: "adl" | "nutrition" | "wounds" | null) => ({
  sectionId,
  heading: sectionId,
  required: false,
  allowedCategories: [],
  entries: [],
  recordedPanel,
});

const template = {
  encounterId: "enc-1",
  templateKey: "routine_visit:rn",
  vocabVersion: "2026.1.0",
  encounterType: "routine_visit",
  discipline: "rn",
  sections: [
    section("assessment", null),
    section("functional_status", "adl"),
    section("nutrition", "nutrition"),
    section("skin_wounds", "wounds"),
  ],
} as unknown as TemplateView;

const none = { adl: false, nutrition: false, wounds: false };

describe("sectionsFilledByRecords", () => {
  it("counts nothing when no record is saved", () => {
    expect([...sectionsFilledByRecords(template, none)]).toEqual([]);
  });

  it("counts the wound section when a wound is recorded at this visit, and only that section", () => {
    expect([...sectionsFilledByRecords(template, { ...none, wounds: true })]).toEqual([
      "skin_wounds",
    ]);
  });

  it("counts each recorded panel independently of the others", () => {
    expect([...sectionsFilledByRecords(template, { ...none, adl: true })]).toEqual([
      "functional_status",
    ]);
    expect([...sectionsFilledByRecords(template, { ...none, nutrition: true })]).toEqual([
      "nutrition",
    ]);
    expect(
      [...sectionsFilledByRecords(template, { adl: true, nutrition: true, wounds: true })].sort(),
    ).toEqual(["functional_status", "nutrition", "skin_wounds"]);
  });

  it("counts nothing for a wound record when the template has no wound section (telephonic, therapy, social work)", () => {
    const withoutWounds = {
      ...template,
      sections: template.sections.filter((s) => s.sectionId !== "skin_wounds"),
    } as TemplateView;
    expect([...sectionsFilledByRecords(withoutWounds, { ...none, wounds: true })]).toEqual([]);
  });

  it("never counts a plain selection section", () => {
    expect(
      sectionsFilledByRecords(template, { adl: true, nutrition: true, wounds: true }).has(
        "assessment",
      ),
    ).toBe(false);
  });
});
