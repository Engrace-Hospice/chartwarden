// @wardenx/billing — §4.5 rule `noe_timeliness_5d` (noe, error, regulatory). The admission's Notice of
// Election must be in `ack_accepted` before the claim can bill (D3); CMS requires the NOE within 5
// calendar days of the hospice election. The rule warns at day 3 of admission and blocks at day 5+1
// unless overridden (42 CFR §418.24). `admissionDay` is PRECOMPUTED (clock-free). PURE: reads ctx only.
import type { Rule } from "./types";
import { fail, pass, skip } from "./types";

const KEY = "noe_timeliness_5d";

const NOE_WARN_DAY = 3;
const NOE_BLOCK_DAY = 6; // day 5 + 1 (CMS 5-day filing window exceeded)

export const noeTimeliness5d: Rule = {
  key: KEY,
  version: 1,
  category: "noe",
  title: "NOE accepted and timely (5-day window)",
  description:
    "The admission's Notice of Election must be ack-accepted before billing; CMS requires NOE filing " +
    "within 5 calendar days of election (42 CFR §418.24). Warn at admission day 3, block at day 5+1.",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "compliance_officer",
  defaultParameters: { warnDay: NOE_WARN_DAY, blockDay: NOE_BLOCK_DAY },
  check: (ctx, params) => {
    if (ctx.noe === null) {
      return fail(KEY, "error", "No Notice of Election exists for the admission.", {
        summary: "File the Notice of Election (D3) before billing the claim.",
        blameTarget: "admission",
        blameTargetId: ctx.claim.admissionId,
        fixAction: "file_noe",
      });
    }
    const warnDay = typeof params.warnDay === "number" ? (params.warnDay as number) : NOE_WARN_DAY;
    const blockDay =
      typeof params.blockDay === "number" ? (params.blockDay as number) : NOE_BLOCK_DAY;
    const noe = ctx.noe;

    if (noe.state === "ack_accepted") {
      return pass(KEY, "error", "Notice of Election is ack-accepted.");
    }
    // NOE not yet accepted: block once the 5-day window is breached, else warn near the deadline.
    if (noe.windowBreached || noe.admissionDay >= blockDay) {
      return fail(
        KEY,
        "error",
        `NOE not ack-accepted and the 5-day filing window is breached (admission day ${noe.admissionDay}).`,
        {
          summary: "Resolve the NOE (resubmit / correct) and obtain MAC acceptance before billing.",
          blameTarget: "admission",
          blameTargetId: ctx.claim.admissionId,
          fixAction: "resolve_noe",
        },
        { admissionDay: noe.admissionDay, noeState: noe.state },
      );
    }
    if (noe.admissionDay >= warnDay) {
      return fail(
        KEY,
        "warn",
        `NOE not yet ack-accepted (admission day ${noe.admissionDay}); approaching the 5-day deadline.`,
        {
          summary: "Submit/confirm the NOE before the 5-day window closes.",
          blameTarget: "admission",
          blameTargetId: ctx.claim.admissionId,
          fixAction: "resolve_noe",
        },
        { admissionDay: noe.admissionDay, noeState: noe.state },
      );
    }
    // Within the window but not yet accepted — pending, not yet a worklist item.
    return skip(
      KEY,
      "error",
      "not_applicable",
      `NOE pending within the 5-day window (day ${noe.admissionDay}).`,
    );
  },
};
