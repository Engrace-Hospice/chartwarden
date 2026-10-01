// F-212 — the tenant-entered sequestration policy's PURE entry rules: plausibility band, reason rule, effective window.
import { describe, expect, it } from "vitest";
import {
  SEQUESTRATION_EARLIEST_EFFECTIVE_FROM,
  type SequestrationPolicyEntry,
  validateSequestrationPolicyEntry,
} from "../src";

const TODAY = "2026-09-29";
const GOOD: SequestrationPolicyEntry = { percentage: "2.00", effectiveFrom: "2022-07-01" };
const check = (over: Partial<SequestrationPolicyEntry> = {}, today = TODAY) =>
  validateSequestrationPolicyEntry({ ...GOOD, ...over }, today);

describe("validateSequestrationPolicyEntry - percentage band", () => {
  it("accepts the standard 2% open-ended and reports effectiveTo null", () => {
    expect(check()).toEqual({ ok: true, effectiveTo: null });
    expect(check({ percentage: "2" })).toEqual({ ok: true, effectiveTo: null });
    expect(check({ percentage: "2.0000" })).toEqual({ ok: true, effectiveTo: null });
  });

  it("accepts the COVID-moratorium 0% and the 1% step-down when a reason documents them", () => {
    expect(
      check({
        percentage: "0.00",
        effectiveFrom: "2020-05-01",
        effectiveTo: "2022-03-31",
        setReason: "CARES Act moratorium",
      }).ok,
    ).toBe(true);
    expect(
      check({
        percentage: "1.00",
        effectiveFrom: "2022-04-01",
        effectiveTo: "2022-06-30",
        setReason: "step-down",
      }).ok,
    ).toBe(true);
  });

  it("requires a reason for anything other than 2% so a stray 0 cannot silently zero the withhold", () => {
    const r = check({ percentage: "0.00" });
    expect(r).toMatchObject({ ok: false });
    expect((r as { errors: readonly string[] }).errors.join(" ")).toMatch(/requires a setReason/);
    expect(check({ percentage: "0", setReason: "   " }).ok).toBe(false);
  });

  it.each([
    ["dollars-style 200", "200"],
    ["a whole 20", "20"],
    ["above the statutory cap", "2.01"],
    ["negative", "-1"],
    ["not a number", "two"],
    ["empty", ""],
    ["comma decimal", "2,00"],
    ["too many fractional digits", "1.23456"],
  ])("rejects %s", (_n, percentage) => {
    expect(check({ percentage, setReason: "x" }).ok).toBe(false);
  });
});

describe("validateSequestrationPolicyEntry - effective window", () => {
  it("rejects a start before sequestration first applied", () => {
    expect(check({ effectiveFrom: "2013-03-31" }).ok).toBe(false);
    expect(check({ effectiveFrom: SEQUESTRATION_EARLIEST_EFFECTIVE_FROM }).ok).toBe(true);
  });

  it("rejects effectiveTo before effectiveFrom and accepts a one-day window", () => {
    expect(check({ effectiveTo: "2022-06-30" }).ok).toBe(false);
    expect(check({ effectiveTo: "2022-07-01" })).toEqual({ ok: true, effectiveTo: "2022-07-01" });
  });

  it("allows a past or current start (tenants must cover service dates that already happened)", () => {
    expect(check({ effectiveFrom: TODAY }).ok).toBe(true);
    expect(check({ effectiveFrom: "2023-01-01" }).ok).toBe(true);
  });

  it("guards a start more than two years ahead (year typo) but allows the near future", () => {
    expect(check({ effectiveFrom: "2027-10-01" }).ok).toBe(true);
    expect(check({ effectiveFrom: "2062-10-01" }).ok).toBe(false);
  });

  it("rejects malformed dates", () => {
    expect(check({ effectiveFrom: "07/01/2022" }).ok).toBe(false);
    expect(check({ effectiveTo: "2022-13-40" }).ok).toBe(false);
  });

  it("reports every error at once", () => {
    const r = check({ percentage: "20", effectiveFrom: "2001-01-01" });
    expect(r.ok).toBe(false);
    expect((r as { errors: readonly string[] }).errors.length).toBeGreaterThanOrEqual(2);
  });
});
