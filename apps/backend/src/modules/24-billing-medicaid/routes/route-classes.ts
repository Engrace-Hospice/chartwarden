// apps/backend/src/modules/24-billing-medicaid/routes/route-classes.ts — ADR-0110 D5: the M24 routes that start NEW
// claims-billing work (claim create, submit, replace, eligibility) versus the open rest (drafts, validation, void,
// abandon, R&B, credentials, config, platform admin). Ordered, first match wins.
import { type RouteClassRule, exemptByRouteId } from "../../../bootstrap/claims-billing-gate";

/** Reads whether the org's claim is a void (TOB 818) — bound at the composition root over the database. */
export type IsVoidClaim = (organizationId: string, claimId: string) => Promise<boolean>;

/**
 * The rules. With `isVoidClaim`, submitting a VOID claim is exempt from the gate (a void retracts a claim already sent;
 * the owner keeps voids available without the add-on). Replacements (817) stay new work.
 */
export function m24RouteClasses(isVoidClaim?: IsVoidClaim): readonly RouteClassRule[] {
  return [
    { cls: "new_work", method: "POST", path: "/api/v1/medicaid-claims" },
    { cls: "open", method: "POST", path: "/api/v1/medicaid-claims/assembly-preview" },
    { cls: "open", method: "POST", path: "/api/v1/medicaid-chc-pricing-preparations" },
    { cls: "open", method: "GET", path: "/api/v1/medicaid-chc-pricing-preparations/*" },
    {
      cls: "new_work",
      method: "POST",
      path: "/api/v1/medicaid-claims/:id/submit",
      ...(isVoidClaim ? { exempt: exemptByRouteId(isVoidClaim) } : {}),
    },
    { cls: "new_work", method: "POST", path: "/api/v1/medicaid-claims/:id/replace" },
    { cls: "new_work", method: "POST", path: "/api/v1/medicaid-eligibility-checks" },
    { cls: "open", method: "*", path: "/api/v1/medicaid-claims/*" },
    { cls: "open", method: "*", path: "/api/v1/medicaid-eligibility-checks/*" },
    { cls: "open", method: "*", path: "/api/v1/medicaid-validation-results/*" },
    { cls: "open", method: "*", path: "/api/v1/medicaid-validation-runs/*" },
    { cls: "open", method: "*", path: "/api/v1/medicaid-validation-overrides/*" },
    { cls: "open", method: "*", path: "/api/v1/medicaid-validation-worklist/*" },
    { cls: "open", method: "*", path: "/api/v1/medicaid-rule-config/*" },
    { cls: "open", method: "*", path: "/api/v1/medicaid-ar-dashboard/*" },
    { cls: "open", method: "*", path: "/api/v1/rb-arrangements/*" },
    { cls: "open", method: "*", path: "/api/v1/rb-days/*" },
    { cls: "open", method: "*", path: "/api/v1/state-medicaid-trading-partner-credentials/*" },
    // Payer-readiness evidence is configuration, not new claims work (ADR-0110 D5).
    { cls: "open", method: "*", path: "/api/v1/medicaid-program-assignments/*" },
    { cls: "open", method: "*", path: "/api/v1/medicaid-enrollment-evidence/*" },
    { cls: "open", method: "*", path: "/api/v1/admin/platform-medicaid-rules/*" },
    { cls: "open", method: "*", path: "/api/v1/admin/state-rate-schedule-load/*" },
  ];
}

/** The rules without the void exemption (route enumeration and tests). */
export const M24_ROUTE_CLASSES: readonly RouteClassRule[] = m24RouteClasses();
