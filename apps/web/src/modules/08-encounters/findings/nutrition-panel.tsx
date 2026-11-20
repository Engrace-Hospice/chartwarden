// apps/web/src/modules/08-encounters/findings — the nutrition and hydration section of the visit note (WF09).
//
//   GET|PUT /api/v1/encounters/{encounterId}/nutrition
//
// Appetite, the share of meals eaten (a whole percent), fluid intake, swallowing and nutrition support. Each is optional and "Not assessed"
// is stored as absent. One Save sends all five, because the PUT replaces the stored record. The share of meals is checked here only so a
// typo is caught beside the field; the server still decides what is accepted. A signed note (the `disabled` prop, or a 409) is read-only.
import { SelectField, TextField } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { type PanelStatusListener, useReportPanelStatus } from "../../../shell/panel-status";
import {
  type NutritionBody,
  type NutritionView,
  loadNutrition,
  saveNutrition,
} from "./findings-api";
import { FindingsFrame, SaveRow } from "./findings-frame";
import {
  APPETITE_LEVELS,
  APPETITE_OPTIONS,
  FLUID_INTAKE_LEVELS,
  FLUID_INTAKE_OPTIONS,
  NUTRITION_SUPPORTS,
  NUTRITION_SUPPORT_OPTIONS,
  SWALLOWING_LEVELS,
  SWALLOWING_OPTIONS,
  codeOf,
} from "./findings-labels";
import {
  type NutritionForm,
  mealIntakeProblem,
  nutritionBodyFromForm,
  nutritionFormFromView,
  nutritionFormSignature,
} from "./findings-model";
import { type FindingsRecord, useFindingsRecord } from "./use-findings-record";

export interface NutritionPanelProps {
  readonly encounterId: string;
  /** The note cannot be edited (signed, or the caller may not author): every control is read-only. */
  readonly disabled?: boolean;
  /** Called after the nutrition record was saved, so the note preview can be refreshed. */
  readonly onSaved?: () => void;
  /** Told whether the form holds unsaved input, whether a save is in flight and whether a record is stored (see `useReportPanelStatus`). */
  readonly onStatusChange?: PanelStatusListener;
}

const ignoreSaved = (): void => {};

export function NutritionPanel({
  encounterId,
  disabled = false,
  onSaved = ignoreSaved,
  onStatusChange,
}: NutritionPanelProps): JSX.Element {
  const record = useFindingsRecord({
    encounterId,
    load: loadNutrition,
    save: saveNutrition,
    onSaved,
  });
  return (
    <FindingsFrame
      title="Nutrition and hydration"
      description="Record what was observed on this visit. Leave a field as Not assessed if it was not."
      loaded={record.loaded}
      onRetry={record.retry}
    >
      {record.loaded.phase === "ready" ? (
        <NutritionFields
          initial={record.loaded.record}
          record={record}
          readOnly={disabled || record.locked !== null}
          onStatusChange={onStatusChange}
        />
      ) : null}
    </FindingsFrame>
  );
}

interface NutritionFieldsProps {
  readonly initial: NutritionView | null;
  readonly record: FindingsRecord<NutritionView, NutritionBody>;
  readonly readOnly: boolean;
  readonly onStatusChange: PanelStatusListener | undefined;
}

function NutritionFields({
  initial,
  record,
  readOnly,
  onStatusChange,
}: NutritionFieldsProps): JSX.Element {
  const [form, setForm] = useState<NutritionForm>(() => nutritionFormFromView(initial));
  // What is stored, as a form signature: the form is unsaved when it says something else.
  const [stored, setStored] = useState(() =>
    nutritionFormSignature(nutritionFormFromView(initial)),
  );
  // Input the note will never take (the panel locked) is shown read-only but no longer counts as unsaved: nothing could save it.
  const dirty = record.locked === null && nutritionFormSignature(form) !== stored;
  useReportPanelStatus(onStatusChange, {
    dirty,
    saving: record.saving,
    recorded: record.loaded.phase === "ready" && record.loaded.record !== null,
  });
  /** Back to the record as it is stored (or as it was last saved). */
  function discard(): void {
    setForm(
      nutritionFormFromView(record.loaded.phase === "ready" ? record.loaded.record : initial),
    );
    record.dismiss();
  }
  async function save(): Promise<void> {
    const sent = form;
    if (await record.save(nutritionBodyFromForm(sent))) setStored(nutritionFormSignature(sent));
  }
  const update = (next: NutritionForm): void => {
    setForm(next);
    record.dismiss();
  };
  const mealProblem = mealIntakeProblem(form.mealIntake);
  return (
    <>
      <fieldset className="wx-form-stack wx-fieldset-reset" disabled={readOnly}>
        <legend className="wx-sr-only">Nutrition and hydration findings</legend>
        <div className="wx-form-grid">
          <SelectField
            className="wx-touch-select"
            label="Appetite"
            value={form.appetite ?? ""}
            options={APPETITE_OPTIONS}
            onChange={(event) =>
              update({ ...form, appetite: codeOf(APPETITE_LEVELS, event.target.value) })
            }
          />
          <TextField
            label="Share of meals eaten (%)"
            hint="A whole number from 0 to 100."
            inputMode="numeric"
            autoComplete="off"
            value={form.mealIntake}
            error={mealProblem ?? undefined}
            onChange={(event) => update({ ...form, mealIntake: event.target.value })}
          />
          <SelectField
            className="wx-touch-select"
            label="Fluid intake"
            value={form.fluidIntake ?? ""}
            options={FLUID_INTAKE_OPTIONS}
            onChange={(event) =>
              update({ ...form, fluidIntake: codeOf(FLUID_INTAKE_LEVELS, event.target.value) })
            }
          />
          <SelectField
            className="wx-touch-select"
            label="Swallowing"
            value={form.swallowing ?? ""}
            options={SWALLOWING_OPTIONS}
            onChange={(event) =>
              update({ ...form, swallowing: codeOf(SWALLOWING_LEVELS, event.target.value) })
            }
          />
          <SelectField
            className="wx-touch-select"
            label="Nutrition support"
            value={form.support ?? ""}
            options={NUTRITION_SUPPORT_OPTIONS}
            onChange={(event) =>
              update({ ...form, support: codeOf(NUTRITION_SUPPORTS, event.target.value) })
            }
          />
        </div>
      </fieldset>
      <SaveRow
        label="Save nutrition"
        savedMessage="Nutrition saved."
        saving={record.saving}
        disabled={readOnly || mealProblem !== null}
        saved={record.saved}
        failure={record.failure}
        locked={record.locked}
        stale={record.stale}
        onReload={record.retry}
        onDiscard={dirty ? discard : undefined}
        onSave={() => void save()}
      />
    </>
  );
}
