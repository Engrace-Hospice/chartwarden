// @wardenx/audit — Module 8 (Encounters & Visit Notes) action catalog (M8-T12; M8 §8.1).
//
// M8's APP-level explicit-emit audit actions, under the D9 `m8.<resource>.<verb>` namespace. Row-diff
// mutation captures for the encounter/vitals/mileage/hearthnote rows flow through the M4 write-audit
// triggers (M8-T03); the entries below are the §8.1 BUSINESS events M8 records where the row diff alone
// doesn't tell the story — the encounter signature lifecycle, the cosignature SLA escalation (12h/24h/
// 48h), the late-entry tier overrides, the HearthNote Layer-2 call + per-passage decisions + hard-block
// attempts, and the PHI read volume metric. Payloads carry ids + enums (no PHI values); the free-text
// reason carriers (supervisor release, late-entry/administrative override, void, addendum, EVV-missing)
// are scrubbed for `narrative_free_text`. The administrative-late override is `critical` severity at emit
// time (recorded on the event row, not here). Part-2 eligible: an encounter can be authored for a
// SUD-flagged patient, so the clinical actions MAY be tagged `compliance_42cfr_part2` per-row at runtime.
import type { ModuleActionCatalog } from "./types";

/** `m8` Encounters & Visit Notes module actions (M8 §8.1). */
export const M8_ACTION_CATALOG: ModuleActionCatalog = [
  {
    action: "m8.encounter.draft_created",
    moduleOwner: "m8",
    defaultRetentionClass: "compliance",
    description: "A draft encounter was created (encounterId, encounterType, discipline, serviceDate, visitId?).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m8.encounter.finalized",
    moduleOwner: "m8",
    defaultRetentionClass: "compliance",
    description: "An encounter passed the Layer-3 gate and finalized (encounterId, layer2Eligibility, vocabVersionId, lateEntryTier).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m8.encounter.layer2_called",
    moduleOwner: "m8",
    defaultRetentionClass: "compliance",
    description: "HearthNote Layer-2 enhancement was invoked (encounterId, modificationId, modelId, promptTemplateVersion, tokensIn/Out, hardBlockedCount, softWarnCount).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m8.encounter.layer2_decision",
    moduleOwner: "m8",
    defaultRetentionClass: "compliance",
    description: "The clinician recorded an accept/edit/reject on a Layer-2 modification (modificationId, passageId, decision, edited).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m8.encounter.signed",
    moduleOwner: "m8",
    defaultRetentionClass: "compliance",
    description: "An encounter was signed (encounterId, method, sessionId, stepUpAuthAt, attestationVariant, requiresCosign).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m8.encounter.cosignature_routed",
    moduleOwner: "m8",
    defaultRetentionClass: "compliance",
    description: "A cosignature request was routed to a cosigner at primary sign (encounterId, routedToMembershipId; system actor).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m8.encounter.cosignature_acknowledged",
    moduleOwner: "m8",
    defaultRetentionClass: "compliance",
    description: "A cosigner acknowledged a routed cosignature request (encounterId; cosigner membership).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m8.encounter.cosignature_signed",
    moduleOwner: "m8",
    defaultRetentionClass: "compliance",
    description: "A cosigner signed, completing the cosignature workflow (encounterId, method, sessionId, stepUpAuthAt).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m8.encounter.cosignature_overdue_12h",
    moduleOwner: "m8",
    defaultRetentionClass: "compliance",
    description: "The 12h cosignature SLA elapsed unacknowledged (encounterId, hoursOverdue=12; system actor, severity info).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m8.encounter.cosignature_escalated_24h",
    moduleOwner: "m8",
    defaultRetentionClass: "compliance",
    description: "The 24h cosignature SLA escalated to a supervisor (encounterId, supervisorMembershipId; system actor, severity warn).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m8.encounter.cosignature_hard_cap_48h",
    moduleOwner: "m8",
    defaultRetentionClass: "compliance",
    description: "The 48h cosignature hard cap was reached (encounterId, supervisorMembershipId; system actor, severity warn).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m8.encounter.cosignature_supervisor_released",
    moduleOwner: "m8",
    defaultRetentionClass: "compliance",
    description: "OVR: a supervisor released a past-hard-cap cosignature (encounterId, reasonRedacted; severity warn).",
    denylistCategories: ["narrative_free_text"],
    isPartTwoEligible: true,
  },
  {
    action: "m8.encounter.late_entry_warned",
    moduleOwner: "m8",
    defaultRetentionClass: "compliance",
    description: "A late-entry warning was recorded at finalize (encounterId, daysLate; severity info).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m8.encounter.significant_late_entry_overridden",
    moduleOwner: "m8",
    defaultRetentionClass: "compliance",
    description: "OVR: a supervisor overrode a significant (3–14d) late entry (encounterId, daysLate, reasonRedacted; severity warn).",
    denylistCategories: ["narrative_free_text"],
    isPartTwoEligible: true,
  },
  {
    action: "m8.encounter.administrative_late_override",
    moduleOwner: "m8",
    defaultRetentionClass: "compliance",
    description: "OVR: a director overrode an administrative (>14d) late entry (encounterId, daysLate, reasonRedacted; severity CRITICAL).",
    denylistCategories: ["narrative_free_text"],
    isPartTwoEligible: true,
  },
  {
    action: "m8.encounter.voided",
    moduleOwner: "m8",
    defaultRetentionClass: "compliance",
    description: "A draft encounter was voided (encounterId, reasonRedacted; severity warn).",
    denylistCategories: ["narrative_free_text"],
    isPartTwoEligible: true,
  },
  {
    action: "m8.encounter.addendum_created",
    moduleOwner: "m8",
    defaultRetentionClass: "compliance",
    description: "An addendum draft was created on a signed encounter (addendumId, parentEncounterId, reasonRedacted).",
    denylistCategories: ["narrative_free_text"],
    isPartTwoEligible: true,
  },
  {
    action: "m8.encounter.addendum_signed",
    moduleOwner: "m8",
    defaultRetentionClass: "compliance",
    description: "An addendum was signed (addendumId, parentEncounterId, method).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m8.encounter.evv_missing_documented",
    moduleOwner: "m8",
    defaultRetentionClass: "compliance",
    description: "An EVV-missing reason was documented (D9 fallback) (encounterId, reasonRedacted).",
    denylistCategories: ["narrative_free_text"],
    isPartTwoEligible: true,
  },
  {
    action: "m8.encounter.care_plan_overdue_gate_engaged",
    moduleOwner: "m8",
    defaultRetentionClass: "compliance",
    description: "The M7 care-plan-review-overdue sign gate engaged on an encounter (encounterId, careplanId; system actor, severity warn).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m8.encounter.layer2_hard_block_attempted",
    moduleOwner: "m8",
    defaultRetentionClass: "compliance",
    description: "A Layer-2 modification was hard-blocked and Layer-1 restored (encounterId, category, passageId; system actor).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m8.encounter.read",
    moduleOwner: "m8",
    defaultRetentionClass: "compliance",
    description: "An encounter was read via the route handler (Module 4 read-audit; carries the reader membership; volume metric, not full payload).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
];
