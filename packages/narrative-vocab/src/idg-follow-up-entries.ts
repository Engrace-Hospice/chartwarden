// packages/narrative-vocab/src/idg-follow-up-entries.ts — the IDG follow-up visit's draft phrases (S5b, ADR-0114, VN-D68).
//
// Appended to the corpus by `draft-entries.ts` as `narrative-vocab@2026.12.5`. DRAFT WORDING until ADA approves this release
// (`CORPUS_CLINICAL_REVIEW`: an approval names the release it covers, VN-D34). The `idg_followup` section is drafted from the ONE IDG action item an
// author linked the visit to, and states three facts about it and nothing else: when the team met, WHAT KIND of decision it made (one of ten fixed
// labels below, never the decision's words) and the item's due date. It never carries the item's title or body, the decision's payload or any
// narrative, and it says nothing was done, completed or addressed: the visit follows the item up, and the clinician says what happened. Both phrases
// are draft-only (the compiler fills the slots from the facts M14 hands over, so no section menu lists them).
import type { EncounterDiscipline, EncounterType, IdgDecisionKind } from "@chartwarden/types";
import type { VocabEntry } from "./types";

/**
 * The words for each decision kind (`idg_decision_kind`, the ten kinds M14 records), complete by construction. Plain labels of the KIND only: none
 * names a diagnosis, a symptom or a risk. A bereavement risk flag is a "bereavement support review", so the note never says a patient or family was
 * flagged. Each reads inside "the team's decision of <date>: <label>".
 */
export const IDG_DECISION_KIND_LABELS = {
  care_plan_update: "an update to the plan of care",
  order_request: "an order request",
  medication_recommendation: "a medication recommendation",
  level_of_care_consideration: "a level of care consideration",
  recertification_consideration: "a recertification consideration",
  family_meeting_needed: "a family meeting",
  bereavement_risk_flag: "a bereavement support review",
  referral: "a referral",
  team_note: "a team note",
  discipline_plan_update: "an update to a discipline's plan of care",
} as const satisfies Readonly<Record<IdgDecisionKind, string>>;

const ALL_DISCIPLINES: readonly EncounterDiscipline[] = [
  "rn",
  "lpn",
  "msw",
  "chaplain",
  "md",
  "np",
];
const IDG_ONLY: readonly EncounterType[] = ["idg_followup"];

/** The 2 IDG follow-up draft entries, in corpus order (appended after the 6 of 2026.12.3): with the item's due date, and without one. */
export const IDG_FOLLOW_UP_VOCABULARY: readonly VocabEntry[] = [
  {
    code: "nv.idg.followup_due",
    label: "IDG follow-up — the team's decision, with its due date",
    phrase:
      "This visit follows up the team's decision of ${idg_meeting_date}: ${idg_decision_label}; due ${idg_due_date}",
    category: "idg_followup",
    disciplines: ALL_DISCIPLINES,
    encounterTypes: IDG_ONLY,
    slotSpecs: {
      idg_decision_label: {
        kind: "choice",
        options: Object.values(IDG_DECISION_KIND_LABELS),
        label: "Decision",
      },
    },
  },
  {
    code: "nv.idg.followup",
    label: "IDG follow-up — the team's decision, with no due date",
    phrase:
      "This visit follows up the team's decision of ${idg_meeting_date}: ${idg_decision_label}",
    category: "idg_followup",
    disciplines: ALL_DISCIPLINES,
    encounterTypes: IDG_ONLY,
    slotSpecs: {
      idg_decision_label: {
        kind: "choice",
        options: Object.values(IDG_DECISION_KIND_LABELS),
        label: "Decision",
      },
    },
  },
];
