import {
  ENCOUNTER_DISCIPLINE_RULES,
  type EncounterDiscipline,
  type EncounterType,
} from "@chartwarden/types";
// packages/hearthnote/__tests__/templates.test.ts — M8-T05 (spec §2.6, architecture §10.5.2).
// The default template registry: one template per legal pair, spec-mandated required sections.
import { describe, expect, it } from "vitest";
import {
  type HearthnoteTemplate,
  TEMPLATES,
  requiredSectionIds,
  resolveTemplate,
} from "../src/index";

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
    ["pt_visit", "pt", "functional_status"],
    ["ot_visit", "ot", "functional_status"],
    ["slp_visit", "slp", "nutrition"],
  ] as const)(
    "%s (%s) is pinned to its therapist and documents assessment, %s and interventions, not vitals",
    (type, discipline, recorded) => {
      const t = resolveTemplate(type, discipline)!;
      expect(t.sections.map((s) => s.id)).toEqual([
        "chief_concern",
        "assessment",
        recorded,
        "interventions",
        "plan",
      ]);
      expect(requiredSectionIds(t)).not.toContain("vitals_review");
      // A therapist visit is not authorable by another discipline, and a therapist cannot author an RN visit type.
      expect(resolveTemplate(type, "rn")).toBeUndefined();
      expect(resolveTemplate("routine_visit", discipline)).toBeUndefined();
    },
  );

  // WF09 — a section whose content is prose must not offer the statement catalog. `chief_concern` ("Reason
  // for Visit") listed every cardiovascular and respiratory finding, so a note's stated reason was a
  // body-system observation, and "Vital Signs Review" offered the same list again. An EMPTY declared list
  // means "free text only"; an undeclared one used to mean "offer everything", which is how that happened.
  const PROSE_ONLY = [
    "vitals_review",
    "plan",
    "family_dynamics",
    "advance_directive",
    "caregiver_overview",
    "pps",
    "esas",
    "prognosis",
    "recert_summary",
    "idg_followup",
  ];

  // The tenant's visit-note draft switch is off by default; with it on, the RN routine visit's vitals and plan sections offer the draft
  // wording instead (`templates-draft-wiring.test.ts`). These pin the base templates, which every other pair always is.
  const baseTemplates = (): HearthnoteTemplate[] =>
    [...TEMPLATES.values()].flatMap((t) => {
      const base = resolveTemplate(t.encounterType, t.discipline, { draftWording: false });
      return base === undefined ? [] : [base];
    });

  it("prose-only sections declare no statement categories", () => {
    for (const t of baseTemplates()) {
      for (const s of t.sections) {
        if (PROSE_ONLY.includes(s.id)) expect(s.allowedCategories, `${t.key}/${s.id}`).toEqual([]);
      }
    }
  });

  it("Reason for Visit offers the visit reasons and nothing else, in every template", () => {
    for (const t of baseTemplates()) {
      const s = t.sections.find((x) => x.id === "chief_concern");
      expect(s?.allowedCategories, t.key).toEqual(["visit_reason"]);
      expect(s?.required, t.key).toBe(true);
    }
  });

  it("every section declares what it offers — none is left to offer the whole catalog", () => {
    for (const t of TEMPLATES.values()) {
      for (const s of t.sections) expect(s.allowedCategories, `${t.key}/${s.id}`).toBeDefined();
    }
  });

  it("section ids within a template are unique and ordered deterministically", () => {
    for (const t of TEMPLATES.values()) {
      const ids = t.sections.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

// WF09 — the recorded ADL, nutrition and wound sections. Their content is the visit's recorded facts (stated
// by a deterministic sentence), so they offer no statements, are never required, and sit after Assessment.
describe("recorded-findings sections (WF09)", () => {
  const FLAG = {
    functional_status: "adlSummary",
    nutrition: "nutritionSummary",
    skin_wounds: "woundSummary",
  } as const;
  const RECORDED_IDS = Object.keys(FLAG) as (keyof typeof FLAG)[];
  const HEADING = {
    functional_status: "Functional Status",
    nutrition: "Nutrition and Hydration",
    skin_wounds: "Skin and Wounds",
  } as const;
  /** Which recorded-findings sections each discipline documents (a telephonic note also drops skin_wounds). */
  const BY_DISCIPLINE: Readonly<Record<EncounterDiscipline, readonly (keyof typeof FLAG)[]>> = {
    rn: ["functional_status", "nutrition", "skin_wounds"],
    lpn: ["functional_status", "nutrition", "skin_wounds"],
    md: ["functional_status", "nutrition", "skin_wounds"],
    np: ["functional_status", "nutrition", "skin_wounds"],
    pt: ["functional_status"],
    ot: ["functional_status"],
    slp: ["nutrition"],
    chha: [],
    msw: [],
    chaplain: [],
    volunteer: [],
  };
  const recordedIdsIn = (t: { sections: readonly { id: string }[] }): string[] =>
    t.sections.map((s) => s.id).filter((id) => RECORDED_IDS.includes(id as keyof typeof FLAG));

  it("each is optional, offers no statements, has its heading and carries its own flag", () => {
    for (const t of TEMPLATES.values()) {
      for (const s of t.sections.filter((x) => RECORDED_IDS.includes(x.id as keyof typeof FLAG))) {
        const id = s.id as keyof typeof FLAG;
        expect(s.required, `${t.key}/${id}`).toBe(false);
        expect(s.allowedCategories, `${t.key}/${id}`).toEqual([]);
        expect(s.heading, `${t.key}/${id}`).toBe(HEADING[id]);
        expect(s[FLAG[id]], `${t.key}/${id}`).toBe(true);
      }
    }
  });

  it("none is ever required, so none can block a finalize", () => {
    for (const t of TEMPLATES.values()) {
      expect(
        requiredSectionIds(t).filter((id) => id in FLAG),
        t.key,
      ).toEqual([]);
    }
  });

  it("every template carries exactly the sections its discipline documents", () => {
    for (const t of TEMPLATES.values()) {
      const expected = BY_DISCIPLINE[t.discipline].filter(
        (id) => !(id === "skin_wounds" && t.encounterType === "telephonic"),
      );
      expect(recordedIdsIn(t), t.key).toEqual(expected);
    }
  });

  it("a telephonic note keeps functional status and nutrition but has no wound section", () => {
    const ids = resolveTemplate("telephonic", "rn")!.sections.map((s) => s.id);
    expect(ids).toContain("functional_status");
    expect(ids).toContain("nutrition");
    expect(ids).not.toContain("skin_wounds");
  });

  it("they follow Assessment directly, ahead of symptom management", () => {
    expect(resolveTemplate("routine_visit", "rn")!.sections.map((s) => s.id)).toEqual([
      "chief_concern",
      "vitals_review",
      "assessment",
      "functional_status",
      "nutrition",
      "skin_wounds",
      "symptom_management",
      "interventions",
      "plan",
    ]);
    expect(resolveTemplate("admission_visit", "rn")!.sections.map((s) => s.id)).toEqual([
      "chief_concern",
      "vitals_review",
      "assessment",
      "functional_status",
      "nutrition",
      "skin_wounds",
      "symptom_management",
      "interventions",
      "plan",
      "med_reconciliation",
      "advance_directive",
      "caregiver_overview",
      "baseline_symptoms",
    ]);
  });

  it("a face-to-face note documents functional status and nutrition ahead of the attestation", () => {
    const ids = resolveTemplate("face_to_face", "md")!.sections.map((s) => s.id);
    expect(ids.indexOf("functional_status")).toBeGreaterThan(ids.indexOf("assessment"));
    expect(ids.indexOf("nutrition")).toBeLessThan(ids.indexOf("f2f_attestation"));
  });

  it("CHHA's existing ADL section states the recorded ADLs instead of gaining a second section", () => {
    const t = resolveTemplate("chha_visit", "chha")!;
    expect(t.sections.map((s) => s.id)).toEqual(["chief_concern", "adl", "plan"]);
    const adl = t.sections.find((s) => s.id === "adl")!;
    expect(adl.adlSummary).toBe(true);
    expect(adl.required).toBe(true);
    expect(adl.allowedCategories).toEqual(["adl"]);
  });

  it("each summary flag sits on its own section only (plus CHHA's ADL section for adlSummary)", () => {
    for (const t of TEMPLATES.values()) {
      for (const s of t.sections) {
        const ownFlag = FLAG[s.id as keyof typeof FLAG];
        for (const flag of Object.values(FLAG)) {
          const expected = flag === ownFlag || (flag === "adlSummary" && s.id === "adl");
          expect(s[flag] === true, `${t.key}/${s.id}/${flag}`).toBe(expected);
        }
      }
    }
  });
});
