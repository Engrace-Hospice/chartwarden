import { paramNumber } from "./_util";
// @wardenx/billing — §4.5 rule `eligibility_check_freshness_30d` (eligibility, WARN, NON-regulatory). The
// only platform-default rule a tenant may disable. The most-recent eligibility check should be within 30
// days of submission; staleness is a warning, never a block. `ageDays` is PRECOMPUTED by the service
// layer (the rule is clock-free). PURE: reads ctx only.
import type { Rule } from "./types";
import { fail, pass, skip } from "./types";

const KEY = "eligibility_check_freshness_30d";

export const eligibilityCheckFreshness30d: Rule = {
  key: KEY,
  version: 1,
  category: "eligibility",
  title: "Eligibility check is fresh (≤ 30 days)",
  description:
    "The most-recent eligibility check should be within 30 days of submission so coverage facts are " +
    "current; a stale check is surfaced as a warning (non-blocking, tenant-configurable).",
  severity: "warn",
  regulatoryRequired: false,
  overrideRoleRequired: "billing_manager",
  defaultParameters: { maxAgeDays: 30 },
  check: (ctx, params) => {
    if (!ctx.seams.eligibilityBound || ctx.eligibility === null) {
      return skip(
        KEY,
        "warn",
        "seam_not_bound",
        "Eligibility (HETS) check not available — deferred.",
      );
    }
    const maxAgeDays = paramNumber(params, "maxAgeDays", 30);
    const { ageDays } = ctx.eligibility;
    if (ageDays <= maxAgeDays) {
      return pass(KEY, "warn", `Eligibility check is ${ageDays} day(s) old (≤ ${maxAgeDays}).`);
    }
    return fail(
      KEY,
      "warn",
      `Eligibility check is ${ageDays} day(s) old (> ${maxAgeDays}); refresh before submission.`,
      {
        summary:
          "Re-run the HETS eligibility check; the on-file check is older than the freshness window.",
        blameTarget: "patient",
        blameTargetId: ctx.claim.patientId,
        fixAction: "refresh_eligibility",
      },
      { ageDays, maxAgeDays },
    );
  },
};
