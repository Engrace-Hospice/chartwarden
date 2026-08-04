// @wardenx/emar — §2.7 D5 comfort-kit deployment + drawdown + return reconciliation — M13-T05.
import { describe, expect, it } from "vitest";
import {
  CONTROLLED_DISCREPANCY_FRACTION,
  type ComfortKitDeployedEnvelope,
  DEFAULT_REPLENISHMENT_THRESHOLD_FRACTION,
  type KitDrawdownState,
  applyKitDrawdown,
  applyKitReturn,
  buildComfortKitDeployment,
  evaluateReplenishmentUrgency,
  reconcileKitReturnLine,
} from "../src/comfort-kit";
import { AdministrationStateError } from "../src/lifecycle/errors";

const ENVELOPE: ComfortKitDeployedEnvelope = {
  deploymentId: "dep-1",
  patientId: "pat-1",
  admissionId: "adm-1",
  deployedAtIso: "2026-06-22T10:00:00.000Z",
  deployedByMembershipId: "mem-1",
  contents: [
    {
      medicationOrderId: "ord-morphine",
      expectedQuantity: 20,
      expectedUnit: "mL",
      lotNumber: "LOT-A",
      expirationDate: "2027-01-01",
      isControlled: true,
    },
    {
      medicationOrderId: "ord-lorazepam",
      expectedQuantity: 10,
      expectedUnit: "mL",
      lotNumber: "LOT-B",
      expirationDate: "2027-01-01",
    },
  ],
};

describe("§2.7 buildComfortKitDeployment", () => {
  it("materializes one drawdown per content line at remaining=expected with the 25% default threshold", () => {
    const plan = buildComfortKitDeployment(ENVELOPE);
    expect(plan.drawdowns).toHaveLength(2);
    const morphine = plan.drawdowns[0]!;
    expect(morphine.remainingQuantity).toBe(20);
    expect(morphine.expectedQuantity).toBe(20);
    expect(morphine.replenishmentThreshold).toBe(20 * DEFAULT_REPLENISHMENT_THRESHOLD_FRACTION);
    expect(morphine.isControlled).toBe(true);
    expect(plan.drawdowns[1]!.isControlled).toBe(false);
  });
  it("honors a per-medication replenishment-threshold override fraction", () => {
    const plan = buildComfortKitDeployment({
      ...ENVELOPE,
      contents: [{ ...ENVELOPE.contents[0]!, replenishmentThresholdFraction: 0.5 }],
    });
    expect(plan.drawdowns[0]!.replenishmentThreshold).toBe(10);
  });
  it("builds the m13.comfort_kit.deployed signal with the content shape (no PHI)", () => {
    const plan = buildComfortKitDeployment(ENVELOPE);
    expect(plan.deployedSignal.deploymentId).toBe("dep-1");
    expect(plan.deployedSignal.patientId).toBe("pat-1");
    expect(plan.deployedSignal.contents).toHaveLength(2);
    expect(plan.deployedSignal.contents[0]).toEqual({
      medicationOrderId: "ord-morphine",
      expectedQuantity: 20,
      expectedUnit: "mL",
    });
  });
  it("rejects an empty kit", () => {
    expect(() => buildComfortKitDeployment({ ...ENVELOPE, contents: [] })).toThrow(
      AdministrationStateError,
    );
  });
  it("rejects a non-positive content quantity", () => {
    expect(() =>
      buildComfortKitDeployment({
        ...ENVELOPE,
        contents: [{ ...ENVELOPE.contents[0]!, expectedQuantity: 0 }],
      }),
    ).toThrow(/positive expected quantity/);
  });
});

const STATE: KitDrawdownState = {
  deploymentId: "dep-1",
  medicationOrderId: "ord-morphine",
  remainingQuantity: 20,
  expectedQuantity: 20,
  expectedUnit: "mL",
  replenishmentThreshold: 5,
  lotNumber: "LOT-A",
  drugName: "morphine 20mg/mL",
};

describe("§2.7 D5 applyKitDrawdown", () => {
  it("decrements by administered + wastage and returns no signal above threshold", () => {
    const r = applyKitDrawdown(STATE, { administeredAmount: 2, wastageAmount: 1 });
    expect(r.newRemainingQuantity).toBe(17);
    expect(r.belowThreshold).toBe(false);
    expect(r.replenishmentSignal).toBeNull();
  });
  it("rejects a decrement that would go negative with KIT_INSUFFICIENT_QUANTITY", () => {
    expect(() => applyKitDrawdown(STATE, { administeredAmount: 25 })).toThrow(
      AdministrationStateError,
    );
    try {
      applyKitDrawdown(STATE, { administeredAmount: 25 });
    } catch (e) {
      expect(e).toMatchObject({ code: "KIT_INSUFFICIENT_QUANTITY" });
    }
  });
  it("emits a routine replenishment signal at threshold with requestedQuantity to top back to full", () => {
    const r = applyKitDrawdown({ ...STATE, remainingQuantity: 6 }, { administeredAmount: 1 });
    expect(r.belowThreshold).toBe(true);
    expect(r.replenishmentSignal).toMatchObject({
      deploymentId: "dep-1",
      medicationOrderId: "ord-morphine",
      remainingQuantity: 5,
      requestedQuantity: 15,
      urgencyKind: "routine",
      lotNumber: "LOT-A",
    });
  });
  it("escalates to urgent when remaining ≤10% of expected", () => {
    const r = applyKitDrawdown({ ...STATE, remainingQuantity: 3 }, { administeredAmount: 1 });
    expect(r.replenishmentSignal?.urgencyKind).toBe("urgent");
  });
  it("escalates to urgent on burn rate (≥3 PRN administrations in 24h) even above the 10% floor", () => {
    const r = applyKitDrawdown(
      { ...STATE, remainingQuantity: 6 },
      { administeredAmount: 1, recentPrnCount24h: 3 },
    );
    expect(r.replenishmentSignal?.urgencyKind).toBe("urgent");
  });
});

describe("§2.7 evaluateReplenishmentUrgency", () => {
  it("is routine above 10% and under the burn-rate threshold", () => {
    expect(evaluateReplenishmentUrgency(5, 20, 2)).toBe("routine");
  });
  it("is urgent at exactly 10% of expected", () => {
    expect(evaluateReplenishmentUrgency(2, 20, 0)).toBe("urgent");
  });
});

describe("§2.7 applyKitReturn", () => {
  it("flips disposal_status to returned and stamps returnedAt", () => {
    const r = applyKitReturn({ deploymentId: "dep-1", returnedAt: "2026-07-01T00:00:00.000Z" });
    expect(r).toEqual({
      deploymentId: "dep-1",
      disposalStatus: "returned",
      returnedAt: "2026-07-01T00:00:00.000Z",
    });
  });
});

describe("§2.7 reconcileKitReturnLine", () => {
  it("records the staff-counted remaining and computes the delta against tracked", () => {
    const r = reconcileKitReturnLine("dep-1", {
      medicationOrderId: "ord-lorazepam",
      trackedRemainingQuantity: 4,
      actualRemainingQuantity: 4,
      expectedQuantity: 10,
      isControlled: false,
    });
    expect(r.finalRemainingQuantityAtReturn).toBe(4);
    expect(r.deltaQuantity).toBe(0);
    expect(r.controlledDiscrepancySignal).toBeNull();
  });
  it("surfaces the controlled-substance discrepancy signal at ≥5% delta", () => {
    const r = reconcileKitReturnLine("dep-1", {
      medicationOrderId: "ord-morphine",
      trackedRemainingQuantity: 8,
      actualRemainingQuantity: 6, // 2 of 20 = 10% missing
      expectedQuantity: 20,
      isControlled: true,
    });
    expect(r.deltaPercent).toBeGreaterThanOrEqual(CONTROLLED_DISCREPANCY_FRACTION);
    expect(r.controlledDiscrepancySignal).toMatchObject({
      deploymentId: "dep-1",
      medicationOrderId: "ord-morphine",
      deltaQuantity: 2,
    });
  });
  it("does NOT surface the discrepancy signal for a non-controlled medication", () => {
    const r = reconcileKitReturnLine("dep-1", {
      medicationOrderId: "ord-lorazepam",
      trackedRemainingQuantity: 8,
      actualRemainingQuantity: 4,
      expectedQuantity: 10,
      isControlled: false,
    });
    expect(r.controlledDiscrepancySignal).toBeNull();
  });
  it("does NOT surface a controlled discrepancy under the 5% floor", () => {
    const r = reconcileKitReturnLine("dep-1", {
      medicationOrderId: "ord-morphine",
      trackedRemainingQuantity: 20,
      actualRemainingQuantity: 19.5, // 0.5 of 20 = 2.5%
      expectedQuantity: 20,
      isControlled: true,
    });
    expect(r.controlledDiscrepancySignal).toBeNull();
  });
});
