// apps/web/src/modules/34-saas/wizard — the contract between the wizard shell (wizard-screen / step-frame, 7C-a) and a step panel.
// A panel is the step's own data, drawn INSIDE the shell's step frame: the frame owns the heading (`data-step-heading`), the owner line,
// the read-only reason, how the step was settled, and the actions on the step itself (Start, Mark done with evidence, Re-open, Skip).
// A panel owns only what its step edits. This file is shared by both pieces: the frame builds a `StepPanelProps` and renders
// `<Panel {...props} />` as a child of the frame; the panels below (`clearinghouse-panel`, `mac-panel`, `dosespot-panel`) read it.
//
// Rules of the contract (each is the frame's job unless it says otherwise):
// - A step the SYSTEM skipped (`isSystemSkip(step)`) is routed to the system-skipped panel BEFORE any step panel, so no panel renders
//   (and none guards for) a step that does not apply: `MacPanel` has no self-guard and relies on this.
// - The shell mounts a wizard screen only once the session has resolved (the chromed-route guard shows a spinner while it loads), so an
//   empty `held` or `roles` means the member holds none of the keys, NOT "not known yet": a panel does not wait for it, and shows its
//   "your role cannot ..." note at once.
// - Skip is the FRAME's button ("Skip this step"). A panel renders no skip button; it shows a short hint (`SkipHint`) while
//   `skip.available`, and keeps `skip.request` only for a panel that needs to open the frame's dialog later. Restoring focus to the
//   control that opened the dialog is the frame's job, not the panel's.
// - `onChanged` never rejects (the frame catches); a panel still does not trust that, and its own screen stays usable if it does.
import type { operations } from "@chartwarden/ui";

type OnboardingResponse =
  operations["getApiV1TenantOnboarding"]["responses"][200]["content"]["application/json"];
export type TenantWizardView = OnboardingResponse;
export type TenantWizardStep = OnboardingResponse["steps"][number];

/** The role a tenant member needs to act on an `org_admin` or `either` step (the `administrator` role does not count). */
export const ORG_ADMIN_ROLE = "org_admin";

/**
 * "This does not apply to us": the skip action of steps 8, 9 and 10 (POST /api/v1/tenant/onboarding/:taskId/skip, `org_admin` role,
 * fresh step-up, a rationale). The FRAME renders the button, the dialog and the write; a panel shows only a hint that it exists.
 */
export interface SkipAction {
  /**
   * True when the signed-in member may skip this step now: a tenant-skippable step that is still open, the tenant still onboarding,
   * the `org_admin` role and `onboarding.manage_own`. False everywhere else, so a panel shows no hint.
   */
  readonly available: boolean;
  /** Opens the frame's skip dialog (rationale, then step-up). Does nothing when `available` is false. Panels do not call it today. */
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
   * Reload `GET /api/v1/tenant/onboarding` after a write landed or a refusal showed the view had moved (statuses and locks move). That
   * read is audited per call: a panel calls this once per finished write, never in a loop or on a timer. Never rejects.
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
 * Whether the frame may offer "Mark done with evidence" on this step. The frame still adds its own conditions (the member holds
 * `onboarding.update` and the owner role): this is the step's side of the rule. `auto` steps are settled by the server's own facts; a
 * step in STEPS_SETTLED_BY_PANEL is settled by its panel (migration 1418 made the clearinghouse step `either`, so the completion mode
 * alone would let a member mark it done without choosing or activating anything).
 */
export function canAttestStep(step: Pick<TenantWizardStep, "key" | "completionMode">): boolean {
  return step.completionMode !== "auto" && !STEPS_SETTLED_BY_PANEL.has(step.key);
}

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
