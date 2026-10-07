// @wardenx/inpatient — GAP-107 unit tests for the D7 IV-overlay additions: the continuous-IV order classifier, the
// rate-unit canonicalizer, the unseeded-drug fallback to the prescriber's bounds, the fail-closed rate/unit
// refusals, and the bedside-check reminder planner.
import { describe, expect, it } from "vitest";
import {
  IV_BEDSIDE_WATCHDOG_TICK_MINUTES,
  buildIvSafetyOverlay,
  evaluateIvPreAdministration,
  isIvContinuousOrder,
  normalizeIvRateUnit,
  planBedsideCheckReminder,
} from "../src/domain/iv-safety/overlay-builder";
import {
  isSeededMedication,
  resolveTitrationWindow,
} from "../src/domain/iv-safety/titration-window-catalog";

describe("isIvContinuousOrder (M12 route iv_continuous or a stated infusion policy)", () => {
  it.each([
    ["iv_continuous", false, true],
    ["IV Continuous", false, true],
    ["continuous-intravenous", false, true],
    ["intravenous", true, true],
    ["intravenous", false, false],
    ["oral", false, false],
    ["iv_push", false, false],
  ])("route %s policy=%s -> %s", (route, hasIvContinuousPolicy, expected) => {
    expect(isIvContinuousOrder({ route, hasIvContinuousPolicy })).toBe(expected);
  });
});

describe("normalizeIvRateUnit", () => {
  it.each([
    ["mg/hr", "mg_per_hour"],
    ["MG / hour", "mg_per_hour"],
    ["mg_per_hour", "mg_per_hour"],
    ["mcg/kg/min", "mcg_per_kg_per_min"],
    ["units/hr", "units_per_hour"],
    ["mL/hr", "ml_per_hour"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizeIvRateUnit(raw)).toBe(expected);
  });

  it("returns null for an unrecognized or absent unit", () => {
    expect(normalizeIvRateUnit("drops/min")).toBeNull();
    expect(normalizeIvRateUnit(null)).toBeNull();
    expect(normalizeIvRateUnit(undefined)).toBeNull();
  });
});

describe("catalog lookup by product name", () => {
  it("matches a seeded drug named inside a longer M12 product name", () => {
    expect(isSeededMedication("Midazolam 100 mg in 0.9% Sodium Chloride")).toBe(true);
    expect(resolveTitrationWindow("Midazolam 100 mg in 0.9% NaCl").maxRate).toBe(10);
    expect(isSeededMedication("Octreotide infusion")).toBe(false);
  });

  it("does not match a catalog key that is only part of another word", () => {
    expect(isSeededMedication("nonmorphinex")).toBe(false);
  });
});

describe("buildIvSafetyOverlay — unseeded drug falls back to the prescriber's bounds", () => {
  it("uses the order's own window (and unit) for a drug the catalog does not seed", () => {
    const o = buildIvSafetyOverlay({
      medicationDisplayName: "octreotide",
      orderPolicy: { minRate: 25, maxRate: 100, rateUnit: "mcg/hr" },
    });
    expect(o.titrationMinRate).toBe(25);
    expect(o.titrationMaxRate).toBe(100);
    expect(o.isSedationClass).toBe(false);
  });

  it("keeps the catalog window for a seeded drug even when the order states a wider one", () => {
    const o = buildIvSafetyOverlay({
      medicationDisplayName: "midazolam",
      orderPolicy: { minRate: 0, maxRate: 500, rateUnit: "mg/hr" },
    });
    expect(o.titrationMaxRate).toBe(10);
    expect(o.dualWitnessRequired).toBe(true);
  });

  it("ignores an inverted or non-finite order policy", () => {
    const o = buildIvSafetyOverlay({
      medicationDisplayName: "octreotide",
      orderPolicy: { minRate: 9, maxRate: 1 },
    });
    expect(o.titrationMaxRate).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("evaluateIvPreAdministration — fail-closed rate handling", () => {
  const overlay = buildIvSafetyOverlay({ medicationDisplayName: "midazolam" });
  const ok = {
    witnessTokenPresent: true,
    hoursSinceContinuousStart: 0,
    minutesSinceLastBedsideCheck: 0,
  };

  it("refuses an administration that states no rate", () => {
    expect(evaluateIvPreAdministration(overlay, { ...ok, proposedRate: null })).toMatchObject({
      allowed: false,
      code: "IV_RATE_OUTSIDE_TITRATION_WINDOW",
      statusCode: 412,
    });
    expect(evaluateIvPreAdministration(overlay, { ...ok, proposedRate: Number.NaN }).allowed).toBe(
      false,
    );
  });

  it("refuses a rate entered in a different (or unrecognized) unit; accepts the same unit in any spelling", () => {
    expect(
      evaluateIvPreAdministration(overlay, { ...ok, proposedRate: 2, proposedRateUnit: "mL/hr" })
        .allowed,
    ).toBe(false);
    expect(
      evaluateIvPreAdministration(overlay, { ...ok, proposedRate: 2, proposedRateUnit: "gtt/min" })
        .allowed,
    ).toBe(false);
    expect(
      evaluateIvPreAdministration(overlay, { ...ok, proposedRate: 2, proposedRateUnit: "mg/hr" })
        .allowed,
    ).toBe(true);
    expect(evaluateIvPreAdministration(overlay, { ...ok, proposedRate: 2 }).allowed).toBe(true);
  });

  it("checks in spec order: window, then witness, then duration, then bedside check", () => {
    const all = {
      proposedRate: 99,
      witnessTokenPresent: false,
      hoursSinceContinuousStart: 999,
      minutesSinceLastBedsideCheck: 999,
    };
    expect(evaluateIvPreAdministration(overlay, all).code).toBe("IV_RATE_OUTSIDE_TITRATION_WINDOW");
    expect(evaluateIvPreAdministration(overlay, { ...all, proposedRate: 2 }).code).toBe(
      "IV_DUAL_WITNESS_REQUIRED",
    );
    expect(
      evaluateIvPreAdministration(overlay, { ...all, proposedRate: 2, witnessTokenPresent: true })
        .code,
    ).toBe("IV_MAX_CONTINUOUS_DURATION_REACHED");
    expect(
      evaluateIvPreAdministration(overlay, {
        ...all,
        proposedRate: 2,
        witnessTokenPresent: true,
        hoursSinceContinuousStart: 1,
      }).code,
    ).toBe("IV_BEDSIDE_CHECK_OVERDUE");
  });
});

describe("evaluateIvPreAdministration — an overdue bedside check does not block a titration", () => {
  const overlay = buildIvSafetyOverlay({ medicationDisplayName: "midazolam" });
  const ready = {
    proposedRate: 2,
    witnessTokenPresent: true,
    hoursSinceContinuousStart: 1,
    minutesSinceLastBedsideCheck: 999,
  };

  it("allows a rate change while the check is overdue, but still refuses a non-titration event", () => {
    expect(evaluateIvPreAdministration(overlay, { ...ready, isTitration: true }).allowed).toBe(
      true,
    );
    expect(evaluateIvPreAdministration(overlay, { ...ready, isTitration: false }).code).toBe(
      "IV_BEDSIDE_CHECK_OVERDUE",
    );
    expect(evaluateIvPreAdministration(overlay, ready).code).toBe("IV_BEDSIDE_CHECK_OVERDUE");
  });

  it("still enforces window, witness and max duration on a titration", () => {
    const t = { ...ready, isTitration: true };
    expect(evaluateIvPreAdministration(overlay, { ...t, proposedRate: 99 }).code).toBe(
      "IV_RATE_OUTSIDE_TITRATION_WINDOW",
    );
    expect(evaluateIvPreAdministration(overlay, { ...t, witnessTokenPresent: false }).code).toBe(
      "IV_DUAL_WITNESS_REQUIRED",
    );
    expect(
      evaluateIvPreAdministration(overlay, { ...t, hoursSinceContinuousStart: 999 }).code,
    ).toBe("IV_MAX_CONTINUOUS_DURATION_REACHED");
  });
});

describe("planBedsideCheckReminder — one alert per overdue interval, not one per tick", () => {
  const interval = 60;
  const plan = (minutesSinceLastCheck: number) =>
    planBedsideCheckReminder({ intervalMinutes: interval, minutesSinceLastCheck });

  it("is quiet while the check is current, including exactly at the interval", () => {
    expect(plan(0).overdue).toBe(false);
    expect(plan(59).notify).toBe(false);
    expect(plan(60).overdue).toBe(false);
    expect(plan(60).notify).toBe(false);
  });

  it("notifies on the single tick that first crosses the interval", () => {
    const ticks = [60, 65, 70, 75].map(plan);
    expect(ticks.map((t) => t.notify)).toEqual([false, true, false, false]);
    expect(plan(65)).toMatchObject({ overdue: true, missedIntervals: 1, minutesOverdue: 5 });
  });

  it("re-notifies once per further whole interval (a recurring reminder)", () => {
    expect(plan(125)).toMatchObject({ notify: true, missedIntervals: 2 });
    expect(plan(130).notify).toBe(false);
    expect(plan(185)).toMatchObject({ notify: true, missedIntervals: 3 });
  });

  it("every 5-minute tick lands in exactly one notify window", () => {
    let notifications = 0;
    for (let m = 0; m <= 600; m += IV_BEDSIDE_WATCHDOG_TICK_MINUTES) {
      if (plan(m).notify) notifications++;
    }
    expect(notifications).toBe(9); // boundaries at 60..540 -> 9 reminders in 10 hours (600 itself is a boundary)
  });
});
