// The pure closure rules the supervisor board and the policy screen share: the bounds mirror the server's, and a row's timing is read
// from what the server's clock decided (never recomputed from the clock start). Synthetic values only.
import { describe, expect, it } from "vitest";
import {
  OVERRIDE_MIN_REASON_CHARS,
  countByStage,
  formatHours,
  isClosureMode,
  isGrantActive,
  needsBlockConfirmation,
  parseOverrideHours,
  parseThresholdHours,
  reasonLength,
  timingLabel,
} from "../closure-model";

const NOW = new Date("2026-11-18T12:00:00.000Z");

describe("parseOverrideHours", () => {
  it.each([
    ["1", 1],
    ["4", 4],
    [" 24 ", 24],
  ])("accepts %j as %i", (text, expected) => {
    expect(parseOverrideHours(text)).toBe(expected);
  });

  it.each(["0", "25", "-1", "2.5", "", "abc", "4h"])("refuses %j", (text) => {
    expect(parseOverrideHours(text)).toBeNull();
  });
});

describe("parseThresholdHours", () => {
  it.each([
    ["1", 1],
    ["24", 24],
    ["168", 168],
  ])("accepts %j as %i", (text, expected) => {
    expect(parseThresholdHours(text)).toBe(expected);
  });

  it.each(["0", "169", "24.5", "", "one day"])("refuses %j", (text) => {
    expect(parseThresholdHours(text)).toBeNull();
  });
});

describe("reasonLength", () => {
  it("counts the trimmed reason, as the server does", () => {
    expect(reasonLength(`   ${"x".repeat(OVERRIDE_MIN_REASON_CHARS)}   `)).toBe(
      OVERRIDE_MIN_REASON_CHARS,
    );
    expect(reasonLength("      ")).toBe(0);
  });
});

describe("timingLabel", () => {
  it("counts an at-risk note down to its deadline", () => {
    const deadline = new Date(NOW.getTime() + 3.5 * 3_600_000).toISOString();
    expect(timingLabel("at_risk", 0, deadline, NOW)).toBe("Due in 3h");
  });

  it("never shows a negative countdown when the clock has just passed the deadline", () => {
    const deadline = new Date(NOW.getTime() - 60_000).toISOString();
    expect(timingLabel("at_risk", 0, deadline, NOW)).toBe("Due in <1h");
  });

  it("shows the server's hours overdue for an overdue or escalated note", () => {
    const deadline = new Date(NOW.getTime() - 14 * 3_600_000).toISOString();
    expect(timingLabel("overdue", 2.9, deadline, NOW)).toBe("2h overdue");
    expect(timingLabel("escalated", 14, deadline, NOW)).toBe("14h overdue");
  });
});

describe("formatHours", () => {
  it("floors to whole hours and floors the first hour to <1h", () => {
    expect(formatHours(0)).toBe("<1h");
    expect(formatHours(0.99)).toBe("<1h");
    expect(formatHours(1)).toBe("1h");
    expect(formatHours(1.99)).toBe("1h");
  });
});

describe("isGrantActive", () => {
  const base = { expiresAt: new Date(NOW.getTime() + 1000).toISOString(), revokedAt: null };

  it("is active strictly before the expiry", () => {
    expect(isGrantActive(base, NOW)).toBe(true);
    expect(isGrantActive({ ...base, expiresAt: NOW.toISOString() }, NOW)).toBe(false);
  });

  it("is not active once revoked, even before the expiry", () => {
    expect(isGrantActive({ ...base, revokedAt: NOW.toISOString() }, NOW)).toBe(false);
  });
});

describe("countByStage", () => {
  it("counts each stage and tolerates an empty list", () => {
    expect(countByStage([])).toEqual({ escalated: 0, overdue: 0, atRisk: 0 });
    expect(
      countByStage([
        { stage: "escalated" },
        { stage: "overdue" },
        { stage: "overdue" },
        { stage: "at_risk" },
      ]),
    ).toEqual({ escalated: 1, overdue: 2, atRisk: 1 });
  });
});

describe("needsBlockConfirmation", () => {
  const warn24 = { mode: "warn", thresholdHours: 24 } as const;
  const block24 = { mode: "block", thresholdHours: 24 } as const;

  it("asks before blocking is turned on", () => {
    expect(needsBlockConfirmation(warn24, block24)).toBe(true);
    expect(needsBlockConfirmation({ mode: "off", thresholdHours: 24 }, block24)).toBe(true);
  });

  it("asks before the deadline is shortened while blocking is on", () => {
    expect(needsBlockConfirmation(block24, { mode: "block", thresholdHours: 12 })).toBe(true);
  });

  it("does not ask when nobody becomes limited", () => {
    expect(needsBlockConfirmation(block24, { mode: "block", thresholdHours: 48 })).toBe(false);
    expect(needsBlockConfirmation(block24, block24)).toBe(false);
    expect(needsBlockConfirmation(block24, { mode: "warn", thresholdHours: 12 })).toBe(false);
    expect(needsBlockConfirmation(warn24, { mode: "off", thresholdHours: 24 })).toBe(false);
  });
});

describe("isClosureMode", () => {
  it("accepts only the three modes", () => {
    expect(["off", "warn", "block"].every(isClosureMode)).toBe(true);
    expect(isClosureMode("enforce")).toBe(false);
  });
});
