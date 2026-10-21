// @chartwarden/billing — M23 ABAC predicate-NAME catalog (§4.7).
//
// The four named ABAC predicates M23 registers into M3's named-predicate registry (the backend
// abac-predicates.ts provides the resolvers in P3). `inOrg` is the RE-USED M3 base predicate every M23
// route also composes (M3 owns its registration) and is NOT re-registered. The standard
// `caseload_or_scope` predicate is REUSED from M5 for patient-context reads — also not re-registered.
// Only the four names below are M23-owned.

/**
 * The §4.7 ABAC predicate names M23 owns:
 *   - provider_entity_billing_scope     — the actor's membership is scoped to the resource's ProviderEntity
 *     (or holds org-wide scope, or is a system principal for M25/M26 service-to-service seam calls).
 *   - claim_in_billing_manager_caseload — the claim's patient is in the actor's caseload AND the claim's
 *     ProviderEntity is in scope (all paths must pass for non-broad-scope roles).
 *   - override_role_eligible            — the actor holds the `override_role_required` role the failed
 *     validation_result's rule demands (typed M3 RoleKey check, not a string match).
 *   - regulatory_required_rule_protected — DENIES the rule-config OVERLAY-EDITING surface (routes 19/20/21)
 *     when the rule is `regulatoryRequired=true`; the per-instance override surface (route 16) is NOT
 *     denied by this predicate (D5 fine-grained distinction).
 */
export const M23_ABAC_PREDICATES = [
  "provider_entity_billing_scope",
  "claim_in_billing_manager_caseload",
  "override_role_eligible",
  "regulatory_required_rule_protected",
] as const;

export type M23AbacPredicateName = (typeof M23_ABAC_PREDICATES)[number];
