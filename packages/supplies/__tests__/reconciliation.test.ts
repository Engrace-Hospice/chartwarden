import { describe, expect, it } from "vitest";

import {
  type ReturnLineInput,
  computeReturnLine,
  computeReturnReconciliation,
  isDisposalWitnessValid,
  isReturnLineCoherent,
} from "../src/reconciliation";

const controlled = (over: Partial<ReturnLineInput> = {}): ReturnLineInput => ({
  dispatchedQuantity: "30",
  quantityReturned: "30",
  quantityDisposedAtHome: "0",
  isControlledSubstance: true,
  controlledSubstanceSchedule: "CII",
  ...over,
});

describe("D8 per-line reconciliation math", () => {
  it("accounts a fully returned line with no discrepancy", () => {
    const r = computeReturnLine(controlled());
    expect(r.quantityUnaccounted).toBe("0");
    expect(r.discrepancyPct).toBe(0);
    expect(r.discrepancyFlagged).toBe(false);
  });

  it("splits returned and home-disposed quantities", () => {
    const r = computeReturnLine(controlled({ quantityReturned: "10", quantityDisposedAtHome: "20" }));
    expect(r.quantityUnaccounted).toBe("0");
    expect(r.discrepancyFlagged).toBe(false);
  });

  it("does NOT flag a controlled line 4.9% short", () => {
    // 30 − 28.53 = 1.47 → 4.9%
    const r = computeReturnLine(controlled({ quantityReturned: "28.53" }));
    expect(r.discrepancyPct).toBeCloseTo(0.049, 6);
    expect(r.discrepancyFlagged).toBe(false);
  });

  it("flags a controlled line at exactly 5% — the boundary is inclusive", () => {
    const r = computeReturnLine(controlled({ quantityReturned: "28.5" }));
    expect(r.quantityUnaccounted).toBe("1.5");
    expect(r.discrepancyPct).toBe(0.05);
    expect(r.discrepancyFlagged).toBe(true);
  });

  it("never flags a NON-controlled line, however short — gloves get used", () => {
    const r = computeReturnLine(
      controlled({ isControlledSubstance: false, controlledSubstanceSchedule: null, quantityReturned: "0" }),
    );
    expect(r.discrepancyPct).toBe(1);
    expect(r.discrepancyFlagged).toBe(false);
  });

  it("keeps decimal quantities exact — 0.1 + 0.2 must not drift", () => {
    const r = computeReturnLine(
      controlled({ dispatchedQuantity: "0.3", quantityReturned: "0.1", quantityDisposedAtHome: "0.2" }),
    );
    expect(r.quantityUnaccounted).toBe("0");
    expect(r.discrepancyPct).toBe(0);
  });

  it("returns zero rather than dividing by zero on a zero-quantity line", () => {
    const r = computeReturnLine(
      controlled({ dispatchedQuantity: "0", quantityReturned: "0", quantityDisposedAtHome: "0" }),
    );
    expect(r.discrepancyPct).toBe(0);
    expect(r.discrepancyFlagged).toBe(false);
  });
});

describe("§2.10 return-line coherence", () => {
  it("accepts accounting for exactly what went out", () => {
    expect(isReturnLineCoherent(controlled({ quantityReturned: "20", quantityDisposedAtHome: "10" }))).toBe(
      true,
    );
  });

  it("refuses accounting for MORE than went out — that writes a negative into the perpetual log", () => {
    expect(isReturnLineCoherent(controlled({ quantityReturned: "20", quantityDisposedAtHome: "20" }))).toBe(
      false,
    );
  });
});

describe("whole-return reconciliation", () => {
  it("detects a discrepancy when any single line flags", () => {
    const summary = computeReturnReconciliation([
      controlled(),
      controlled({ quantityReturned: "0" }),
      controlled({ isControlledSubstance: false, controlledSubstanceSchedule: null, quantityReturned: "0" }),
    ]);
    expect(summary.flaggedLineCount).toBe(1);
    expect(summary.discrepancyDetected).toBe(true);
    expect(summary.lines).toHaveLength(3);
  });

  it("reports no discrepancy on a clean return", () => {
    const summary = computeReturnReconciliation([controlled(), controlled()]);
    expect(summary.discrepancyDetected).toBe(false);
    expect(summary.flaggedLineCount).toBe(0);
  });
});

describe("§2.6 witness distinctness", () => {
  it("requires a witness for home witnessed destruction", () => {
    expect(
      isDisposalWitnessValid({
        disposalMethod: "dispose_at_home_by_witnessed_destruction",
        disposalWitnessMembershipId: null,
        assignedRetrievingMembershipId: "m-1",
        reconciledByMembershipId: "m-2",
      }),
    ).toBe(false);
  });

  it("refuses a witness who is also the reconciler or the retriever", () => {
    for (const same of ["assignedRetrievingMembershipId", "reconciledByMembershipId"] as const) {
      expect(
        isDisposalWitnessValid({
          disposalMethod: "dispose_at_home_by_witnessed_destruction",
          disposalWitnessMembershipId: "m-1",
          assignedRetrievingMembershipId: same === "assignedRetrievingMembershipId" ? "m-1" : "m-9",
          reconciledByMembershipId: same === "reconciledByMembershipId" ? "m-1" : "m-8",
        }),
      ).toBe(false);
    }
  });

  it("accepts three distinct people", () => {
    expect(
      isDisposalWitnessValid({
        disposalMethod: "dispose_at_home_by_witnessed_destruction",
        disposalWitnessMembershipId: "m-1",
        assignedRetrievingMembershipId: "m-2",
        reconciledByMembershipId: "m-3",
      }),
    ).toBe(true);
  });

  it("does not require a witness for take-back or pharmacy transfer", () => {
    for (const method of ["take_back_by_supply_team", "transferred_to_disposing_pharmacy"] as const) {
      expect(
        isDisposalWitnessValid({
          disposalMethod: method,
          disposalWitnessMembershipId: null,
          assignedRetrievingMembershipId: "m-1",
          reconciledByMembershipId: "m-2",
        }),
      ).toBe(true);
    }
  });
});
