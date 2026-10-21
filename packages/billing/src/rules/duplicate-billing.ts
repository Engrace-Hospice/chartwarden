// @chartwarden/billing — §4.5 rule `duplicate_billing_check` (duplicates, error, regulatory). No overlapping
// date range may exist within the same patient + CCN, and no duplicate of a previously-accepted claim.
// The §3.4 partial unique index is the STRUCTURAL backstop; this rule is the user-facing surfacing. In
// the pure domain the only cross-claim fact materialized is the immediately-prior claim's through-date,
// so this rule surfaces an overlap with that predecessor; full duplicate detection is the repository's
// partial-unique-index job (noted below). PURE: reads ctx only.
import type { Rule } from "./types";
import { fail, pass } from "./types";

const KEY = "duplicate_billing_check";

export const duplicateBillingCheck: Rule = {
  key: KEY,
  version: 1,
  category: "duplicates",
  title: "No duplicate / overlapping billing",
  description:
    "No overlapping service-date range may exist within the same patient + CCN, and the claim must not " +
    "duplicate a previously-accepted claim. The §3.4 partial unique index enforces this structurally; " +
    "this rule surfaces it on the worklist.",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  check: (ctx) => {
    const c = ctx.claim;
    // Surface an overlap with the immediately-prior claim (the cross-claim fact available in-context).
    // A replacement/void (817/818) legitimately re-covers a prior range, so it is exempt here.
    const isReplacementOrVoid = c.tob === "817" || c.tob === "818";
    if (
      !isReplacementOrVoid &&
      c.priorClaimServiceTo !== null &&
      c.serviceFrom <= c.priorClaimServiceTo
    ) {
      return fail(
        KEY,
        "error",
        "Service dates overlap the immediately-prior claim for this patient/CCN.",
        {
          summary:
            "Trim this claim's start to the day after the prior claim's through-date, or void/replace.",
          blameTarget: "claim",
          blameTargetId: c.claimId,
          fixAction: "edit_claim",
        },
        { priorClaimServiceTo: c.priorClaimServiceTo, serviceFrom: c.serviceFrom },
      );
    }
    // NOTE(P3): exhaustive duplicate detection across ALL prior accepted claims is performed by the
    // repository via the §3.4 partial unique index `(patient_id, provider_entity_id, [service range])`;
    // the pure rule only has the prior-claim continuity facts in `ClaimSnapshot`.
    return pass(
      KEY,
      "error",
      "No overlap with the prior claim (structural duplicate index is the backstop).",
    );
  },
};
