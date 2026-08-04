import { describe, expect, it } from "vitest";

import {
  COMFORT_KIT_PLATFORM_FLOOR,
  type TenantTemplateMedication,
  floorQuantityBounds,
  validateTenantTemplate,
} from "../src/template/floor";

const asTenantLines = (
  over: Partial<Record<string, Partial<TenantTemplateMedication>>> = {},
): TenantTemplateMedication[] =>
  COMFORT_KIT_PLATFORM_FLOOR.map((f) => ({
    floorKey: f.key,
    drugName: f.drugName,
    isControlledSubstance: f.isControlledSubstance,
    expectedQuantity: f.expectedQuantity,
    replenishmentThresholdPct: f.replenishmentThresholdPct,
    ...(over[f.key] ?? {}),
  }));

const codes = (r: ReturnType<typeof validateTenantTemplate>) =>
  r.ok ? [] : r.violations.map((v) => v.code);

const MORPHINE = "morphine_sulfate_20mg_ml_oral_solution";

describe("D3 platform floor", () => {
  it("is the four-medication industry baseline", () => {
    expect(COMFORT_KIT_PLATFORM_FLOOR).toHaveLength(4);
    expect(COMFORT_KIT_PLATFORM_FLOOR.map((m) => m.drugName)).toEqual([
      "Morphine sulfate",
      "Lorazepam",
      "Haloperidol",
      "Atropine sulfate",
    ]);
  });

  it("pairs every controlled medication with its DEA schedule and leaves the others null", () => {
    for (const m of COMFORT_KIT_PLATFORM_FLOOR) {
      expect(m.controlledSubstanceSchedule !== null).toBe(m.isControlledSubstance);
    }
  });

  it("derives tenant bounds as half and double the floor quantity", () => {
    expect(floorQuantityBounds(MORPHINE)).toEqual({ min: 15, max: 60 });
    expect(floorQuantityBounds("not-a-floor-medication")).toBeNull();
  });
});

describe("D3 tenant-tighten-only validator", () => {
  it("accepts the unmodified floor", () => {
    expect(validateTenantTemplate(asTenantLines()).ok).toBe(true);
  });

  it("accepts a tenant ADDITION alongside the floor", () => {
    const lines = [
      ...asTenantLines(),
      {
        floorKey: null,
        drugName: "Glycopyrrolate",
        isControlledSubstance: false,
        expectedQuantity: 10,
        replenishmentThresholdPct: 0.1,
      },
    ];
    expect(validateTenantTemplate(lines).ok).toBe(true);
  });

  it("refuses to let a tenant remove a floor medication", () => {
    const lines = asTenantLines().filter((l) => l.floorKey !== MORPHINE);
    expect(codes(validateTenantTemplate(lines))).toContain("floor_medication_removed");
  });

  it("accepts a quantity tightened to the tenant minimum", () => {
    expect(validateTenantTemplate(asTenantLines({ [MORPHINE]: { expectedQuantity: 15 } })).ok).toBe(
      true,
    );
  });

  it("refuses a quantity below the tenant minimum", () => {
    expect(
      codes(validateTenantTemplate(asTenantLines({ [MORPHINE]: { expectedQuantity: 14 } }))),
    ).toContain("quantity_below_tenant_minimum");
  });

  it("refuses a quantity above the platform ceiling", () => {
    expect(
      codes(validateTenantTemplate(asTenantLines({ [MORPHINE]: { expectedQuantity: 61 } }))),
    ).toContain("quantity_above_tenant_ceiling");
  });

  it("allows RAISING a replenishment threshold — that replenishes sooner", () => {
    expect(
      validateTenantTemplate(asTenantLines({ [MORPHINE]: { replenishmentThresholdPct: 0.33 } })).ok,
    ).toBe(true);
  });

  it("refuses LOWERING a replenishment threshold — that is the 2am-without-morphine direction", () => {
    expect(
      codes(
        validateTenantTemplate(asTenantLines({ [MORPHINE]: { replenishmentThresholdPct: 0.1 } })),
      ),
    ).toContain("threshold_loosened");
  });

  it("refuses clearing the platform-managed controlled-substance flag", () => {
    expect(
      codes(
        validateTenantTemplate(asTenantLines({ [MORPHINE]: { isControlledSubstance: false } })),
      ),
    ).toContain("controlled_flag_disarmed");
  });

  it("reports every violation at once rather than stopping at the first", () => {
    const lines = asTenantLines({
      [MORPHINE]: { expectedQuantity: 1, replenishmentThresholdPct: 0.01 },
    }).filter((l) => l.floorKey !== "lorazepam_2mg_ml_oral_solution");
    const c = codes(validateTenantTemplate(lines));
    expect(c).toContain("floor_medication_removed");
    expect(c).toContain("quantity_below_tenant_minimum");
    expect(c).toContain("threshold_loosened");
  });
});
