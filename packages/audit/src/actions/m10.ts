// @chartwarden/audit — Module 10 (HOPE Engine) action catalog (CW-AC-46).
//
// M10's un-catalogued `hope.*` audit events (`hope.timepoint_signed`, `hope.sfv_completed`, `hope.sfv_completion_denied`, …)
// are free strings by design (hope-signature-audit.ts); the one below is catalogued because a CW-MON-01 detection rule reads
// it (`signature.licence_refusal_burst`, packages/audit/src/review/rules.ts), and a rule may only name a catalogued action.
// D9 namespace `m10.<resource>.<verb>`. The payload is ids and closed enums (no licence number, issuing body or name).
import type { ModuleActionCatalog } from "./types";

/** `m10` HOPE Engine module actions. */
export const M10_ACTION_CATALOG: ModuleActionCatalog = [
  {
    action: "m10.signature.licence_refused",
    moduleOwner: "m10",
    defaultRetentionClass: "compliance",
    description:
      "A HOPE record signature was refused (mode enforce, outcome denied) or would have been (mode shadow: the signature went through, outcome success) because the signer holds no active licence in the record's discipline (mode, errorCode, operation, reason, rfaKind, requiredDiscipline, heldLicenceKinds, licenceAsOf, byMembershipId).",
    denylistCategories: [],
    isPartTwoEligible: true,
  },
  {
    action: "m10.signature.licence_policy_changed",
    moduleOwner: "m10",
    defaultRetentionClass: "compliance",
    description:
      "An organization's enforcement mode for the signer-licence check was set by a platform operator (previousMode, mode, justification: the 20-200 character reason required below enforce, null on enforce; byMembershipId).",
    // The reason is free text a person typed: screened for patient identifiers by the service before it is written.
    denylistCategories: [],
    isPartTwoEligible: false,
  },
];
