// packages/hearthnote/src/templates/registry.ts — M8-T05 (spec §2.6, architecture §10.5.2).
//
// The Phase-1 default template registry: one resolved template per LEGAL (encounter_type × discipline)
// pair. Legality is sourced from the single `ENCOUNTER_DISCIPLINE_RULES` matrix in `@wardenx/types`, so
// the templates and the M8-T04 sync validator never drift. Each template's section set is composed from
// a discipline base plus the encounter-type-specific required sections the spec §2.2 table enumerates
// (admission → med-rec/advance-directive/caregiver/baseline; recert → PPS/ESAS/prognosis/summary; F2F →
// attestation; etc.). Pure data + a couple of resolvers; no IO.
import {
  ENCOUNTER_DISCIPLINE_RULES,
  type EncounterDiscipline,
  type EncounterType,
} from "@wardenx/types";
import type { HearthnoteTemplate, TemplateSection } from "./types";
import { templateKey } from "./types";

// ── section catalog (each section defined once; templates reference by id) ───────────────────────────
const SECTION: Record<string, TemplateSection> = {
  chief_concern: { id: "chief_concern", heading: "Reason for Visit", required: true },
  vitals_review: { id: "vitals_review", heading: "Vital Signs Review", required: true },
  assessment: {
    id: "assessment",
    heading: "Assessment",
    required: true,
    allowedCategories: ["observation"],
  },
  symptom_management: {
    id: "symptom_management",
    heading: "Symptom Management",
    required: false,
    allowedCategories: ["symptom_impact"],
  },
  interventions: {
    id: "interventions",
    heading: "Interventions",
    required: false,
    allowedCategories: ["care_plan_element"],
  },
  plan: { id: "plan", heading: "Plan and Next Visit", required: true },
  adl: {
    id: "adl",
    heading: "Activities of Daily Living",
    required: true,
    allowedCategories: ["adl"],
  },
  psychosocial: {
    id: "psychosocial",
    heading: "Psychosocial Assessment",
    required: true,
    allowedCategories: ["psychosocial"],
  },
  family_dynamics: { id: "family_dynamics", heading: "Family Dynamics", required: true },
  spiritual: {
    id: "spiritual",
    heading: "Spiritual Assessment",
    required: true,
    allowedCategories: ["spiritual"],
  },
  med_reconciliation: {
    id: "med_reconciliation",
    heading: "Medication Reconciliation",
    required: true,
    allowedCategories: ["care_plan_element"],
  },
  advance_directive: {
    id: "advance_directive",
    heading: "Advance Directive Acknowledgment",
    required: true,
  },
  caregiver_overview: { id: "caregiver_overview", heading: "Caregiver Overview", required: true },
  baseline_symptoms: {
    id: "baseline_symptoms",
    heading: "Baseline Symptoms",
    required: true,
    allowedCategories: ["symptom_impact"],
  },
  pps: { id: "pps", heading: "Palliative Performance Status", required: true },
  esas: { id: "esas", heading: "Symptom Assessment (ESAS)", required: true },
  prognosis: { id: "prognosis", heading: "Prognostic Indicators", required: true },
  recert_summary: { id: "recert_summary", heading: "Recertification Summary", required: true },
  f2f_attestation: {
    id: "f2f_attestation",
    heading: "Face-to-Face Attestation",
    required: true,
    allowedCategories: ["attestation"],
  },
  idg_followup: { id: "idg_followup", heading: "IDG Decision Follow-Up", required: true },
};

/** The base section ids a discipline documents, before encounter-type specialization. */
function baseSectionIds(discipline: EncounterDiscipline): readonly string[] {
  switch (discipline) {
    case "rn":
    case "lpn":
    case "md":
    case "np":
      return [
        "chief_concern",
        "vitals_review",
        "assessment",
        "symptom_management",
        "interventions",
        "plan",
      ];
    case "chha":
      return ["chief_concern", "adl", "plan"];
    case "msw":
      return ["chief_concern", "psychosocial", "interventions", "plan"];
    case "chaplain":
      return ["chief_concern", "spiritual", "plan"];
    case "pt":
    case "ot":
    case "slp":
      // Therapists document a functional assessment and their interventions; like CHHA/MSW they carry no
      // `vitals_review`, so the §2.6 gate requires no vitals for a therapy visit.
      return ["chief_concern", "assessment", "interventions", "plan"];
    case "volunteer":
      return ["chief_concern", "plan"];
  }
}

/** The extra required sections an encounter type pins on top of the discipline base (§2.2 table). */
function extraSectionIds(encounterType: EncounterType): readonly string[] {
  switch (encounterType) {
    case "admission_visit":
      return ["med_reconciliation", "advance_directive", "caregiver_overview", "baseline_symptoms"];
    case "recert_visit":
      return ["pps", "esas", "prognosis", "recert_summary"];
    case "face_to_face":
      return ["med_reconciliation", "prognosis", "f2f_attestation"];
    case "msw_assessment":
      return ["family_dynamics"];
    case "idg_followup":
      return ["idg_followup"];
    default:
      return [];
  }
}

/** Build the resolved template for one legal pair (telephonic drops the vitals section — §2.2). */
function buildTemplate(
  encounterType: EncounterType,
  discipline: EncounterDiscipline,
): HearthnoteTemplate {
  const base = baseSectionIds(discipline).filter(
    (id) => !(id === "vitals_review" && encounterType === "telephonic"),
  );
  const ordered: string[] = [];
  for (const id of [...base, ...extraSectionIds(encounterType)]) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  return {
    key: templateKey(encounterType, discipline),
    encounterType,
    discipline,
    sections: ordered.map((id) => {
      const section = SECTION[id];
      if (section === undefined) throw new Error(`unknown section id '${id}'`);
      return section;
    }),
  };
}

/** Every default template, keyed by `${encounterType}:${discipline}`, for all legal pairs. */
export const TEMPLATES: ReadonlyMap<string, HearthnoteTemplate> = new Map(
  (Object.keys(ENCOUNTER_DISCIPLINE_RULES) as EncounterType[]).flatMap((encounterType) =>
    ENCOUNTER_DISCIPLINE_RULES[encounterType].map((discipline): [string, HearthnoteTemplate] => [
      templateKey(encounterType, discipline),
      buildTemplate(encounterType, discipline),
    ]),
  ),
);

/** Resolve the default template for a pair; `undefined` if the pair is illegal (§2.7). */
export function resolveTemplate(
  encounterType: EncounterType,
  discipline: EncounterDiscipline,
): HearthnoteTemplate | undefined {
  return TEMPLATES.get(templateKey(encounterType, discipline));
}

/** The ids of the template's required sections (the Layer-3 gate's "must be populated" list). */
export function requiredSectionIds(template: HearthnoteTemplate): readonly string[] {
  return template.sections.filter((s) => s.required).map((s) => s.id);
}
