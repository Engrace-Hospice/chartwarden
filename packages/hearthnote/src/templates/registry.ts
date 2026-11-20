// packages/hearthnote/src/templates/registry.ts — M8-T05 (spec §2.6, architecture §10.5.2).
//
// The Phase-1 default template registry: one resolved template per LEGAL (encounter_type × discipline)
// pair. Legality is sourced from the single `ENCOUNTER_DISCIPLINE_RULES` matrix in `@chartwarden/types`, so
// the templates and the M8-T04 sync validator never drift. Each template's section set is composed from
// a discipline base plus the encounter-type-specific required sections the spec §2.2 table enumerates
// (admission → med-rec/advance-directive/caregiver/baseline; recert → PPS/ESAS/prognosis/summary; F2F →
// attestation; etc.). Pure data + a couple of resolvers; no IO.

import type { VocabCategory } from "@chartwarden/narrative-vocab";
import {
  ENCOUNTER_DISCIPLINE_RULES,
  type EncounterDiscipline,
  type EncounterType,
} from "@chartwarden/types";
import type { HearthnoteTemplate, TemplateSection } from "./types";
import { templateKey } from "./types";

/**
 * A required section the clinician writes in their own words: it offers no preset statements.
 *
 * Reason for Visit, Vital Signs Review and Plan used to declare no categories, which offered the whole
 * catalog — so a note's stated reason was a cardiovascular finding, and the same statement could be ticked
 * in three sections with three different values. Until structured reasons exist (WF09 step 2), prose is the
 * honest content for these.
 */
const prose = (id: string, heading: string): TemplateSection => ({
  id,
  heading,
  required: true,
  allowedCategories: [],
});

// ── section catalog (each section defined once; templates reference by id) ───────────────────────────
const SECTION: Record<string, TemplateSection> = {
  // A choice of visit reasons (one per note), with free text for the detail a choice cannot carry.
  chief_concern: {
    id: "chief_concern",
    heading: "Reason for Visit",
    required: true,
    allowedCategories: ["visit_reason"],
    fallSummary: true,
  },
  vitals_review: { ...prose("vitals_review", "Vital Signs Review"), vitalsSummary: true },
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
  plan: prose("plan", "Plan and Next Visit"),
  // The recorded ADL, nutrition and wound sections: optional, and free text only. Their content is the visit's
  // recorded facts, stated by a deterministic sentence (the way `vitals_review` states the recorded vitals).
  functional_status: {
    id: "functional_status",
    heading: "Functional Status",
    required: false,
    allowedCategories: [],
    adlSummary: true,
  },
  nutrition: {
    id: "nutrition",
    heading: "Nutrition and Hydration",
    required: false,
    allowedCategories: [],
    nutritionSummary: true,
  },
  skin_wounds: {
    id: "skin_wounds",
    heading: "Skin and Wounds",
    required: false,
    allowedCategories: [],
    woundSummary: true,
  },
  // CHHA already has an ADL section (required); it states the recorded ADLs rather than gaining a second one.
  adl: {
    id: "adl",
    heading: "Activities of Daily Living",
    required: true,
    allowedCategories: ["adl"],
    adlSummary: true,
  },
  psychosocial: {
    id: "psychosocial",
    heading: "Psychosocial Assessment",
    required: true,
    allowedCategories: ["psychosocial"],
  },
  family_dynamics: prose("family_dynamics", "Family Dynamics"),
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
  advance_directive: prose("advance_directive", "Advance Directive Acknowledgment"),
  caregiver_overview: prose("caregiver_overview", "Caregiver Overview"),
  baseline_symptoms: {
    id: "baseline_symptoms",
    heading: "Baseline Symptoms",
    required: true,
    allowedCategories: ["symptom_impact"],
  },
  pps: prose("pps", "Palliative Performance Status"),
  esas: prose("esas", "Symptom Assessment (ESAS)"),
  prognosis: prose("prognosis", "Prognostic Indicators"),
  recert_summary: prose("recert_summary", "Recertification Summary"),
  f2f_attestation: {
    id: "f2f_attestation",
    heading: "Face-to-Face Attestation",
    required: true,
    allowedCategories: ["attestation"],
  },
  idg_followup: prose("idg_followup", "IDG Decision Follow-Up"),
};

/**
 * VN-D15 (S1 PR B): the draft-wording categories of the RN routine visit's `chief_concern`, `vitals_review`
 * and `plan` sections. Wired for THIS template only — `chief_concern` and `plan` are shared with every
 * discipline, and the draft entries are tagged for the RN routine visit alone. `plan` also keeps
 * `care_plan_element`, the category of the care-plan phrases its menu already offered, and `chief_concern`
 * keeps `visit_reason` (WF09): the structured Reason for Visit choice and the fall link on it stay offered
 * while the draft wording is on. Every other template resolves exactly the sections it had before.
 */
const ROUTINE_VISIT_RN_CATEGORIES: Readonly<Record<string, readonly VocabCategory[]>> = {
  chief_concern: ["visit_reason", "chief_concern"],
  vitals_review: ["vitals_review"],
  plan: ["plan", "care_plan_element"],
};

/** Per-template category wiring, keyed by template key then section id. */
const CATEGORY_WIRING: ReadonlyMap<
  string,
  Readonly<Record<string, readonly VocabCategory[]>>
> = new Map([[templateKey("routine_visit", "rn"), ROUTINE_VISIT_RN_CATEGORIES]]);

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
        "functional_status",
        "nutrition",
        "skin_wounds",
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
      // `vitals_review`, so the §2.6 gate requires no vitals for a therapy visit. PT and OT also state the
      // functional status they assessed (transfers, ambulation, devices; self-care); SLP the swallowing and
      // intake it assessed. None of the three treats wounds.
      return [
        "chief_concern",
        "assessment",
        ...(discipline === "slp" ? ["nutrition"] : ["functional_status"]),
        "interventions",
        "plan",
      ];
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

/** What a telephonic note cannot hold: nothing was measured, so no vitals and no wound measurements (§2.2). */
const TELEPHONIC_OMITS: ReadonlySet<string> = new Set(["vitals_review", "skin_wounds"]);

/** Build the resolved template for one legal pair (telephonic drops the vitals and wound sections — §2.2). */
function buildTemplate(
  encounterType: EncounterType,
  discipline: EncounterDiscipline,
  wired: boolean,
): HearthnoteTemplate {
  const base = baseSectionIds(discipline).filter(
    (id) => !(TELEPHONIC_OMITS.has(id) && encounterType === "telephonic"),
  );
  const ordered: string[] = [];
  for (const id of [...base, ...extraSectionIds(encounterType)]) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  const key = templateKey(encounterType, discipline);
  return {
    key,
    encounterType,
    discipline,
    sections: ordered.map((id) => {
      const section = SECTION[id];
      if (section === undefined) throw new Error(`unknown section id '${id}'`);
      const categories = wired ? CATEGORY_WIRING.get(key)?.[id] : undefined;
      return categories === undefined ? section : { ...section, allowedCategories: categories };
    }),
  };
}

const buildAll = (wired: boolean): ReadonlyMap<string, HearthnoteTemplate> =>
  new Map(
    (Object.keys(ENCOUNTER_DISCIPLINE_RULES) as EncounterType[]).flatMap((encounterType) =>
      ENCOUNTER_DISCIPLINE_RULES[encounterType].map((discipline): [string, HearthnoteTemplate] => [
        templateKey(encounterType, discipline),
        buildTemplate(encounterType, discipline, wired),
      ]),
    ),
  );

/** Every default template, keyed by `${encounterType}:${discipline}`, for all legal pairs. */
export const TEMPLATES: ReadonlyMap<string, HearthnoteTemplate> = buildAll(true);

/** The same templates with the VN-D15 category wiring left off: every section carries the categories it had before S1 PR B. */
const UNWIRED_TEMPLATES: ReadonlyMap<string, HearthnoteTemplate> = buildAll(false);

export interface ResolveTemplateOptions {
  /**
   * Whether the RN routine visit's `chief_concern`, `vitals_review` and `plan` sections carry the draft-wording categories (the default).
   * `false` resolves the template as it was before the draft corpus, for a tenant whose visit-note draft switch is off.
   */
  readonly draftWording?: boolean;
}

/** Resolve the default template for a pair; `undefined` if the pair is illegal (§2.7). */
export function resolveTemplate(
  encounterType: EncounterType,
  discipline: EncounterDiscipline,
  options: ResolveTemplateOptions = {},
): HearthnoteTemplate | undefined {
  const templates = options.draftWording === false ? UNWIRED_TEMPLATES : TEMPLATES;
  return templates.get(templateKey(encounterType, discipline));
}

/** The ids of the template's required sections (the Layer-3 gate's "must be populated" list). */
export function requiredSectionIds(template: HearthnoteTemplate): readonly string[] {
  return template.sections.filter((s) => s.required).map((s) => s.id);
}
