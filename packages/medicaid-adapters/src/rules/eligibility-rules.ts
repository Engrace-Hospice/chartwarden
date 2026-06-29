// @wardenx/medicaid-adapters — §4.6 eligibility + recipient-ID rules. PURE: read ctx only.
import { fail, pass, skip } from "./types";
import type { MedicaidRule, RuleParameters } from "./types";

/** medicaid_eligibility_active — eligibility outcome must be active or mco_assignment; inactive blocks. */
export const medicaidEligibilityActive: MedicaidRule = {
  key: "medicaid_eligibility_active",
  version: 1,
  category: "eligibility",
  title: "Medicaid eligibility active",
  description:
    "The latest eligibility check for the patient resolves to 'active' or 'mco_assignment'; " +
    "'inactive' / 'unknown' / 'error' blocks submission.",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  applicableStates: [],
  check: (ctx) => {
    const KEY = "medicaid_eligibility_active";
    if (!ctx.seams.eligibilityBound || ctx.eligibility === null) {
      return skip(KEY, "error", "seam_not_bound", "Eligibility seam unbound; rule deferred.");
    }
    const o = ctx.eligibility.outcome;
    if (o === "active" || o === "mco_assignment") {
      return pass(KEY, "error", `Eligibility is '${o}'.`);
    }
    return fail(KEY, "error", `Eligibility is '${o}', not active.`, {
      summary: "Refresh the patient's Medicaid eligibility before billing.",
      blameTarget: "patient",
      fixAction: "refresh_eligibility",
    });
  },
};

/** medicaid_eligibility_freshness_30d — the most-recent check is within 30 days of submission (warn). */
export const medicaidEligibilityFreshness30d: MedicaidRule = {
  key: "medicaid_eligibility_freshness_30d",
  version: 1,
  category: "eligibility",
  title: "Medicaid eligibility freshness (30d)",
  description: "The most-recent eligibility check is within 30 days of submission.",
  severity: "warn",
  regulatoryRequired: false,
  overrideRoleRequired: "billing_manager",
  applicableStates: [],
  defaultParameters: { maxAgeDays: 30 },
  check: (ctx, params: RuleParameters) => {
    const KEY = "medicaid_eligibility_freshness_30d";
    if (!ctx.seams.eligibilityBound || ctx.eligibility === null) {
      return skip(KEY, "warn", "seam_not_bound", "Eligibility seam unbound; rule deferred.");
    }
    const maxAgeDays = typeof params.maxAgeDays === "number" ? params.maxAgeDays : 30;
    if (ctx.eligibility.ageDays <= maxAgeDays) {
      return pass(KEY, "warn", `Eligibility checked ${ctx.eligibility.ageDays}d ago.`);
    }
    return fail(
      KEY,
      "warn",
      `Eligibility check is ${ctx.eligibility.ageDays}d old (> ${maxAgeDays}d).`,
      { summary: "Refresh eligibility to keep the 30-day freshness window.", fixAction: "refresh_eligibility" },
      { ageDays: ctx.eligibility.ageDays },
    );
  },
};

/** medicaid_recipient_id_format — state-specific recipient-ID format validity (adapter-driven). */
export const medicaidRecipientIdFormat: MedicaidRule = {
  key: "medicaid_recipient_id_format",
  version: 1,
  category: "eligibility",
  title: "Medicaid recipient ID format",
  description:
    "The patient's state Medicaid Recipient ID matches the state-specific format the adapter declares " +
    "(e.g. Oregon OHP 8-digit mod-10). The digits are never read here — only the adapter's validity flag.",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  applicableStates: [],
  check: (ctx) => {
    const KEY = "medicaid_recipient_id_format";
    if (!ctx.seams.adapterBound || ctx.recipientIdFormatValid === null) {
      return skip(KEY, "error", "seam_not_bound", "Adapter recipient-ID validation unavailable; deferred.");
    }
    if (ctx.recipientIdFormatValid) {
      return pass(KEY, "error", "Recipient ID format is valid for the state.");
    }
    return fail(KEY, "error", "Recipient ID format is invalid for the state.", {
      summary: "Verify the recipient ID against the patient's Medicaid card.",
      blameTarget: "patient",
      fixAction: "edit_in_m5",
    });
  },
};
