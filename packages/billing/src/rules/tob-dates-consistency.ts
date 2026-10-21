import { dateLte } from "./_util";
// @chartwarden/billing — §4.5 rule `tob_and_dates_consistency` (tob_dates, error, regulatory). The UB-04
// Type of Bill must match the claim's semantics and the service dates must be contiguous with the prior
// claim (D4 / D14): 811 admit-through-discharge requires a discharge in range; 812 first-interim requires
// no prior claim; 813 continuing-interim requires a prior 812/813; 814 last-interim-before-discharge.
// PURE: reads ctx only.
import type { Rule } from "./types";
import { fail, pass } from "./types";

const KEY = "tob_and_dates_consistency";

export const tobAndDatesConsistency: Rule = {
  key: KEY,
  version: 1,
  category: "tob_dates",
  title: "Type-of-Bill and service-date consistency",
  description:
    "The Type of Bill must match the claim semantics and service dates must be contiguous with the prior " +
    "claim: 811 requires a discharge in range; 812 requires no prior claim; 813 requires a prior 812/813; " +
    "814 is the last interim before discharge (D4/D14).",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  check: (ctx) => {
    const c = ctx.claim;
    const defects: string[] = [];

    // Service window must be well-ordered.
    if (!dateLte(c.serviceFrom, c.serviceTo)) {
      defects.push(`service_from ${c.serviceFrom} is after service_to ${c.serviceTo}`);
    }

    switch (c.tob) {
      case "811": // admission through discharge — discharge must fall in the claim range
        if (c.dischargeDate === null) {
          defects.push("TOB 811 (admit-through-discharge) has no discharge date");
        } else if (c.dischargeDate < c.serviceFrom || c.dischargeDate > c.serviceTo) {
          defects.push("TOB 811 discharge date is outside the service range");
        }
        break;
      case "812": // first interim — must have no prior claim for the admission
        if (c.priorClaimTob !== null) {
          defects.push("TOB 812 (first interim) but a prior claim exists for the admission");
        }
        break;
      case "813": // continuing interim — must follow a prior 812 or 813
        if (c.priorClaimTob !== "812" && c.priorClaimTob !== "813") {
          defects.push("TOB 813 (continuing interim) without a prior 812/813 claim");
        }
        break;
      case "814": // last interim before discharge — must follow a prior interim
        if (c.priorClaimTob === null) {
          defects.push("TOB 814 (last interim) without a prior interim claim");
        }
        break;
      case "817": // replacement
      case "818": // void
        if (c.replacesClaimId === null) {
          defects.push(`TOB ${c.tob} (replacement/void) without a predecessor claim reference`);
        }
        break;
    }

    // Contiguity with the prior claim: this claim should start the day after the prior claim's through.
    if (c.priorClaimServiceTo !== null && !dateLte(c.priorClaimServiceTo, c.serviceFrom)) {
      defects.push("service dates overlap the prior claim (not contiguous)");
    }

    if (defects.length === 0) {
      return pass(KEY, "error", `TOB ${c.tob} is consistent with the claim semantics and dates.`);
    }
    return fail(
      KEY,
      "error",
      `Type-of-Bill / date consistency has ${defects.length} defect(s).`,
      {
        summary:
          "Correct the Type of Bill or the service dates to match the claim's billing sequence.",
        blameTarget: "claim",
        blameTargetId: c.claimId,
        fixAction: "edit_claim",
      },
      { defectCount: defects.length, firstDefect: defects[0] ?? "", tob: c.tob },
    );
  },
};
