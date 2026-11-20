import { describe, expect, it } from "vitest";
import type { AdlView, NutritionView } from "./findings-api";
import {
  EMPTY_BODY_MEASURES,
  adlBodyFromForm,
  adlFormFromView,
  adlFormSignature,
  bodyMeasureErrors,
  bodyMeasurePayload,
  computeBmi,
  mealIntakeProblem,
  nutritionBodyFromForm,
  nutritionFormFromView,
  nutritionFormSignature,
  priorWeightLine,
  weightChangeText,
  withAdlItem,
  withDevice,
} from "./findings-model";

const STORED_ADL: AdlView = {
  encounterId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
  patientId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  version: 1_763_546_400_000,
  items: { bathing: "limited_assist", eating: "independent" },
  bladder: "continent",
  bowel: null,
  devices: ["walker"],
  updatedAt: "2026-11-19T10:00:00.000Z",
};

describe("ADL form", () => {
  it("starts empty when nothing was recorded", () => {
    expect(adlFormFromView(null)).toEqual({ items: {}, bladder: null, bowel: null, devices: [] });
  });

  it("reads a stored record into the form and back into the same PUT body", () => {
    const form = adlFormFromView(STORED_ADL);

    expect(form.items).toEqual({ bathing: "limited_assist", eating: "independent" });
    expect(adlBodyFromForm(form)).toEqual({
      items: { bathing: "limited_assist", eating: "independent" },
      bladder: "continent",
      bowel: null,
      devices: ["walker"],
    });
  });

  it("drops an item set back to not assessed, and never mutates the form it was given", () => {
    const before = adlFormFromView(STORED_ADL);

    const after = withAdlItem(before, "bathing", null);

    expect(after.items).toEqual({ eating: "independent" });
    expect(before.items).toEqual({ bathing: "limited_assist", eating: "independent" });
    expect(withAdlItem(before, "dressing", "supervision").items.dressing).toBe("supervision");
  });

  it("sends devices in the documented order whatever order they were ticked in", () => {
    const ticked = withDevice(withDevice(adlFormFromView(null), "walker", true), "cane", true);

    expect(ticked.devices).toEqual(["walker", "cane"]);
    expect(adlBodyFromForm(ticked).devices).toEqual(["cane", "walker"]);
    expect(withDevice(ticked, "walker", false).devices).toEqual(["cane"]);
  });
});

describe("nutrition form", () => {
  const STORED: NutritionView = {
    encounterId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
    patientId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
    version: 1_763_546_400_000,
    appetite: "poor",
    mealIntakePercent: 0,
    fluidIntake: null,
    swallowing: "difficulty_solids",
    support: null,
    updatedAt: "2026-11-19T10:00:00.000Z",
  };

  it("keeps a recorded 0 percent as the text 0, not as blank", () => {
    expect(nutritionFormFromView(STORED).mealIntake).toBe("0");
    expect(nutritionFormFromView(null).mealIntake).toBe("");
  });

  it("builds the whole PUT body, with every field not assessed sent as null", () => {
    expect(nutritionBodyFromForm(nutritionFormFromView(STORED))).toEqual({
      appetite: "poor",
      mealIntakePercent: 0,
      fluidIntake: null,
      swallowing: "difficulty_solids",
      support: null,
    });
    expect(nutritionBodyFromForm(nutritionFormFromView(null))).toEqual({
      appetite: null,
      mealIntakePercent: null,
      fluidIntake: null,
      swallowing: null,
      support: null,
    });
  });

  it.each(["", "  ", "0", "45", " 45 ", "100"])("accepts %j as the share of meals", (typed) => {
    expect(mealIntakeProblem(typed)).toBeNull();
  });

  it.each(["101", "-1", "12.5", "abc", "1e2", "4 5", "+5"])(
    "refuses %j as the share of meals",
    (typed) => {
      expect(mealIntakeProblem(typed)).toBe("Enter a whole number from 0 to 100.");
    },
  );
});

describe("BMI", () => {
  const values = (
    weight: string,
    weightUnit: "lb" | "kg",
    height: string,
    heightUnit: "in" | "cm",
  ) => ({
    weight,
    weightUnit,
    height,
    heightUnit,
  });

  // The expected values are what the server's computeBmi (authoring/vitals.ts) answers for the same inputs.
  it.each([
    ["150", "lb", "65", "in", "25.0"],
    ["70", "kg", "175", "cm", "22.9"],
    ["70", "kg", "70", "in", "22.1"],
    ["152", "lb", "64", "in", "26.1"],
    ["68", "kg", "170", "cm", "23.5"],
  ] as const)("computes %s %s over %s %s as %s", (weight, wu, height, hu, expected) => {
    expect(computeBmi(values(weight, wu, height, hu))).toBe(expected);
  });

  it("is null until both measures are valid numbers above zero", () => {
    expect(computeBmi(EMPTY_BODY_MEASURES)).toBeNull();
    expect(computeBmi(values("150", "lb", "", "in"))).toBeNull();
    expect(computeBmi(values("", "lb", "65", "in"))).toBeNull();
    expect(computeBmi(values("abc", "lb", "65", "in"))).toBeNull();
    expect(computeBmi(values("150", "lb", "0", "in"))).toBeNull();
  });
});

describe("weight and height entry", () => {
  it("accepts blank fields and positive numbers, and names a bad one", () => {
    expect(bodyMeasureErrors(EMPTY_BODY_MEASURES)).toEqual({});
    expect(bodyMeasureErrors({ ...EMPTY_BODY_MEASURES, weight: "152.5", height: "64" })).toEqual(
      {},
    );
    expect(bodyMeasureErrors({ ...EMPTY_BODY_MEASURES, weight: "0", height: "six" })).toEqual({
      weight: "Enter the weight as a number greater than 0.",
      height: "Enter the height as a number greater than 0.",
    });
  });

  it("puts only the entered measures, each with its unit, into the vitals body", () => {
    expect(bodyMeasurePayload(EMPTY_BODY_MEASURES)).toEqual({});
    expect(
      bodyMeasurePayload({ weight: " 152 ", weightUnit: "kg", height: "", heightUnit: "cm" }),
    ).toEqual({ weight: "152", weightUnit: "kg" });
    expect(
      bodyMeasurePayload({ weight: "152", weightUnit: "lb", height: "64", heightUnit: "in" }),
    ).toEqual({ weight: "152", weightUnit: "lb", height: "64", heightUnit: "in" });
  });

  it("leaves out a measure that is not a valid number rather than sending it", () => {
    expect(
      bodyMeasurePayload({ weight: "abc", weightUnit: "lb", height: "64", heightUnit: "in" }),
    ).toEqual({ height: "64", heightUnit: "in" });
  });
});

describe("weight change", () => {
  const prior = { value: "155", unit: "lb" };

  it.each([
    ["152", "lb", "Down 3 lb."],
    ["157.5", "lb", "Up 2.5 lb."],
    ["155", "lb", "No change."],
    ["155.04", "lb", "No change."],
  ] as const)("states %s %s against 155 lb as %s", (value, unit, expected) => {
    expect(weightChangeText({ value, unit }, prior)).toBe(expected);
  });

  it("converts the prior reading into the unit being entered", () => {
    // 155 lb is 70.3 kg.
    expect(weightChangeText({ value: "70", unit: "kg" }, prior)).toBe("Down 0.3 kg.");
    expect(weightChangeText({ value: "155", unit: "lb" }, { value: "70.3", unit: "kg" })).toBe(
      "No change.",
    );
  });

  it("says nothing when either weight is missing or the prior unit is not lb or kg", () => {
    expect(weightChangeText({ value: "", unit: "lb" }, prior)).toBeNull();
    expect(weightChangeText({ value: "abc", unit: "lb" }, prior)).toBeNull();
    expect(weightChangeText({ value: "150", unit: "lb" }, { value: "x", unit: "lb" })).toBeNull();
    expect(
      weightChangeText({ value: "150", unit: "lb" }, { value: "70", unit: "stone" }),
    ).toBeNull();
  });
});

describe("last-visit line", () => {
  const now = new Date(2026, 10, 19);
  const prior = { value: "155", unit: "lb", on: "2026-11-04" };

  it("is absent without an earlier weight", () => {
    expect(priorWeightLine(null, { value: "152", unit: "lb" }, now)).toBeNull();
  });

  it("states the last visit alone until a weight is typed", () => {
    expect(priorWeightLine(prior, { value: "", unit: "lb" }, now)).toBe(
      "Last visit (Nov 4): 155 lb.",
    );
  });

  it("adds the change in plain words once a weight is typed", () => {
    expect(priorWeightLine(prior, { value: "152", unit: "lb" }, now)).toBe(
      "Last visit (Nov 4): 155 lb. Down 3 lb.",
    );
  });
});

describe("form signatures", () => {
  it("reads two ADL forms with the same answers as one, whatever order they were edited in", () => {
    const first = withAdlItem(
      withAdlItem(adlFormFromView(null), "bathing", "limited_assist"),
      "eating",
      "independent",
    );
    const second = withAdlItem(
      withAdlItem(adlFormFromView(null), "eating", "independent"),
      "bathing",
      "limited_assist",
    );
    expect(adlFormSignature(first)).toBe(adlFormSignature(second));
  });

  it("reads an ADL form that changed an answer, or a device, as different", () => {
    const stored = adlFormFromView(STORED_ADL);
    expect(adlFormSignature(withAdlItem(stored, "bathing", "independent"))).not.toBe(
      adlFormSignature(stored),
    );
    expect(adlFormSignature(withDevice(stored, "cane", true))).not.toBe(adlFormSignature(stored));
    expect(
      adlFormSignature(
        withAdlItem(withAdlItem(stored, "bathing", null), "bathing", "limited_assist"),
      ),
    ).toBe(adlFormSignature(stored));
  });

  it("counts a typed share of meals that is not a number as typed", () => {
    const stored = nutritionFormFromView(null);
    expect(nutritionFormSignature({ ...stored, mealIntake: "abc" })).not.toBe(
      nutritionFormSignature(stored),
    );
    expect(nutritionFormSignature({ ...stored, mealIntake: " " })).toBe(
      nutritionFormSignature(stored),
    );
  });
});
