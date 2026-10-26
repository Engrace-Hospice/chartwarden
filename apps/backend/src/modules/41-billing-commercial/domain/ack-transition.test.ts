import { describe, expect, it } from "vitest";
import { transitionForAck } from "./ack-transition";

describe("transitionForAck", () => {
  it("a clearinghouse acceptance moves submitted to ack_pending and never to accepted", () => {
    expect(transitionForAck("submitted", "clearinghouse", "accepted")).toEqual({
      to: "ack_pending",
      event: "m41.claim.clearinghouse_accepted",
    });
    expect(transitionForAck("ack_pending", "clearinghouse", "accepted")).toBeNull();
  });

  it("a payer acceptance accepts, even before the clearinghouse-stage answer arrived", () => {
    for (const from of ["submitted", "ack_pending"]) {
      expect(transitionForAck(from, "payer", "accepted")).toEqual({
        to: "accepted",
        event: "m41.claim.accepted",
      });
    }
  });

  it.each([
    ["clearinghouse", "rejected"],
    ["payer", "rejected"],
    ["payer", "partial"],
  ] as const)("a %s %s answer rejects the claim", (stage, disposition) => {
    for (const from of ["submitted", "ack_pending"]) {
      expect(transitionForAck(from, stage, disposition)).toEqual({
        to: "rejected",
        event: "m41.claim.rejected",
      });
    }
  });

  it.each(["draft", "ready", "accepted", "rejected", "void"])(
    "does not move a %s claim",
    (from) => {
      expect(transitionForAck(from, "payer", "accepted")).toBeNull();
      expect(transitionForAck(from, "payer", "rejected")).toBeNull();
      expect(transitionForAck(from, "clearinghouse", "accepted")).toBeNull();
    },
  );
});
