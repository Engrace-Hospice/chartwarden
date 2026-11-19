import { describe, expect, it } from "vitest";
import {
  dateTime,
  daysUntil,
  dueLabel,
  humanize,
  shortDate,
  shortId,
  toneOf,
} from "../wire-format";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-11-18T12:00:00Z");
const inDays = (days: number): string => new Date(NOW + days * DAY_MS).toISOString();

describe("toneOf", () => {
  const map = { active: "success", failed: "error" } as const;

  it("returns the mapped tone for a known wire value", () => {
    expect(toneOf(map, "failed")).toBe("error");
  });

  it("falls back to neutral for an unknown, empty, null or undefined key", () => {
    expect(toneOf(map, "mystery")).toBe("neutral");
    expect(toneOf(map, "")).toBe("neutral");
    expect(toneOf(map, null)).toBe("neutral");
    expect(toneOf(map, undefined)).toBe("neutral");
  });
});

describe("humanize", () => {
  it("title-cases a snake or upper wire enum", () => {
    expect(humanize("gate_engaged")).toBe("Gate engaged");
    expect(humanize("ACTIVE")).toBe("Active");
  });

  it("renders an em dash for a missing value", () => {
    expect(humanize(null)).toBe("—");
    expect(humanize(undefined)).toBe("—");
    expect(humanize("")).toBe("—");
  });
});

describe("date and id labels", () => {
  it("shortDate keeps the YYYY-MM-DD prefix", () => {
    expect(shortDate("2026-11-18T10:20:30Z")).toBe("2026-11-18");
    expect(shortDate(null)).toBe("—");
  });

  it("dateTime appends HH:MM to the date", () => {
    expect(dateTime("2026-11-18T10:20:30Z")).toBe("2026-11-18 10:20");
    expect(dateTime(undefined)).toBe("—");
  });

  it("shortId keeps the first eight characters", () => {
    expect(shortId("12345678-aaaa-bbbb")).toBe("12345678");
    expect(shortId("")).toBe("—");
  });
});

describe("daysUntil", () => {
  it("counts whole days forward and backward from now", () => {
    expect(daysUntil(inDays(3), NOW)).toBe(3);
    expect(daysUntil(inDays(-1), NOW)).toBe(-1);
  });

  it("floors a partial day toward the past", () => {
    expect(daysUntil(inDays(1.5), NOW)).toBe(1);
    expect(daysUntil(inDays(-0.5), NOW)).toBe(-1);
  });

  it("returns null for a missing or unparseable instant", () => {
    expect(daysUntil(null, NOW)).toBeNull();
    expect(daysUntil("not-a-date", NOW)).toBeNull();
  });
});

describe("dueLabel", () => {
  it("labels today, future and overdue instants with correct pluralisation", () => {
    expect(dueLabel(inDays(0), NOW)).toBe("due today");
    expect(dueLabel(inDays(1), NOW)).toBe("in 1 day");
    expect(dueLabel(inDays(3), NOW)).toBe("in 3 days");
    expect(dueLabel(inDays(-1), NOW)).toBe("1 day overdue");
    expect(dueLabel(inDays(-2), NOW)).toBe("2 days overdue");
  });

  it("renders an em dash when there is no date", () => {
    expect(dueLabel(null, NOW)).toBe("—");
  });
});
