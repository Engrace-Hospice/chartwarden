// @chartwarden/audit — Module 15 (Discipline Care Plans) action catalog (Workflow 06 audit D-15).
//
// M15's APP-level explicit-emit audit actions, under the D9 `m15.<resource>.<verb>` namespace. The row-diff
// captures of the plan, goal, intervention, assessment and version rows flow through the M4 write-audit
// triggers; the three entries below are the business events M15 records where the row diff alone does not
// tell the story: the discharge seal on `m6.admission.discharged`, and the M14 IDG-decision loop's applied
// and refused verdicts. Payloads carry ids, counts and enums, never record content. A discipline plan can be
// authored for a SUD-flagged patient, so each action MAY be tagged `compliance_42cfr_part2` per-row (§5.3).
import type { ModuleActionCatalog } from "./types";

/** `m15` Discipline Care Plans module actions. */
export const M15_ACTION_CATALOG: ModuleActionCatalog = [
  {
    action: "m15.plan.discharged",
    moduleOwner: "m15",
    defaultRetentionClass: "compliance",
    description:
      "A discipline plan was sealed on admission discharge (admissionId, reason, finalSnapshotVersionId, sourceEventId).",
    denylistCategories: ["narrative_free_text"],
    isPartTwoEligible: true,
  },
  {
    action: "m15.idg_decision.applied",
    moduleOwner: "m15",
    defaultRetentionClass: "compliance",
    description:
      "An M14 discipline-plan decision was applied to the plan as a draft revision (decisionId, meetingId, mutationCount).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m15.idg_decision.refused",
    moduleOwner: "m15",
    defaultRetentionClass: "compliance",
    description:
      "An M14 discipline-plan decision was refused for a permanent reason and recorded as a durable refusal (decisionId, reason code; ids and a code only).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
];
