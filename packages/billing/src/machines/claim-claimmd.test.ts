import { describe, expect, it } from "vitest";
import { reduce } from "./claim";

describe("M23 normalized Claim.MD receipt transition", () => {
  it("moves only a submitted claim to clearinghouse acknowledgment pending", () => {
    expect(reduce("submitted", "claimmd_receipt_accepted")).toMatchObject({ state: "ack_pending" });
    expect(reduce("ack_pending", "claimmd_receipt_accepted").error).toBeDefined();
    expect(reduce("ack_accepted", "claimmd_receipt_accepted").error).toBeDefined();
    expect(reduce("paid", "claimmd_receipt_accepted").error).toBeDefined();
  });
});
