// GAP-032 — M11 verbal pre-expiry tiers, lab-results-overdue expected-by, and completion-watcher planners.
import { describe, expect, it } from "vitest";
import {
  completionCriterionMet,
  expectedResultsBy,
  hoursUntil,
  planVerbalPreExpiry,
} from "../src/modules/11-orders/order-sweeps";

const at = (iso: string) => new Date(iso);

describe("planVerbalPreExpiry", () => {
  const deadline = at("2026-10-07T00:00:00.000Z");
  it("emits nothing while more than 12h remain", () => {
    expect(planVerbalPreExpiry(deadline, at("2026-10-06T11:00:00.000Z"), [])).toBeNull();
  });
  it("emits the 12h (medium) tier once inside 12h", () => {
    const plan = planVerbalPreExpiry(deadline, at("2026-10-06T13:00:00.000Z"), []);
    expect(plan).toEqual({ tier: "12h", severity: "medium", markTiers: ["12h"] });
  });
  it("does not re-emit a tier already alerted", () => {
    expect(planVerbalPreExpiry(deadline, at("2026-10-06T13:00:00.000Z"), ["12h"])).toBeNull();
  });
  it("emits the 2h (high) tier once inside 2h even when 12h was never alerted, marking both", () => {
    const plan = planVerbalPreExpiry(deadline, at("2026-10-06T23:00:00.000Z"), []);
    expect(plan).toEqual({ tier: "2h", severity: "high", markTiers: ["12h", "2h"] });
  });
  it("emits 2h after 12h was alerted", () => {
    const plan = planVerbalPreExpiry(deadline, at("2026-10-06T22:30:00.000Z"), ["12h"]);
    expect(plan).toEqual({ tier: "2h", severity: "high", markTiers: ["2h"] });
  });
  it("leaves a window already past its deadline to the expiry worker", () => {
    expect(planVerbalPreExpiry(deadline, at("2026-10-07T00:00:00.000Z"), [])).toBeNull();
  });
});

describe("hoursUntil", () => {
  it("rounds to one decimal and never negative", () => {
    expect(hoursUntil(at("2026-10-07T00:00:00.000Z"), at("2026-10-06T22:30:00.000Z"))).toBe(1.5);
    expect(hoursUntil(at("2026-10-07T00:00:00.000Z"), at("2026-10-08T00:00:00.000Z"))).toBe(0);
  });
});

describe("expectedResultsBy (D18)", () => {
  const signed = at("2026-10-06T00:00:00.000Z");
  it("stat 1h, asap 4h, routine 24h after signature", () => {
    expect(expectedResultsBy("stat", signed).toISOString()).toBe("2026-10-06T01:00:00.000Z");
    expect(expectedResultsBy("asap", signed).toISOString()).toBe("2026-10-06T04:00:00.000Z");
    expect(expectedResultsBy("routine", signed).toISOString()).toBe("2026-10-07T00:00:00.000Z");
  });
  it("falls back to 24h for an unknown priority", () => {
    expect(expectedResultsBy("weird", signed).toISOString()).toBe("2026-10-07T00:00:00.000Z");
  });
});

describe("completionCriterionMet (D8 / D17)", () => {
  const none = { supplyDelivered: false, recertPeriodLive: false, locPeriodExists: false };
  it("completes supply and comfort_kit orders once M21 delivered", () => {
    expect(completionCriterionMet("supply", { ...none, supplyDelivered: true })).toBe(true);
    expect(completionCriterionMet("comfort_kit", { ...none, supplyDelivered: true })).toBe(true);
    expect(completionCriterionMet("supply", none)).toBe(false);
  });
  it("completes a recertification order once its benefit period is live", () => {
    expect(completionCriterionMet("recertification", { ...none, recertPeriodLive: true })).toBe(
      true,
    );
    expect(completionCriterionMet("recertification", none)).toBe(false);
  });
  it("completes a level_of_care_change order once the LOC period it triggered exists", () => {
    expect(completionCriterionMet("level_of_care_change", { ...none, locPeriodExists: true })).toBe(
      true,
    );
  });
  it("never auto-completes labs (D17 clinician review) or dme (rental close-out)", () => {
    const all = { supplyDelivered: true, recertPeriodLive: true, locPeriodExists: true };
    expect(completionCriterionMet("lab", all)).toBe(false);
    expect(completionCriterionMet("dme", all)).toBe(false);
    expect(completionCriterionMet("ancillary_service", all)).toBe(false);
  });
});
