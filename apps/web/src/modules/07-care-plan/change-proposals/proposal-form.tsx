// apps/web/src/modules/07-care-plan/change-proposals — the compact form of one proposal (any of the six kinds), as the body of the
// right-hand drawer the composer opens. Controlled: the owner holds the state and the field errors, this renders the fields of `kind`.
// Every field is a kit field with a visible label; the SUD flag is a native checkbox because the kit has no checkbox.
import { CodeSearchInput, SelectField, TextAreaField, TextField } from "@chartwarden/ui";
import type { FormEvent, JSX } from "react";
import { type FormErrors, type FormState, LIMITS } from "./proposal-form-model";
import {
  DISCIPLINE_LABEL,
  GOAL_SOURCE_LABEL,
  GOAL_STATUS_LABEL,
  PROBLEM_KIND_LABEL,
  PROBLEM_SOURCE_LABEL,
  optionsOf,
} from "./proposal-labels";
import type { ProposalKind } from "./proposal-types";

export interface ChoiceOption {
  readonly value: string;
  readonly label: string;
}

export interface ProposalFormProps {
  readonly formId: string;
  readonly kind: ProposalKind;
  readonly value: FormState;
  readonly onChange: (next: FormState) => void;
  readonly errors: FormErrors;
  readonly onSubmit: () => void;
  /** The problems a new goal or intervention can hang off (existing ones, and new ones proposed in this visit). */
  readonly problemOptions: readonly ChoiceOption[];
  /** The existing goals of the chosen problem (an intervention may support one). */
  readonly goalOptions: readonly ChoiceOption[];
  /** What the plan calls the element a resolve / update / discontinue names. */
  readonly targetLabel: string;
  /** Every field is read-only (a save is in flight, or the note can no longer take a write). */
  readonly disabled?: boolean;
}

const NO_GOAL: ChoiceOption = { value: "", label: "No linked goal" };
const NO_STATUS_CHANGE: ChoiceOption = { value: "", label: "No status change" };
const PICK_PROBLEM: ChoiceOption = { value: "", label: "Choose a problem" };

/** The key of `labels` that `value` names, else `fallback`: a select can only hand back an option, but the type does not know that. */
function oneOf<K extends string>(
  labels: Readonly<Record<K, string>>,
  value: string,
  fallback: K,
): K {
  return value in labels ? (value as K) : fallback;
}

function TargetLine({ label, text }: { label: string; text: string }): JSX.Element | null {
  return text ? (
    <dl className="wx-kv">
      <dt>{label}</dt>
      <dd>{text}</dd>
    </dl>
  ) : null;
}

export function ProposalForm({
  formId,
  kind,
  value,
  onChange,
  errors,
  onSubmit,
  problemOptions,
  goalOptions,
  targetLabel,
  disabled = false,
}: ProposalFormProps): JSX.Element {
  const set =
    <K extends keyof FormState>(key: K) =>
    (next: FormState[K]): void =>
      onChange({ ...value, [key]: next });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <form id={formId} onSubmit={submit} noValidate>
      <fieldset className="wx-form-stack wx-fieldset-reset" disabled={disabled}>
        {kind === "problem_add" ? (
          <>
            <TextAreaField
              label="Problem description"
              required
              rows={3}
              maxLength={LIMITS.text}
              placeholder="e.g. Dyspnea at rest related to end-stage heart failure"
              value={value.description}
              onChange={(e) => set("description")(e.target.value)}
              error={errors.description}
            />
            <SelectField
              label="Problem type"
              hint="Terminal problems anchor the hospice plan of care."
              options={optionsOf(PROBLEM_KIND_LABEL)}
              value={value.problemKind}
              onChange={(e) =>
                set("problemKind")(oneOf(PROBLEM_KIND_LABEL, e.target.value, "related"))
              }
            />
            <SelectField
              label="Source"
              options={optionsOf(PROBLEM_SOURCE_LABEL)}
              value={value.problemSource}
              onChange={(e) =>
                set("problemSource")(oneOf(PROBLEM_SOURCE_LABEL, e.target.value, "clinical"))
              }
            />
            <CodeSearchInput
              label="ICD-10 code"
              system="icd10cm"
              value={value.icd10Code}
              onChange={(code) => set("icd10Code")(code)}
              placeholder="Optional. Search by code or description"
              error={errors.icd10Code}
            />
            <CodeSearchInput
              label="SNOMED code"
              system="snomed"
              value={value.snomedCode}
              onChange={(code) => set("snomedCode")(code)}
              placeholder="Optional. Search by code or description"
              error={errors.snomedCode}
            />
            <TextField
              label="Onset date"
              type="date"
              value={value.onsetAt}
              onChange={(e) => set("onsetAt")(e.target.value)}
              error={errors.onsetAt}
            />
            <label className="wx-action-check">
              <input
                type="checkbox"
                checked={value.sudRelated}
                onChange={(e) => set("sudRelated")(e.target.checked)}
              />
              <span>
                Substance use disorder related (mark only when the problem contains such
                information)
              </span>
            </label>
          </>
        ) : null}

        {kind === "problem_resolve" ? (
          <>
            <TargetLine label="Problem" text={targetLabel} />
            <TextAreaField
              label="Resolution note"
              required
              rows={3}
              maxLength={LIMITS.text}
              hint="Say why this problem is resolved."
              value={value.resolutionNote}
              onChange={(e) => set("resolutionNote")(e.target.value)}
              error={errors.resolutionNote}
            />
          </>
        ) : null}

        {kind === "goal_add" ? (
          <>
            <SelectField
              label="Linked problem"
              required
              options={[PICK_PROBLEM, ...problemOptions]}
              value={value.problemRef}
              onChange={(e) => set("problemRef")(e.target.value)}
              error={errors.problemRef}
            />
            <TextAreaField
              label="Goal statement"
              required
              rows={3}
              maxLength={LIMITS.text}
              placeholder="e.g. Patient will report dyspnea is manageable at rest"
              value={value.originalText}
              onChange={(e) => set("originalText")(e.target.value)}
              error={errors.originalText}
            />
            <SelectField
              label="Source"
              options={optionsOf(GOAL_SOURCE_LABEL)}
              value={value.goalSource}
              onChange={(e) =>
                set("goalSource")(oneOf(GOAL_SOURCE_LABEL, e.target.value, "clinical"))
              }
            />
            <TextField
              label="Measurable outcome"
              maxLength={LIMITS.text}
              value={value.measurableOutcome}
              onChange={(e) => set("measurableOutcome")(e.target.value)}
              error={errors.measurableOutcome}
            />
            <TextField
              label="Target date"
              type="date"
              value={value.targetAt}
              onChange={(e) => set("targetAt")(e.target.value)}
              error={errors.targetAt}
            />
          </>
        ) : null}

        {kind === "goal_update" ? (
          <>
            <TargetLine label="Goal" text={targetLabel} />
            <TextAreaField
              label="Revised goal statement"
              rows={3}
              maxLength={LIMITS.text}
              hint="Leave blank to keep the goal as written."
              value={value.revisedText}
              onChange={(e) => set("revisedText")(e.target.value)}
              error={errors.revisedText}
            />
            <TextField
              label="Measurable outcome"
              maxLength={LIMITS.text}
              value={value.measurableOutcome}
              onChange={(e) => set("measurableOutcome")(e.target.value)}
              error={errors.measurableOutcome}
            />
            <SelectField
              label="New status"
              options={[NO_STATUS_CHANGE, ...optionsOf(GOAL_STATUS_LABEL)]}
              value={value.goalStatus}
              onChange={(e) =>
                set("goalStatus")(
                  e.target.value === ""
                    ? ""
                    : oneOf(GOAL_STATUS_LABEL, e.target.value, "in_progress"),
                )
              }
            />
            <TextField
              label="Target date"
              type="date"
              value={value.targetAt}
              onChange={(e) => set("targetAt")(e.target.value)}
              error={errors.targetAt}
            />
          </>
        ) : null}

        {kind === "intervention_add" ? (
          <>
            <SelectField
              label="Linked problem"
              required
              options={[PICK_PROBLEM, ...problemOptions]}
              value={value.problemRef}
              onChange={(e) => onChange({ ...value, problemRef: e.target.value, goalRef: "" })}
              error={errors.problemRef}
            />
            <TextAreaField
              label="Intervention"
              required
              rows={3}
              maxLength={LIMITS.text}
              placeholder="e.g. Assess respiratory status and reinforce comfort measures"
              value={value.scopeText}
              onChange={(e) => set("scopeText")(e.target.value)}
              error={errors.scopeText}
            />
            <TextField
              label="Frequency"
              required
              maxLength={LIMITS.frequencyText}
              placeholder="e.g. Twice weekly"
              value={value.frequencyText}
              onChange={(e) => set("frequencyText")(e.target.value)}
              error={errors.frequencyText}
            />
            <TextField
              label="Frequency value"
              required
              maxLength={LIMITS.frequencyValue}
              placeholder="e.g. 2"
              value={value.frequencyValue}
              onChange={(e) => set("frequencyValue")(e.target.value)}
              error={errors.frequencyValue}
            />
            <SelectField
              label="Discipline"
              options={optionsOf(DISCIPLINE_LABEL)}
              value={value.discipline}
              onChange={(e) => set("discipline")(oneOf(DISCIPLINE_LABEL, e.target.value, "rn"))}
            />
            <TextField
              label="Responsible role"
              maxLength={LIMITS.responsibleRole}
              placeholder="e.g. Primary RN"
              value={value.responsibleRole}
              onChange={(e) => set("responsibleRole")(e.target.value)}
              error={errors.responsibleRole}
            />
            <SelectField
              label="Supports goal"
              hint="Optional. Link the intervention to the goal it supports."
              options={[NO_GOAL, ...goalOptions]}
              value={value.goalRef}
              onChange={(e) => set("goalRef")(e.target.value)}
            />
          </>
        ) : null}

        {kind === "intervention_discontinue" ? (
          <>
            <TargetLine label="Intervention" text={targetLabel} />
            <TextAreaField
              label="Reason for discontinuing"
              required
              rows={3}
              maxLength={LIMITS.text}
              value={value.reason}
              onChange={(e) => set("reason")(e.target.value)}
              error={errors.reason}
            />
          </>
        ) : null}
      </fieldset>
    </form>
  );
}
