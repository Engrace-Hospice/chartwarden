// @wardenx/emar — §2.6 D7 controlled-substance witness eligibility — M13-T04.
import { describe, expect, it } from "vitest";
import {
  assertWitnessEligible,
  controlledSubstanceWitnessEligible,
  type WitnessEligibilityInput,
} from "../src/witness";

const eligible: WitnessEligibilityInput = {
  witnessMembershipId: "mem-witness",
  administeringClinicianMembershipId: "mem-admin",
  witnessDiscipline: "RN",
  witnessMembershipActive: true,
  sameTenant: true,
  witnessIsCaregiver: false,
  witnessIsBreakGlass: false,
};

describe("§2.6 D7 controlledSubstanceWitnessEligible", () => {
  it("an active same-tenant RN witness who is not the administering clinician is eligible", () => {
    expect(controlledSubstanceWitnessEligible(eligible)).toEqual({ eligible: true, isBreakGlass: false });
  });
  it("each of {rn, lpn, md, np, pa} is an eligible discipline (case-insensitive)", () => {
    for (const d of ["rn", "lpn", "md", "np", "pa", "NP"]) {
      expect(controlledSubstanceWitnessEligible({ ...eligible, witnessDiscipline: d }).eligible).toBe(true);
    }
  });
  it("a clinician cannot witness themselves", () => {
    expect(
      controlledSubstanceWitnessEligible({ ...eligible, witnessMembershipId: "mem-admin" }),
    ).toEqual({ eligible: false, reason: "is_administering_clinician" });
  });
  it("CHHA/MSW/chaplain/volunteer cannot witness", () => {
    for (const d of ["chha", "msw", "chaplain", "volunteer"]) {
      expect(controlledSubstanceWitnessEligible({ ...eligible, witnessDiscipline: d })).toEqual({
        eligible: false,
        reason: "discipline_ineligible",
      });
    }
  });
  it("an inactive or cross-tenant membership is ineligible", () => {
    expect(
      controlledSubstanceWitnessEligible({ ...eligible, witnessMembershipActive: false }),
    ).toEqual({ eligible: false, reason: "membership_inactive" });
    expect(controlledSubstanceWitnessEligible({ ...eligible, sameTenant: false })).toEqual({
      eligible: false,
      reason: "different_tenant",
    });
  });
  it("a caregiver cannot witness a clinician-administered dose", () => {
    expect(controlledSubstanceWitnessEligible({ ...eligible, witnessIsCaregiver: true })).toEqual({
      eligible: false,
      reason: "is_caregiver",
    });
  });
  it("a break-glass witness is eligible but flagged for the warn audit event", () => {
    expect(controlledSubstanceWitnessEligible({ ...eligible, witnessIsBreakGlass: true })).toEqual({
      eligible: true,
      isBreakGlass: true,
    });
  });
});

describe("§2.6 D7 assertWitnessEligible", () => {
  it("returns { isBreakGlass } on success", () => {
    expect(assertWitnessEligible(eligible)).toEqual({ isBreakGlass: false });
    expect(assertWitnessEligible({ ...eligible, witnessIsBreakGlass: true })).toEqual({ isBreakGlass: true });
  });
  it("throws CONTROLLED_WITNESS_NOT_ELIGIBLE (403) with the reason in the message", () => {
    expect(() => assertWitnessEligible({ ...eligible, witnessIsCaregiver: true })).toThrow(
      expect.objectContaining({ code: "CONTROLLED_WITNESS_NOT_ELIGIBLE", statusCode: 403 }),
    );
  });
});
