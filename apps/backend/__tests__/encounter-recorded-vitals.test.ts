// WF09 — the vitals a visit note states (`recordedVitalsFrom`), the derived BMI (`computeBmi`) and the weight/height capture rules
// (`planVitalsCapture`). Pure: no database. The merge reads every set captured on the encounter, newest first.
import { ValidationError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  type VitalsInput,
  computeBmi,
  planVitalsCapture,
  recordedVitalsFrom,
  unitlessMeasurements,
} from "../src/modules/08-encounters/authoring/index";
import {
  parseHeight,
  parseWeight,
  plausibleKilograms,
  plausibleMetres,
} from "../src/modules/08-encounters/authoring/measurements";

/** The field names a 422 from the capture planner names. */
function failedFields(input: VitalsInput): string[] {
  try {
    planVitalsCapture(input);
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as ValidationError).statusCode).toBe(422);
    return ((e as ValidationError).details ?? []).map((d) => d.field ?? "");
  }
  throw new Error("expected the capture to be refused");
}

describe("recordedVitalsFrom — merging the sets of one encounter (newest first)", () => {
  it("takes each measurement from the newest set that carries it, so a partial retake keeps the earlier reading", () => {
    const merged = recordedVitalsFrom([
      { heartRate: 88 },
      { heartRate: 70, respiratoryRate: 16, spo2: 95 },
    ]);
    expect(merged).toMatchObject({ heartRate: 88, respiratoryRate: 16, spo2: 95 });
  });

  it("states systolic and diastolic from the SAME set: the newest one that has both", () => {
    const merged = recordedVitalsFrom([
      { bpSystolic: 150 },
      { bpSystolic: 120, bpDiastolic: 80 },
      { bpSystolic: 110, bpDiastolic: 70 },
    ]);
    expect(merged.bpSystolic).toBe(120);
    expect(merged.bpDiastolic).toBe(80);
  });

  it("never pairs halves of different sets when no set has both: the newest set with either is stated alone", () => {
    const merged = recordedVitalsFrom([{ bpSystolic: 150 }, { bpDiastolic: 80 }]);
    expect(merged.bpSystolic).toBe(150);
    expect(merged.bpDiastolic).toBeUndefined();
  });

  it("takes a temperature together with the unit it was captured in", () => {
    const merged = recordedVitalsFrom([
      { temperature: "98.6", temperatureUnit: "f" },
      { temperature: "37", temperatureUnit: "c" },
    ]);
    expect(merged).toMatchObject({ temperature: "98.6", temperatureUnit: "f" });
  });

  it("takes a weight with its own unit, and skips a set whose weight has none", () => {
    const merged = recordedVitalsFrom([
      { weight: "150" },
      { weight: "68", weightUnit: "kg" },
      { weight: "140", weightUnit: "lb" },
    ]);
    expect(merged).toMatchObject({ weight: "68", weightUnit: "kg" });
  });

  it("ignores a weight in a unit of the wrong family and a height that is not a number", () => {
    const merged = recordedVitalsFrom([
      { weight: "150", weightUnit: "mmHg" },
      { height: "tall", heightUnit: "cm" },
    ]);
    expect(merged.weight).toBeUndefined();
    expect(merged.height).toBeUndefined();
    expect(merged.bmi).toBeUndefined();
  });

  it("derives BMI from the MERGED weight and height, whichever sets they came from", () => {
    const merged = recordedVitalsFrom([
      { height: "175", heightUnit: "cm" },
      { weight: "70", weightUnit: "kg" },
    ]);
    expect(merged.bmi).toBe("22.9");
  });

  it("derives no BMI from a weight and height in different unit systems that cannot be a person", () => {
    const merged = recordedVitalsFrom([
      { weight: "70", weightUnit: "kg", height: "5.8", heightUnit: "in" },
    ]);
    expect(merged.bmi).toBeUndefined();
  });

  it("states nothing for no sets", () => {
    expect(recordedVitalsFrom([])).toEqual({});
  });
});

describe("computeBmi — never guesses a unit or a value", () => {
  it("is null without a weight unit, a height unit or both", () => {
    expect(computeBmi({ weight: "150", height: "68" })).toBeNull();
    expect(computeBmi({ weight: "150", height: "68", heightUnit: "in" })).toBeNull();
    expect(computeBmi({ weight: "150", weightUnit: "lb", height: "68" })).toBeNull();
  });

  it("is null for a unit from the wrong family", () => {
    expect(
      computeBmi({ weight: "70", weightUnit: "mmHg", height: "175", heightUnit: "cm" }),
    ).toBeNull();
    expect(
      computeBmi({ weight: "70", weightUnit: "kg", height: "175", heightUnit: "kg" }),
    ).toBeNull();
  });

  it("is null for a value that is not a positive plain number, or is not a plausible human size", () => {
    for (const bad of ["abc", "0", "-70", "7e1", "0x46", ""]) {
      expect(
        computeBmi({ weight: bad, weightUnit: "kg", height: "175", heightUnit: "cm" }),
      ).toBeNull();
    }
    expect(
      computeBmi({ weight: "70", weightUnit: "kg", height: "5.8", heightUnit: "in" }),
    ).toBeNull();
    expect(
      computeBmi({ weight: "7000", weightUnit: "kg", height: "175", heightUnit: "cm" }),
    ).toBeNull();
  });

  it("computes it for both unit systems", () => {
    expect(computeBmi({ weight: "70", weightUnit: "kg", height: "175", heightUnit: "cm" })).toBe(
      "22.9",
    );
    expect(computeBmi({ weight: "154", weightUnit: "lb", height: "69", heightUnit: "in" })).toBe(
      "22.7",
    );
  });
});

describe("planVitalsCapture — weight and height need a number and a unit of their own family", () => {
  it("refuses a weight with no unit, naming the unit field", () => {
    expect(failedFields({ weight: "150" })).toEqual(["weightUnit"]);
    expect(failedFields({ height: "68" })).toEqual(["heightUnit"]);
  });

  it("refuses a unit from the wrong family, even with no value", () => {
    expect(failedFields({ weight: "150", weightUnit: "mmHg" })).toEqual(["weightUnit"]);
    expect(failedFields({ height: "68", heightUnit: "kg" })).toEqual(["heightUnit"]);
    expect(failedFields({ weightUnit: "cm" })).toEqual(["weightUnit"]);
  });

  it("refuses a value that is not a positive number", () => {
    for (const bad of ["abc", "0", "-5", "1e3", "12 lb"]) {
      expect(failedFields({ weight: bad, weightUnit: "lb" })).toEqual(["weight"]);
    }
  });

  it("names every field that is wrong at once", () => {
    expect(failedFields({ weight: "abc", height: "68" })).toEqual([
      "weight",
      "weightUnit",
      "heightUnit",
    ]);
  });

  it("accepts a complete pair and stores its BMI", () => {
    const plan = planVitalsCapture({
      weight: "70",
      weightUnit: "kg",
      height: "175",
      heightUnit: "cm",
    });
    expect(plan.bmi).toBe("22.9");
    expect(plan.fieldsCaptured).toEqual(["weight", "height"]);
  });

  it("accepts a capture with no weight or height at all", () => {
    expect(planVitalsCapture({ bpSystolic: 120, bpDiastolic: 80 }).bmi).toBeNull();
  });
});

describe("measurements — the one rule for a recorded weight or height", () => {
  it("requires a unit of the family and a plain positive decimal", () => {
    expect(parseWeight("150.5", "lb")).toEqual({ value: 150.5, unit: "lb" });
    expect(parseWeight(" 68 ", "kg")).toEqual({ value: 68, unit: "kg" });
    expect(parseWeight("150", null)).toBeNull();
    expect(parseWeight("150", "cm")).toBeNull();
    expect(parseHeight("68", "in")).toEqual({ value: 68, unit: "in" });
    expect(parseHeight("68", "lb")).toBeNull();
    expect(parseHeight("-1", "cm")).toBeNull();
  });

  it("bounds the derived sizes to what a person can be", () => {
    expect(plausibleKilograms("1", "kg")).toBeNull();
    expect(plausibleKilograms("70", "kg")).toBe(70);
    expect(plausibleMetres("20", "cm")).toBeNull();
    expect(plausibleMetres("175", "cm")).toBeCloseTo(1.75);
  });
});

describe("unitlessMeasurements — a stored weight or height that cannot be stated is reported, not silently dropped", () => {
  it("flags a weight with no unit or a unit of the wrong family, and a height likewise", () => {
    expect(unitlessMeasurements([{ weight: "150", weightUnit: null }])).toEqual({
      weightUnitMissing: true,
      heightUnitMissing: false,
    });
    expect(unitlessMeasurements([{ weight: "150", weightUnit: "mmHg" }]).weightUnitMissing).toBe(
      true,
    );
    expect(unitlessMeasurements([{ height: "68", heightUnit: null }])).toEqual({
      weightUnitMissing: false,
      heightUnitMissing: true,
    });
  });

  it("flags any one row among several, and nothing for complete, absent or non-numeric values", () => {
    expect(
      unitlessMeasurements([
        { weight: "70", weightUnit: "kg", height: "175", heightUnit: "cm" },
        { weight: "71", weightUnit: null },
      ]).weightUnitMissing,
    ).toBe(true);
    expect(
      unitlessMeasurements([
        { weight: "70", weightUnit: "kg", height: "175", heightUnit: "cm" },
        { weight: null, weightUnit: null },
        { weight: "abc", weightUnit: null },
      ]),
    ).toEqual({ weightUnitMissing: false, heightUnitMissing: false });
    expect(unitlessMeasurements([])).toEqual({
      weightUnitMissing: false,
      heightUnitMissing: false,
    });
  });
});
