// packages/narrative-vocab/src/discipline-plan-entries.ts — the social-work and chaplain visits' draft phrases (S4, ADR-0114, VN-D45 to VN-D50).
//
// Appended to the corpus by `draft-entries.ts` as `narrative-vocab@2026.12.3`. DRAFT WORDING until ADA approves this release
// (`CORPUS_CLINICAL_REVIEW`: an approval names the release it covers, VN-D34). Every phrase states what the discipline's care plan lists and,
// for a goal, who stated it as the record says so: "Plan-of-care goal: ..." and "Plan-of-care intervention: ...". None says anything was done,
// discussed, provided, met or improved, none states a status or progress, and none is an assessment: a plan lists what is intended, and the
// clinician says what happened. All of them are draft-only: the draft compiler fills the slots from the sealed plan, so none is listed in a
// section menu a clinician could type values into (`discipline_plan` is wired to no section).
import type { EncounterDiscipline, EncounterType } from "@chartwarden/types";
import type { VocabEntry } from "./types";

const MSW_AND_CHAPLAIN: readonly EncounterDiscipline[] = ["msw", "chaplain"];
const MSW_ONLY: readonly EncounterDiscipline[] = ["msw"];
/**
 * The templates whose `plan` section is drafted from the goals of the discipline's plan: the four social-work and chaplain visits and (S5,
 * VN-D52, `narrative-vocab@2026.12.4`) the IDG follow-up, which each of the two disciplines makes as its ordinary visit.
 */
const GOAL_TEMPLATES: readonly EncounterType[] = [
  "msw_assessment",
  "msw_followup",
  "chaplain_assessment",
  "chaplain_visit",
  "idg_followup",
];
/** The templates that also have an `interventions` section: the social-work visits and IDG follow-up; the chaplain's template has none. */
const INTERVENTION_TEMPLATES: readonly EncounterType[] = [
  "msw_assessment",
  "msw_followup",
  "idg_followup",
];

/** The 6 discipline-plan draft entries, in corpus order (appended after the 5 of 2026.12.1). */
export const DISCIPLINE_PLAN_VOCABULARY: readonly VocabEntry[] = [
  // ── the open goals of the plan in effect at the visit (the `plan` section) ──────────────────────────────────
  {
    code: "nv.dp.goal_listed",
    label: "Plan of care — goal",
    phrase: "Plan-of-care goal: ${goal_text}",
    category: "discipline_plan",
    disciplines: MSW_AND_CHAPLAIN,
    encounterTypes: GOAL_TEMPLATES,
  },
  // Who stated the goal, where the record says it was not the clinician. A goal a clinician later revised is listed without it:
  // the revised words are no longer the patient's, the family's or the agent's.
  {
    code: "nv.dp.goal_patient",
    label: "Plan of care — goal stated by the patient",
    phrase: "Plan-of-care goal, stated by the patient: ${goal_text}",
    category: "discipline_plan",
    disciplines: MSW_AND_CHAPLAIN,
    encounterTypes: GOAL_TEMPLATES,
  },
  {
    code: "nv.dp.goal_family",
    label: "Plan of care — goal stated by the family",
    phrase: "Plan-of-care goal, stated by the family: ${goal_text}",
    category: "discipline_plan",
    disciplines: MSW_AND_CHAPLAIN,
    encounterTypes: GOAL_TEMPLATES,
  },
  {
    code: "nv.dp.goal_agent",
    label: "Plan of care — goal stated by the patient's agent",
    phrase: "Plan-of-care goal, stated by the patient's agent: ${goal_text}",
    category: "discipline_plan",
    disciplines: MSW_AND_CHAPLAIN,
    encounterTypes: GOAL_TEMPLATES,
  },

  // ── the active interventions of the plan in effect at the visit (the social-work `interventions` section) ────
  {
    code: "nv.dp.intervention",
    label: "Plan of care — intervention",
    phrase: "Plan-of-care intervention: ${intervention_text}",
    category: "discipline_plan",
    disciplines: MSW_ONLY,
    encounterTypes: INTERVENTION_TEMPLATES,
  },
  {
    code: "nv.dp.intervention_frequency",
    label: "Plan of care — intervention with its frequency",
    phrase: "Plan-of-care intervention: ${intervention_text}; frequency: ${frequency_text}",
    category: "discipline_plan",
    disciplines: MSW_ONLY,
    encounterTypes: INTERVENTION_TEMPLATES,
  },
];
