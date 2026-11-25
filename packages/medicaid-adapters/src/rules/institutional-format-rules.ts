// M24 platform safety rule: local coding evidence may support draft preparation, but not READY,
// which enables the submission action in the claim state machine.
import { fail, pass } from "./types";
import type { MedicaidRule } from "./types";

/** Prevents a locally useful but unqualified hospice line profile from reaching submission-ready state. */
export const medicaidHospiceInstitutionalFormatQualified: MedicaidRule = {
  key: "medicaid_hospice_institutional_format_qualified",
  version: 1,
  category: "documentation",
  title: "Hospice institutional billing format is qualified",
  description:
    "Hospice lines may reach READY only when their coding and unit profile is qualified for the applicable institutional claim format.",
  severity: "error",
  regulatoryRequired: false,
  platformRequired: true,
  applicableStates: [],
  check: (ctx) => {
    const key = "medicaid_hospice_institutional_format_qualified";
    if (
      ctx.claim.kind === "rb_only" ||
      !ctx.lines.some((line) => !line.isRb) ||
      ctx.hospiceInstitutionalFormatQualified === true
    ) {
      return pass(
        key,
        "error",
        "Hospice institutional billing format is qualified or not applicable.",
      );
    }
    return fail(
      key,
      "error",
      "The hospice billing profile supports local draft preparation but is not qualified for the institutional claim format.",
      {
        summary:
          "Keep the claim in draft preparation until coding, units, and the applicable institutional format are qualified.",
        fixAction: "qualify_medicaid_institutional_format",
      },
    );
  },
};
