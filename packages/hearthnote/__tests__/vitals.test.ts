// packages/hearthnote/__tests__/vitals.test.ts — WF09.
// The recorded-vitals sentence: the original wording is byte-stable, and height, BMI and the change since the
// previous visit are stated from stored values only (exact decimal arithmetic, no float noise).
import { describe, expect, it } from "vitest";
import { type RecordedVitals, describeRecordedVitals } from "../src/index";

const BASE: RecordedVitals = {
  bpSystolic: 128,
  bpDiastolic: 88,
  heartRate: 78,
  respiratoryRate: 12,
  temperature: "97.8",
  temperatureUnit: "f",
  spo2: 97,
  painScore: 5,
  weight: "61.5",
  weightUnit: "kg",
};

const prior = (value: string, unit: string, on = "2026-11-05"): RecordedVitals["priorWeight"] => ({
  value,
  unit,
  on,
});

describe("describeRecordedVitals — regression (nothing new recorded)", () => {
  it("keeps the original sentence byte for byte", () => {
    expect(describeRecordedVitals(BASE)).toBe(
      "Vital signs: blood pressure 128/88 mmHg, heart rate 78 bpm, respiratory rate 12 breaths/min, temperature 97.8 °F, SpO₂ 97%, pain score 5 of 10, weight 61.5 kg.",
    );
    expect(describeRecordedVitals({ weight: "134.5", weightUnit: "lb" })).toBe(
      "Vital signs: weight 134.5 lb.",
    );
    expect(describeRecordedVitals({ weight: "61.5" })).toBe("Vital signs: weight 61.5.");
    expect(describeRecordedVitals({ bpSystolic: 128 })).toBe(
      "Vital signs: systolic blood pressure 128 mmHg.",
    );
  });

  it("ignores the new fields when they are empty", () => {
    const empty: RecordedVitals = {
      ...BASE,
      height: null,
      heightUnit: null,
      bmi: null,
      priorWeight: null,
    };
    expect(describeRecordedVitals(empty)).toBe(describeRecordedVitals(BASE));
    expect(describeRecordedVitals({ ...BASE, height: "  ", bmi: "" })).toBe(
      describeRecordedVitals(BASE),
    );
  });

  it("is empty when nothing is recorded", () => {
    expect(describeRecordedVitals(undefined)).toBe("");
    expect(describeRecordedVitals({})).toBe("");
    expect(describeRecordedVitals({ height: null, bmi: null, priorWeight: null })).toBe("");
  });

  it("adds no change when there is no current weight, even with a prior one", () => {
    expect(describeRecordedVitals({ heartRate: 70, priorWeight: prior("62.5", "kg") })).toBe(
      "Vital signs: heart rate 70 bpm.",
    );
  });
});

describe("describeRecordedVitals — height and BMI", () => {
  it("states height and BMI as stored after the weight", () => {
    expect(
      describeRecordedVitals({
        weight: "61.2",
        weightUnit: "kg",
        height: "170",
        heightUnit: "cm",
        bmi: "24.3",
      }),
    ).toBe("Vital signs: weight 61.2 kg, height 170 cm, BMI 24.3.");
  });

  it("states each on its own when the others were not recorded", () => {
    expect(describeRecordedVitals({ height: "67", heightUnit: "in" })).toBe(
      "Vital signs: height 67 in.",
    );
    expect(describeRecordedVitals({ bmi: "24.3" })).toBe("Vital signs: BMI 24.3.");
  });

  it("states a height without a unit we name as the bare value", () => {
    expect(describeRecordedVitals({ height: "170", heightUnit: "furlongs" })).toBe(
      "Vital signs: height 170.",
    );
  });
});

describe("describeRecordedVitals — change since the previous visit", () => {
  const withWeight = (current: string, p: RecordedVitals["priorWeight"], unit = "kg"): string =>
    describeRecordedVitals({ weight: current, weightUnit: unit, priorWeight: p });

  it("states a loss in the same unit", () => {
    expect(withWeight("61.2", prior("62.5", "kg"))).toBe(
      "Vital signs: weight 61.2 kg, 1.3 kg lower than 62.5 kg on 2026-11-05.",
    );
  });

  it("states a gain in the same unit", () => {
    expect(withWeight("62.9", prior("62.5", "kg"))).toBe(
      "Vital signs: weight 62.9 kg, 0.4 kg higher than 62.5 kg on 2026-11-05.",
    );
  });

  it("states no change", () => {
    expect(withWeight("62.5", prior("62.50", "kg"))).toBe(
      "Vital signs: weight 62.5 kg, unchanged from 62.50 kg on 2026-11-05.",
    );
  });

  it("does the decimal arithmetic exactly, with no float noise", () => {
    // 0.3 - 0.1 and 0.1 + 0.2 style values are the classic float traps.
    expect(withWeight("0.3", prior("0.1", "kg"))).toContain("0.2 kg higher than 0.1 kg");
    expect(withWeight("100.3", prior("100.1", "lb"), "lb")).toContain(
      "0.2 lb higher than 100.1 lb",
    );
    expect(withWeight("61.20", prior("62.5", "kg"))).toContain("1.3 kg lower");
    expect(withWeight("60", prior("62.5", "kg"))).toContain("2.5 kg lower");
    expect(withWeight("62", prior("60", "kg"))).toContain("2 kg higher");
    expect(withWeight("1234567890123456.7", prior("1234567890123456.1", "kg"))).toContain(
      "0.6 kg higher",
    );
  });

  it("states the prior weight without a difference when the units differ", () => {
    expect(withWeight("61.2", prior("137.8", "lb"))).toBe(
      "Vital signs: weight 61.2 kg, prior weight 137.8 lb on 2026-11-05.",
    );
  });

  it("states the prior weight without a difference when either unit is not one we name", () => {
    expect(withWeight("61.2", prior("62.5", "stone"))).toBe(
      "Vital signs: weight 61.2 kg, prior weight 62.5 on 2026-11-05.",
    );
    expect(withWeight("61.2", prior("62.5", "kg"), "stone")).toBe(
      "Vital signs: weight 61.2, prior weight 62.5 kg on 2026-11-05.",
    );
  });

  it("states the prior weight without a difference when a value is not a decimal", () => {
    expect(withWeight("sixty", prior("62.5", "kg"))).toBe(
      "Vital signs: weight sixty kg, prior weight 62.5 kg on 2026-11-05.",
    );
    expect(withWeight("61.2", prior("62,5", "kg"))).toBe(
      "Vital signs: weight 61.2 kg, prior weight 62,5 kg on 2026-11-05.",
    );
  });

  it("drops the date when none was given and the prior entry when it has no value", () => {
    expect(withWeight("61.2", prior("62.5", "kg", " "))).toBe(
      "Vital signs: weight 61.2 kg, 1.3 kg lower than 62.5 kg.",
    );
    expect(withWeight("61.2", prior(" ", "kg"))).toBe("Vital signs: weight 61.2 kg.");
  });

  it("puts the change before height and BMI", () => {
    expect(
      describeRecordedVitals({
        weight: "61.2",
        weightUnit: "kg",
        priorWeight: prior("62.5", "kg"),
        height: "170",
        heightUnit: "cm",
        bmi: "24.3",
      }),
    ).toBe(
      "Vital signs: weight 61.2 kg, 1.3 kg lower than 62.5 kg on 2026-11-05, height 170 cm, BMI 24.3.",
    );
  });
});
