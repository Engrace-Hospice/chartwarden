import { paramString } from "./_util";
// @wardenx/billing — §4.5 rule `modifier_codes_valid` (modifiers, error, regulatory). Required modifiers
// must be present where applicable and every modifier code must be valid per the current CMS list via
// M38 `cms_hospice_modifiers` (resolved as-of the claim's service-from). Reads the resolved
// `terminology` value-set membership; SKIPs when M38 is unbound. PURE: reads ctx only.
import type { Rule } from "./types";
import { fail, isMemberOf, pass, skip } from "./types";

const KEY = "modifier_codes_valid";

/** The one `@wardenx/billing` platform-default rule value set — exported so the M23 boot composition
 *  (F-124, #251) resolves the SAME id when it bulk pre-fetches M38's expansion, rather than each side
 *  carrying its own copy of the literal. */
export const CMS_HOSPICE_MODIFIER_VALUE_SET = "cms_hospice_modifiers";

const MODIFIER_VALUE_SET = CMS_HOSPICE_MODIFIER_VALUE_SET;

export const modifierCodesValid: Rule = {
  key: KEY,
  version: 1,
  category: "modifiers",
  title: "Modifier codes valid",
  description:
    "Every line modifier must be a current valid CMS hospice modifier (M38 cms_hospice_modifiers, " +
    "as-of service-from) and required modifiers must be present where applicable.",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  defaultParameters: { valueSetId: MODIFIER_VALUE_SET },
  check: (ctx, params) => {
    if (!ctx.seams.terminologyBound) {
      return skip(
        KEY,
        "error",
        "seam_not_bound",
        "Terminology (M38) not bound — modifier validation deferred.",
      );
    }
    const valueSetId = paramString(params, "valueSetId", MODIFIER_VALUE_SET);
    const invalid: string[] = [];
    for (const line of ctx.lines) {
      for (const modifier of line.modifiers) {
        if (!isMemberOf(ctx.terminology, valueSetId, modifier)) {
          invalid.push(`${line.serviceDate}: ${modifier}`);
        }
      }
    }
    if (invalid.length === 0) {
      return pass(KEY, "error", "All line modifiers are valid CMS hospice modifiers.");
    }
    return fail(
      KEY,
      "error",
      `${invalid.length} invalid modifier code(s) on the claim.`,
      {
        summary:
          "Remove or correct the invalid modifier(s) against the current CMS hospice modifier list.",
        blameTarget: "claim_line",
        fixAction: "edit_claim",
      },
      { invalidCount: invalid.length, firstInvalid: invalid[0] ?? "" },
    );
  },
};
