// @wardenx/billing — FY2027 CR 14495: the `f2f_telehealth_g0679` rule + the pure G0679 date derivation
// claim assembly uses (docs/research/FY2027_HOSPICE_COP_RESEARCH.md §4). Pure; no DB, no clock.
import type {
  ClaimLineSnapshot,
  FaceToFaceSnapshot,
  RuleResult,
  ValidationContext,
} from "@wardenx/billing";
import {
  G0679_EFFECTIVE_FROM,
  G0679_HCPCS,
  G0679_REVENUE_CODE,
  G0679_UNITS_PER_ENCOUNTER,
  G0679_UNIT_CHARGE_CENTS,
  createDefaultBillingRegistry,
  f2fTelehealthG0679,
  levelOfCareCoherence,
  telehealthF2fDatesRequiringG0679,
} from "@wardenx/billing";
import { describe, expect, it } from "vitest";
import { passingContext } from "./_fixtures";

const SPAN_2027 = { serviceFrom: "2027-01-01", serviceTo: "2027-01-31" } as const;

function f2f(overrides: Partial<FaceToFaceSnapshot> = {}): FaceToFaceSnapshot {
  return {
    electionPeriodSequence: 3,
    attested: true,
    encounterDate: "2027-01-20",
    modality: "telehealth",
    ...overrides,
  };
}

function g0679Line(overrides: Partial<ClaimLineSnapshot> = {}): ClaimLineSnapshot {
  return {
    claimLineId: "line-g0679",
    serviceDate: "2027-01-20",
    revenueCode: G0679_REVENUE_CODE,
    qCode: "Q5001",
    levelOfCare: "routine_home_care",
    hcpcs: G0679_HCPCS,
    modifiers: [],
    unitCount: G0679_UNITS_PER_ENCOUNTER,
    unitRateCents: G0679_UNIT_CHARGE_CENTS,
    lineChargeCents: G0679_UNITS_PER_ENCOUNTER * G0679_UNIT_CHARGE_CENTS,
    icdPointerPositions: [1],
    backingEncounterIds: [],
    ...overrides,
  };
}

/** A January-2027 claim with one per-diem line, the given F2F facts and any extra lines. */
function ctx2027(
  faceToFace: readonly FaceToFaceSnapshot[],
  extraLines: readonly ClaimLineSnapshot[] = [],
  tob: ValidationContext["claim"]["tob"] = "813",
): ValidationContext {
  const base = passingContext();
  return {
    ...base,
    claim: { ...base.claim, ...SPAN_2027, tob },
    lines: [{ ...base.lines[0]!, serviceDate: "2027-01-15" }, ...extraLines],
    levelOfCarePeriods: [{ ...base.levelOfCarePeriods[0]!, to: "2027-12-31" }],
    faceToFace,
  };
}

function run(c: ValidationContext): RuleResult {
  return f2fTelehealthG0679.check(c, f2fTelehealthG0679.defaultParameters ?? {});
}

describe("telehealthF2fDatesRequiringG0679 — which encounters need a G0679 line", () => {
  it("returns a telehealth encounter dated inside the span on/after 2027-01-01", () => {
    expect(telehealthF2fDatesRequiringG0679([f2f()], SPAN_2027)).toEqual(["2027-01-20"]);
  });

  it("never reports an in-person or unrecorded-modality encounter", () => {
    expect(
      telehealthF2fDatesRequiringG0679(
        [f2f({ modality: "in_person" }), f2f({ modality: null })],
        SPAN_2027,
      ),
    ).toEqual([]);
  });

  it("does not report a telehealth encounter before the 2027-01-01 effective date (boundary)", () => {
    const span = { serviceFrom: "2026-12-01", serviceTo: "2027-01-31" };
    expect(
      telehealthF2fDatesRequiringG0679(
        [f2f({ encounterDate: "2026-12-31" }), f2f({ encounterDate: G0679_EFFECTIVE_FROM })],
        span,
      ),
    ).toEqual(["2027-01-01"]);
  });

  it("ignores an encounter outside the claim span (either side) and one with no date", () => {
    expect(
      telehealthF2fDatesRequiringG0679(
        [
          f2f({ encounterDate: "2027-02-01" }),
          f2f({ encounterDate: "2026-12-31" }),
          f2f({ encounterDate: null }),
        ],
        SPAN_2027,
      ),
    ).toEqual([]);
  });

  it("includes both span edges and de-duplicates a date", () => {
    expect(
      telehealthF2fDatesRequiringG0679(
        [
          f2f({ encounterDate: "2027-01-31" }),
          f2f({ encounterDate: "2027-01-01", electionPeriodSequence: 4 }),
          f2f({ encounterDate: "2027-01-31", electionPeriodSequence: 5 }),
        ],
        SPAN_2027,
      ),
    ).toEqual(["2027-01-01", "2027-01-31"]);
  });
});

describe("f2f_telehealth_g0679 rule", () => {
  it("is registered in the default registry as a regulatory error rule", () => {
    const rule = createDefaultBillingRegistry().getRule("f2f_telehealth_g0679");
    expect(rule?.severity).toBe("error");
    expect(rule?.regulatoryRequired).toBe(true);
  });

  it("passes when no telehealth encounter is in the span and no G0679 line is present", () => {
    expect(run(ctx2027([f2f({ modality: "in_person" })])).passed).toBe(true);
  });

  it("passes when the telehealth encounter carries its dated G0679/0657 line", () => {
    expect(run(ctx2027([f2f()], [g0679Line()])).passed).toBe(true);
  });

  it("fails when a telehealth encounter dated on/after 2027-01-01 has no G0679 line", () => {
    const r = run(ctx2027([f2f()]));
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("error");
  });

  it("fails when the G0679 line is dated on a different day than the encounter", () => {
    expect(run(ctx2027([f2f()], [g0679Line({ serviceDate: "2027-01-21" })])).passed).toBe(false);
  });

  it("fails when G0679 is reported on a revenue code other than 0657 (BR 14495.3)", () => {
    const r = run(ctx2027([], [g0679Line({ revenueCode: "0651" })]));
    expect(r.passed).toBe(false);
  });

  it("fails when G0679 is dated before 2027-01-01 (BR 14495.1)", () => {
    const base = passingContext();
    const c: ValidationContext = {
      ...base,
      lines: [...base.lines, g0679Line({ serviceDate: "2026-03-20" })],
    };
    expect(run(c).passed).toBe(false);
  });

  it("fails when G0679 is on a TOB other than 81X/82X (BR 14495.2)", () => {
    const r = run(
      ctx2027([f2f()], [g0679Line()], "331" as unknown as ValidationContext["claim"]["tob"]),
    );
    expect(r.passed).toBe(false);
  });

  it("does not require a line for a telehealth encounter before 2027 (claim span in 2026)", () => {
    const base = passingContext();
    const c: ValidationContext = {
      ...base,
      faceToFace: [f2f({ encounterDate: "2026-03-10" })],
    };
    expect(run(c).passed).toBe(true);
  });
});

describe("level_of_care_coherence leaves the G0679 line to f2f_telehealth_g0679", () => {
  it("a G0679 line on revenue code 0657 is not a per-diem revenue-code defect", () => {
    const c = ctx2027([f2f()], [g0679Line()]);
    const r = levelOfCareCoherence.check(c, levelOfCareCoherence.defaultParameters ?? {});
    expect(r.passed).toBe(true);
  });
});
