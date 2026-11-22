import type { IntakeStepId } from "./intake-workspace-stage";

export type IntakeStageActionId =
  | "start-review"
  | "return-to-review"
  | "save-verification"
  | "find-patient-matches"
  | "qualify-referral"
  | "convert-referral";

/** The embedded task exposes one typed action to the persistent footer. */
export interface IntakeStageAction {
  readonly id: IntakeStageActionId;
  readonly stageId: IntakeStepId;
  readonly disabled: boolean;
  readonly run: () => void;
}

export type RegisterIntakeStageAction = (action: IntakeStageAction | null) => void;
