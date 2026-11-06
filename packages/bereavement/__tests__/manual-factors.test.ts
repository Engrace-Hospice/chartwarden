// @chartwarden/bereavement — ADR-0109 D5: human-entered risk factors ride the evidence with a "true wins" merge.
import type { BereavementRiskFactorInputs } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  BEREAVEMENT_RISK_FACTOR_NAMES,
  RISK_FACTOR_WIRE_KEYS,
  deriveRiskFactors,
  factorsFromWire,
  factorsToWire,
  mergeFactorValue,
  mergeManualFactors,
} from "../src";

const ALL_UNKNOWN: BereavementRiskFactorInputs = {
  ambivalentRelationship: "unknown",
  suddenUnexpectedDeath: "unknown",
  priorUnresolvedLoss: "unknown",
  preExistingMentalHealth: "unknown",
  socialIsolation: "unknown",
  financialStrain: "unknown",
  primaryCaregiverRole: "unknown",
  activeSubstanceUse: "unknown",
};

const evidence = (over: Record<string, unknown> = {}) => ({
  mswAssessed: false,
  mswFactors: [],
  ppsPoints: null,
  roster: { isPrimaryCaregiver: null, enrolledSurvivorCount: null },
  sudDisclosureAllowed: true,
  ...over,
});

describe("mergeFactorValue (true wins, then a documented false beats unknown)", () => {
  it.each([
    [true, false, true],
    [false, true, true],
    [true, "unknown", true],
    ["unknown", true, true],
    [false, "unknown", false],
    ["unknown", false, false],
    [false, false, false],
    ["unknown", "unknown", "unknown"],
  ] as const)("merge(%s, %s) = %s", (a, b, expected) => {
    expect(mergeFactorValue(a, b)).toBe(expected);
  });
});

describe("mergeManualFactors", () => {
  it("never un-sets a true, whichever side holds it", () => {
    const merged = mergeManualFactors({ financialStrain: true }, { financialStrain: false });
    expect(merged.financialStrain).toBe(true);
  });

  it("keeps keys only one side names", () => {
    const merged = mergeManualFactors({ socialIsolation: false }, { priorUnresolvedLoss: true });
    expect(merged).toEqual({ socialIsolation: false, priorUnresolvedLoss: true });
  });

  it("treats undefined inputs as empty and returns a fresh object", () => {
    const prior = { financialStrain: true } as const;
    const merged = mergeManualFactors(prior, undefined);
    expect(merged).toEqual(prior);
    expect(merged).not.toBe(prior);
    expect(mergeManualFactors(undefined, undefined)).toEqual({});
  });
});

describe("deriveRiskFactors with manualFactors", () => {
  it("fills an unknown slot with a human-documented value", () => {
    const { factors } = deriveRiskFactors(
      evidence({ manualFactors: { financialStrain: true, socialIsolation: false } }),
    );
    expect(factors.financialStrain).toBe(true);
    expect(factors.socialIsolation).toBe(false);
    expect(factors.priorUnresolvedLoss).toBe("unknown");
  });

  it("never lowers a derived true (an MSW finding survives a manual false)", () => {
    const { factors } = deriveRiskFactors(
      evidence({
        mswAssessed: true,
        mswFactors: [{ factor: "financial_strain" }] as never,
        manualFactors: { financialStrain: false },
      }),
    );
    expect(factors.financialStrain).toBe(true);
  });

  it("ignores a manual substance-use value when disclosure is not allowed", () => {
    const { factors, redactedCategories } = deriveRiskFactors(
      evidence({ sudDisclosureAllowed: false, manualFactors: { activeSubstanceUse: true } }),
    );
    expect(factors.activeSubstanceUse).toBe("unknown");
    expect(redactedCategories).toEqual(["sud"]);
  });

  it("accepts a manual substance-use value when disclosure is allowed", () => {
    const { factors } = deriveRiskFactors(
      evidence({ sudDisclosureAllowed: true, manualFactors: { activeSubstanceUse: true } }),
    );
    expect(factors.activeSubstanceUse).toBe(true);
  });

  it("is a no-op without manual factors", () => {
    expect(deriveRiskFactors(evidence()).factors).toEqual(ALL_UNKNOWN);
  });
});

describe("wire key mapping", () => {
  it("covers every rubric factor exactly once", () => {
    expect(Object.values(RISK_FACTOR_WIRE_KEYS).sort()).toEqual(
      [...BEREAVEMENT_RISK_FACTOR_NAMES].sort(),
    );
  });

  it("round-trips the eight keys", () => {
    const wire = factorsToWire({ ...ALL_UNKNOWN, preExistingMentalHealth: true });
    expect(wire.preexisting_mental_health).toBe(true);
    expect(factorsFromWire(wire)).toEqual({ ...ALL_UNKNOWN, preExistingMentalHealth: true });
  });

  it("only maps keys it was given (a partial wire object stays partial)", () => {
    expect(factorsFromWire({ social_isolation: false })).toEqual({ socialIsolation: false });
  });
});
