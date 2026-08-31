// @wardenx/audit — Module 7 (Care Plan / IPOC) action catalog (M7-T09; M7 §8.1).
//
// M7's APP-level explicit-emit audit actions, under the D9 `m7.<resource>.<verb>` namespace. Row-diff
// mutation captures for problem/goal/intervention rows flow through the M4 write-audit triggers
// (M7-T02); the entries below are the §8.1 BUSINESS events M7 records where the row diff alone doesn't
// tell the story — care-plan lifecycle transitions, the multi-signer quorum, the 5-/15-day gate
// engagement/override, the IDG-decision applier, and the §7.6 SUD redaction observability. Payloads
// carry ids + enums (no PHI values); the free-text reason carriers (gate override, return-to-draft,
// discharge) are scrubbed for `narrative_free_text`. The gate-override event is `critical` severity at
// emit time (recorded on the event row, not here) and is `compliance_relevant=true` for CMS export.
// Part-2 eligible: a care plan can be authored for a SUD-flagged patient, so the clinical actions MAY
// be tagged `compliance_42cfr_part2` per-row at runtime (§5.3).
import type { ModuleActionCatalog } from "./types";

/** `m7` Care Plan (IPOC) module actions (M7 §8.1). */
export const M7_ACTION_CATALOG: ModuleActionCatalog = [
  {
    action: "m7.care_plan.created",
    moduleOwner: "m7",
    defaultRetentionClass: "compliance",
    description: "A care plan was created for a patient on admission (planId, patientId, admissionId).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m7.care_plan.activated",
    moduleOwner: "m7",
    defaultRetentionClass: "compliance",
    description: "A care plan went active on its first signed version (planId, initialVersionId).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m7.care_plan.discharged",
    moduleOwner: "m7",
    defaultRetentionClass: "compliance",
    description: "A care plan reached its discharged terminal state (planId, reason).",
    denylistCategories: ["narrative_free_text"],
    isPartTwoEligible: true,
  },
  {
    action: "m7.care_plan.version_drafted",
    moduleOwner: "m7",
    defaultRetentionClass: "compliance",
    description: "A new care-plan version draft was opened (versionId, kind, sequence).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m7.care_plan.version_finalized",
    moduleOwner: "m7",
    defaultRetentionClass: "compliance",
    description: "A version was finalized to in_review with its Required Signer Set (versionId, requiredSignerSet).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m7.care_plan.version_signed",
    moduleOwner: "m7",
    defaultRetentionClass: "compliance",
    description: "A signer added a signature to a version (versionId, role, sequence, signaturesCollected/Needed).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m7.care_plan.version_completed",
    moduleOwner: "m7",
    defaultRetentionClass: "compliance",
    description: "Quorum met; a version transitioned to signed (versionId, signedAt).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m7.care_plan.version_returned_to_draft",
    moduleOwner: "m7",
    defaultRetentionClass: "compliance",
    description: "A version was returned to draft for edits; prior signatures cleared (versionId, reason, D8).",
    denylistCategories: ["narrative_free_text"],
    isPartTwoEligible: true,
  },
  {
    action: "m7.care_plan.initial_overdue",
    moduleOwner: "m7",
    defaultRetentionClass: "compliance",
    description: "The 5-day initial gate elapsed unsigned (planId, admissionActivatedAt, dueAt; severity warn).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m7.care_plan.review_overdue",
    moduleOwner: "m7",
    defaultRetentionClass: "compliance",
    description: "The 15-day review gate elapsed without a new signed version (planId, lastSignedAt, dueAt; warn).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m7.care_plan.review_gate_engaged",
    moduleOwner: "m7",
    defaultRetentionClass: "compliance",
    description: "The encounter-sign gate engaged after the grace window (planId, gateEngagedAt; severity warn).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m7.care_plan.gate_overridden",
    moduleOwner: "m7",
    defaultRetentionClass: "compliance",
    description: "OVR: a clinical supervisor/medical director overrode the sign gate (planId, reason, gateKind; severity CRITICAL).",
    denylistCategories: ["narrative_free_text"],
    isPartTwoEligible: true,
  },
  {
    action: "m7.care_plan.read",
    moduleOwner: "m7",
    defaultRetentionClass: "compliance",
    description: "A care plan was read via the route handler (Module 4 read-audit; carries the caller membership).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m7.care_plan.summary_read",
    moduleOwner: "m7",
    defaultRetentionClass: "compliance",
    description: "A care-plan summary was read by staff/collaborator/portal (carries session_class).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m7.care_plan.idg_proposal_created",
    moduleOwner: "m7",
    defaultRetentionClass: "compliance",
    description: "The IDG consumer persisted an M14 care-plan decision as proposed changes (idgDecisionId, versionId, changes).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m7.care_plan.idg_proposal_applied",
    moduleOwner: "m7",
    defaultRetentionClass: "compliance",
    description: "A signed IDG review applied its proposed changes to working care-plan content (versionId, changes).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m7.care_plan.sud_redaction_applied",
    moduleOwner: "m7",
    defaultRetentionClass: "operational",
    description: "§7.6 SUD content was omitted from a caller's read/summary (planId, callerSessionId, redactedProblemCount; sampled).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
];
