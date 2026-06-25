// @wardenx/saas-tenant-platform · onboarding — the eleven canonical onboarding steps (M34 §2.3 / §3.12).
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

/** The eleven canonical onboarding step keys, in `canonical_order` (§2.3 mermaid / §3.12 seed). These
 *  are `onboarding_task_template.key` values; the per-tenant `onboarding_task.template_key` references
 *  them. The sub-state pattern (`in_progress → blocked → in_progress → [*]` or `→ skipped → [*]`) is
 *  uniform across every step (§2.3) and lives in the machine, not per-step. */
export const CANONICAL_ONBOARDING_STEPS = [
  "account_created",
  "org_seeded",
  "ccn_registered",
  "mac_configured",
  "dosespot_kickoff_initiated",
  "xero_connected",
  "payroll_connected",
  "locations_seeded",
  "first_admin_invited",
  "sample_data_loaded",
  "go_live_checklist_complete",
] as const;

/** One canonical onboarding step key (§2.3 / §3.12). */
export type CanonicalOnboardingStep = (typeof CANONICAL_ONBOARDING_STEPS)[number];

/** The synthetic machine terminal — reached when `go_live_checklist_complete` completes and the tenant
 *  flips to `active` (the `[*]` final node in the §2.3 mermaid). Not a template key; a machine sentinel. */
export const ONBOARDING_DONE = "__done__" as const;

/** True iff `key` is one of the eleven canonical steps (a template-key typo guard). */
export function isCanonicalOnboardingStep(key: string): key is CanonicalOnboardingStep {
  return (CANONICAL_ONBOARDING_STEPS as readonly string[]).includes(key);
}

/** The canonical index (0-based) of a step, or `-1` for a non-canonical / unknown key. Used to order the
 *  machine's graph when the repo returns canonical templates; non-canonical steps order by their own
 *  `canonical_order` after the canonical floor. */
export function canonicalStepIndex(key: string): number {
  return (CANONICAL_ONBOARDING_STEPS as readonly string[]).indexOf(key);
}
