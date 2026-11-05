// apps/backend/src/modules/24-billing-medicaid/routes/route-classes.ts — ADR-0108 D5: the M24 routes that start NEW
// claims-billing work (claim create, submit, replace, eligibility) versus the open rest (drafts, validation, void,
// abandon, R&B, credentials, config, platform admin). Ordered, first match wins.
import type { RouteClassRule } from "../../../bootstrap/claims-billing-gate";

export const M24_ROUTE_CLASSES: readonly RouteClassRule[] = [
  { cls: "new_work", method: "POST", path: "/api/v1/medicaid-claims" },
  { cls: "new_work", method: "POST", path: "/api/v1/medicaid-claims/:id/submit" },
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
  { cls: "open", method: "*", path: "/api/v1/admin/platform-medicaid-rules/*" },
  { cls: "open", method: "*", path: "/api/v1/admin/state-rate-schedule-load/*" },
];
