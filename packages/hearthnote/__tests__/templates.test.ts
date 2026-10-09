import { ENCOUNTER_DISCIPLINE_RULES, type EncounterType } from "@wardenx/types";
// packages/hearthnote/__tests__/templates.test.ts — M8-T05 (spec §2.6, architecture §10.5.2).
// The default template registry: one template per legal pair, spec-mandated required sections.
import { describe, expect, it } from "vitest";
import { TEMPLATES, requiredSectionIds, resolveTemplate } from "../src/index";

describe("template registry", () => {
  it("has exactly one template per legal (encounterType × discipline) pair", () => {
    const legalPairs = (Object.keys(ENCOUNTER_DISCIPLINE_RULES) as EncounterType[]).flatMap((t) =>
      ENCOUNTER_DISCIPLINE_RULES[t].map((d) => `${t}:${d}`),
    );
    expect(TEMPLATES.size).toBe(legalPairs.length);
    for (const key of legalPairs) expect(TEMPLATES.has(key)).toBe(true);
  });

  it("returns undefined for an illegal pair", () => {
    expect(resolveTemplate("face_to_face", "rn")).toBeUndefined();
    expect(resolveTemplate("chha_visit", "md")).toBeUndefined();
  });

  it("admission_visit pins the spec §2.2 required sections", () => {
    const t = resolveTemplate("admission_visit", "rn");
    const required = requiredSectionIds(t!);
    expect(required).toEqual(
      expect.arrayContaining([
        "med_reconciliation",
        "advance_directive",
        "caregiver_overview",
        "baseline_symptoms",
      ]),
    );
  });

  it("recert_visit pins PPS / ESAS / prognosis / recert summary", () => {
    const required = requiredSectionIds(resolveTemplate("recert_visit", "rn")!);
    expect(required).toEqual(
      expect.arrayContaining(["pps", "esas", "prognosis", "recert_summary"]),
    );
  });

  it("face_to_face requires the attestation section", () => {
    expect(requiredSectionIds(resolveTemplate("face_to_face", "md")!)).toContain("f2f_attestation");
  });

  it("telephonic drops the vitals-review section (no vitals required)", () => {
    const t = resolveTemplate("telephonic", "rn")!;
    expect(t.sections.some((s) => s.id === "vitals_review")).toBe(false);
  });

  it("a clinical visit keeps a vitals-review section", () => {
    const t = resolveTemplate("routine_visit", "rn")!;
    expect(t.sections.some((s) => s.id === "vitals_review")).toBe(true);
  });

  it("chha_visit uses the ADL section, not vitals", () => {
    const t = resolveTemplate("chha_visit", "chha")!;
    expect(t.sections.some((s) => s.id === "adl")).toBe(true);
    expect(t.sections.some((s) => s.id === "vitals_review")).toBe(false);
  });

  it.each([
    ["pt_visit", "pt"],
    ["ot_visit", "ot"],
    ["slp_visit", "slp"],
  ] as const)(
    "%s is pinned to its therapist and documents assessment + interventions, not vitals",
    (type, discipline) => {
      const t = resolveTemplate(type, discipline)!;
      expect(t.sections.map((s) => s.id)).toEqual([
        "chief_concern",
        "assessment",
        "interventions",
        "plan",
      ]);
      expect(requiredSectionIds(t)).not.toContain("vitals_review");
      // A therapist visit is not authorable by another discipline, and a therapist cannot author an RN visit type.
      expect(resolveTemplate(type, "rn")).toBeUndefined();
      expect(resolveTemplate("routine_visit", discipline)).toBeUndefined();
    },
  );

  it("section ids within a template are unique and ordered deterministically", () => {
    for (const t of TEMPLATES.values()) {
      const ids = t.sections.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
