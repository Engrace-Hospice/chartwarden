import { describe, expect, it } from "vitest";
import { validateMedicationOrderData } from "../src";

const standard = { sigStructured: { doseQuantity: 1, doseUnit: "tablet", route: "oral", frequencyCode: "daily", asNeeded: false }, sigFreeText: "Take one tablet daily.", refillsAuthorized: 1, dispenseQuantity: { value: 30, unit: "tablets" }, daysSupply: 30, daw: false };
const controlled = { ...standard, indication: "Severe pain", clinicalJustification: "Hospice symptom-management clinical justification.", deaSchedule: "II", prescriberDea: "AB1234567", refillsAuthorized: 0 };
describe("M12 canonical medication data", () => {
  it("accepts a complete standard prescription", () => expect(validateMedicationOrderData("standard", "standard.v1", standard)).toEqual([]));
  it("permits incomplete drafts but rejects unknown data keys", () => { expect(validateMedicationOrderData("standard", undefined, {}, false)).toEqual([]); expect(validateMedicationOrderData("standard", undefined, { unexpected: true }, false)[0]?.field).toBe("data.unexpected"); });
  it("enforces Schedule II no-refill rule", () => expect(validateMedicationOrderData("controlled_substance", "controlled_substance.v1", { ...controlled, refillsAuthorized: 1 }).some((f) => f.code === "REFILL_SCHEDULE_II_NON_REFILLABLE")).toBe(true));
  it("requires DEA schedule for controlled compounds", () => expect(validateMedicationOrderData("compounded", undefined, { containsControlled: true }, true).some((f) => f.field === "data.deaSchedule")).toBe(true));
});
