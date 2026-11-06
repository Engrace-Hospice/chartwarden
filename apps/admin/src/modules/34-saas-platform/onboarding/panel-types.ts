// apps/admin/src/modules/34-saas-platform/onboarding — what the wizard hands every step panel.
import type { StepActions, WizardStep, WizardView } from "./wizard-model";

export interface PanelContext {
  readonly orgSlug: string;
  readonly view: WizardView;
  readonly step: WizardStep;
  readonly actions: StepActions;
  /** Reload the wizard (statuses, locks and the go-live state move after most writes). */
  readonly refresh: () => Promise<void>;
}
