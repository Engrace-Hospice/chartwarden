import { paramNumber } from "./_util";
// @chartwarden/billing — §4.5 rule `aggregate_cap_projection` (cap, regulatory). The patient's projected
// payments must be below the hospice aggregate cap (42 CFR §418.308), and the claim must warn if it
// brings the agency-wide projection within 5% of the cap (D8). The M26 `CapProjectionProvider` is a
// DENY-STUB at this phase, so `capProjection` is null and the rule SKIPs (`seam_not_bound`) —
// warn-degraded, NEVER a hard block; it tightens to an `error` block once M26 binds (severity is `error`
// so a bound over-cap projection blocks). PURE: reads ctx only.
import type { Rule } from "./types";
import { fail, pass, skip } from "./types";

const KEY = "aggregate_cap_projection";

const CAP_WARN_PCT = 95; // warn within 5% of the cap

export const aggregateCapProjection: Rule = {
  key: KEY,
  version: 1,
  category: "cap",
  title: "Aggregate cap projection within limit",
  description:
    "The patient's projected payments must be below the hospice aggregate cap (42 CFR §418.308); the " +
    "claim warns if it brings the agency-wide projection within 5% of the cap. Deferred (skipped) while " +
    "the M26 cap provider is a deny-stub; tightens to a hard error once bound (D8).",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "compliance_officer",
  defaultParameters: { warnPctOfCap: CAP_WARN_PCT },
  check: (ctx, params) => {
    if (!ctx.seams.capProjectionBound || ctx.capProjection === null) {
      return skip(
        KEY,
        "error",
        "seam_not_bound",
        "Cap projection (M26) not bound — aggregate-cap projection unavailable; deferred (non-blocking).",
      );
    }
    const cap = ctx.capProjection;
    const warnPct = paramNumber(params, "warnPctOfCap", CAP_WARN_PCT);

    if (!cap.patientWithinCap) {
      return fail(
        KEY,
        "error",
        "Projected payments exceed the hospice aggregate cap for the patient.",
        {
          summary: "Review the aggregate-cap projection; the patient is over the cap.",
          blameTarget: "patient",
          blameTargetId: ctx.claim.patientId,
          fixAction: "review_cap",
        },
        { orgPctOfCap: cap.orgPctOfCap },
      );
    }
    if (cap.orgPctOfCap >= warnPct) {
      return fail(
        KEY,
        "warn",
        `Agency-wide aggregate-cap projection is ${cap.orgPctOfCap}% of the cap (within ${100 - warnPct}%).`,
        {
          summary: "Monitor the agency-wide aggregate-cap projection; it is nearing the limit.",
          blameTarget: "claim",
          blameTargetId: ctx.claim.claimId,
          fixAction: "review_cap",
        },
        { orgPctOfCap: cap.orgPctOfCap, warnPctOfCap: warnPct },
      );
    }
    return pass(
      KEY,
      "error",
      `Aggregate-cap projection within limit (${cap.orgPctOfCap}% agency-wide).`,
    );
  },
};
