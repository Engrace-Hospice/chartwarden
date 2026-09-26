import { describe, expect, it } from "vitest";
import { hydrateMedicationData, serializeMedicationData } from "../medication-editor-model";
import { isMedicationFindingMapped, medicationFindingKey } from "../medication-validation";

const SIG = {
  doseQuantity: 1,
  doseUnit: "tablet",
  route: "oral",
  frequencyCode: "daily",
  asNeeded: false,
};

describe("M12 medication editor canonical payload boundary", () => {
  it("round-trips every Standard field, including quantity, false DAW, indication, and notes", () => {
    const data = {
      sigStructured: SIG,
      sigFreeText: "Take one tablet daily",
      indication: "Pain",
      clinicalJustification: "x",
      notes: "note",
      refillsAuthorized: 2,
      dispenseQuantity: { value: 30, unit: "tablet" },
      daysSupply: 30,
      daw: false,
    };
    expect(serializeMedicationData(hydrateMedicationData(data, "standard"), "standard")).toEqual(
      data,
    );
  });
  it("round-trips controlled Schedule II zero refills and its required DEA fields", () => {
    const data = {
      sigStructured: SIG,
      sigFreeText: "Take one tablet daily",
      indication: "Severe pain",
      clinicalJustification: "Controlled substance clinical justification",
      notes: "note",
      refillsAuthorized: 0,
      dispenseQuantity: { value: 30, unit: "tablet" },
      daysSupply: 30,
      daw: false,
      deaSchedule: "II",
      prescriberDea: "AB1234567",
    };
    expect(
      serializeMedicationData(
        hydrateMedicationData(data, "controlled_substance"),
        "controlled_substance",
      ),
    ).toEqual(data);
  });
  it("preserves a Schedule III-V refill count rather than applying Schedule II UI semantics", () => {
    const data = {
      sigStructured: SIG,
      sigFreeText: "Take one tablet daily",
      indication: "Severe pain",
      clinicalJustification: "Controlled substance clinical justification",
      refillsAuthorized: 5,
      dispenseQuantity: { value: 30, unit: "tablet" },
      daysSupply: 30,
      daw: false,
      deaSchedule: "III",
      prescriberDea: "AB1234567",
    };
    expect(
      serializeMedicationData(
        hydrateMedicationData(data, "controlled_substance"),
        "controlled_substance",
      ).refillsAuthorized,
    ).toBe(5);
  });
  it("round-trips all compound fields and removes stale DEA only when not controlled", () => {
    const data = {
      compoundingPharmacyMdmId: "pharmacy",
      formulationDescription: "A sufficiently detailed compounded formulation",
      components: [
        { componentName: "A", componentStrength: "10 mg", quantityRatio: "1:2", rxnormRxcui: "1" },
        { componentName: "B", componentStrength: "20 mg", quantityRatio: "1:1", ndc: "2" },
      ],
      containsControlled: true,
      deaSchedule: "III",
      sigStructured: SIG,
      sigFreeText: "Apply as directed",
      indication: "Pain",
      clinicalJustification: "reason",
      notes: "note",
      refillsAuthorized: 1,
      dispenseQuantity: { value: 30, unit: "g" },
      daysSupply: 30,
      daw: true,
    };
    expect(
      serializeMedicationData(hydrateMedicationData(data, "compounded"), "compounded"),
    ).toEqual(data);
    expect(
      serializeMedicationData({ ...data, containsControlled: false }, "compounded").deaSchedule,
    ).toBeUndefined();
    expect(serializeMedicationData({ ...data, daw: false }, "compounded").daw).toBe(true);
  });
  it("maps envelope, nested SIG/quantity, and indexed component findings; unknown findings remain summary candidates", () => {
    expect(medicationFindingKey("data.dispenseQuantity.value")).toBe("quantity.value");
    expect(medicationFindingKey("data.components.1.quantityRatio")).toBe(
      "component.1.quantityRatio",
    );
    expect(isMedicationFindingMapped("prescribingPhysicianMdmId")).toBe(true);
    expect(isMedicationFindingMapped("data.sigStructured.frequencyCode")).toBe(true);
    expect(isMedicationFindingMapped("data.components.0.componentStrength")).toBe(true);
    expect(isMedicationFindingMapped("data.unknownFutureField")).toBe(false);
  });
});
