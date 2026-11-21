// @chartwarden/medicaid-adapters — §4.6 COB (dual-eligible) + rate-schedule rules. PURE: read ctx only.
import { fail, pass, skip } from "./types";
import type { MedicaidRule } from "./types";

/** Mandatory platform gate: both payers and their full-range responsibility must be resolved by M5. */
export const medicaidPayerResponsibilityResolved: MedicaidRule = {
  key: "medicaid_payer_responsibility_resolved",
  version: 1,
  category: "cob",
  title: "Payer responsibility is resolved",
  description:
    "The selected Medicaid coverage and actual primary payer must be unambiguous for the complete service window, and the claim kind must be permitted by current payer policy.",
  severity: "error",
  regulatoryRequired: false,
  platformRequired: true,
  applicableStates: [],
  check: (ctx) => {
    const KEY = "medicaid_payer_responsibility_resolved";
    if (ctx.payerResponsibility.status === "permitted") {
      return pass(
        KEY,
        "error",
        "Payer responsibility is permitted for this claim kind and service window.",
      );
    }
    return fail(
      KEY,
      "error",
      ctx.payerResponsibility.status === "unresolved"
        ? "Payer responsibility could not be resolved for the complete service window."
        : `Payer responsibility does not permit this claim (${ctx.payerResponsibility.reasonCode ?? "policy_unresolved"}).`,
      {
        summary: "Resolve coverage and payer responsibility before this claim can become ready.",
        fixAction: "resolve_payer_responsibility",
      },
    );
  },
};

/**
 * medicare_primary_required_for_dual is an internal readiness gate while the applicable state format and
 * COB requirements remain unresolved. It deliberately does not prescribe whether an acknowledgment,
 * adjudication, remittance, or payment is required for any future R&B-only format. M23 evidence is exposed
 * separately by the read-only assembly preview; it cannot satisfy this gate or authorize secondary assembly.
 */
export const medicarePrimaryRequiredForDual: MedicaidRule = {
  key: "medicare_primary_required_for_dual",
  version: 2,
  category: "cob",
  title: "Secondary Medicaid policy confirmed",
  description:
    "Secondary Medicaid assembly remains unavailable until the applicable state claim format and coordination-of-benefits requirements are confirmed. This internal gate does not define a universal Medicare payment threshold.",
  severity: "error",
  regulatoryRequired: false,
  platformRequired: true,
  applicableStates: [],
  check: (ctx) => {
    const KEY = "medicare_primary_required_for_dual";
    if (!ctx.claim.hasConcurrentMedicareAndMedicaidCoverage) {
      return pass(
        KEY,
        "error",
        "The recorded payer scenario does not require the unresolved secondary Medicaid policy gate.",
      );
    }
    return fail(
      KEY,
      "error",
      "The applicable state-specific secondary Medicaid claim format and COB evidence requirements are unconfirmed. Medicare acknowledgment, adjudication, remittance, or payment facts do not independently authorize this claim.",
      {
        summary:
          "Keep secondary Medicaid assembly blocked until the billing owner confirms the supported format and required coordination evidence.",
        fixAction: "confirm_state_secondary_medicaid_policy",
      },
    );
  },
};

/** A legacy or directly-created Medicare link is not sufficient COB evidence for M24 readiness. */
export const medicaidMedicareClaimLinkageSupported: MedicaidRule = {
  key: "medicaid_medicare_linkage_supported",
  version: 1,
  category: "cob",
  title: "Medicare claim linkage is supported",
  description:
    "A Medicaid claim cannot become ready while it carries a Medicare claim reference without a qualified, correlated COB evidence contract.",
  severity: "error",
  regulatoryRequired: false,
  platformRequired: true,
  applicableStates: [],
  check: (ctx) => {
    const KEY = "medicaid_medicare_linkage_supported";
    if (ctx.claim.medicareClaimId === null) {
      return pass(KEY, "error", "No unsupported Medicare claim reference is attached.");
    }
    return fail(
      KEY,
      "error",
      "This claim has a Medicare claim reference without a qualified COB evidence contract. It cannot become ready based on the reference alone.",
      {
        summary:
          "Reconcile the unsupported Medicare claim link before this Medicaid claim can become ready.",
        fixAction: "reconcile_medicare_claim_link",
      },
    );
  },
};

/**
 * medicaid_rate_schedule_present_for_service_date — every claim line resolves a non-null state rate
 * schedule rate for its LOC + service date, and the snapshotted rate is positive.
 */
export const medicaidRateSchedulePresentForServiceDate: MedicaidRule = {
  key: "medicaid_rate_schedule_present_for_service_date",
  version: 1,
  category: "rate",
  title: "Rate schedule present for service date",
  description:
    "Each claim line resolves a non-null state rate schedule rate for its LOC and service date.",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  applicableStates: [],
  check: (ctx) => {
    const KEY = "medicaid_rate_schedule_present_for_service_date";
    if (!ctx.seams.rateScheduleBound) {
      return skip(KEY, "error", "seam_not_bound", "Rate-schedule seam unbound; rule deferred.");
    }
    const missing = ctx.rateLookups.filter(
      (r) => !r.rateFound || r.rateCents === null || r.rateCents <= 0,
    );
    if (missing.length === 0 && ctx.rateLookups.length > 0) {
      return pass(KEY, "error", "All lines resolve a positive rate-schedule rate.");
    }
    if (ctx.rateLookups.length === 0) {
      return fail(KEY, "error", "No rate lookups present for the claim lines.", {
        summary: "Ensure the state rate schedule is loaded for the service period.",
        fixAction: "load_rate_schedule",
      });
    }
    return fail(
      KEY,
      "error",
      `${missing.length} line(s) have no rate-schedule rate for the service date.`,
      {
        summary: "Load the state rate schedule for the affected LOC/date(s).",
        fixAction: "load_rate_schedule",
      },
      { missingRates: missing.length },
    );
  },
};
