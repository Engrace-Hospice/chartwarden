import { describe, expect, it } from "vitest";
import { advisoryNote, isHighRisk } from "./medication-status";

describe("scheduled-drug advisory", () => {
  it("counts a drug scheduled by name as high risk and explains it, without claiming the class flag", () => {
    const lorazepamStandard = { isControlledSubstance: false, advisoryDeaSchedule: "IV" };
    expect(isHighRisk(lorazepamStandard)).toBe(true);
    expect(advisoryNote(lorazepamStandard)).toContain("C-IV");
  });
  it("adds nothing for a class-controlled or unscheduled order", () => {
    expect(advisoryNote({ isControlledSubstance: true, advisoryDeaSchedule: "II" })).toBeNull();
    expect(isHighRisk({ isControlledSubstance: false, advisoryDeaSchedule: null })).toBe(false);
  });
});
