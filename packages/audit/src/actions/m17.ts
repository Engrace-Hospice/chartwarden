// @chartwarden/audit — Module 17 (Scheduling) action catalog (CW-AC-46 follow-up).
//
// M17's row-diff captures (visit, time_off, membership_credential, …) flow through the M4 write-audit triggers. The entries
// below are the explicit-emit BUSINESS events whose refusal the row diff cannot show: a refused write leaves no row.
// Payloads carry ids and closed enums only (no names, no licence numbers, no free text), so nothing here is PHI and nothing
// is 42 CFR Part 2 eligible.
import type { ModuleActionCatalog } from "./types";

/** `m17` Scheduling module actions. */
export const M17_ACTION_CATALOG: ModuleActionCatalog = [
  {
    action: "m17.credential.self_grant_refused",
    moduleOwner: "m17",
    defaultRetentionClass: "compliance",
    description:
      "A member tried to record a professional licence on their own membership (POST /api/v1/memberships/:membershipId/credentials where the target is the caller's own membership; membershipId, credentialType, denial = CREDENTIAL_SELF_GRANT_REFUSED; severity warn, outcome denied; ids and the closed discipline enum only, no licence number and no free text; the refused request wrote no row, so this is written on its own transaction, best effort, and a failure to write it never replaces the refusal). The licence roster is what the visit-create credential gate and the HOPE signer-licence check (CW-AC-46, #1206) read, so a self-grant is an attempt to forge the fact they trust. Reviewed by CW-MON-01 (privileged.credential_self_grant_attempt). No patient, so never Part 2.",
    denylistCategories: [],
    isPartTwoEligible: false,
  },
];
