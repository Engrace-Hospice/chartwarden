import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractX12SubmissionEvidence, X12EvidenceError } from "./submission-evidence";

const institutional = readFileSync(new URL("./__fixtures__/stedi-claim.x12", import.meta.url), "utf8");

describe("extractX12SubmissionEvidence", () => {
  it("extracts the billing entity, payer, claim reference, service period and exact-byte digest", () => {
    const result = extractX12SubmissionEvidence(institutional, "000000101");
    expect(result.transactionSet).toBe("837I");
    expect(result.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.claims).toEqual([expect.objectContaining({
      billingNpi: "1234567893", billingTin: "931234567", payerId: "STEDI", pcn: "WXHOSP0001",
      claimType: "81:A:3", serviceFrom: "20260101", serviceTo: "20260131",
      isa13: "000000101", gs06: "101", st02: "0101",
    })]);
  });

  it("rejects a control number mismatch, missing TIN, unsupported transaction and malformed envelope", () => {
    expect(() => extractX12SubmissionEvidence(institutional, "000000102")).toThrow(X12EvidenceError);
    expect(() => extractX12SubmissionEvidence(institutional.replace("REF*EI*931234567~", ""))).toThrow(/INCOMPLETE_IDENTITY/);
    expect(() => extractX12SubmissionEvidence(institutional.replace("005010X223A2", "005010X999ZZ"))).toThrow(/UNSUPPORTED_TRANSACTION/);
    expect(() => extractX12SubmissionEvidence("not-x12")).toThrow(/INVALID_X12/);
  });

  it("extracts each claim in a multi-claim transaction under the same correctly scoped billing loops", () => {
    const multi = institutional.replace("SE*35*0101~", "CLM*SECOND-SYNTHETIC*1.00***81:A:3**A*Y*Y~DTP*434*RD8*20260201-20260228~SE*37*0101~");
    const result = extractX12SubmissionEvidence(multi);
    expect(result.claims.map((claim) => claim.pcn)).toEqual(["WXHOSP0001", "SECOND-SYNTHETIC"]);
    expect(result.claims[1]).toMatchObject({ billingNpi: "1234567893", billingTin: "931234567", payerId: "STEDI" });
  });

  it("distinguishes an 837P from the functional-group implementation identifier", () => {
    const professional = institutional.replaceAll("005010X223A2", "005010X222A1").replace("81:A:3", "11:B:1");
    expect(extractX12SubmissionEvidence(professional).transactionSet).toBe("837P");
  });
});
