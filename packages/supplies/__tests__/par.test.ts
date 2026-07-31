// packages/supplies/__tests__/par.test.ts — M21-T03 (§2.7 / D5, §7.5).
import { describe, expect, it } from "vitest";

import {
  applyParDelta,
  areParThresholdsOrdered,
  isBelowReorderPoint,
  isStockoutImminent,
  parStockSeverity,
} from "../src/par";

const shelf = (current: string, reorderPoint = "10", minSafetyStock = "4") => ({
  currentQuantity: current,
  reorderPoint,
  minSafetyStock,
});

describe("parStockSeverity — the §7.5 bands over the §3.1 normative thresholds", () => {
  it("reads a stocked shelf as ok", () => {
    expect(parStockSeverity(shelf("25"))).toBe("ok");
  });

  it("bands at-or-below the reorder point as below_threshold (inclusive boundary)", () => {
    expect(parStockSeverity(shelf("10"))).toBe("below_threshold");
    expect(parStockSeverity(shelf("9.5"))).toBe("below_threshold");
  });

  it("bands at-or-below the safety floor as critical_low", () => {
    expect(parStockSeverity(shelf("4"))).toBe("critical_low");
    expect(parStockSeverity(shelf("0.5"))).toBe("critical_low");
  });

  it("keeps `depleted` distinct from `critical_low` — an empty hub fills nothing at all", () => {
    expect(parStockSeverity(shelf("0"))).toBe("depleted");
    // The distinction survives a tenant that set no safety floor at all.
    expect(parStockSeverity(shelf("0", "10", "0"))).toBe("depleted");
    expect(parStockSeverity(shelf("3", "10", "0"))).toBe("below_threshold");
  });

  it("does not drift on decimal quantities a float would round", () => {
    expect(parStockSeverity(shelf("10.0000000000000001", "10", "4"))).toBe("ok");
  });
});

describe("threshold predicates", () => {
  it("treats a critical shelf as ALSO below the reorder point — the reorder queue must still see it", () => {
    const s = shelf("2");
    expect(isStockoutImminent(s)).toBe(true);
    expect(isBelowReorderPoint(s)).toBe(true);
  });

  it("rejects an inverted threshold pair (the critical band would be unreachable)", () => {
    expect(
      areParThresholdsOrdered({ reorderPoint: "4", minSafetyStock: "10", reorderQuantity: "20" }),
    ).toBe(false);
    expect(
      areParThresholdsOrdered({ reorderPoint: "10", minSafetyStock: "4", reorderQuantity: "20" }),
    ).toBe(true);
  });

  it("rejects negative thresholds", () => {
    expect(
      areParThresholdsOrdered({ reorderPoint: "10", minSafetyStock: "-1", reorderQuantity: "5" }),
    ).toBe(false);
    expect(
      areParThresholdsOrdered({ reorderPoint: "10", minSafetyStock: "0", reorderQuantity: "-5" }),
    ).toBe(false);
  });
});

describe("applyParDelta", () => {
  it("increments on a vendor receipt", () => {
    expect(applyParDelta("12", "8")).toEqual({ ok: true, nextQuantity: "20" });
  });

  it("decrements exactly, without float drift", () => {
    expect(applyParDelta("30", "-0.3")).toEqual({ ok: true, nextQuantity: "29.7" });
  });

  it("allows a decrement to exactly zero", () => {
    expect(applyParDelta("5", "-5")).toEqual({ ok: true, nextQuantity: "0" });
  });

  it("REFUSES rather than clamps a decrement past zero — the shortfall IS the reorder signal", () => {
    expect(applyParDelta("5", "-8")).toEqual({ ok: false, shortBy: "3" });
  });
});
