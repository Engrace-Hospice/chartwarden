// @wardenx/billing — §4.5 rule `patient_eligibility_part_a_active` (eligibility, error, regulatory). The
// patient must have active Medicare Part A as-of the claim's service-from (the §1.3 first gate of FFS
// hospice billing). Reads the precomputed `eligibility` snapshot (the service layer resolved the most-
// recent `eligibility_check`); `active_part_a` passes, `inactive_part_a` BLOCKS, and an indeterminate /
// error / unbound check SKIPs (deferred, never a false block). PURE: reads ctx only.
import type { Rule } from "./types";
import { fail, pass, skip } from "./types";

const KEY = "patient_eligibility_part_a_active";

export const patientEligibilityPartAActive: Rule = {
  key: KEY,
  version: 1,
  category: "eligibility",
  title: "Patient has active Medicare Part A",
  description:
    "The patient must have active Medicare Part A on the claim's service-from date; an inactive Part A " +
    "status blocks submission (42 CFR §418.24 — election presupposes Part A entitlement).",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  check: (ctx) => {
    if (!ctx.seams.eligibilityBound || ctx.eligibility === null) {
      return skip(KEY, "error", "seam_not_bound", "Eligibility (HETS) check not available — deferred.");
    }
    const { outcome } = ctx.eligibility;
    if (outcome === "active_part_a") {
      return pass(KEY, "error", "Patient has active Medicare Part A on the service-from date.");
    }
    if (outcome === "inactive_part_a") {
      return fail(
        KEY,
        "error",
        "Patient does not have active Medicare Part A on the service-from date.",
        {
          summary: "Resolve Part A entitlement before billing; the patient is not currently Part-A active.",
          blameTarget: "patient",
          blameTargetId: ctx.claim.patientId,
          fixAction: "refresh_eligibility",
        },
        { eligibilityOutcome: outcome },
      );
    }
    // indeterminate / error: cannot confirm entitlement — block (fail-closed) with a refresh hint.
    return fail(
      KEY,
      "error",
      "Medicare Part A entitlement could not be confirmed for the service-from date.",
      {
        summary: "Re-run the HETS eligibility check; entitlement is indeterminate.",
        blameTarget: "patient",
        blameTargetId: ctx.claim.patientId,
        fixAction: "refresh_eligibility",
      },
      { eligibilityOutcome: outcome },
    );
  },
};
