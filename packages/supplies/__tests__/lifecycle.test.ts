import type { SupplyRequestKind, SupplyRequestStatus } from "@wardenx/types";
import { describe, expect, it } from "vitest";

import {
  SUPPLY_REQUEST_EDGES,
  allowedTransitions,
  autoCompletesOnReceipt,
  canTransition,
  isTerminalSupplyStatus,
  resolveTransition,
} from "../src/lifecycle";

const KINDS: readonly SupplyRequestKind[] = [
  "dme",
  "supply",
  "comfort_kit_deploy",
  "comfort_kit_replenish",
];

describe("§2.2 supply-request edge set", () => {
  it("never leaves a terminal status", () => {
    for (const edge of SUPPLY_REQUEST_EDGES) {
      expect(isTerminalSupplyStatus(edge.from)).toBe(false);
    }
  });

  it("treats cancellation_pending as NON-terminal — the vendor may still refuse", () => {
    expect(isTerminalSupplyStatus("cancellation_pending")).toBe(false);
    expect(isTerminalSupplyStatus("completed")).toBe(true);
    expect(isTerminalSupplyStatus("cancelled")).toBe(true);
  });

  it("walks the happy path end to end for every kind", () => {
    const path: readonly [SupplyRequestStatus, string][] = [
      ["requested", "assignVendor"],
      ["vendor_assigned", "placeOrderWithVendor"],
      ["ordered", "vendorConfirmedShipment"],
      ["in_transit", "confirmDeliveryAtAddress"],
      ["delivered", "caregiverOrPatientConfirmsReceipt"],
      ["received_confirmed", "completeRequest"],
    ];
    for (const kind of KINDS) {
      for (const [from, transition] of path) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(canTransition(from, kind, transition as any)).toBe(true);
      }
    }
  });
});

describe("§2.2 two-phase cancellation", () => {
  it("cancels immediately before the vendor was told", () => {
    expect(resolveTransition("requested", "dme", "cancel")?.to).toBe("cancelled");
    expect(resolveTransition("vendor_assigned", "dme", "cancel")?.to).toBe("cancelled");
  });

  it("refuses a direct cancel once the order is with the vendor", () => {
    expect(resolveTransition("ordered", "dme", "cancel")).toBeNull();
    expect(resolveTransition("in_transit", "dme", "cancel")).toBeNull();
  });

  it("routes a post-ordered cancellation through cancellation_pending", () => {
    expect(resolveTransition("ordered", "dme", "requestCancellation")?.to).toBe(
      "cancellation_pending",
    );
    expect(
      resolveTransition("cancellation_pending", "dme", "vendorConfirmedCancellation")?.to,
    ).toBe("cancelled");
  });

  it("walks a refused cancellation BACK to a live state, not to an error state", () => {
    const backs = allowedTransitions("cancellation_pending", "dme")
      .filter((e) => e.transition === "vendorRefusedCancellation")
      .map((e) => e.to)
      .sort();
    expect(backs).toEqual(["in_transit", "ordered"]);
  });
});

describe("§2.2 the returned branch is kit-only", () => {
  it("lets a kit return from delivered and received_confirmed", () => {
    for (const kind of ["comfort_kit_deploy", "comfort_kit_replenish"] as const) {
      expect(canTransition("delivered", kind, "initiateReturn")).toBe(true);
      expect(canTransition("received_confirmed", kind, "initiateReturn")).toBe(true);
      expect(canTransition("returned", kind, "completeReturnReconciliation")).toBe(true);
    }
  });

  it("refuses to put DME or a consumable into the controlled-substance return pipeline", () => {
    for (const kind of ["dme", "supply"] as const) {
      expect(canTransition("delivered", kind, "initiateReturn")).toBe(false);
      expect(canTransition("received_confirmed", kind, "initiateReturn")).toBe(false);
      expect(canTransition("returned", kind, "completeReturnReconciliation")).toBe(false);
    }
  });
});

describe("§2.2 auto-complete on receipt", () => {
  it("completes a one-shot DME purchase and a consumable", () => {
    expect(autoCompletesOnReceipt("dme", "one_time_purchase")).toBe(true);
    expect(autoCompletesOnReceipt("supply", null)).toBe(true);
  });

  it("keeps a monthly DME rental open for the rental life", () => {
    expect(autoCompletesOnReceipt("dme", "monthly")).toBe(false);
  });

  it("keeps both kit kinds open until M13 acks", () => {
    expect(autoCompletesOnReceipt("comfort_kit_deploy", null)).toBe(false);
    expect(autoCompletesOnReceipt("comfort_kit_replenish", null)).toBe(false);
  });
});
