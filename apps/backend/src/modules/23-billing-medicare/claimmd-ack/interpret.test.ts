import { describe, expect, it } from "vitest";
import { type CapturedClaimMdMessage, interpretClaimMdStatus } from "./interpret";

const base: CapturedClaimMdMessage = {
  eventId: "00000000-0000-4000-8000-000000000001",
  responseId: "101",
  accountReference: "central-test",
  usage: "test",
  capturedAt: new Date("2026-01-01T00:00:00Z"),
  parent: {
    senderid: "CLMMD",
    sender_name: "CLAIM.MD",
    status: "A",
    claimmd_id: "55",
    response_time: "2026-01-01 1:00pm",
  },
  message: { responseid: "101", mesgid: "ACK", status: "A", message: "Acknowledged" },
};

describe("Claim.MD normalized response interpretation", () => {
  it("recognizes only the documented Claim.MD receipt combination without an X12 label", () => {
    const result = interpretClaimMdStatus(base);
    expect(result).toMatchObject({
      sourceRepresentation: "claimmd_normalized_api",
      stage: "clearinghouse",
      meaning: "clearinghouse_receipt",
      proposedAction: "record_clearinghouse_receipt",
      authority: "documented_example",
    });
    expect(JSON.stringify(result)).not.toContain("Acknowledged");
    expect(JSON.stringify(result)).not.toContain("ack_999");
  });
  it.each([
    [{ ...base, parent: { senderid: "PAYER", status: "A" } }, "unverified_external"],
    [{ ...base, parent: { senderid: "CLMMD", status: "R" } }, "clearinghouse"],
    [{ ...base, message: { responseid: "101", mesgid: "ACK", status: "R" } }, "clearinghouse"],
    [{ ...base, message: { responseid: "102", mesgid: "ACK", status: "A" } }, "clearinghouse"],
    [
      { ...base, message: { responseid: "101", mesgid: "PAY", status: "A", message: "Paid" } },
      "clearinghouse",
    ],
  ] as const)("holds unsupported statuses", (input, stage) => {
    expect(interpretClaimMdStatus(input)).toMatchObject({
      stage,
      proposedAction: null,
      authority: "none",
    });
  });
  it("keeps distinct message-level identities", () => {
    const first = interpretClaimMdStatus(base);
    const second = interpretClaimMdStatus({
      ...base,
      eventId: "00000000-0000-4000-8000-000000000002",
      responseId: "102",
      message: { responseid: "102", mesgid: "ACK", status: "A" },
    });
    expect(first.eventId).not.toBe(second.eventId);
    expect(first.responseId).not.toBe(second.responseId);
  });
  it("fails closed on malformed nested messages", () => {
    expect(interpretClaimMdStatus({ ...base, message: null })).toMatchObject({
      proposedAction: null,
      reasonCode: "MALFORMED_MESSAGE",
    });
  });
});
