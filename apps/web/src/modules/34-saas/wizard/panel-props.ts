// apps/web/src/modules/34-saas/wizard — the contract between the wizard shell (wizard-screen / step-frame, 7C-a) and a step panel.
// A panel is the step's own data, drawn INSIDE the shell's step frame: the frame owns the heading (`data-step-heading`), the owner line,
// the read-only reason, how the step was settled, and the actions on the step itself (Start, Mark done with evidence, Re-open, Skip).
// A panel owns only what its step edits. This file is shared by both pieces: the frame builds a `StepPanelProps` and renders
// `<Panel {...props} />` as a child of the frame; the panels below (`clearinghouse-panel`, `mac-panel`, `dosespot-panel`) read it.
import type { operations } from "@chartwarden/ui";

type OnboardingResponse =
  operations["getApiV1TenantOnboarding"]["responses"][200]["content"]["application/json"];
export type TenantWizardView = OnboardingResponse;
export type TenantWizardStep = OnboardingResponse["steps"][number];

/** The role a tenant member needs to act on an `org_admin` or `either` step (the `administrator` role does not count). */
export const ORG_ADMIN_ROLE = "org_admin";

/**
 * "This does not apply to us": the skip action of steps 8, 9 and 10 (POST /api/v1/tenant/onboarding/:taskId/skip, `org_admin` role,
 * fresh step-up, a rationale). The FRAME renders the dialog and sends the write; a panel only offers the entry point.
 */
export interface SkipAction {
  /**
   * True when the signed-in member may skip this step now: a tenant-skippable step that is still open, the tenant still onboarding,
   * the `org_admin` role and `onboarding.manage_own`. False everywhere else, so a panel shows no entry point.
   */
  readonly available: boolean;
  /** Opens the frame's skip dialog (rationale, then step-up). Does nothing when `available` is false. */
  readonly request: () => void;
}

export interface StepPanelProps {
  /** The step on screen (an item of `view.steps`). */
  readonly step: TenantWizardStep;
  /** The whole `GET /api/v1/tenant/onboarding` answer (statuses, locks, `tenantStatus`, go-live). */
  readonly view: TenantWizardView;
  /** The signed-in member's permission keys; empty until the session answers (fail closed). */
  readonly held: ReadonlySet<string>;
  /** The signed-in member's role keys in the organization; empty until the session answers (fail closed). */
  readonly roles: ReadonlySet<string>;
  /**
   * Reload `GET /api/v1/tenant/onboarding` after a write landed (statuses and locks move). That read is audited per call: a panel calls
   * this once per finished write, never in a loop or on a timer.
   */
  readonly onChanged: () => Promise<void> | void;
  readonly skip: SkipAction;
}

/**
 * Steps whose own panel settles the step (choosing a clearinghouse settles `clearinghouse_selected` through the server's advance pass), so
 * the frame offers no "Mark done with evidence" on them: that would settle the step without the choice.
 */
export const STEPS_SETTLED_BY_PANEL: ReadonlySet<string> = new Set(["clearinghouse_selected"]);

/**
 * Whether the step's own forms may be offered at all: the tenant is onboarding, the step exists, and it is not locked behind an earlier one.
 * A settled step is still worked on (its data may change and the step be re-opened), so only a LOCKED, unsettled step is closed here.
 * The frame says WHY it is closed; a panel shows no form.
 */
export function isStepOpenForWork(
  view: Pick<TenantWizardView, "tenantStatus">,
  step: Pick<TenantWizardStep, "id" | "locked" | "status">,
): boolean {
  if (view.tenantStatus !== "onboarding" || step.id === null) return false;
  const settled = step.status === "done" || step.status === "skipped";
  return !(step.locked && !settled);
}
