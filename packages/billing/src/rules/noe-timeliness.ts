// @wardenx/billing — §4.5 rule `noe_timeliness_5d` (noe, error, regulatory). The admission's Notice of
// Election must be in `ack_accepted` before the claim can bill (D3); CMS requires the NOE within 5
// calendar days of the hospice election. The rule warns at day 3 of admission and blocks at day 5+1
// unless overridden (42 CFR §418.24). `admissionDay` is PRECOMPUTED (clock-free). PURE: reads ctx only.
//
// Once the NOE is accepted, the rule judges it by the MAC's acceptance date (ch. 11 §20.1.1: timely = submitted to
// AND accepted by the MAC within 5 calendar days after admission). A late NOE does not block the claim — the days
// from admission through the day before acceptance are provider liability, reported as occurrence span 77, which
// the validation service derives onto the claim (`lateNoeOccurrenceSpan`); the rule reports it (info).
import { lateNoeOccurrenceSpan, noeTimeliness } from "../notice/late-noe";
import type { NoeStatusSnapshot, Rule, RuleResult, ValidationContext } from "./types";
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

    if (noe.state === "ack_accepted") return acceptedResult(ctx, noe);
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

/** An accepted NOE: timely, late with this claim's OSC 77 span, or of unknown timeliness (no acceptance date). */
function acceptedResult(ctx: ValidationContext, noe: NoeStatusSnapshot): RuleResult {
  const timeliness = noeTimeliness({
    admissionDate: noe.electionEffectiveDate,
    acceptedDate: noe.acceptedDate,
  });
  if (timeliness.status === "unknown" || noe.acceptedDate === null) {
    return fail(
      KEY,
      "warn",
      "NOE is ack-accepted but its acceptance date is not on record; the late-NOE occurrence span 77 cannot be determined.",
      {
        summary: "Confirm the NOE acceptance date with the MAC before billing.",
        blameTarget: "admission",
        blameTargetId: ctx.claim.admissionId,
        fixAction: "resolve_noe",
      },
    );
  }
  const source = noe.acceptedDateSource ?? "receipt";
  if (timeliness.status === "timely") {
    return pass(
      KEY,
      "error",
      `Notice of Election accepted on ${noe.acceptedDate} (${source}), within the 5-day window (due ${timeliness.dueDate}).`,
    );
  }
  const span = lateNoeOccurrenceSpan({
    admissionDate: noe.electionEffectiveDate,
    acceptedDate: noe.acceptedDate,
    serviceFrom: ctx.claim.serviceFrom,
    serviceTo: ctx.claim.serviceTo,
  });
  if (span === null) {
    return pass(
      KEY,
      "error",
      `Notice of Election accepted late on ${noe.acceptedDate}; none of this claim's days are provider liable.`,
    );
  }
  return fail(
    KEY,
    "info",
    `Late NOE: accepted on ${noe.acceptedDate} (${source}), ${timeliness.daysLate} day(s) after the ${timeliness.dueDate} due date. Days ${span.from} through ${span.through} are provider liability, reported as occurrence span ${span.code}.`,
    {
      summary:
        "Report the claim lines on the occurrence-span-77 days as non-covered; request a CMS exception if one of the ch. 11 §20.1.1 circumstances applies.",
      blameTarget: "admission",
      blameTargetId: ctx.claim.admissionId,
      fixAction: "resolve_noe",
    },
    {
      daysLate: timeliness.daysLate ?? 0,
      dueDate: timeliness.dueDate,
      acceptedDate: noe.acceptedDate,
      acceptedDateSource: source,
      occurrenceSpanCode: span.code,
      occurrenceSpanFrom: span.from,
      occurrenceSpanThrough: span.through,
    },
  );
}
