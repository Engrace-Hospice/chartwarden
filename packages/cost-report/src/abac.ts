// @chartwarden/cost-report — M27 ABAC predicate-NAME catalog (§4.7).
//
// The three named ABAC predicates M27 registers into M3's named-predicate registry (the backend
// abac-predicates.ts provides the resolvers in P3). `inOrg` is the RE-USED M3 base predicate every M27
// route also composes (M3 owns its registration) and is NOT re-registered. `provider_entity_scope` is
// REUSED from M40 (the per-CCN scoping that defines the entire M27 surface) — also not re-registered by
// M27. Only the three names below are M27-owned.

/**
 * The §4.7 ABAC predicate names M27 owns:
 *   - cost_report_editor_for_provider  — the actor's membership is scoped to the report's ProviderEntity
 *     (or the encompassing org with `cost_report.edit_any_provider`); guards every edit surface.
 *   - cost_report_approver_for_provider — the actor holds the elevated-approval flag for the report's
 *     ProviderEntity; guards override / approve_for_submit / submit / reopen.
 *   - cost_report_period_active        — the report is in an editable lifecycle state (draft/populating);
 *     guards worksheet/import/bad-debt writes (a state-machine ABAC, not just RBAC).
 */
export const M27_ABAC_PREDICATES = [
  "cost_report_editor_for_provider",
  "cost_report_approver_for_provider",
  "cost_report_period_active",
] as const;

export type M27AbacPredicateName = (typeof M27_ABAC_PREDICATES)[number];
