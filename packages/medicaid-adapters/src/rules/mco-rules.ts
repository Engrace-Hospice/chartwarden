// @chartwarden/medicaid-adapters — §4.6 MCO routing rule. PURE: read ctx only.
import { fail, pass, skip } from "./types";
import type { MedicaidRule } from "./types";

/**
 * medicaid_mco_assignment_routes — if eligibility resolves to an MCO assignment, the channel resolved from
 * M40 state_medicaid_mco.routing_channel must match an ACTIVE credential row for the service date.
 */
export const medicaidMcoAssignmentRoutes: MedicaidRule = {
  key: "medicaid_mco_assignment_routes",
  version: 1,
  category: "mco",
  title: "MCO assignment routes correctly",
  description:
    "When the patient is MCO/CCO-enrolled, the resolved submission channel matches an active " +
    "trading-partner credential for that MCO on the service date.",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  applicableStates: [],
  check: (ctx) => {
    const KEY = "medicaid_mco_assignment_routes";
    if (ctx.mcoRouting === null) {
      return skip(KEY, "error", "seam_not_bound", "MCO routing facts unavailable; deferred.");
    }
    if (!ctx.mcoRouting.eligibilityIsMcoAssignment) {
      return pass(KEY, "error", "Patient is FFS / Open Card; no MCO routing required.");
    }
    if (ctx.mcoRouting.resolvedChannel !== null && ctx.mcoRouting.hasActiveCredentialForChannel) {
      return pass(
        KEY,
        "error",
        `MCO routes to '${ctx.mcoRouting.resolvedChannel}' with an active credential.`,
      );
    }
    return fail(
      KEY,
      "error",
      ctx.mcoRouting.resolvedChannel === null
        ? "No routing channel resolved for the patient's MCO assignment."
        : `No active credential for channel '${ctx.mcoRouting.resolvedChannel}'.`,
      {
        summary: "Configure the MCO/CCO trading-partner credential (M34 wizard) before submitting.",
        fixAction: "configure_credential_in_m34",
      },
    );
  },
};
