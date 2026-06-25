// @wardenx/saas-tenant-platform — the `TenantOnboardingProvider` seam (M34 §4.6).
//
// The read surface over the per-tenant onboarding checklist (`onboarding_task`, §3.3). Consumed by
// the tenant-lifecycle transition that gates `onboarding → active` (a tenant may not go active until
// every canonical onboarding task is done or explicitly skipped) and by the onboarding dashboard.
// The interface lives HERE in the feature package; the M1 registry holds the registered instance
// opaquely and validateSeams() fails closed at boot.
//
// The status union mirrors the `onboarding_task_status` pgEnum (packages/db/src/schema/saas/
// onboarding-task.ts) as a type-level constant so the seam contract takes no @wardenx/db edge.

/**
 * The onboarding-task status (§3.3). Type-level mirror of the `onboarding_task_status` pgEnum:
 * `pending → in_progress → done | skipped | blocked`.
 */
export type OnboardingTaskStatus = "pending" | "in_progress" | "done" | "skipped" | "blocked";

/** The current onboarding step for an org — the task key and its status, or `null` when the org has
 *  no onboarding checklist (e.g. it never reached the `onboarding` lifecycle state). */
export interface OnboardingStep {
  readonly stepKey: string;
  readonly status: OnboardingTaskStatus;
}

/**
 * The boot-registered onboarding read surface (§4.6). Consumed by the lifecycle `onboarding → active`
 * gate ({@link allCanonicalTasksDoneOrSkipped}) and the onboarding dashboard ({@link currentStepForOrg}).
 */
export interface TenantOnboardingProvider {
  /** The current onboarding step for the org, or `null` when there is no checklist. */
  currentStepForOrg(orgId: string): Promise<OnboardingStep | null>;

  /** True when every canonical onboarding task for the org is `done` or `skipped` — the precondition
   *  the lifecycle service checks before promoting a tenant from `onboarding` to `active`. */
  allCanonicalTasksDoneOrSkipped(orgId: string): Promise<boolean>;
}
