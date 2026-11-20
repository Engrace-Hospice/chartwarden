// apps/web/src/modules/08-encounters/findings — the weight and height fields of the visit vitals (WF09).
//
// Controlled: the vitals panel that embeds these owns the values and sends them with the vitals capture (`bodyMeasurePayload`). Weight and
// height travel as strings with their unit, which is how the vitals capture stores them. BMI is shown as a live preview computed exactly as
// the server computes the stored one (kg / m squared, one decimal); it is never typed. Under the weight sits the last visit's weight and,
// once a weight is typed, the change in plain words, in the unit the clinician is entering.
import { SelectField, TextField } from "@chartwarden/ui";
import type { JSX } from "react";
import type { WeightHistoryView } from "./findings-api";
import { codeOf } from "./findings-labels";
import {
  type BodyMeasureValues,
  type HeightUnit,
  type WeightUnit,
  bodyMeasureErrors,
  computeBmi,
  priorWeightLine,
} from "./findings-model";

export { useWeightHistory } from "./use-weight-history";

const WEIGHT_UNITS: readonly WeightUnit[] = ["lb", "kg"];
const HEIGHT_UNITS: readonly HeightUnit[] = ["in", "cm"];
const toOptions = (units: readonly string[]) => units.map((unit) => ({ value: unit, label: unit }));
const WEIGHT_UNIT_OPTIONS = toOptions(WEIGHT_UNITS);
const HEIGHT_UNIT_OPTIONS = toOptions(HEIGHT_UNITS);

export interface BodyMeasureFieldsProps {
  readonly values: BodyMeasureValues;
  readonly onChange: (next: BodyMeasureValues) => void;
  readonly disabled?: boolean;
  /** From `useWeightHistory`; when it holds an earlier weight, the line under the weight field compares against it. */
  readonly weightHistory?: WeightHistoryView | null;
  /** What the server refused about the weight or height (its field errors), shown on the field until the values change. */
  readonly serverErrors?: {
    readonly weight?: string | undefined;
    readonly height?: string | undefined;
  };
}

export function BodyMeasureFields({
  values,
  onChange,
  disabled = false,
  weightHistory = null,
  serverErrors = {},
}: BodyMeasureFieldsProps): JSX.Element {
  const errors = bodyMeasureErrors(values);
  const bmi = computeBmi(values);
  const priorLine = priorWeightLine(weightHistory?.prior ?? null, {
    value: values.weight,
    unit: values.weightUnit,
  });
  return (
    <div className="wx-form-stack">
      <div className="wx-form-grid">
        <TextField
          label="Weight"
          inputMode="decimal"
          autoComplete="off"
          disabled={disabled}
          value={values.weight}
          error={errors.weight ?? serverErrors.weight}
          onChange={(event) => onChange({ ...values, weight: event.target.value })}
        />
        <SelectField
          className="wx-touch-select"
          label="Weight unit"
          disabled={disabled}
          value={values.weightUnit}
          options={WEIGHT_UNIT_OPTIONS}
          onChange={(event) =>
            onChange({
              ...values,
              weightUnit: codeOf(WEIGHT_UNITS, event.target.value) ?? values.weightUnit,
            })
          }
        />
        <TextField
          label="Height"
          inputMode="decimal"
          autoComplete="off"
          disabled={disabled}
          value={values.height}
          error={errors.height ?? serverErrors.height}
          onChange={(event) => onChange({ ...values, height: event.target.value })}
        />
        <SelectField
          className="wx-touch-select"
          label="Height unit"
          disabled={disabled}
          value={values.heightUnit}
          options={HEIGHT_UNIT_OPTIONS}
          onChange={(event) =>
            onChange({
              ...values,
              heightUnit: codeOf(HEIGHT_UNITS, event.target.value) ?? values.heightUnit,
            })
          }
        />
      </div>
      {priorLine ? <p className="wx-form-hint">{priorLine}</p> : null}
      {bmi ? (
        <p className="wx-form-hint">{`BMI ${bmi} (calculated from weight and height)`}</p>
      ) : null}
    </div>
  );
}
