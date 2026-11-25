// apps/backend/__tests__/encounter-gate-wound-section.test.ts — why the §2.6 gate has no wound term, pinned.
//
// The composer rail counts a wound assessed at this visit as documenting the section that states it (`Skin and Wounds`). The server's
// check 1 counts a recorded ADL or nutrition record the same way (`sectionsPopulatedByFindings`), but not a wound, because no template
// REQUIRES a wound section: check 1 only ever looks at required sections, so a wound can neither satisfy nor miss it. That is an
// invariant of the template registry, not a coincidence, and this file pins it. The day a wound section becomes required, this fails
// and the gate must count the visit's wounds (M9's seam, read before the transaction opens) in the same change: a required section
// the web rail shows as Documented while the server refuses it (or the converse) is the disagreement this guards against.
import { TEMPLATES, resolveTemplate } from "@chartwarden/hearthnote";
import type { EncounterDiscipline, EncounterType } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  type GateSectionSelection,
  runEncounterComplianceGate,
  sectionsPopulatedByFindings,
} from "../src/modules/08-encounters/gate/index";
import { buildTemplateMenu } from "../src/modules/08-encounters/routes/selections";

const ALL_VITALS = new Set([
  "bp",
  "heartRate",
  "respiratoryRate",
  "temperature",
  "spo2",
  "pain",
] as const);
const NONE = new Set<never>();

const woundSections = () =>
  [...TEMPLATES.values()].flatMap((template) =>
    template.sections
      .filter((s) => s.woundSummary === true)
      .map((section) => ({ template, section })),
  );

describe("the gate and the wound-stating section", () => {
  it("has at least one template that states wounds (the invariant below is not vacuous)", () => {
    expect(woundSections().length).toBeGreaterThan(0);
  });

  it("is never REQUIRED in any (type x discipline) template, so check 1 never depends on a recorded wound", () => {
    const required = woundSections()
      .filter(({ section }) => section.required)
      .map(({ template, section }) => `${template.key}/${section.id}`);
    expect(required).toEqual([]);
  });

  it("names the same wound-stating sections the composer shows, as `skin_wounds`, in every clinical-visit template", () => {
    for (const { template, section } of woundSections()) {
      expect(section.id).toBe("skin_wounds");
      expect(["rn", "lpn", "md", "np"]).toContain(template.discipline);
      expect(template.encounterType).not.toBe("telephonic");
    }
  });

  it("lets a routine RN note with no wound and no selection in the wound section pass check 1 for it", () => {
    const verdict = runEncounterComplianceGate({
      encounterType: "routine_visit" as EncounterType,
      discipline: "rn" as EncounterDiscipline,
      sections: (resolveTemplate("routine_visit", "rn")?.sections ?? [])
        .filter((s) => s.required)
        .map((s): GateSectionSelection => ({ sectionId: s.id, entryCount: 1, hasFreeText: false })),
      carePlanOverdue: null,
      vitalsCaptured: ALL_VITALS,
      vitalsClinicallyNotIndicated: NONE,
      scalesPresent: NONE,
    });
    const fields = verdict.pass ? [] : verdict.remediation.map((r) => r.field);
    expect(fields).not.toContain("skin_wounds");
  });

  it("does not block an RN routine visit on an empty Skin and Wounds section: check 1 lists only the sections that really are required", () => {
    const required = (resolveTemplate("routine_visit", "rn")?.sections ?? []).filter(
      (s) => s.required,
    );
    const gateWith = (sections: readonly GateSectionSelection[]) =>
      runEncounterComplianceGate({
        encounterType: "routine_visit" as EncounterType,
        discipline: "rn" as EncounterDiscipline,
        sections,
        carePlanOverdue: null,
        vitalsCaptured: ALL_VITALS,
        vitalsClinicallyNotIndicated: NONE,
        scalesPresent: NONE,
      });
    const missingSections = (verdict: ReturnType<typeof gateWith>) =>
      verdict.pass
        ? []
        : verdict.remediation.filter((r) => r.check === "required_sections").map((r) => r.field);

    // Every required section populated, Skin and Wounds untouched: nothing for check 1 to list.
    const populated = required.map(
      (s): GateSectionSelection => ({ sectionId: s.id, entryCount: 1, hasFreeText: false }),
    );
    expect(missingSections(gateWith(populated))).toEqual([]);
    // A note with nothing in it lists the required sections and never Skin and Wounds.
    expect(missingSections(gateWith([]))).toEqual(required.map((s) => s.id));
  });

  it("states the same requirement in the composer's template view as the gate enforces, for every legal pair", () => {
    for (const template of TEMPLATES.values()) {
      const viewRequired = buildTemplateMenu(template.encounterType, template.discipline)
        .sections.filter((s) => s.required)
        .map((s) => s.sectionId);
      const verdict = runEncounterComplianceGate({
        encounterType: template.encounterType,
        discipline: template.discipline,
        sections: [],
        carePlanOverdue: null,
        vitalsCaptured: ALL_VITALS,
        vitalsClinicallyNotIndicated: NONE,
        scalesPresent: NONE,
      });
      const gateRequires = verdict.pass
        ? []
        : verdict.remediation.filter((r) => r.check === "required_sections").map((r) => r.field);
      expect(viewRequired, template.key).toEqual(gateRequires);
    }
  });

  it("does not turn a recorded ADL or nutrition finding into a wound-section population", () => {
    const populated = sectionsPopulatedByFindings("routine_visit", "rn", {
      adl: { items: { bathing: "limited_assist" } },
      nutrition: { appetite: "good" },
    });
    expect(populated.has("skin_wounds")).toBe(false);
    expect(populated.has("functional_status")).toBe(true);
    expect(populated.has("nutrition")).toBe(true);
  });
});
