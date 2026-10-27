import { describe, expect, it } from "vitest";
import { transitionForRemittance } from "./remittance-transition";

describe("transitionForRemittance", () => {
  it("a sent claim moves to the outcome of its first adjudication, even before the payer acknowledgment arrived", () => {
    for (const from of ["submitted", "ack_pending", "accepted"]) {
      expect(transitionForRemittance(from, "paid")).toBe("paid");
      expect(transitionForRemittance(from, "partially_paid")).toBe("partially_paid");
      expect(transitionForRemittance(from, "denied")).toBe("denied");
    }
  });

  it("a claim never regresses: nothing leaves paid, and a denial never overwrites a payment", () => {
    for (const o of ["paid", "partially_paid", "denied"] as const) {
      expect(transitionForRemittance("paid", o)).toBeNull();
    }
    expect(transitionForRemittance("partially_paid", "denied")).toBeNull();
    expect(transitionForRemittance("partially_paid", "partially_paid")).toBeNull();
  });

  it("a later payment may complete a partial payment or reverse a denial (appeal or reprocess)", () => {
    expect(transitionForRemittance("partially_paid", "paid")).toBe("paid");
    expect(transitionForRemittance("denied", "paid")).toBe("paid");
    expect(transitionForRemittance("denied", "partially_paid")).toBe("partially_paid");
    expect(transitionForRemittance("denied", "denied")).toBeNull();
  });

  it("a claim that was never sent, or is rejected or void, does not move", () => {
    for (const from of ["draft", "ready", "rejected", "void"]) {
      expect(transitionForRemittance(from, "paid")).toBeNull();
    }
  });
});
