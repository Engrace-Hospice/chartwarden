// apps/backend/src/modules/41-billing-commercial/routes/route-classes.ts — ADR-0108 D5: the M41 routes (the mount plus
// the commercial claim and acknowledgment-quarantine registrars) that start NEW claims-billing work: claim assemble,
// ready, submit and the eligibility check. Validation, void, reconcile, authorizations, enrollment, payer-plan policy
// and the acknowledgment quarantine stay open. Ordered, first match wins.
import type { RouteClassRule } from "../../../bootstrap/claims-billing-gate";

export const M41_ROUTE_CLASSES: readonly RouteClassRule[] = [
  { cls: "new_work", method: "POST", path: "/api/v1/billing/commercial/claims/assemble" },
  { cls: "new_work", method: "POST", path: "/api/v1/billing/commercial/claims/:id/ready" },
  { cls: "new_work", method: "POST", path: "/api/v1/billing/commercial/claims/:id/submit" },
  { cls: "new_work", method: "POST", path: "/api/v1/billing/commercial/eligibility/check" },
  { cls: "open", method: "*", path: "/api/v1/billing/commercial/claims/*" },
  { cls: "open", method: "*", path: "/api/v1/billing/commercial/eligibility/*" },
  { cls: "open", method: "*", path: "/api/v1/billing/commercial/authorizations/*" },
  { cls: "open", method: "*", path: "/api/v1/billing/commercial/ack-quarantine/*" },
  { cls: "open", method: "*", path: "/api/v1/billing/commercial/payer-plans/*" },
  { cls: "open", method: "*", path: "/api/v1/billing/commercial/enrollments/*" },
];
