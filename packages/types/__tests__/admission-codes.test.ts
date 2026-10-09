// packages/types/__tests__/admission-codes.test.ts — the NUBC admission-type (UB-04 FL 14) and point-of-origin
// (FL 15) code sets a hospice claim carries as 837I CL101 / CL102. One declaration shared by M6 (entry), M23 (claim
// assembly + validation) and the web picker.
import { describe, expect, it } from "vitest";
import {
  ADMISSION_SOURCE_CODES,
  ADMISSION_SOURCE_LABELS,
  ADMISSION_TYPE_CODES,
  ADMISSION_TYPE_LABELS,
  isAdmissionSourceCode,
  isAdmissionTypeCode,
} from "../src/admission";

describe("admission type of admission (FL 14 / CL101)", () => {
  it("is the NUBC set a hospice claim may carry (MAC hospice billing sheets)", () => {
    expect([...ADMISSION_TYPE_CODES]).toEqual(["1", "2", "3", "5", "9"]);
  });

  it("has a human label for every code, naming 9 as 'information not available'", () => {
    for (const code of ADMISSION_TYPE_CODES)
      expect(ADMISSION_TYPE_LABELS[code].length).toBeGreaterThan(0);
    expect(ADMISSION_TYPE_LABELS["9"]).toMatch(/not available/i);
  });

  it.each(["1", "2", "3", "5", "9"])("accepts %s", (c) =>
    expect(isAdmissionTypeCode(c)).toBe(true),
  );
  it.each(["0", "4", "6", "A", "", "10", " 1", null, undefined])("rejects %s", (c) =>
    expect(isAdmissionTypeCode(c)).toBe(false),
  );
});

describe("admission point of origin (FL 15 / CL102)", () => {
  it("is the NUBC set a hospice claim may carry (MAC hospice billing sheets)", () => {
    expect([...ADMISSION_SOURCE_CODES]).toEqual(["1", "2", "4", "5", "6", "8", "9"]);
  });

  it("has a human label for every code", () => {
    for (const code of ADMISSION_SOURCE_CODES) {
      expect(ADMISSION_SOURCE_LABELS[code].length).toBeGreaterThan(0);
    }
    expect(ADMISSION_SOURCE_LABELS["1"]).toMatch(/non-health care facility/i);
  });

  it.each(["1", "2", "4", "5", "6", "8", "9"])("accepts %s", (c) =>
    expect(isAdmissionSourceCode(c)).toBe(true),
  );
  it.each(["0", "3", "7", "A", "", null, undefined])("rejects %s", (c) =>
    expect(isAdmissionSourceCode(c)).toBe(false),
  );
});
