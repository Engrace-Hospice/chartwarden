// apps/admin/src/modules/34-saas-platform/onboarding — the tenant onboarding wizard's decisions as pure functions (what the rail
// shows, which actions a step offers, where "resume" lands). The server owns every rule (strict sequence, owner, evidence, the pending
// go-live attestation); this only decides what to OFFER, so an operator is not handed a button the server is certain to refuse.
import type { StepRailItem, StepRailState, operations } from "@chartwarden/ui";

type WizardResponse =
  operations["getApiV1PlatformTenantsByOrgSlugOnboarding"]["responses"][200]["content"]["application/json"];
export type WizardView = WizardResponse;
export type WizardStep = WizardResponse["steps"][number];
export type WizardOwner = WizardStep["owner"];

/** The step the platform settles through the two-party approval: never attested, skipped or re-opened by hand. */
export const GO_LIVE_STEP_KEY = "go_live_checklist_complete";

/**
 * The steps an operator may skip from the console: the ones where "does not apply" is a real answer. The server would let a skip
 * through on any step but go-live, so the UI is where this is held (the owner's decision: MAC-type steps are attested with evidence,
 * skipped only where the step does not apply; the Organisation, plan, BAA and the rest are never skipped by hand).
 */
export const SKIPPABLE_STEP_KEYS: ReadonlySet<string> = new Set([
  "mac_configured",
  "payer_enrollment",
  "dosespot_kickoff_initiated",
  "sample_data_loaded",
]);

/** The rationale the system records when a tenant that bills outside ChartWarden has its billing steps skipped for it. */
export const OUTSIDE_SKIP_RATIONALE = "bills outside ChartWarden";

export const OWNER_LABEL: Record<WizardOwner, string> = {
  platform_ops: "Platform operator",
  org_admin: "Tenant admin",
  compliance_officer: "Compliance officer",
  either: "Tenant admin or operator",
};

const isSettled = (s: WizardStep): boolean => s.status === "done" || s.status === "skipped";
const isGating = (s: WizardStep): boolean => s.isCanonical && !s.optional;

/**
 * True for a skip the SYSTEM made because the tenant bills outside ChartWarden. The server says so (`systemSkipped`); the rationale text is
 * never read for this: a person can type the same words.
 */
export const isSystemSkip = (step: WizardStep): boolean =>
  step.status === "skipped" && step.systemSkipped;

function titleOf(view: WizardView, key: string): string {
  return view.steps.find((s) => s.key === key)?.title ?? key;
}

function railStateOf(step: WizardStep, currentKey: string | null): StepRailState {
  if (step.status === "blocked") return "blocked";
  if (step.status === "skipped") return "skipped";
  if (step.status === "done") return "done";
  if (step.locked) return "locked";
  return step.key === currentKey ? "current" : "todo";
}

export function railItemsOf(view: WizardView): StepRailItem[] {
  return view.steps.map((step) => ({
    key: step.key,
    label: step.title,
    caption: isSystemSkip(step)
      ? `Skipped automatically: ${OUTSIDE_SKIP_RATIONALE}`
      : OWNER_LABEL[step.owner],
    state: railStateOf(step, view.currentStepKey),
    ...(step.locked && step.lockedBy
      ? { lockedReason: `Finish ${titleOf(view, step.lockedBy)} first` }
      : {}),
  }));
}

export interface StepActions {
  readonly canAttest: boolean;
  readonly canSkip: boolean;
  readonly canReopen: boolean;
  /** Why a re-open is not offered although the step is settled. */
  readonly reopenBlockedBy: "go_live_pending" | null;
  /** Why nothing can be done on this step right now (shown in place of the actions), or null. */
  readonly readOnlyReason: string | null;
}

const NONE: Omit<StepActions, "readOnlyReason" | "reopenBlockedBy"> = {
  canAttest: false,
  canSkip: false,
  canReopen: false,
};

function readOnlyReasonOf(step: WizardStep, view: WizardView): string | null {
  if (view.tenantStatus === "provisioning") {
    return "This tenant is still provisioning. Steps open when provisioning finishes.";
  }
  if (view.tenantStatus === "active") return "This tenant is live. Onboarding is complete.";
  if (view.tenantStatus !== "onboarding") {
    return `Onboarding is closed for this tenant (${view.tenantStatus}).`;
  }
  if (step.id === null) return "This step is created when provisioning finishes.";
  if (step.locked && !isSettled(step)) {
    return `Finish ${titleOf(view, step.lockedBy ?? "the earlier step")} first.`;
  }
  return null;
}

export function stepActionsOf(step: WizardStep, view: WizardView): StepActions {
  const readOnlyReason = readOnlyReasonOf(step, view);
  if (readOnlyReason !== null) return { ...NONE, reopenBlockedBy: null, readOnlyReason };
  if (step.key === GO_LIVE_STEP_KEY)
    return { ...NONE, reopenBlockedBy: null, readOnlyReason: null };
  if (isSettled(step)) {
    const pending = view.goLive.state === "awaiting_approval";
    return {
      ...NONE,
      canReopen: !pending,
      reopenBlockedBy: pending ? "go_live_pending" : null,
      readOnlyReason: null,
    };
  }
  return {
    canAttest: step.completionMode !== "auto",
    canSkip: SKIPPABLE_STEP_KEYS.has(step.key),
    canReopen: false,
    reopenBlockedBy: null,
    readOnlyReason: null,
  };
}

/** Where "resume" lands: the first gating step not yet settled, else the last step. Null for an empty wizard. */
export function defaultStepKey(view: WizardView): string | null {
  return view.currentStepKey ?? view.steps.at(-1)?.key ?? null;
}

export function gatingProgress(view: WizardView): { done: number; total: number } {
  const gating = view.steps.filter(isGating);
  return { done: gating.filter(isSettled).length, total: gating.length };
}
