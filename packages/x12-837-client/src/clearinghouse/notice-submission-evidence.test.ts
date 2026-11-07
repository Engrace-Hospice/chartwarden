import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractX12NoticeEvidence } from "./notice-submission-evidence";

const fixture = (kind: "NOE_81A" | "NOTR_81B" | "TRANSFER_81C") =>
  readFileSync(new URL(`./__fixtures__/stedi-${kind}.x12`, import.meta.url), "utf8")
    .replace(/(ISA(?:\*[^*]*){7}\*)[^*]*/, `$1${"CLAIMMD".padEnd(15, " ")}`)
    .replace(/(GS\*HC\*[^*]+\*)[^*]*/, "$1CLAIMMD");
describe("extractX12NoticeEvidence", () => {
  it("extracts exact institutional evidence and validates distinct NOE, NOTR and transfer transaction codes", () => {
    expect(extractX12NoticeEvidence(fixture("NOE_81A"), "noe", "WXNOE0001", "test")).toMatchObject({ billingNpi: "1234567893", billingTin: "931234567", payerId: "STEDI",
      transactionSet: "837I", isa13: "000000106", gs06: "106", st02: "0106", outboundBusinessControlNumber: "WXNOE0001" });
    expect(extractX12NoticeEvidence(fixture("NOTR_81B"), "notr", "WXNOTR0001", "test").outboundBusinessControlNumber).toBe("WXNOTR0001");
    expect(extractX12NoticeEvidence(fixture("TRANSFER_81C"), "transfer_notice", "WXNOE0001", "test").outboundBusinessControlNumber).toBe("WXNOE0001");
    expect(extractX12NoticeEvidence(fixture("TRANSFER_81C").replace("81:A:C", "81:A:D"), "transfer_notice", "WXNOE0001", "test").transactionSet).toBe("837I");
  });
  it("rejects professional, malformed, and ambiguous-provider payloads", () => {
    const x12 = fixture("NOE_81A");
    expect(() => extractX12NoticeEvidence(x12.replaceAll("005010X223A2", "005010X222A1"), "noe", "WXNOE0001", "test")).toThrow("UNSUPPORTED_NOTICE_X12");
    expect(() => extractX12NoticeEvidence(x12.replace("REF*EI*931234567~", ""), "noe", "WXNOE0001", "test")).toThrow("INCOMPLETE_NOTICE_IDENTITY");
    expect(() => extractX12NoticeEvidence(x12.replace("NM1*85*2*EXAMPLE HOSPICE OF OREGON*****XX*1234567893~", "NM1*85*2*EXAMPLE HOSPICE OF OREGON*****XX*1234567893~NM1*85*2*OTHER*****XX*1234567893~"), "noe", "WXNOE0001", "test")).toThrow("AMBIGUOUS_NOTICE_IDENTITY");
    expect(() => extractX12NoticeEvidence(x12, "notr", "WXNOE0001", "test")).toThrow("NOTICE_KIND_MISMATCH");
    expect(() => extractX12NoticeEvidence(x12, "noe", "different-control", "test")).toThrow("NOTICE_CONTROL_MISMATCH");
    expect(() => extractX12NoticeEvidence(x12, "noe", "WXNOE0001", "production")).toThrow("UNSUPPORTED_NOTICE_X12");
  });
});
