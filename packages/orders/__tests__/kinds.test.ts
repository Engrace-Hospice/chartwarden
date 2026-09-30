import { describe, expect, it } from "vitest";
import {
  ORDER_KIND_CONTRACT_STATUS,
  ORDER_KIND_REGISTRY,
  ORDER_KIND_VERSION,
  validateOrderData,
} from "../src/kinds";

const TRANSITIONAL_KINDS = ["dme", "supply", "ancillary_service"] as const;

describe("M11 transitional order-payload contracts", () => {
  it.each(TRANSITIONAL_KINDS)("keeps %s explicitly marked as unpublished", (kind) => {
    expect(ORDER_KIND_CONTRACT_STATUS[kind]).toBe("contract_not_published");
    expect(ORDER_KIND_REGISTRY[kind].contractStatus).toBe("contract_not_published");
  });

  it.each(TRANSITIONAL_KINDS)(
    "accepts an extensible object for %s without inventing required fields",
    (kind) => {
      expect(
        validateOrderData(kind, ORDER_KIND_VERSION[kind], {
          localWorkflowExtension: { value: true },
        }),
      ).toEqual([]);
    },
  );

  it.each(TRANSITIONAL_KINDS)("still rejects a non-object %s payload", (kind) => {
    expect(validateOrderData(kind, ORDER_KIND_VERSION[kind], [])).not.toEqual([]);
  });

  it("does not silently accept an unpublished contract under an unknown version", () => {
    expect(validateOrderData("dme", "dme.v3", {})).toEqual([
      { field: "kindVersion", message: "Unsupported dme payload version." },
    ]);
    expect(validateOrderData("comfort_kit", "comfort_kit.v2", {})).toEqual([
      { field: "kindVersion", message: "Unsupported comfort_kit payload version." },
    ]);
  });
});

const SKU = "11111111-1111-4111-8111-111111111111";

describe("F-232 dme.v2 / supply.v2 published contracts", () => {
  it("leaves the v1 default untouched (older orders keep validating under v1)", () => {
    expect(ORDER_KIND_VERSION.dme).toBe("dme.v1");
    expect(ORDER_KIND_VERSION.supply).toBe("supply.v1");
    expect(validateOrderData("dme", "dme.v1", { anything: 1 })).toEqual([]);
    expect(validateOrderData("supply", "supply.v1", {})).toEqual([]);
  });

  it("dme.v2 accepts the published shape and requires skuId + quantity", () => {
    expect(
      validateOrderData("dme", "dme.v2", {
        skuId: SKU,
        quantity: 1,
        rentalCadence: "monthly",
        needsInstallation: true,
        needsPatientEducation: false,
      }),
    ).toEqual([]);
    expect(validateOrderData("dme", "dme.v2", { skuId: SKU, quantity: 2 })).toEqual([]);
    expect(validateOrderData("dme", "dme.v2", {})).not.toEqual([]);
    expect(validateOrderData("dme", "dme.v2", { skuId: SKU })).not.toEqual([]);
    expect(validateOrderData("dme", "dme.v2", { skuId: SKU, quantity: 0 })).not.toEqual([]);
    expect(validateOrderData("dme", "dme.v2", { skuId: "not-a-uuid", quantity: 1 })).not.toEqual([]);
  });

  it("supply.v2 accepts the published shape and requires skuId + quantity", () => {
    expect(validateOrderData("supply", "supply.v2", { skuId: SKU, quantity: 3, unit: "box" })).toEqual([]);
    expect(validateOrderData("supply", "supply.v2", { skuId: SKU, quantity: 3 })).toEqual([]);
    expect(validateOrderData("supply", "supply.v2", { quantity: 3 })).not.toEqual([]);
  });

  it("v2 is CLOSED: a delivery address or hcpcs cannot ride an order", () => {
    expect(
      validateOrderData("dme", "dme.v2", {
        skuId: SKU,
        quantity: 1,
        deliveryAddress: { line1: "1 Main St" },
      }),
    ).not.toEqual([]);
    expect(
      validateOrderData("supply", "supply.v2", { skuId: SKU, quantity: 1, hcpcs: "A4620" }),
    ).not.toEqual([]);
    // dme-only fields are not part of supply.v2
    expect(
      validateOrderData("supply", "supply.v2", { skuId: SKU, quantity: 1, rentalCadence: "monthly" }),
    ).not.toEqual([]);
  });
});
