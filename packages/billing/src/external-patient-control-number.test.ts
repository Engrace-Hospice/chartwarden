import { describe, expect, it } from "vitest";
import { generateExternalPatientControlNumber } from "./external-patient-control-number";

describe("generateExternalPatientControlNumber", () => {
  it("creates clearinghouse-safe 17-character alphanumeric identifiers", () => {
    const values = Array.from({ length: 100 }, generateExternalPatientControlNumber);
    expect(values.every((value) => /^[A-Z0-9]{17}$/.test(value))).toBe(true);
    expect(new Set(values).size).toBe(values.length);
  });
});
