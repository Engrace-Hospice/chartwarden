// @chartwarden/billing — §4.5 rule `cbsa_value_codes_present` (wage, error, regulatory). A hospice claim reports value code
// 61 (CBSA of the beneficiary's residence, home levels of care) and/or G8 (CBSA of the latest inpatient facility,
// inpatient levels) — the pricer wage-adjusts with them (CMS Pub. 100-04 ch. 11 §30.3). The code comes from the
// patient's / facility's ZIP via the platform geography tables and is never guessed: when a required code cannot be
// placed the claim is blocked until the address is fixed. PURE: reads ctx only; codes and reasons, no address/PHI.
import type { MissingValueCode } from "../cbsa";
import type { Rule, RuleDefect } from "./types";
import { fail, pass, skip } from "./types";

const KEY = "cbsa_value_codes_present";

const REASON_TEXT: Readonly<Record<MissingValueCode["reason"], string>> = {
  invalid_zip: "the recorded ZIP code is not a valid 5-digit ZIP",
  zip_unknown: "the recorded ZIP code is not in the CMS wage-index geography",
  county_unknown: "the ZIP's county has no CMS wage-index area for this fiscal year",
  no_zip_recorded: "no ZIP code is recorded for it",
  no_facility_stay: "no inpatient facility found for the claim's inpatient dates",
  ambiguous_facility:
    "more than one facility with different (or missing) ZIP codes served the last inpatient day",
};

const SOURCE: Readonly<Record<MissingValueCode["code"], string>> = {
  "61": "the patient's residence at the end of the billing period",
  G8: "the latest inpatient facility",
};

const defectOf = (m: MissingValueCode): RuleDefect => ({
  code: `VALUE_CODE_${m.code}_UNRESOLVED`,
  message: `Value code ${m.code} (CBSA of ${SOURCE[m.code]}) cannot be reported: ${REASON_TEXT[m.reason]}.`,
});

export const cbsaValueCodesPresent: Rule = {
  key: KEY,
  version: 1,
  category: "wage",
  title: "Wage-index CBSA value codes are resolved",
  description:
    "Home-level lines need value code 61 (residence CBSA) and inpatient-level lines value code G8 (facility CBSA) " +
    "so the Medicare pricer can wage-adjust the claim.",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  check: (ctx) => {
    const resolution = ctx.claim.valueCodes;
    if (resolution === undefined) {
      return skip(
        KEY,
        "error",
        "not_applicable",
        "No value-code resolution was materialized for this claim.",
      );
    }
    if (resolution.missing.length === 0) {
      return pass(KEY, "error", "Every required wage-index value code is resolved.");
    }
    const result = fail(
      KEY,
      "error",
      `${resolution.missing.length} required value code(s) could not be resolved.`,
      {
        summary:
          "Correct the patient residence address (or the inpatient facility's address) so its ZIP code places it in a CMS wage-index area, then re-validate.",
        blameTarget: "patient",
        fixAction: "fix_address_in_m5",
      },
    );
    return {
      ...result,
      annotations: { ...result.annotations, defects: resolution.missing.map(defectOf) },
    };
  },
};
