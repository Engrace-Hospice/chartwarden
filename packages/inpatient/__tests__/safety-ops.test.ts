// @chartwarden/inpatient — M37-T08 unit tests: restraint (§2.10), visitor (§2.7), equipment (§2.9), meal (§2.8).
import { describe, expect, it } from "vitest";
import {
  assertInspectionCurrent,
  computeNextInspectionDue,
  inspectionWarnThreshold,
  isInspectionCurrent,
} from "../src/domain/equipment/inspection";
import { isComfortFeedingConcern, isIntakeFractionValid } from "../src/domain/meal/intake";
import {
  evaluateVisitorCheckIn,
  isImmediateFamily,
  screeningHasRisk,
} from "../src/domain/visitor/restriction-evaluator";
import type { IpuStateError } from "../src/errors";
import {
  RESTRAINT_JUSTIFICATION_MIN,
  RESTRAINT_REASSESS_FLOOR_MINUTES,
  isRestraintReassessmentDue,
  normalizeReassessmentInterval,
  planReassessmentOutcome,
  validateRestraintApply,
} from "../src/machines/ipu-restraint";

const MIN = 60_000;
const DAY = 86_400_000;

describe("restraint policy (§2.10 D11)", () => {
  const ok = {
    justificationText: "x".repeat(RESTRAINT_JUSTIFICATION_MIN),
    hasOrderingOrder: true,
    stepUpVerified: true,
  };
  it("validates a compliant application", () => {
    expect(() => validateRestraintApply(ok)).not.toThrow();
  });
  it("requires step-up, a physician order, and a 100-char justification", () => {
    expect(() => validateRestraintApply({ ...ok, stepUpVerified: false })).toThrow(
      /RESTRAINT_STEP_UP_REQUIRED|step-up/,
    );
    expect(() => validateRestraintApply({ ...ok, hasOrderingOrder: false })).toThrow(
      /RESTRAINT_ORDER_REQUIRED|order/,
    );
    try {
      validateRestraintApply({ ...ok, justificationText: "short" });
    } catch (e) {
      expect((e as IpuStateError).code).toBe("RESTRAINT_JUSTIFICATION_TOO_SHORT");
    }
  });
  it("enforces the tighten-only reassessment floor by category", () => {
    expect(normalizeReassessmentInterval(15, "behavioral")).toBe(15);
    expect(normalizeReassessmentInterval(10, "behavioral")).toBe(10);
    expect(RESTRAINT_REASSESS_FLOOR_MINUTES.medical).toBe(120);
    expect(() => normalizeReassessmentInterval(30, "behavioral")).toThrow(/NOT_TIGHTENING|loosen/);
  });
  it("flags a reassessment due past the interval", () => {
    const t = 100 * MIN;
    expect(isRestraintReassessmentDue(t, 15, t + 16 * MIN)).toBe(true);
    expect(isRestraintReassessmentDue(t, 15, t + 14 * MIN)).toBe(false);
  });
  it("routes reassessment outcomes (continue/modify/release)", () => {
    expect(planReassessmentOutcome("active", "continue")).toMatchObject({
      closesEvent: false,
      nextState: "active",
    });
    expect(planReassessmentOutcome("active", "modify")).toMatchObject({
      closesEvent: true,
      forksNewEvent: true,
      nextState: "released",
    });
    expect(planReassessmentOutcome("active", "release")).toMatchObject({
      closesEvent: true,
      forksNewEvent: false,
      outbox: "m37.restraint.released",
    });
    expect(() => planReassessmentOutcome("released", "continue")).toThrow(
      /active restraint event can be reassessed/,
    );
  });
});

describe("visitor restrictions (§2.7 D8)", () => {
  it("classifies immediate family", () => {
    expect(isImmediateFamily("spouse")).toBe(true);
    expect(isImmediateFamily("friend")).toBe(false);
  });
  it("allows an unrestricted check-in with no flags", () => {
    expect(evaluateVisitorCheckIn("friend", [])).toMatchObject({
      allowed: true,
      maskRequired: false,
      appliedRestriction: null,
    });
  });
  it("blocks on full_block (412)", () => {
    try {
      evaluateVisitorCheckIn("spouse", [{ kind: "full_block" }]);
    } catch (e) {
      expect((e as IpuStateError).code).toBe("VISITOR_RESTRICTION_FULL_BLOCK");
      expect((e as IpuStateError).statusCode).toBe(412);
    }
  });
  it("immediate_family_only blocks a friend but admits a child", () => {
    expect(() => evaluateVisitorCheckIn("friend", [{ kind: "immediate_family_only" }])).toThrow(
      /immediate family only/,
    );
    expect(evaluateVisitorCheckIn("child", [{ kind: "immediate_family_only" }]).allowed).toBe(true);
  });
  it("mask_required allows with a mask flag echoed", () => {
    const d = evaluateVisitorCheckIn("friend", [{ kind: "mask_required" }]);
    expect(d).toMatchObject({
      allowed: true,
      maskRequired: true,
      appliedRestriction: "mask_required",
    });
  });
  it("flags screening risk", () => {
    expect(
      screeningHasRisk({
        feverPresent: true,
        coughPresent: false,
        recentCovidExposure14d: false,
        recentTravelOutsideCountry14d: false,
        recentRespiratoryIllnessInHousehold14d: false,
      }),
    ).toBe(true);
    expect(
      screeningHasRisk({
        feverPresent: false,
        coughPresent: false,
        recentCovidExposure14d: false,
        recentTravelOutsideCountry14d: false,
        recentRespiratoryIllnessInHousehold14d: false,
      }),
    ).toBe(false);
  });
});

describe("equipment inspection (§2.9 D10)", () => {
  const t0 = 1000 * DAY;
  it("computes next-due by inspection kind", () => {
    expect(computeNextInspectionDue("annual_biomed", t0)).toBe(t0 + 365 * DAY);
    expect(computeNextInspectionDue("per_use_safety", t0)).toBe(t0 + 30 * DAY);
    // post_repair keeps the existing annual due, not a fresh clock.
    expect(computeNextInspectionDue("post_repair_safety", t0, t0 + 200 * DAY)).toBe(t0 + 200 * DAY);
  });
  it("gates assignment on an overdue inspection (412)", () => {
    const due = t0 + 365 * DAY;
    expect(isInspectionCurrent(due, t0)).toBe(true);
    expect(isInspectionCurrent(due, due + 1 * DAY)).toBe(false);
    expect(() => assertInspectionCurrent(due, t0)).not.toThrow();
    try {
      assertInspectionCurrent(due, due + 2 * DAY);
    } catch (e) {
      expect((e as IpuStateError).code).toBe("EQUIPMENT_INSPECTION_OVERDUE");
    }
  });
  it("hits the warn thresholds 14/7/2/0 days out", () => {
    const due = t0 + 365 * DAY;
    expect(inspectionWarnThreshold(due, due - 7 * DAY)).toBe(7);
    expect(inspectionWarnThreshold(due, due - 5 * DAY)).toBeNull();
    expect(inspectionWarnThreshold(due, due)).toBe(0);
  });
});

describe("meal intake (§2.8 D9)", () => {
  it("validates the intake fraction range", () => {
    expect(isIntakeFractionValid(0.5)).toBe(true);
    expect(isIntakeFractionValid(null)).toBe(true);
    expect(isIntakeFractionValid(1.5)).toBe(false);
  });
  it("flags a comfort-feeding concern", () => {
    expect(isComfortFeedingConcern(0.1, true, "comfort_feeding")).toBe(true);
    expect(isComfortFeedingConcern(0.5, true, "comfort_feeding")).toBe(false);
    expect(isComfortFeedingConcern(0.1, false, "comfort_feeding")).toBe(false);
    expect(isComfortFeedingConcern(0.1, true, "regular")).toBe(false);
  });
});
