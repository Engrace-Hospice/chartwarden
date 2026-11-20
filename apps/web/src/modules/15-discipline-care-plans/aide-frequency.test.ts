// The aide task frequency presets: each pairs a plain-words phrase with the machine form the database
// CHECK `discipline_intervention_frequency_value_ck` accepts (migration 0098), so a pick can never be rejected
// at insert the way a free-typed "3/week" was.
import { describe, expect, it } from "vitest";
import { FREQUENCY_PRESETS, frequencyPresetFor } from "./aide-frequency";

/** Verbatim from migration 0098 — the only shape the table accepts. */
const DB_FREQUENCY_CHECK =
  /^([0-9]+:(visit|day|week|month|prn|continuous):(day|week|month|episode|prn))$/;

describe("FREQUENCY_PRESETS", () => {
  it("only offers coded values the discipline_intervention CHECK constraint accepts", () => {
    for (const preset of FREQUENCY_PRESETS) {
      expect(preset.code, preset.words).toMatch(DB_FREQUENCY_CHECK);
    }
  });

  it("pairs each phrase with exactly one code, so either side can drive the other", () => {
    const codes = FREQUENCY_PRESETS.map((p) => p.code);
    const words = FREQUENCY_PRESETS.map((p) => p.words);
    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(words).size).toBe(words.length);
  });

  it("looks a preset up by its code, and answers undefined for anything else", () => {
    expect(frequencyPresetFor("2:visit:week")?.words).toBe("twice weekly");
    expect(frequencyPresetFor("2/week")).toBeUndefined();
    expect(frequencyPresetFor("")).toBeUndefined();
  });
});
