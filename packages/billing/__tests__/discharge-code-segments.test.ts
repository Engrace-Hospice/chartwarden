// @wardenx/billing — the 837I CL1 / HI*BG / HI*BH segment contract for the discharge claim codes.
import {
  buildCl1Segment,
  buildConditionCodeSegments,
  buildDischargeCodeSegments,
  buildOccurrenceCodeSegments,
  claimDocumentDischargeCodes,
  deriveDischargeClaimCodes,
} from "@wardenx/billing";
import { describe, expect, it } from "vitest";

describe("837I discharge-code segments", () => {
  it("CL1 carries the patient status in CL103", () => {
    expect(
      buildCl1Segment({ admissionTypeCode: "1", admissionSourceCode: "1", patientStatusCode: "40" }),
    ).toBe("CL1*1*1*40~");
    expect(buildCl1Segment({ admissionTypeCode: "1", patientStatusCode: "30" })).toBe("CL1*1**30~");
  });

  it("condition codes go in HI*BG composites", () => {
    expect(buildConditionCodeSegments(["52"])).toEqual(["HI*BG:52~"]);
    expect(buildConditionCodeSegments(["H2"])).toEqual(["HI*BG:H2~"]);
    expect(buildConditionCodeSegments([])).toEqual([]);
  });

  it("occurrence codes go in HI*BH composites with a D8 date", () => {
    expect(buildOccurrenceCodeSegments([{ code: "55", date: "2026-03-19" }])).toEqual([
      "HI*BH:55:D8:20260319~",
    ]);
  });

  it("splits more than 12 composites across HI segments", () => {
    const codes = Array.from({ length: 13 }, (_, i) => String(10 + i));
    const segs = buildConditionCodeSegments(codes);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.split("*")).toHaveLength(13);
    expect(segs[1]).toBe("HI*BG:22~");
  });

  it("rejects malformed codes, dates and CL101", () => {
    expect(() => buildConditionCodeSegments(["5"])).toThrow();
    expect(() => buildOccurrenceCodeSegments([{ code: "42", date: "03/19/2026" }])).toThrow();
    expect(() => buildCl1Segment({ admissionTypeCode: "", patientStatusCode: "01" })).toThrow();
  });

  it("revocation end to end: CL1 status 01 + HI*BH:42", () => {
    const codes = deriveDischargeClaimCodes({
      serviceTo: "2026-03-31",
      discharge: { kind: "revocation", effectiveDate: "2026-03-05" },
    });
    expect(
      buildDischargeCodeSegments({
        admissionTypeCode: "1",
        dischargeCodes: claimDocumentDischargeCodes(codes),
      }),
    ).toEqual(["CL1*1**01~", "HI*BH:42:D8:20260305~"]);
  });

  it("for cause end to end: CL1 status 01 + HI*BG:H2", () => {
    const codes = deriveDischargeClaimCodes({
      serviceTo: "2026-03-31",
      discharge: { kind: "for_cause", effectiveDate: "2026-03-05" },
    });
    expect(
      buildDischargeCodeSegments({
        admissionTypeCode: "1",
        dischargeCodes: claimDocumentDischargeCodes(codes),
      }),
    ).toEqual(["CL1*1**01~", "HI*BG:H2~"]);
  });

  it("refuses to project unresolved codes onto a claim document", () => {
    const codes = deriveDischargeClaimCodes({
      serviceTo: "2026-03-31",
      discharge: { kind: "transfer", effectiveDate: "2026-03-05", receivingCareSetting: null },
    });
    expect(() => claimDocumentDischargeCodes(codes)).toThrow(/transfer_setting_missing/);
  });
});
