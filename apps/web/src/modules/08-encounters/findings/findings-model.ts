// apps/web/src/modules/08-encounters/findings — the pure half of the findings forms: stored record <-> form state <-> PUT body, the share of
// meals eaten, and the weight and height arithmetic. No React, no IO, so every rule here has a plain unit test.
//
// A PUT REPLACES THE WHOLE RECORD, so a body is always built from the complete form: a field left at "Not assessed" is sent as absent
// (an ADL item) or null, never carried over from an earlier save.
import { shortDate } from "../../../shell/short-date";
import type { AdlBody, AdlView, NutritionBody, NutritionView, WeightReading } from "./findings-api";
import {
  ADL_DEVICES,
  ADL_ITEMS,
  type AdlDevice,
  type AdlItem,
  type AdlLevel,
  type AppetiteLevel,
  type ContinenceLevel,
  type FluidIntakeLevel,
  type NutritionSupport,
  type SwallowingLevel,
} from "./findings-labels";

// ── ADLs ───────────────────────────────────────────────────────────────────────────────────────────────

export interface AdlForm {
  /** Only the activities that were assessed. */
  readonly items: Readonly<Partial<Record<AdlItem, AdlLevel>>>;
  readonly bladder: ContinenceLevel | null;
  readonly bowel: ContinenceLevel | null;
  readonly devices: readonly AdlDevice[];
}

export function adlFormFromView(view: AdlView | null): AdlForm {
  return {
    items: view?.items ?? {},
    bladder: view?.bladder ?? null,
    bowel: view?.bowel ?? null,
    devices: view?.devices ?? [],
  };
}

export function adlBodyFromForm(form: AdlForm): AdlBody {
  return {
    items: { ...form.items },
    bladder: form.bladder,
    bowel: form.bowel,
    devices: ADL_DEVICES.filter((device) => form.devices.includes(device)),
  };
}

/** What the form says, independent of the order it was edited in: two forms with the same signature would save the same record. */
export function adlFormSignature(form: AdlForm): string {
  return JSON.stringify([
    ADL_ITEMS.map((item) => form.items[item] ?? null),
    form.bladder,
    form.bowel,
    ADL_DEVICES.map((device) => form.devices.includes(device)),
  ]);
}

/** The form with `item` set to `level`, or removed (not assessed) when `level` is null. */
export function withAdlItem(form: AdlForm, item: AdlItem, level: AdlLevel | null): AdlForm {
  const { [item]: _dropped, ...rest } = form.items;
  return { ...form, items: level === null ? rest : { ...rest, [item]: level } };
}

export function withDevice(form: AdlForm, device: AdlDevice, on: boolean): AdlForm {
  const others = form.devices.filter((d) => d !== device);
  return { ...form, devices: on ? [...others, device] : others };
}

// ── Nutrition ──────────────────────────────────────────────────────────────────────────────────────────

export interface NutritionForm {
  readonly appetite: AppetiteLevel | null;
  /** What the clinician typed; parsed by {@link mealIntakeProblem} / {@link nutritionBodyFromForm}. */
  readonly mealIntake: string;
  readonly fluidIntake: FluidIntakeLevel | null;
  readonly swallowing: SwallowingLevel | null;
  readonly support: NutritionSupport | null;
}

export function nutritionFormFromView(view: NutritionView | null): NutritionForm {
  return {
    appetite: view?.appetite ?? null,
    mealIntake: view?.mealIntakePercent == null ? "" : String(view.mealIntakePercent),
    fluidIntake: view?.fluidIntake ?? null,
    swallowing: view?.swallowing ?? null,
    support: view?.support ?? null,
  };
}

const MEAL_INTAKE_MIN = 0;
const MEAL_INTAKE_MAX = 100;
const WHOLE_NUMBER = /^\d+$/;

/** Why the typed share of meals is not a whole percent from 0 to 100, in words, or null when it is blank or fine. */
export function mealIntakeProblem(typed: string): string | null {
  const text = typed.trim();
  if (text === "") return null;
  const value = Number(text);
  return WHOLE_NUMBER.test(text) && value >= MEAL_INTAKE_MIN && value <= MEAL_INTAKE_MAX
    ? null
    : `Enter a whole number from ${MEAL_INTAKE_MIN} to ${MEAL_INTAKE_MAX}.`;
}

/** What the form says, as typed (a share of meals that is not a number still counts as typed): the same form, the same signature. */
export function nutritionFormSignature(form: NutritionForm): string {
  return JSON.stringify([
    form.appetite,
    form.mealIntake.trim(),
    form.fluidIntake,
    form.swallowing,
    form.support,
  ]);
}

/** The PUT body for the form; the caller has already refused a form with a {@link mealIntakeProblem}. */
export function nutritionBodyFromForm(form: NutritionForm): NutritionBody {
  const text = form.mealIntake.trim();
  return {
    appetite: form.appetite,
    mealIntakePercent: text === "" ? null : Number(text),
    fluidIntake: form.fluidIntake,
    swallowing: form.swallowing,
    support: form.support,
  };
}

// ── Weight and height ──────────────────────────────────────────────────────────────────────────────────

export type WeightUnit = "lb" | "kg";
export type HeightUnit = "in" | "cm";

/** The vitals form's weight and height, as typed: strings, because the vitals capture stores them as numerics-as-text. */
export interface BodyMeasureValues {
  readonly weight: string;
  readonly weightUnit: WeightUnit;
  readonly height: string;
  readonly heightUnit: HeightUnit;
}

export const EMPTY_BODY_MEASURES: BodyMeasureValues = {
  weight: "",
  weightUnit: "lb",
  height: "",
  heightUnit: "in",
};

/** The same constants the server's BMI uses (`apps/backend/.../authoring/vitals.ts`), so the preview matches what is stored. */
const KG_PER_LB = 0.45359237;
const CM_PER_IN = 2.54;
const CM_PER_M = 100;
const POSITIVE_NUMBER = /^\d+(\.\d+)?$/;

function positiveNumber(typed: string): number | null {
  const text = typed.trim();
  if (!POSITIVE_NUMBER.test(text)) return null;
  const value = Number(text);
  return value > 0 ? value : null;
}

/** What is wrong with a typed weight or height, per field. A blank field is fine: the measurement was not taken. */
export function bodyMeasureErrors(values: BodyMeasureValues): {
  readonly weight?: string;
  readonly height?: string;
} {
  const problem = (typed: string, noun: string): string | undefined =>
    typed.trim() !== "" && positiveNumber(typed) === null
      ? `Enter the ${noun} as a number greater than 0.`
      : undefined;
  const weight = problem(values.weight, "weight");
  const height = problem(values.height, "height");
  return { ...(weight ? { weight } : {}), ...(height ? { height } : {}) };
}

/** The `weight`, `weightUnit`, `height`, `heightUnit` members of the vitals capture body: only what was entered, each with its unit. */
export function bodyMeasurePayload(values: BodyMeasureValues): {
  readonly weight?: string;
  readonly weightUnit?: WeightUnit;
  readonly height?: string;
  readonly heightUnit?: HeightUnit;
} {
  const errors = bodyMeasureErrors(values);
  const weight = errors.weight === undefined && positiveNumber(values.weight) !== null;
  const height = errors.height === undefined && positiveNumber(values.height) !== null;
  return {
    ...(weight ? { weight: values.weight.trim(), weightUnit: values.weightUnit } : {}),
    ...(height ? { height: values.height.trim(), heightUnit: values.heightUnit } : {}),
  };
}

/** BMI to one decimal, computed exactly as the server does (kg / m squared), or null until both measures are valid. */
export function computeBmi(values: BodyMeasureValues): string | null {
  const weight = positiveNumber(values.weight);
  const height = positiveNumber(values.height);
  if (weight === null || height === null) return null;
  const kg = values.weightUnit === "lb" ? weight * KG_PER_LB : weight;
  const cm = values.heightUnit === "in" ? height * CM_PER_IN : height;
  const metres = cm / CM_PER_M;
  return (kg / (metres * metres)).toFixed(1);
}

const isWeightUnit = (unit: string): unit is WeightUnit => unit === "lb" || unit === "kg";
const toKg = (value: number, unit: WeightUnit): number =>
  unit === "lb" ? value * KG_PER_LB : value;
const fromKg = (kg: number, unit: WeightUnit): number => (unit === "lb" ? kg / KG_PER_LB : kg);

const oneDecimal = (value: number): string => String(Math.round(value * 10) / 10);

/** "Down 3 lb.", "Up 2.5 kg." or "No change.", in the unit of the new reading; null when the prior unit is not lb or kg. */
export function weightChangeText(
  entered: { readonly value: string; readonly unit: WeightUnit },
  prior: { readonly value: string; readonly unit: string },
): string | null {
  const now = positiveNumber(entered.value);
  const before = positiveNumber(prior.value);
  if (now === null || before === null || !isWeightUnit(prior.unit)) return null;
  const change = now - fromKg(toKg(before, prior.unit), entered.unit);
  const rounded = Math.round(change * 10) / 10;
  if (rounded === 0) return "No change.";
  return `${rounded < 0 ? "Down" : "Up"} ${oneDecimal(Math.abs(rounded))} ${entered.unit}.`;
}

/**
 * The line under the weight field: the last visit's weight and, once a weight is typed, the change in plain words.
 * No judgement is attached to the change; the clinician and the note's own sentence say what it means.
 */
export function priorWeightLine(
  prior: WeightReading | null,
  entered: { readonly value: string; readonly unit: WeightUnit },
  now: Date = new Date(),
): string | null {
  if (prior === null) return null;
  const last = `Last visit (${shortDate(prior.on, { yearlessIn: now })}): ${prior.value} ${prior.unit}.`;
  const change = weightChangeText(entered, prior);
  return change === null ? last : `${last} ${change}`;
}
