import { describe, expect, it } from "vitest";
import { advisoryNote, highRiskLabel, isHighRisk } from "./medication-status";

describe("scheduled-drug advisory", () => {
  it("counts a drug scheduled by name as high risk and explains it, without claiming the class flag", () => {
    const lorazepamStandard = { isControlledSubstance: false, advisoryDeaSchedule: "IV" };
    expect(isHighRisk(lorazepamStandard)).toBe(true);
    expect(advisoryNote(lorazepamStandard)).toContain("C-IV");
  });
  it("labels a High Risk row with the class schedule, else the marked advisory, else C-?", () => {
    expect(highRiskLabel({ deaSchedule: "II", advisoryDeaSchedule: "IV" })).toBe("C-II");
    expect(highRiskLabel({ deaSchedule: null, advisoryDeaSchedule: "II" })).toBe("C-II (advisory)");
    expect(highRiskLabel({ deaSchedule: null })).toBe("C-?");
  });
  it("adds nothing for a class-controlled or unscheduled order", () => {
    expect(advisoryNote({ isControlledSubstance: true, advisoryDeaSchedule: "II" })).toBeNull();
    expect(isHighRisk({ isControlledSubstance: false, advisoryDeaSchedule: null })).toBe(false);
  });
});
