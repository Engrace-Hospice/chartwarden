// @wardenx/discipline-plans — M15-T01 policy/cadence unit tests.
//
// The CoP-floor invariants the whole module rests on: 418.76(h)(1) tighten-only cadence, the §7.1
// escalation ladder shifting with a tenant override, the D11 quorum lookup, and the M15-F04 hours-÷-hours
// ratio badge (including the honest `unavailable` state while the M27/M23 denominator is unbound).
import { describe, expect, it } from "vitest";

import {
  AIDE_POC_REQUIRED_SIGNERS,
  BOOTSTRAP_ON_ADMISSION_ACTIVATED,
  INITIAL_ASSESSMENT_CLOCKS,
  SUPERVISORY_CADENCE,
  VOLUNTEER_RATIO_POLICY,
  isCadenceOverrideLegal,
  requiredSignersFor,
  supervisoryEscalationDays,
  volunteerRatioStatus,
} from "../src";

describe("supervisory cadence (D3 / 42 CFR 418.76(h)(1))", () => {
  it("accepts a tightening override and refuses any loosening", () => {
    expect(isCadenceOverrideLegal(7)).toBe(true);
    expect(isCadenceOverrideLegal(SUPERVISORY_CADENCE.platformFloorDays)).toBe(true);
    expect(isCadenceOverrideLegal(15)).toBe(false);
    expect(isCadenceOverrideLegal(0)).toBe(false);
    expect(isCadenceOverrideLegal(7.5)).toBe(false);
  });

  it("resolves the §7.1 ladder to day 12 / 14 / 16 at the platform floor", () => {
    expect(supervisoryEscalationDays(SUPERVISORY_CADENCE.platformFloorDays)).toEqual({
      warnAtDays: 12,
      overdueAtDays: 14,
      encounterSignGateAtDays: 16,
    });
  });

  it("shifts the whole ladder when a tenant tightens the cadence", () => {
    expect(supervisoryEscalationDays(7)).toEqual({
      warnAtDays: 5,
      overdueAtDays: 7,
      encounterSignGateAtDays: 9,
    });
  });
});

describe("initial-assessment clocks (D10)", () => {
  it("bootstraps three kinds at admission and leaves the volunteer plan lazy", () => {
    expect(BOOTSTRAP_ON_ADMISSION_ACTIVATED).toEqual(["aide_poc", "msw_plan", "spiritual_plan"]);
  });

  it("runs the MSW + chaplain 5-day CoP 418.54(c) window, chaplain satisfiable by declination", () => {
    expect(INITIAL_ASSESSMENT_CLOCKS.msw_plan.dueWithinDays).toBe(5);
    expect(INITIAL_ASSESSMENT_CLOCKS.msw_plan.satisfiedBy).toBe("signed_initial_assessment");
    expect(INITIAL_ASSESSMENT_CLOCKS.spiritual_plan.satisfiedBy).toBe(
      "signed_initial_assessment_or_declination",
    );
  });

  it("counts the volunteer window in business days, unlike every other kind", () => {
    expect(INITIAL_ASSESSMENT_CLOCKS.volunteer_plan.businessDays).toBe(true);
    expect(INITIAL_ASSESSMENT_CLOCKS.aide_poc.businessDays).toBe(false);
  });
});

describe("required signer sets (D11 / §3.5)", () => {
  it("makes the CHHA an acknowledgment, never a cosignature", () => {
    const chha = AIDE_POC_REQUIRED_SIGNERS.initial.find((s) => s.role === "chha_acknowledgment");
    expect(chha?.isAcknowledgment).toBe(true);
    expect(
      AIDE_POC_REQUIRED_SIGNERS.initial.find((s) => s.role === "rn_case_manager")?.isAcknowledgment,
    ).toBe(false);
  });

  it("lets the chaplain self-sign without an RN cosignature", () => {
    expect(requiredSignersFor("spiritual_plan", "initial")).toHaveLength(1);
    expect(requiredSignersFor("msw_plan", "initial")).toHaveLength(2);
  });

  it("reuses the initial quorum for an interim revision and requires none for the discharge version", () => {
    expect(requiredSignersFor("volunteer_plan", "interim_revision")).toEqual(
      requiredSignersFor("volunteer_plan", "initial"),
    );
    expect(requiredSignersFor("aide_poc", "discharge")).toEqual([]);
  });
});

describe("volunteer hour ratio (M15-F04 / 42 CFR 418.78(e))", () => {
  it("badges at the 5% floor and the 3% escalation point", () => {
    expect(volunteerRatioStatus(VOLUNTEER_RATIO_POLICY.floor)).toBe("green");
    expect(volunteerRatioStatus(0.04)).toBe("yellow");
    expect(volunteerRatioStatus(VOLUNTEER_RATIO_POLICY.criticalBelow)).toBe("yellow");
    expect(volunteerRatioStatus(0.029)).toBe("red");
  });

  it("reports an unbound denominator as `unavailable`, never as a 0% CoP breach", () => {
    expect(volunteerRatioStatus(null)).toBe("unavailable");
    expect(volunteerRatioStatus(0)).toBe("red");
  });
});
