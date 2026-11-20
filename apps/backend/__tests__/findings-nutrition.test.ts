// WF09 — the nutrition record authoring rules (pure): validation of the PUT body and the note-fact mapping.
import {
  APPETITE_LEVELS,
  FLUID_INTAKE_LEVELS,
  NUTRITION_SUPPORTS,
  SWALLOWING_LEVELS,
} from "@chartwarden/hearthnote";
import { describe, expect, it } from "vitest";
import {
  type NutritionColumns,
  planNutritionRecord,
  recordedNutritionFromRow,
} from "../src/modules/08-encounters/findings/nutrition";

const EMPTY: NutritionColumns = {
  appetite: null,
  mealIntakePercent: null,
  fluidIntake: null,
  swallowing: null,
  support: null,
};

describe("planNutritionRecord", () => {
  it("maps the body to the stored columns, null for what was not assessed", () => {
    expect(planNutritionRecord({ appetite: "poor", mealIntakePercent: 25 })).toEqual({
      ...EMPTY,
      appetite: "poor",
      mealIntakePercent: 25,
    });
  });

  it("accepts every documented value of every set", () => {
    for (const v of APPETITE_LEVELS) expect(planNutritionRecord({ appetite: v }).appetite).toBe(v);
    for (const v of FLUID_INTAKE_LEVELS)
      expect(planNutritionRecord({ fluidIntake: v }).fluidIntake).toBe(v);
    for (const v of SWALLOWING_LEVELS)
      expect(planNutritionRecord({ swallowing: v }).swallowing).toBe(v);
    for (const v of NUTRITION_SUPPORTS) expect(planNutritionRecord({ support: v }).support).toBe(v);
  });

  it("treats an empty body as a cleared record and null as not assessed", () => {
    expect(planNutritionRecord({})).toEqual(EMPTY);
    expect(planNutritionRecord({ appetite: null, mealIntakePercent: null })).toEqual(EMPTY);
  });

  it("accepts the 0 and 100 percent edges", () => {
    expect(planNutritionRecord({ mealIntakePercent: 0 }).mealIntakePercent).toBe(0);
    expect(planNutritionRecord({ mealIntakePercent: 100 }).mealIntakePercent).toBe(100);
  });

  it.each([
    ["an unknown appetite", { appetite: "ravenous" }, "appetite"],
    ["an unknown fluid intake", { fluidIntake: "flood" }, "fluidIntake"],
    ["an unknown swallowing level", { swallowing: "fine" }, "swallowing"],
    ["an unknown support", { support: "magic" }, "support"],
    ["a percent over 100", { mealIntakePercent: 101 }, "mealIntakePercent"],
    ["a negative percent", { mealIntakePercent: -1 }, "mealIntakePercent"],
    ["a fractional percent", { mealIntakePercent: 12.5 }, "mealIntakePercent"],
    ["a non-numeric percent", { mealIntakePercent: "half" }, "mealIntakePercent"],
  ])("rejects %s with a 422 naming the field", (_name, input, field) => {
    const run = () => planNutritionRecord(input as never);
    expect(run).toThrowError(
      expect.objectContaining({ statusCode: 422, code: "VALIDATION_FAILED" }),
    );
    try {
      run();
    } catch (e) {
      expect((e as { details?: { field: string }[] }).details?.[0]?.field).toBe(field);
    }
  });
});

describe("recordedNutritionFromRow", () => {
  it("omits null fields", () => {
    expect(recordedNutritionFromRow({ ...EMPTY, appetite: "fair", mealIntakePercent: 0 })).toEqual({
      appetite: "fair",
      mealIntakePercent: 0,
    });
  });

  it("returns an empty object for a row that recorded nothing", () => {
    expect(recordedNutritionFromRow(EMPTY)).toEqual({});
  });
});
