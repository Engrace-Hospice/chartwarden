// @chartwarden/billing — §4.5 rule `ipu_cap_projection` (cap, regulatory). The inpatient (GIP + IRC) day
// projection must be below the inpatient cap for the cap period (42 CFR §418.302(f) — the 20% inpatient
// limitation). Like `aggregate_cap_projection`, this SKIPs (`seam_not_bound`) while the M26 cap provider
// is a deny-stub (warn-degraded, never a hard block) and tightens to an `error` block once bound (D8).
// PURE: reads ctx only.
import type { Rule } from "./types";
import { fail, pass, skip } from "./types";

const KEY = "ipu_cap_projection";

export const ipuCapProjection: Rule = {
  key: KEY,
  version: 1,
  category: "cap",
  title: "Inpatient (IPU) cap projection within limit",
  description:
    "The inpatient (GIP + IRC) day projection must be below the inpatient cap for the cap period " +
    "(42 CFR §418.302(f) inpatient limitation). Deferred (skipped) while the M26 cap provider is a " +
    "deny-stub; tightens to a hard error once bound (D8).",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "compliance_officer",
  check: (ctx) => {
    if (!ctx.seams.capProjectionBound || ctx.capProjection === null) {
      return skip(
        KEY,
        "error",
        "seam_not_bound",
        "Cap projection (M26) not bound — IPU-cap projection unavailable; deferred (non-blocking).",
      );
    }
    if (!ctx.capProjection.ipuWithinCap) {
      return fail(
        KEY,
        "error",
        "Projected inpatient (GIP + IRC) days exceed the inpatient cap for the cap period.",
        {
          summary:
            "Review inpatient utilization; the agency is over the 20% inpatient cap projection.",
          blameTarget: "claim",
          blameTargetId: ctx.claim.claimId,
          fixAction: "review_cap",
        },
      );
    }
    return pass(KEY, "error", "Inpatient (IPU) cap projection within limit.");
  },
};
