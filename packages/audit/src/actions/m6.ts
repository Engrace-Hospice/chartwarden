// @wardenx/audit — Module 6 (Admission, Election & Certification) action catalog (M6-T12; M6 §8.1.2).
//
// M6's APP-level explicit-emit audit actions, under the D9 `m6.<resource>.<verb>` namespace. Row-diff
// mutation captures flow through the M4 write-audit triggers (M6-T03); the entries below are the
// §8.1.2 BUSINESS events M6 records via `recordBusinessEvent` where the row diff alone doesn't tell the
// story — state transitions and side-effects (activation, signing, overrides, the M29 external-event
// applier outcomes). `clinical_record` in the spec is a DATA class, not a RetentionClass, so the
// clinically-retained events file under `compliance` (10-year clinical retention is an M4 policy detail
// over the class); the operationally-flagged events file under `operational`. Override / missed-window /
// contract-violation events are `high` severity at emit time (recorded on the event row, not here) and
// carry `compliance_relevant=true` for CMS-survey export. Payloads carry ids + enums (no PHI values);
// the free-text reason carriers (override/discharge) are scrubbed for `narrative_free_text`.
// Part-2 eligible: an admission can be for a SUD-flagged patient, so the clinical actions MAY be tagged
// `compliance_42cfr_part2` per-row at runtime (§5.3).
import type { ModuleActionCatalog } from "./types";

/** `m6` Admission, Election & Certification module actions (M6 §8.1.2). */
export const M6_ACTION_CATALOG: ModuleActionCatalog = [
  {
    action: "m6.referral.triaged",
    moduleOwner: "m6",
    defaultRetentionClass: "compliance",
    description: "A referral was triaged eligible/ineligible (carries the outcome).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m6.referral.accepted",
    moduleOwner: "m6",
    defaultRetentionClass: "compliance",
    description: "A referral was accepted; links the drafted admissionId.",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m6.admission.activated",
    moduleOwner: "m6",
    defaultRetentionClass: "compliance",
    description: "An admission was activated; carries the R-AC-01 preconditions snapshot.",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m6.admission.discharged",
    moduleOwner: "m6",
    defaultRetentionClass: "compliance",
    description: "An admission reached a discharged/bereavement terminal state (reason + dischargeDate).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m6.election.signed",
    moduleOwner: "m6",
    defaultRetentionClass: "compliance",
    description: "An election statement was signed (signing role captured).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m6.cti.signed",
    moduleOwner: "m6",
    defaultRetentionClass: "compliance",
    description: "A CTI was fully signed (hospice-MD + attending signatures captured separately).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m6.cti.late_flagged",
    moduleOwner: "m6",
    defaultRetentionClass: "compliance",
    description: "A CTI was flagged late; carries the D4 written-cert deadline echo.",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m6.f2f.attested",
    moduleOwner: "m6",
    defaultRetentionClass: "compliance",
    description: "A face-to-face encounter was attested by the NP/physician.",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m6.f2f.window_overridden",
    moduleOwner: "m6",
    defaultRetentionClass: "compliance",
    description: "OVR-F2F-01: an F2F window was overridden by a compliance officer (reason captured).",
    denylistCategories: ["narrative_free_text"],
    isPartTwoEligible: true,
  },
  {
    action: "m6.loc.changed",
    moduleOwner: "m6",
    defaultRetentionClass: "compliance",
    description: "A level-of-care change was recorded (from/to level).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m6.discharge.created",
    moduleOwner: "m6",
    defaultRetentionClass: "compliance",
    description: "A discharge was filed (reason; for-cause carries a pending-cosign flag).",
    denylistCategories: ["narrative_free_text"],
    isPartTwoEligible: true,
  },
  {
    action: "m6.discharge.cosigned",
    moduleOwner: "m6",
    defaultRetentionClass: "compliance",
    description: "A medical director cosigned a for-cause discharge (W-DC-02 completion).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m6.compliance.window.overridden",
    moduleOwner: "m6",
    defaultRetentionClass: "compliance",
    description: "OVR-CW-01: a compliance window was closed via override (reason captured).",
    denylistCategories: ["narrative_free_text"],
    isPartTwoEligible: false,
  },
  // FY2027 — 42 CFR 418.24(c)/(d) election statement addendum. Ids + enums only; the refusal reason and the
  // exemption note are free text on the row (denylisted in the 0381 trigger) and never ride these events.
  {
    action: "m6.election_addendum.furnished",
    moduleOwner: "m6",
    defaultRetentionClass: "compliance",
    description: "An election statement addendum version was furnished in writing (418.24(c)(10); method + version).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m6.election_addendum.signature_recorded",
    moduleOwner: "m6",
    defaultRetentionClass: "compliance",
    description: "Receipt of an addendum version was acknowledged by signature (418.24(c)(9); signer kind).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m6.election_addendum.refusal_recorded",
    moduleOwner: "m6",
    defaultRetentionClass: "compliance",
    description: "The beneficiary or representative refused to sign an addendum version; the reason is on the addendum (418.24(c)(9)).",
    denylistCategories: ["narrative_free_text"],
    isPartTwoEligible: true,
  },
  {
    action: "m6.election_addendum.exemption_recorded",
    moduleOwner: "m6",
    defaultRetentionClass: "compliance",
    description: "An addendum version was marked not required / signature not required because the patient died, revoked or was discharged (418.24(d)(3)/(4)).",
    denylistCategories: ["narrative_free_text"],
    isPartTwoEligible: true,
  },
  {
    action: "m6.applier.processed",
    moduleOwner: "m6",
    defaultRetentionClass: "compliance",
    description: "The AdmissionEventApplier processed an accepted M29 proposal (proposalId, resourceKind, outcome).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m6.applier.idempotent_skip",
    moduleOwner: "m6",
    defaultRetentionClass: "operational",
    description: "The applier skipped an M29 proposal already processed (idempotency replay; proposalId, reason).",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
  {
    action: "m6.applier.contract_violation_refused",
    moduleOwner: "m6",
    defaultRetentionClass: "compliance",
    description: "The applier refused an M29 proposal that violated the D13 ownership/resource contract.",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
];
