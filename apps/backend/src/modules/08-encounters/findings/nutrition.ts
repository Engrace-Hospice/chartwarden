// apps/backend/src/modules/08-encounters/findings/nutrition.ts — WF09: the nutrition and hydration status a clinician records
// on one visit (pure). Same shape as adl.ts: the PUT body is the `RecordedNutrition` of @chartwarden/hearthnote, validated against
// its constants (the sets the `encounter_nutrition` CHECK constraints enforce), mapped to the stored columns and back. No IO.
import {
  APPETITE_LEVELS,
  type AppetiteLevel,
  FLUID_INTAKE_LEVELS,
  type FluidIntakeLevel,
  NUTRITION_SUPPORTS,
  type NutritionSupport,
  type RecordedNutrition,
  SWALLOWING_LEVELS,
  type SwallowingLevel,
} from "@chartwarden/hearthnote";
import { invalid, oneOfOrNull } from "./validate";

/** The PUT body. An absent or null field is "not assessed"; the PUT replaces the whole record. */
export type NutritionInput = RecordedNutrition;

/** The stored columns of one `encounter_nutrition` row (the Drizzle insert shape minus ids and stamps). */
export interface NutritionColumns {
  readonly appetite: AppetiteLevel | null;
  readonly mealIntakePercent: number | null;
  readonly fluidIntake: FluidIntakeLevel | null;
  readonly swallowing: SwallowingLevel | null;
  readonly support: NutritionSupport | null;
}

const MEAL_INTAKE_MIN = 0;
const MEAL_INTAKE_MAX = 100;

function mealIntakeOf(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MEAL_INTAKE_MIN ||
    value > MEAL_INTAKE_MAX
  ) {
    return invalid(
      "mealIntakePercent",
      `must be a whole percent from ${MEAL_INTAKE_MIN} to ${MEAL_INTAKE_MAX}`,
    );
  }
  return value;
}

/** Validate a nutrition PUT body and return the columns it stores; throws the 422 envelope naming the first bad field. */
export function planNutritionRecord(input: NutritionInput): NutritionColumns {
  return {
    appetite: oneOfOrNull("appetite", input.appetite, APPETITE_LEVELS),
    mealIntakePercent: mealIntakeOf(input.mealIntakePercent),
    fluidIntake: oneOfOrNull("fluidIntake", input.fluidIntake, FLUID_INTAKE_LEVELS),
    swallowing: oneOfOrNull("swallowing", input.swallowing, SWALLOWING_LEVELS),
    support: oneOfOrNull("support", input.support, NUTRITION_SUPPORTS),
  };
}

/** The nutrition facts a note states, from a stored row: null columns are omitted (a recorded 0 percent is kept). */
export function recordedNutritionFromRow(row: NutritionColumns): RecordedNutrition {
  return {
    ...(row.appetite === null ? {} : { appetite: row.appetite }),
    ...(row.mealIntakePercent === null ? {} : { mealIntakePercent: row.mealIntakePercent }),
    ...(row.fluidIntake === null ? {} : { fluidIntake: row.fluidIntake }),
    ...(row.swallowing === null ? {} : { swallowing: row.swallowing }),
    ...(row.support === null ? {} : { support: row.support }),
  };
}
