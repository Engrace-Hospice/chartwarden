// @chartwarden/medicaid-adapters — §4.6 state-specific modifier + documentation rules (adapter-published).
// PURE: read ctx only. The adapter publishes the requirement set; the service layer reduces it to a
// boolean the rule reads. A `null` flag means the adapter declares no requirement → SKIP not_applicable.
import { fail, pass, skip } from "./types";
import type { MedicaidRule } from "./types";

/** medicaid_state_specific_modifiers_valid — state-specific HCPCS modifier requirements are satisfied. */
export const medicaidStateSpecificModifiersValid: MedicaidRule = {
  key: "medicaid_state_specific_modifiers_valid",
  version: 1,
  category: "modifiers",
  title: "State-specific modifiers valid",
  description:
    "State-specific HCPCS modifier requirements (e.g. an Oregon CCO claim's CCO modifier) are present on " +
    "the required LOC/revenue-code lines, per the adapter's published requirement set.",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  applicableStates: [],
  check: (ctx) => {
    const KEY = "medicaid_state_specific_modifiers_valid";
    if (ctx.modifiersSatisfied === null) {
      return skip(
        KEY,
        "error",
        "not_applicable",
        "No state-specific modifier requirement for this claim.",
      );
    }
    return ctx.modifiersSatisfied
      ? pass(KEY, "error", "State-specific modifiers satisfied.")
      : fail(KEY, "error", "Required state-specific modifier(s) missing.", {
          summary: "Add the state/MCO-required HCPCS modifier(s) to the affected line(s).",
          blameTarget: "claim_line",
          fixAction: "edit_claim_line",
        });
  },
};

/** medicaid_state_specific_documentation — state-specific documentation requirements are satisfied. */
export const medicaidStateSpecificDocumentation: MedicaidRule = {
  key: "medicaid_state_specific_documentation",
  version: 1,
  category: "documentation",
  title: "State-specific documentation",
  description:
    "State-specific documentation requirements (e.g. an Oregon CCO assignment letter attached via M22) " +
    "are satisfied, per the adapter's published requirement set.",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  applicableStates: [],
  check: (ctx) => {
    const KEY = "medicaid_state_specific_documentation";
    if (ctx.documentationSatisfied === null) {
      return skip(
        KEY,
        "error",
        "not_applicable",
        "No state-specific documentation requirement for this claim.",
      );
    }
    return ctx.documentationSatisfied
      ? pass(KEY, "error", "State-specific documentation satisfied.")
      : fail(KEY, "error", "Required state-specific documentation missing.", {
          summary: "Attach the state/MCO-required document(s) (M22) before submitting.",
          fixAction: "attach_document",
        });
  },
};
