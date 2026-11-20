import { describe, expect, it } from "vitest";
import { classifyMedicareClaimEvidence } from "../seams/claim-reader";

describe("M23 Medicare coordination evidence", () => {
  it("keeps technical acknowledgments separate from adjudication", () => {
    expect(classifyMedicareClaimEvidence("ack_accepted", false)).toBe("acknowledged");
    expect(classifyMedicareClaimEvidence("ack_partial", false)).toBe("acknowledged");
  });

  it("requires a recorded M25 remittance reference before classifying adjudication", () => {
    expect(classifyMedicareClaimEvidence("paid", false)).toBe("unknown");
    expect(classifyMedicareClaimEvidence("partial_paid", false)).toBe("unknown");
    expect(classifyMedicareClaimEvidence("denied", false)).toBe("unknown");
    expect(classifyMedicareClaimEvidence("paid", true)).toBe("adjudicated_paid");
    expect(classifyMedicareClaimEvidence("partial_paid", true)).toBe("adjudicated_partial");
    expect(classifyMedicareClaimEvidence("denied", true)).toBe("adjudicated_denied");
  });

  it("does not turn missing financial amounts into zero or treat replaced claims as active evidence", () => {
    expect(classifyMedicareClaimEvidence("replaced", true)).toBe("reversed_or_superseded");
    expect(classifyMedicareClaimEvidence("voided", false)).toBe("reversed_or_superseded");
    expect(classifyMedicareClaimEvidence("future_state", false)).toBe("unknown");
  });

  it("recognizes a remittance recoupment that returns the M23 claim state to ACK_ACCEPTED", () => {
    expect(classifyMedicareClaimEvidence("ack_accepted", true, "ack_accepted")).toBe(
      "reversed_or_superseded",
    );
    expect(classifyMedicareClaimEvidence("paid", true, "paid")).toBe("adjudicated_paid");
  });
});
