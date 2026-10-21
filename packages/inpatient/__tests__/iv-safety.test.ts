// @chartwarden/inpatient — M37-T05 unit tests for the §2.6 IV-continuous safety overlay (closes the M13 deferral).
import { describe, expect, it } from "vitest";
import {
  IV_BEDSIDE_CHECK_NON_SEDATION_MINUTES,
  IV_BEDSIDE_CHECK_SEDATION_MINUTES,
  IV_MAX_CONTINUOUS_DURATION_FLOOR_HOURS,
  buildIvSafetyOverlay,
  evaluateIvPreAdministration,
} from "../src/domain/iv-safety/overlay-builder";
import {
  isSedationClassMedication,
  resolveTitrationWindow,
} from "../src/domain/iv-safety/titration-window-catalog";

describe("titration catalog + sedation classifier (§2.6)", () => {
  it("classifies known sedation drips and non-sedation analgesics", () => {
    expect(isSedationClassMedication("Midazolam")).toBe(true);
    expect(isSedationClassMedication("propofol")).toBe(true);
    expect(isSedationClassMedication("Dexmedetomidine drip")).toBe(true); // substring match, unseeded exact name
    expect(isSedationClassMedication("morphine")).toBe(false);
  });

  it("resolves a seeded window and a conservative default for the unknown", () => {
    expect(resolveTitrationWindow("midazolam").maxRate).toBe(10);
    const unknown = resolveTitrationWindow("some-novel-agent");
    expect(unknown.isSedationClass).toBe(false);
    expect(unknown.maxRate).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("overlay builder (§2.6 D7)", () => {
  it("builds a sedation-class overlay with dual-witness + q-1h bedside cadence", () => {
    const o = buildIvSafetyOverlay({ medicationDisplayName: "midazolam" });
    expect(o.isSedationClass).toBe(true);
    expect(o.dualWitnessRequired).toBe(true);
    expect(o.bedsideCheckIntervalMinutes).toBe(IV_BEDSIDE_CHECK_SEDATION_MINUTES);
    expect(o.maxContinuousDurationHours).toBe(IV_MAX_CONTINUOUS_DURATION_FLOOR_HOURS);
  });

  it("builds a non-sedation overlay with q-2h cadence and honors an M12 max-duration", () => {
    const o = buildIvSafetyOverlay({ medicationDisplayName: "morphine", m12MaxDurationHours: 72 });
    expect(o.dualWitnessRequired).toBe(false);
    expect(o.bedsideCheckIntervalMinutes).toBe(IV_BEDSIDE_CHECK_NON_SEDATION_MINUTES);
    expect(o.maxContinuousDurationHours).toBe(72);
  });
});

describe("M13 pre-administration gate (§2.6 — the 4 checks)", () => {
  const overlay = buildIvSafetyOverlay({ medicationDisplayName: "midazolam" }); // sedation: window 0.5–10 mg/hr

  const ok = {
    proposedRate: 5,
    witnessTokenPresent: true,
    hoursSinceContinuousStart: 10,
    minutesSinceLastBedsideCheck: 30,
  };

  it("allows an in-window, dual-witnessed, on-time administration", () => {
    expect(evaluateIvPreAdministration(overlay, ok)).toEqual({ allowed: true });
  });

  it("denies a rate outside the titration window", () => {
    expect(evaluateIvPreAdministration(overlay, { ...ok, proposedRate: 20 })).toMatchObject({
      allowed: false,
      code: "IV_RATE_OUTSIDE_TITRATION_WINDOW",
      statusCode: 412,
    });
  });

  it("denies a sedation drip without a dual-witness token", () => {
    expect(
      evaluateIvPreAdministration(overlay, { ...ok, witnessTokenPresent: false }),
    ).toMatchObject({
      allowed: false,
      code: "IV_DUAL_WITNESS_REQUIRED",
    });
  });

  it("denies once the max continuous duration is exceeded", () => {
    expect(
      evaluateIvPreAdministration(overlay, { ...ok, hoursSinceContinuousStart: 200 }),
    ).toMatchObject({
      allowed: false,
      code: "IV_MAX_CONTINUOUS_DURATION_REACHED",
    });
  });

  it("denies a bedside check overdue past the interval", () => {
    expect(
      evaluateIvPreAdministration(overlay, { ...ok, minutesSinceLastBedsideCheck: 90 }),
    ).toMatchObject({
      allowed: false,
      code: "IV_BEDSIDE_CHECK_OVERDUE",
    });
  });

  it("checks rate before witness (deterministic ordering)", () => {
    // Both a bad rate and a missing witness: the rate check wins.
    expect(
      evaluateIvPreAdministration(overlay, { ...ok, proposedRate: 99, witnessTokenPresent: false })
        .code,
    ).toBe("IV_RATE_OUTSIDE_TITRATION_WINDOW");
  });
});
