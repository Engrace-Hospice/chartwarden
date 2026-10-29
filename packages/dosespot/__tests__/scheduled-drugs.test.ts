import { describe, expect, it } from "vitest";
import { advisoryDeaSchedule } from "../src/classes/scheduled-drugs";

describe("advisoryDeaSchedule", () => {
  it("matches a generic name inside a decorated drug name, case-insensitively", () => {
    expect(advisoryDeaSchedule("LORAZEPAM 0.5 mg tablet")).toBe("IV");
    expect(advisoryDeaSchedule("Morphine sulfate oral solution")).toBe("II");
    expect(advisoryDeaSchedule("buprenorphine/naloxone 8-2 mg")).toBe("III");
  });
  it("takes the most restrictive schedule when a name lists several drugs", () => {
    expect(advisoryDeaSchedule("lorazepam / morphine kit")).toBe("II");
    expect(advisoryDeaSchedule("pregabalin 25 mg")).toBe("V");
  });
  it("returns null for an unscheduled drug and never matches inside another word", () => {
    expect(advisoryDeaSchedule("Acetaminophen 500 mg")).toBeNull();
    expect(advisoryDeaSchedule("Haloperidol 1 mg")).toBeNull();
    expect(advisoryDeaSchedule("Nonmorphinelike substance")).toBeNull();
  });
});
