import { COMMERCIAL_ELIGIBILITY_FRESHNESS_RULE_ID } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { evaluateEligibilityFreshness } from "./freshness";

const NOW = "2026-10-25T12:00:00.000Z";
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

describe("evaluateEligibilityFreshness", () => {
  it("passes an active check inside the window", () => {
    const f = evaluateEligibilityFreshness({
      latest: { outcome: "active", checkedAt: daysAgo(3) },
      policy: "warn",
      maxAgeDays: 30,
      now: NOW,
    });
    expect(f).toMatchObject({
      status: "fresh",
      severity: "pass",
      ruleId: COMMERCIAL_ELIGIBILITY_FRESHNESS_RULE_ID,
    });
    expect(f.evidence).toMatchObject({
      ageDays: 3,
      maxAgeDays: 30,
      policy: "warn",
      outcome: "active",
    });
  });

  it("treats the last day of the window as fresh and the next day as stale", () => {
    const base = { policy: "warn", maxAgeDays: 30, now: NOW } as const;
    expect(
      evaluateEligibilityFreshness({
        ...base,
        latest: { outcome: "active", checkedAt: daysAgo(30) },
      }).status,
    ).toBe("fresh");
    expect(
      evaluateEligibilityFreshness({
        ...base,
        latest: { outcome: "active", checkedAt: daysAgo(31) },
      }).status,
    ).toBe("stale");
  });

  it("a missing check is a warning under the default policy and a block under the block policy", () => {
    const base = { latest: null, maxAgeDays: 30, now: NOW } as const;
    expect(evaluateEligibilityFreshness({ ...base, policy: "warn" })).toMatchObject({
      status: "missing",
      severity: "warning",
    });
    expect(evaluateEligibilityFreshness({ ...base, policy: "block" })).toMatchObject({
      status: "missing",
      severity: "block",
    });
  });

  it("a stale check follows the policy", () => {
    const latest = { outcome: "active", checkedAt: daysAgo(90) } as const;
    expect(
      evaluateEligibilityFreshness({ latest, policy: "warn", maxAgeDays: 30, now: NOW }).severity,
    ).toBe("warning");
    expect(
      evaluateEligibilityFreshness({ latest, policy: "block", maxAgeDays: 30, now: NOW }).severity,
    ).toBe("block");
  });

  it("a fresh inactive answer blocks whatever the policy says (the payer said not covered)", () => {
    const f = evaluateEligibilityFreshness({
      latest: { outcome: "inactive", checkedAt: daysAgo(1) },
      policy: "warn",
      maxAgeDays: 30,
      now: NOW,
    });
    expect(f).toMatchObject({ status: "inactive", severity: "block" });
  });

  it("a fresh unknown answer cannot be relied on, so it follows the policy", () => {
    const latest = { outcome: "unknown", checkedAt: daysAgo(1) } as const;
    expect(
      evaluateEligibilityFreshness({ latest, policy: "warn", maxAgeDays: 30, now: NOW }),
    ).toMatchObject({ status: "unverified", severity: "warning" });
    expect(
      evaluateEligibilityFreshness({ latest, policy: "block", maxAgeDays: 30, now: NOW }).severity,
    ).toBe("block");
  });

  it("an unreadable timestamp fails closed to the policy severity, never to pass", () => {
    const f = evaluateEligibilityFreshness({
      latest: { outcome: "active", checkedAt: "not-a-date" },
      policy: "block",
      maxAgeDays: 30,
      now: NOW,
    });
    expect(f).toMatchObject({ status: "stale", severity: "block" });
  });

  it("a check dated in the future (clock skew) counts as age 0, not as negative age", () => {
    const f = evaluateEligibilityFreshness({
      latest: { outcome: "active", checkedAt: new Date(Date.parse(NOW) + 3_600_000).toISOString() },
      policy: "warn",
      maxAgeDays: 30,
      now: NOW,
    });
    expect(f.evidence.ageDays).toBe(0);
    expect(f.severity).toBe("pass");
  });

  it("rejects a max age outside 1..365 as a caller bug", () => {
    for (const maxAgeDays of [0, -1, 366, 1.5, Number.NaN]) {
      expect(() =>
        evaluateEligibilityFreshness({ latest: null, policy: "warn", maxAgeDays, now: NOW }),
      ).toThrow(RangeError);
    }
  });

  it("carries no member id: the evidence has ids-free, value-free fields only", () => {
    const f = evaluateEligibilityFreshness({
      latest: { outcome: "active", checkedAt: daysAgo(2) },
      policy: "warn",
      maxAgeDays: 30,
      now: NOW,
    });
    expect(Object.keys(f.evidence).sort()).toEqual([
      "ageDays",
      "checkedAt",
      "maxAgeDays",
      "outcome",
      "policy",
    ]);
  });
});
