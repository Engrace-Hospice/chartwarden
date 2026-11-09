import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { X12EvidenceError, extractX12SubmissionEvidence } from "./submission-evidence";

const institutional = readFileSync(
  new URL("./__fixtures__/stedi-claim.x12", import.meta.url),
  "utf8",
);

describe("extractX12SubmissionEvidence", () => {
  it("extracts the billing entity, payer, claim reference, service period and exact-byte digest", () => {
    const result = extractX12SubmissionEvidence(institutional, "000000101");
    expect(result.transactionSet).toBe("837I");
    expect(result.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.claims).toEqual([
      expect.objectContaining({
        billingNpi: "1234567893",
        billingTin: "931234567",
        payerId: "STEDI",
        pcn: "WXHOSP0001",
        claimType: "81:A:3",
        serviceFrom: "20260101",
        serviceTo: "20260131",
        isa13: "000000101",
        gs06: "101",
        st02: "0101",
      }),
    ]);
  });

  it("rejects a control number mismatch, missing TIN, unsupported transaction and malformed envelope", () => {
    expect(() => extractX12SubmissionEvidence(institutional, "000000102")).toThrow(
      X12EvidenceError,
    );
    expect(() =>
      extractX12SubmissionEvidence(institutional.replace("REF*EI*931234567~", "")),
    ).toThrow(/INCOMPLETE_IDENTITY/);
    expect(() =>
      extractX12SubmissionEvidence(institutional.replace("005010X223A2", "005010X999ZZ")),
    ).toThrow(/UNSUPPORTED_TRANSACTION/);
    expect(() => extractX12SubmissionEvidence("not-x12")).toThrow(/INVALID_X12/);
  });

  it("extracts each claim in a multi-claim transaction under the same correctly scoped billing loops", () => {
    const multi = institutional.replace(
      "SE*35*0101~",
      "CLM*SECOND-SYNTHETIC*1.00***81:A:3**A*Y*Y~DTP*434*RD8*20260201-20260228~SE*37*0101~",
    );
    const result = extractX12SubmissionEvidence(multi);
    expect(result.claims.map((claim) => claim.pcn)).toEqual(["WXHOSP0001", "SECOND-SYNTHETIC"]);
    expect(result.claims[1]).toMatchObject({
      billingNpi: "1234567893",
      billingTin: "931234567",
      payerId: "STEDI",
    });
  });

  it("extracts exact service-line facts and only treats an outbound REF*6R as a line control reference", () => {
    const withReference = institutional.replace(
      "SV2*0651*HC:Q5001*200.00*UN*1~",
      "SV2*0651*HC:Q5001*200.00*UN*1~REF*6R*L1~",
    );
    const lines = extractX12SubmissionEvidence(withReference).claims[0]?.serviceLines;
    expect(lines).toEqual([
      { position: 1, lineItemControlNumber: "L1", revenueCode: "0651", procedureCode: "Q5001", serviceFrom: "20260101", serviceTo: "20260101", units: "1", chargeCents: 20000 },
      { position: 2, lineItemControlNumber: null, revenueCode: "0652", procedureCode: "Q5001", serviceFrom: "20260102", serviceTo: "20260102", units: "32", chargeCents: 80000 },
      { position: 3, lineItemControlNumber: null, revenueCode: "0655", procedureCode: "Q5006", serviceFrom: "20260110", serviceTo: "20260110", units: "1", chargeCents: 50000 },
    ]);
  });

  it("distinguishes an 837P from the functional-group implementation identifier", () => {
    const professional = institutional
      .replaceAll("005010X223A2", "005010X222A1")
      .replace("81:A:3", "11:B:1");
    expect(extractX12SubmissionEvidence(professional).transactionSet).toBe("837P");
  });
});
