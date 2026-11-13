// packages/ui/src/web — the tenant onboarding wizard's lane-neutral decisions as pure functions (what the rail shows, how far along the
// gating steps are, where "resume" lands). Hoisted from the admin wizard: the platform view and the tenant view carry the same step
// shape, so one set of helpers serves both. What each lane OFFERS on a step (actions, copy) stays with the lane; the server owns every
// rule (strict sequence, owner, evidence, the pending go-live attestation).
import type { StepRailItem, StepRailState } from "./components/step-rail";

export type WizardOwnerKey = "platform_ops" | "org_admin" | "compliance_officer" | "either";

/** The step fields these helpers read: a structural subset of both lanes' `steps[]` items. */
export interface WizardRailStep {
  readonly key: string;
  readonly title: string;
  readonly owner: WizardOwnerKey;
  readonly status: "pending" | "in_progress" | "done" | "skipped" | "blocked";
  readonly locked: boolean;
  readonly lockedBy: string | null;
  readonly systemSkipped: boolean;
  readonly isCanonical: boolean;
  readonly optional: boolean;
}

export interface WizardRailView {
  readonly steps: readonly WizardRailStep[];
  readonly currentStepKey: string | null;
}

/** The rationale the system records when a tenant that bills outside ChartWarden has its billing steps skipped for it. */
export const OUTSIDE_SKIP_RATIONALE = "bills outside ChartWarden";

export const isSettledStep = (s: Pick<WizardRailStep, "status">): boolean =>
  s.status === "done" || s.status === "skipped";
export const isGatingStep = (s: Pick<WizardRailStep, "isCanonical" | "optional">): boolean =>
  s.isCanonical && !s.optional;

/**
 * True for a skip the SYSTEM made because the tenant bills outside ChartWarden. The server says so (`systemSkipped`); the rationale text is
 * never read for this: a person can type the same words.
 */
export const isSystemSkip = (step: Pick<WizardRailStep, "status" | "systemSkipped">): boolean =>
  step.status === "skipped" && step.systemSkipped;

function railStateOf(step: WizardRailStep, currentKey: string | null): StepRailState {
  if (step.status === "blocked") return "blocked";
  if (step.status === "skipped") return "skipped";
  if (step.status === "done") return "done";
  if (step.locked) return "locked";
  return step.key === currentKey ? "current" : "todo";
}

/** The rail's items; `ownerLabel` is the lane's own wording for each owner ("Platform operator" for staff, "ChartWarden" for a tenant). */
export function railItemsOf(
  view: WizardRailView,
  ownerLabel: Readonly<Record<WizardOwnerKey, string>>,
): StepRailItem[] {
  const titleOf = (key: string): string => view.steps.find((s) => s.key === key)?.title ?? key;
  return view.steps.map((step) => ({
    key: step.key,
    label: step.title,
    caption: isSystemSkip(step)
      ? `Skipped automatically: ${OUTSIDE_SKIP_RATIONALE}`
      : ownerLabel[step.owner],
    state: railStateOf(step, view.currentStepKey),
    ...(step.locked && step.lockedBy
      ? { lockedReason: `Finish ${titleOf(step.lockedBy)} first` }
      : {}),
  }));
}

/** Where "resume" lands: the first gating step not yet settled, else the last step. Null for an empty wizard. */
export function defaultStepKey(view: WizardRailView): string | null {
  return view.currentStepKey ?? view.steps.at(-1)?.key ?? null;
}

export function gatingProgress(view: WizardRailView): { done: number; total: number } {
  const gating = view.steps.filter(isGatingStep);
  return { done: gating.filter(isSettledStep).length, total: gating.length };
}
