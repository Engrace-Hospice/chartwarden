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

  it.each(TRANSITIONAL_KINDS)("accepts an extensible object for %s without inventing required fields", (kind) => {
    expect(
      validateOrderData(kind, ORDER_KIND_VERSION[kind], {
        localWorkflowExtension: { value: true },
      }),
    ).toEqual([]);
  });

  it.each(TRANSITIONAL_KINDS)("still rejects a non-object %s payload", (kind) => {
    expect(validateOrderData(kind, ORDER_KIND_VERSION[kind], [])).not.toEqual([]);
  });

  it("does not silently accept an unpublished contract under a different version", () => {
    expect(validateOrderData("dme", "dme.v2", {})).toEqual([
      { field: "kindVersion", message: "Unsupported dme payload version." },
    ]);
  });
});
