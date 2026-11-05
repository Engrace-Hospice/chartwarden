// @chartwarden/saas-tenant-platform · onboarding — the canonical onboarding steps (M34 §2.3 / §3.12; wizard order v2,
// migration 1327).
//
// The §2.3 machine's STATE FLOOR is data-driven (D3): the authoritative source is the platform-seeded
// `onboarding_task_template` catalog (§3.12), read at runtime via the OnboardingRepository. This module
// mirrors the canonical eleven-step ORDER + key set as a type-level constant so:
//   (1) the pure machine can be built/unit-tested with the canonical floor without a DB read, and
//   (2) a typo in a seed step key (one that is NOT in this canonical set) is detectable.
// It does NOT duplicate the seed's mutable policy (labels, due-day offsets, required roles, the
// precondition expressions) — those live ONLY in the seed so a copy change stays a seed change (D3).
// Agency-specific (non-canonical, canonical_order >= 100) steps are NOT listed here; the machine builds
// its graph from whatever templates the repo returns, in `canonical_order`, with these eleven as the
// known canonical floor.

/** The canonical onboarding step keys, in `canonical_order` (the ops wizard order seeded by migration 1327; the retired
 *  org_seeded / xero_connected / payroll_connected keys stay in the catalog as history but are not listed). These
 *  are `onboarding_task_template.key` values; the per-tenant `onboarding_task.template_key` references
 *  them. The sub-state pattern (`in_progress → blocked → in_progress → [*]` or `→ skipped → [*]`) is
 *  uniform across every step (§2.3) and lives in the machine, not per-step. */
export const CANONICAL_ONBOARDING_STEPS = [
  "account_created",
  "plan_contract",
  "baa_executed",
  "provisioning_complete",
  "ccn_registered",
  "locations_seeded",
  "clearinghouse_selected",
  "mac_configured",
  "payer_enrollment",
  "dosespot_kickoff_initiated",
  "first_admin_invited",
  "compliance_officer_assigned",
  "sample_data_loaded",
  "go_live_checklist_complete",
] as const;

/** One canonical onboarding step key. */
export type CanonicalOnboardingStep = (typeof CANONICAL_ONBOARDING_STEPS)[number];

/**
 * The `precondition_dsl` migration 1327 writes on the `go_live_checklist_complete` template.
 *
 * ROLLBACK SAFETY. Migrations 1327-1329 are `expand`, so deploy.sh may restore the previous release over them. That
 * release's sweep settles a step whose precondition holds, treats a NULL precondition as met, and then activates the
 * tenant once every canonical step is settled: a NULL here would let a restored release take a tenant live with no
 * compliance-officer attestation and no platform approval. `goLiveApproved` is a context field NO release produces, so
 * the previous evaluator throws `PreconditionDslError` (unknown context field): that tenant's pass fails loud and is
 * retried, it never settles go-live. This release never evaluates the expression (go-live is `attestation` mode and the
 * machine config drops the DSL of every attestation step); it is a tripwire for the old code only. Do NOT register
 * `goLiveApproved` as a context field: the guard test fails if the evaluator ever accepts it.
 */
export const GO_LIVE_ROLLBACK_GUARD_DSL = "context.goLiveApproved == true";

/** The synthetic machine terminal — reached when `go_live_checklist_complete` completes and the tenant
 *  flips to `active` (the `[*]` final node in the §2.3 mermaid). Not a template key; a machine sentinel. */
export const ONBOARDING_DONE = "__done__" as const;

/** True iff `key` is one of the canonical steps (a template-key typo guard). */
export function isCanonicalOnboardingStep(key: string): key is CanonicalOnboardingStep {
  return (CANONICAL_ONBOARDING_STEPS as readonly string[]).includes(key);
}

/** The canonical index (0-based) of a step, or `-1` for a non-canonical / unknown key. Used to order the
 *  machine's graph when the repo returns canonical templates; non-canonical steps order by their own
 *  `canonical_order` after the canonical floor. */
export function canonicalStepIndex(key: string): number {
  return (CANONICAL_ONBOARDING_STEPS as readonly string[]).indexOf(key);
}
