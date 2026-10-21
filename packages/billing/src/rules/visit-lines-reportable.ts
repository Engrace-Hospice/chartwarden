// @chartwarden/billing — §4.5 rule `visit_lines_reportable` (visits, warn, regulatory). CMS requires every visit by
// hospice staff on the claim (Pub. 100-04 ch. 11 §30.3), in 15-minute units. A billable visit with no documented
// duration — or outside every level-of-care period — cannot be turned into a line without inventing data, so the
// assembly SKIPS it; this rule surfaces each skipped visit (encounter ids and reason codes only, no PHI) as a
// non-blocking warning so a biller can document it and re-validate. PURE: reads ctx only.
import type { RuleDefect, VisitReportingSnapshot } from "./types";
import type { Rule } from "./types";
import { fail, pass, skip } from "./types";

const KEY = "visit_lines_reportable";

type Unresolved = VisitReportingSnapshot["unresolved"][number];

const DEFECT_BY_REASON: Readonly<Record<Unresolved["reason"], { code: string; message: string }>> =
  {
    duration_missing: {
      code: "VISIT_DURATION_MISSING",
      message:
        "The visit has no documented start/end time, so its 15-minute units cannot be reported.",
    },
    no_level_of_care_period: {
      code: "VISIT_NO_LEVEL_OF_CARE_PERIOD",
      message:
        "No level-of-care period covers the visit date, so the visit cannot be placed on the claim.",
    },
  };

const defectOf = (u: Unresolved): RuleDefect => ({
  ...DEFECT_BY_REASON[u.reason],
  refs: { encounterId: u.encounterId },
});

export const visitLinesReportable: Rule = {
  key: KEY,
  version: 1,
  category: "visits",
  title: "Billable visits are reported on the claim",
  description:
    "Every billable visit by hospice staff is reported as its own 15-minute-unit line (CMS Pub. 100-04 ch. 11 " +
    "§30.3). A visit that cannot be reported (undocumented duration, no covering level-of-care period) is " +
    "skipped and listed here so it can be documented.",
  severity: "warn",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  check: (ctx) => {
    if (ctx.visitReporting === undefined) {
      return skip(
        KEY,
        "warn",
        "not_applicable",
        "No visit reporting was materialized for this claim.",
      );
    }
    const { unresolved } = ctx.visitReporting;
    if (unresolved.length === 0) {
      return pass(KEY, "warn", "Every billable visit is reported on the claim.");
    }
    const result = fail(
      KEY,
      "warn",
      `${unresolved.length} billable visit(s) could not be reported on the claim.`,
      {
        summary:
          "Document the visit start/end times (or the level of care covering the visit date) in the clinical record, then re-validate; the claim is missing these visit lines until then.",
        blameTarget: "encounter",
        fixAction: "document_visit_in_m8",
      },
      { unreportedVisitCount: unresolved.length },
    );
    return {
      ...result,
      annotations: { ...result.annotations, defects: unresolved.map(defectOf) },
    };
  },
};
