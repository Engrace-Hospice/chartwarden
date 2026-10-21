// @chartwarden/medicaid-adapters — §4.6 COB (dual-eligible) + rate-schedule rules. PURE: read ctx only.
import { fail, pass, skip } from "./types";
import type { MedicaidRule } from "./types";

/** M23 claim states from which a Medicaid-secondary COB claim may reference the Medicare-primary. */
const MEDICARE_RESOLVED_STATES = new Set(["ack_accepted", "paid", "partial_paid", "replaced"]);

/**
 * medicare_primary_required_for_dual — for a dual-eligible patient, the Medicaid (R&B) claim's
 * medicareClaimId references an M23 claim in ACK_ACCEPTED or further, with a non-null EOB COB context.
 */
export const medicarePrimaryRequiredForDual: MedicaidRule = {
  key: "medicare_primary_required_for_dual",
  version: 1,
  category: "cob",
  title: "Medicare-primary required for dual-eligible",
  description:
    "For dual-eligible patients, the Medicaid claim references a Medicare-primary claim that has reached " +
    "ACK_ACCEPTED (or further) and carries the snapshotted EOB COB context.",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  applicableStates: [],
  check: (ctx) => {
    const KEY = "medicare_primary_required_for_dual";
    if (!ctx.claim.isDualEligible) {
      return pass(KEY, "error", "Patient is not dual-eligible; Medicare-primary not required.");
    }
    if (!ctx.seams.medicareClaimBound || ctx.medicareSecondary === null) {
      return skip(KEY, "error", "seam_not_bound", "M23 ClaimReader unbound; COB rule deferred.");
    }
    const ms = ctx.medicareSecondary;
    const resolved =
      ms.medicareClaimState !== null && MEDICARE_RESOLVED_STATES.has(ms.medicareClaimState);
    if (ctx.claim.medicareClaimId !== null && resolved && ms.eobContextPresent) {
      return pass(KEY, "error", `Medicare-primary is '${ms.medicareClaimState}' with EOB context.`);
    }
    return fail(
      KEY,
      "error",
      ctx.claim.medicareClaimId === null
        ? "Dual-eligible claim has no linked Medicare-primary claim."
        : `Medicare-primary not yet accepted (state '${ms.medicareClaimState ?? "unknown"}').`,
      {
        summary: "Submit/accept the Medicare-primary claim (M23) before billing Medicaid R&B.",
        fixAction: "resolve_medicare_primary",
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
