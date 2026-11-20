// apps/backend/src/modules/08-encounters/authoring/measurements.ts — WF09: the one definition of a RECORDED weight or height.
//
// A weight is a number with the unit it was taken in; the vitals capture, the note's "weight" and "BMI", and the weight history
// all read it through here, so the three can never disagree about whether a stored value counts. A value counts only when it is
// a plain positive decimal AND carries a unit of its own family (weight: kg | lb, height: cm | in): a unit is never defaulted,
// because "150" with no unit is not a measurement a note can state and a BMI built on a guessed unit is wrong by a factor of 2 to 40.
// Pure, no IO.

export const WEIGHT_UNITS = ["kg", "lb"] as const;
export type WeightUnit = (typeof WEIGHT_UNITS)[number];
export const HEIGHT_UNITS = ["cm", "in"] as const;
export type HeightUnit = (typeof HEIGHT_UNITS)[number];

/** A measurement as the note and the history take it: the number and its unit, both known. */
export interface Measure<U extends string> {
  readonly value: number;
  readonly unit: U;
}

const KG_PER_LB = 0.45359237;
const CM_PER_INCH = 2.54;
const CM_PER_METRE = 100;

/** Plausible human bounds a derived BMI is computed within; outside them the inputs are a typo or a unit slip, and no BMI is stated. */
const PLAUSIBLE_KG = { min: 2, max: 500 } as const;
const PLAUSIBLE_METRES = { min: 0.4, max: 2.6 } as const;

/** Plain positive decimal text only: no sign, exponent, hex or separators, so what is stored is exactly what the note quotes. */
const POSITIVE_DECIMAL = /^\d+(?:\.\d+)?$/;

/** The number in `text` when it is a plain positive decimal, else null. */
export function positiveDecimal(text: string | null | undefined): number | null {
  const trimmed = text?.trim() ?? "";
  if (!POSITIVE_DECIMAL.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : null;
}

const inFamily = <U extends string>(
  family: readonly U[],
  unit: string | null | undefined,
): unit is U => unit !== null && unit !== undefined && (family as readonly string[]).includes(unit);

/** The weight when `weight` is a positive number AND `unit` is kg or lb; null otherwise (no unit is ever assumed). */
export function parseWeight(
  weight: string | null | undefined,
  unit: string | null | undefined,
): Measure<WeightUnit> | null {
  const value = positiveDecimal(weight);
  return value !== null && inFamily(WEIGHT_UNITS, unit) ? { value, unit } : null;
}

/** The height when `height` is a positive number AND `unit` is cm or in; null otherwise (no unit is ever assumed). */
export function parseHeight(
  height: string | null | undefined,
  unit: string | null | undefined,
): Measure<HeightUnit> | null {
  const value = positiveDecimal(height);
  return value !== null && inFamily(HEIGHT_UNITS, unit) ? { value, unit } : null;
}

/** A recorded weight in kilograms, or null when it is not recorded or not a plausible human weight. */
export function plausibleKilograms(
  weight: string | null | undefined,
  unit: string | null | undefined,
): number | null {
  const parsed = parseWeight(weight, unit);
  if (parsed === null) return null;
  const kg = parsed.unit === "lb" ? parsed.value * KG_PER_LB : parsed.value;
  return kg >= PLAUSIBLE_KG.min && kg <= PLAUSIBLE_KG.max ? kg : null;
}

/** A recorded height in metres, or null when it is not recorded or not a plausible human height. */
export function plausibleMetres(
  height: string | null | undefined,
  unit: string | null | undefined,
): number | null {
  const parsed = parseHeight(height, unit);
  if (parsed === null) return null;
  const metres = (parsed.unit === "in" ? parsed.value * CM_PER_INCH : parsed.value) / CM_PER_METRE;
  return metres >= PLAUSIBLE_METRES.min && metres <= PLAUSIBLE_METRES.max ? metres : null;
}

/** The measurement fields of a stored vitals row that `unitlessMeasurements` reads. */
export interface MeasuredRow {
  readonly weight?: string | null;
  readonly weightUnit?: string | null;
  readonly height?: string | null;
  readonly heightUnit?: string | null;
}

/**
 * Which recorded measurements cannot be stated because their unit is missing or of the wrong family: a legacy row (`weight_unit` is
 * nullable, with no CHECK) that holds a weight but no kg|lb, or a height but no cm|in. Such a value is never stated in the note, the
 * history or the BMI (a unit is never guessed), so it would otherwise vanish without a word: the reads that return stored vitals
 * report it, and a screen can tell the author to re-enter the measurement with its unit.
 */
export function unitlessMeasurements(rows: readonly MeasuredRow[]): {
  readonly weightUnitMissing: boolean;
  readonly heightUnitMissing: boolean;
} {
  return {
    weightUnitMissing: rows.some(
      (r) => positiveDecimal(r.weight) !== null && parseWeight(r.weight, r.weightUnit) === null,
    ),
    heightUnitMissing: rows.some(
      (r) => positiveDecimal(r.height) !== null && parseHeight(r.height, r.heightUnit) === null,
    ),
  };
}
