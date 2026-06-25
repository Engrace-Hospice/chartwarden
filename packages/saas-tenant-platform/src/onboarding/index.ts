// @wardenx/saas-tenant-platform · onboarding barrel (M34 §2.3 / D3).
//
// The §2.3 onboarding ROOT machine (strictly observable, pure) + its data-driven step floor + the typed
// precondition-DSL evaluator + the structured OnboardingContext the preconditions read. The IO-bearing
// advance worker that turns the machine's emits into `onboarding_task` writes + `m34.tenant.onboarding_*`
// outbox/alerts lives in ../services/onboarding-advance-worker (pure over injected ports, the mdm-jobs
// precedent).
export type {
  OnboardingContext,
  OnboardingContextValue,
  OnboardingProviderEntityView,
} from "./context";
export {
  CANONICAL_ONBOARDING_STEPS,
  type CanonicalOnboardingStep,
  ONBOARDING_DONE,
  canonicalStepIndex,
  isCanonicalOnboardingStep,
} from "./steps";
export { PreconditionDslError, evaluatePrecondition } from "./precondition-dsl";
export {
  type OnboardingAdvanceResult,
  type OnboardingEmit,
  type OnboardingMachineConfig,
  type OnboardingOutboxEvent,
  type OnboardingStateNode,
  type OnboardingStateTransition,
  type OnboardingStepState,
  advanceOnboarding,
  buildOnboardingMachineConfig,
  compareStepOrder,
} from "./machine";
