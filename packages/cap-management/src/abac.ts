// @wardenx/cap-management — M26 ABAC predicate-NAME catalog (§4.7). The five named predicates M26 registers
// into M3's named-predicate registry (the backend abac-predicates.ts provides the Drizzle-backed resolvers
// in P3). `inOrg` / `caseload_or_scope` are REUSED base predicates M3/M5 own and are NOT re-registered here.
export const M26_ABAC_PREDICATES = [
  // cap_period.status IN ('open','active','reopened') — the accrual-eligible states (recompute route)
  "cap_period_open",
  // cap_period.status='in_settlement' AND a proposed cap_settlement exists (propose/finalize routes)
  "cap_period_in_settlement",
  // cap_period.status='settled' AND cap_settlement.status='final' (reopen route)
  "cap_period_settled",
  // cap_period.methodology IS NULL AND status<>'settled' (methodology-lock route; GAP-039)
  "cap_period_methodology_unlocked",
  // the actor holds the platform_admin role (all /v1/platform/cap/* routes)
  "cap_platform_admin",
] as const;

export type M26AbacPredicateName = (typeof M26_ABAC_PREDICATES)[number];
