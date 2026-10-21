import { periodCoversDate } from "./_util";
// @chartwarden/billing — §4.5 rule `election_period_active` (period, error, regulatory). A valid hospice
// election period (M6) must cover every service date on the claim; a revoked patient's coverage ends on
// the revocation date (D5). Reads the resolved `electionPeriods` snapshot + the claim's line service
// dates. PURE: reads ctx only.
import type { Rule } from "./types";
import { fail, pass } from "./types";

const KEY = "election_period_active";

export const electionPeriodActive: Rule = {
  key: KEY,
  version: 1,
  category: "period",
  title: "Active election period covers all service dates",
  description:
    "Every service date on the claim must fall within an active hospice election period; for a revoked " +
    "election, coverage ends on the revocation date (42 CFR §418.24 / §418.28).",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "medical_director",
  check: (ctx) => {
    if (ctx.electionPeriods.length === 0) {
      return fail(KEY, "error", "No hospice election period exists for the patient.", {
        summary: "Record the hospice election (M6) before billing.",
        blameTarget: "admission",
        blameTargetId: ctx.claim.admissionId,
        fixAction: "edit_in_m6",
      });
    }
    // Service dates to cover: each line's service date, plus the claim window endpoints as a backstop.
    const dates = new Set<string>([ctx.claim.serviceFrom, ctx.claim.serviceTo]);
    for (const line of ctx.lines) dates.add(line.serviceDate);

    const uncovered: string[] = [];
    for (const date of dates) {
      if (!ctx.electionPeriods.some((p) => periodCoversDate(p, date))) uncovered.push(date);
    }
    if (uncovered.length === 0) {
      return pass(
        KEY,
        "error",
        "An active election period covers every service date on the claim.",
      );
    }
    return fail(
      KEY,
      "error",
      `${uncovered.length} service date(s) are not covered by an active election period.`,
      {
        summary:
          "Trim the claim to the elected/un-revoked range or correct the election period in M6; " +
          "service dates fall outside any active election.",
        blameTarget: "election_period",
        fixAction: "edit_in_m6",
      },
      { uncoveredDateCount: uncovered.length, firstUncoveredDate: uncovered[0] ?? "" },
    );
  },
};
