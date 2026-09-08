import { describe, expect, it } from "vitest";
import {
  deriveHopeJ2051TriggerState,
  hopeSfvDueAtFromJ2050B,
} from "../src/modules/10-hope/hope-sfv-service";

function answers(values: Record<string, string>) {
  return new Map(
    Object.entries(values).map(([itemCode, value]) => [
      itemCode,
      { state: "answered" as const, value },
    ]),
  );
}

describe("HOPE SFV canonical J2051 trigger", () => {
  it("treats moderate or severe J2051 as a definitive SFV trigger", () => {
    expect(
      deriveHopeJ2051TriggerState(answers({ J2050A: "1", J2050B: "2025-10-01", J2051A: "2" })),
    ).toMatchObject({
      state: "true",
      triggerFired: true,
      maxSeverity: "moderate",
      symptomImpactDate: "2025-10-01",
    });
    expect(deriveHopeJ2051TriggerState(answers({ J2050A: "1", J2051H: "3" }))).toMatchObject({
      state: "true",
      triggerFired: true,
      maxSeverity: "severe",
    });
  });

  it("treats a complete 0/1/9 set as definitively false without treating 9 as skipped", () => {
    const values = Object.fromEntries(
      ["A", "B", "C", "D", "E", "F", "G", "H"].map((suffix) => [
        `J2051${suffix}`,
        suffix === "H" ? "9" : "1",
      ]),
    );

    expect(deriveHopeJ2051TriggerState(answers({ J2050A: "1", ...values }))).toMatchObject({
      state: "false",
      triggerFired: false,
      maxSeverity: "mild",
    });
  });

  it("does not convert incomplete J2051 answers into a false trigger", () => {
    expect(deriveHopeJ2051TriggerState(answers({ J2050A: "1", J2051A: "1" }))).toMatchObject({
      state: "pending",
      triggerFired: false,
      maxSeverity: "mild",
    });
  });

  it("uses J2050A=0 as a definitive no-SFV branch", () => {
    expect(deriveHopeJ2051TriggerState(answers({ J2050A: "0" }))).toMatchObject({
      state: "false",
      triggerFired: false,
      maxSeverity: "none",
    });
  });

  it("derives the operational due date from J2050B plus two calendar days", () => {
    expect(hopeSfvDueAtFromJ2050B("2025-10-01").toISOString()).toBe("2025-10-03T23:59:59.999Z");
  });
});
