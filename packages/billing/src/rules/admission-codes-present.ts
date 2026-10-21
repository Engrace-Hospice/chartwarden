// @chartwarden/billing — §4.5 rule `admission_codes_present` (admission, error, regulatory). The UB-04 requires the Type
// of Admission (FL 14) and Point of Origin (FL 15) on every institutional claim, and Stedi's 837I schema requires the
// point of origin. The codes are recorded on the M6 admission and never invented, so a claim without them is
// blocked until they are recorded. PURE: reads ctx only; codes and ids, no PHI.
import type { Rule, RuleDefect } from "./types";
import { fail, pass, skip } from "./types";

const KEY = "admission_codes_present";

export const admissionCodesPresent: Rule = {
  key: KEY,
  version: 1,
  category: "admission",
  title: "Admission type and point of origin are recorded",
  description:
    "The claim carries the UB-04 Type of Admission (FL 14) and Point of Origin (FL 15) recorded on the admission.",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  check: (ctx) => {
    const { admissionTypeCode, admissionSourceCode, admissionId } = ctx.claim;
    if (admissionTypeCode === undefined && admissionSourceCode === undefined) {
      return skip(
        KEY,
        "error",
        "not_applicable",
        "No admission-code facts were materialized for this claim.",
      );
    }
    const defects: RuleDefect[] = [];
    if (admissionTypeCode == null) {
      defects.push({
        code: "ADMISSION_TYPE_MISSING",
        message: "The admission has no Type of Admission (UB-04 FL 14).",
        refs: { admissionId },
      });
    }
    if (admissionSourceCode == null) {
      defects.push({
        code: "ADMISSION_SOURCE_MISSING",
        message: "The admission has no Point of Origin (UB-04 FL 15).",
        refs: { admissionId },
      });
    }
    if (defects.length === 0) {
      return pass(KEY, "error", "Admission type and point of origin are recorded.");
    }
    const result = fail(KEY, "error", `${defects.length} admission code(s) are not recorded.`, {
      summary: "Record the admission type and point of origin on the admission, then re-validate.",
      blameTarget: "admission",
      blameTargetId: admissionId,
      fixAction: "record_admission_codes_in_m6",
    });
    return { ...result, annotations: { ...result.annotations, defects } };
  },
};
