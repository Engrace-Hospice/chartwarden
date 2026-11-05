// apps/backend/src/modules/23-billing-medicare/routes/route-classes.ts — ADR-0108 D5: which M23 routes start NEW
// claims-billing work (gated by the add-on) and which stay open. Ordered, first match wins: the new-work exceptions
// come before the open prefix that would otherwise cover them. NOE / NOTR / transfer notices, voids, draft edits,
// validation, acknowledgments and configuration stay OPEN (CMS 5-day deadlines; finish in-flight work).
// `claims-billing-route-classes.test.ts` fails on an unclassified mutating route or a rule that matches nothing.
import type { RouteClassRule } from "../../../bootstrap/claims-billing-gate";

export const M23_ROUTE_CLASSES: readonly RouteClassRule[] = [
  { cls: "new_work", method: "POST", path: "/api/v1/billing/claims/assemble" },
  { cls: "new_work", method: "POST", path: "/api/v1/billing/claims/:id/submit" },
  { cls: "new_work", method: "POST", path: "/api/v1/billing/claims/:id/replace" },
  { cls: "new_work", method: "POST", path: "/api/v1/billing/eligibility/check" },
  { cls: "new_work", method: "POST", path: "/api/v1/billing/dde-items" },
  { cls: "new_work", method: "POST", path: "/api/v1/billing/dde-items/:id/record-submission" },
  { cls: "new_work", method: "POST", path: "/api/v1/billing/dde-items/:id/submit-via-provider" },
  { cls: "new_work", method: "POST", path: "/api/v1/billing/dde-items/:id/retry" },
  { cls: "open", method: "*", path: "/api/v1/billing/claims/*" },
  { cls: "open", method: "*", path: "/api/v1/billing/eligibility/*" },
  { cls: "open", method: "*", path: "/api/v1/billing/dde-items/*" },
  { cls: "open", method: "*", path: "/api/v1/claims/*" },
  { cls: "open", method: "*", path: "/api/v1/noe-records/*" },
  { cls: "open", method: "*", path: "/api/v1/notr-records/*" },
  { cls: "open", method: "*", path: "/api/v1/billing/transfer-notices/*" },
  { cls: "open", method: "*", path: "/api/v1/billing/clearinghouse-attempts/*" },
  { cls: "open", method: "*", path: "/api/v1/billing/rule-configs/*" },
  { cls: "open", method: "*", path: "/api/v1/billing/validation-overrides/*" },
  { cls: "open", method: "*", path: "/api/v1/billing/claim-validation-summary/*" },
  { cls: "open", method: "*", path: "/api/v1/billing/sequestration-policies/*" },
  { cls: "open", method: "*", path: "/api/v1/billing/mac-credentials/*" },
  { cls: "open", method: "*", path: "/api/v1/billing/edi-profiles/*" },
  { cls: "open", method: "*", path: "/api/v1/billing/rate-tables/*" },
  { cls: "open", method: "*", path: "/api/v1/billing/visit-charge-schedules/*" },
  { cls: "open", method: "*", path: "/api/v1/billing/wage-indexes/*" },
  { cls: "open", method: "*", path: "/api/v1/billing/ar-dashboard/*" },
  { cls: "open", method: "*", path: "/api/v1/billing/metrics/*" },
  { cls: "open", method: "*", path: "/api/v1/internal/billing/*" },
  { cls: "open", method: "*", path: "/api/v1/admin/billing/*" },
];
