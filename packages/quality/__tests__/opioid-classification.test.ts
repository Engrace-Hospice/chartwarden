import { describe, expect, it } from "vitest";
import { isOpioidDrugName } from "../src/measures/operational/opioid-classification";

describe("isOpioidDrugName", () => {
  it("matches common generic ingredient names, case-insensitively", () => {
    expect(isOpioidDrugName("Oxycodone 5mg")).toBe(true);
    expect(isOpioidDrugName("MORPHINE SULFATE ER")).toBe(true);
    expect(isOpioidDrugName("hydromorphone")).toBe(true);
    expect(isOpioidDrugName("Fentanyl Transdermal Patch 25mcg/hr")).toBe(true);
  });

  it("matches well-known brand names even when the generic name isn't in the string", () => {
    expect(isOpioidDrugName("OxyContin ER 10mg")).toBe(true);
    expect(isOpioidDrugName("Percocet 5/325")).toBe(true);
    expect(isOpioidDrugName("Dilaudid 2mg/mL injection")).toBe(true);
  });

  it("does NOT match a non-opioid drug, including other controlled substances", () => {
    expect(isOpioidDrugName("Lorazepam 1mg")).toBe(false);
    expect(isOpioidDrugName("Haloperidol 5mg/mL")).toBe(false);
    expect(isOpioidDrugName("Acetaminophen 325mg")).toBe(false);
    expect(isOpioidDrugName("Amoxicillin 500mg")).toBe(false);
  });
});
