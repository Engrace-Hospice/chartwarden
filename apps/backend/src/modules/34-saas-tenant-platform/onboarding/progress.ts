// apps/backend/src/modules/34-saas-tenant-platform/onboarding/progress.ts — a tenant's onboarding in one line (pure).
//
// The platform console's tenant list shows "7 of 13, current step, go-live state" per tenant. It is judged exactly the way the
// activation guard and the wizard view judge a tenant: over the GATING steps (canonical, not optional, not retired), in the
// wizard's order. A task that belongs to a retired template (kept as history) or to a tenant-added step is never counted, so the
// number can never disagree with the wizard it links to.
import { type GoLiveState, goLiveStateOf } from "./go-live";
import type { GoLiveAttestation, StepTask, StepTemplate } from "./model";
import { currentStepKey, gatingTemplateKeys, isSettled } from "./sequence";

export interface OnboardingProgress {
  /** Gating steps that are done or skipped. */
  readonly doneCount: number;
  /** Gating steps in the wizard (the go-live step included, optional and tenant-added steps not). */
  readonly totalCount: number;
  /** The first gating step that is not settled (the wizard's "you are here"), or null when every one is. */
  readonly currentStepKey: string | null;
  readonly goLiveState: GoLiveState;
}

export function summarizeOnboarding(input: {
  readonly tenantStatus: string;
  readonly templates: readonly StepTemplate[];
  readonly tasks: readonly StepTask[];
  readonly attestations: readonly GoLiveAttestation[];
}): OnboardingProgress {
  const gating = new Set(gatingTemplateKeys(input.templates));
  const doneCount = input.tasks.filter(
    (t) => gating.has(t.templateKey) && isSettled(t.status),
  ).length;
  return {
    doneCount,
    totalCount: gating.size,
    currentStepKey: currentStepKey(input.templates, input.tasks),
    goLiveState: goLiveStateOf(input),
  };
}
