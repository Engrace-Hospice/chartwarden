// M23 — the 837I claim document carries the UB-04 Type of Admission / Point of Origin recorded on the claim.
import { describe, expect, it } from "vitest";
import { claimDocumentFor } from "../jobs/m23-jobs";

const claim = {
  id: "claim-1",
  tob: "811",
  serviceFrom: "2026-03-01",
  serviceTo: "2026-03-31",
  patientStatusCode: "30",
  conditionCodes: [],
  occurrenceCodes: [],
};

describe("claimDocumentFor admission codes", () => {
  it("passes the recorded admission type and point of origin through", () => {
    const doc = claimDocumentFor(
      { ...claim, admissionTypeCode: "3", admissionSourceCode: "1" },
      "CCN-1",
    );
    expect(doc.admissionTypeCode).toBe("3");
    expect(doc.admissionSourceCode).toBe("1");
  });

  it("is null (never defaulted) when the claim has none", () => {
    const doc = claimDocumentFor(claim, "CCN-1");
    expect(doc.admissionTypeCode).toBeNull();
    expect(doc.admissionSourceCode).toBeNull();
  });
});
