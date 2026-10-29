import { describe, expect, it } from "vitest";
import { orderStatedDose } from "./emar-api";
import { formatLocalTs } from "./emar-status";

describe("formatLocalTs", () => {
  it("shows the viewer's local wall time, not the UTC slice", () => {
    const local = new Date(2026, 9, 29, 14, 28);
    expect(formatLocalTs(local.toISOString())).toBe("2026-10-29 14:28");
  });
  it("renders a dash for absent or unparseable values", () => {
    expect(formatLocalTs(null)).toBe("—");
    expect(formatLocalTs("nope")).toBe("—");
  });
});

describe("orderStatedDose", () => {
  it("reads a flat or nested sig dose", () => {
    expect(orderStatedDose({ data: { doseQuantity: 0.25, doseUnit: "mL" } })).toEqual({
      amount: 0.25,
      unit: "mL",
    });
    expect(
      orderStatedDose({ data: { sigStructured: { doseQuantity: 5, doseUnit: "mg" } } }),
    ).toEqual({ amount: 5, unit: "mg" });
  });
  it("treats a missing, zero or unit-less dose as not stated", () => {
    expect(orderStatedDose({ data: null })).toBeNull();
    expect(orderStatedDose({ data: { doseQuantity: 0, doseUnit: "mL" } })).toBeNull();
    expect(orderStatedDose({ data: { doseQuantity: 1, doseUnit: " " } })).toBeNull();
  });
});
