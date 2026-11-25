import { describe, expect, it } from "vitest";
import {
  LATE_ENTRY_REASON_MIN_CHARS,
  LATE_ENTRY_REASON_TIERS,
  LATE_ENTRY_TIER_DAY_CEILINGS,
  calendarDaysBetween,
  lateEntryTierForDaysLate,
} from "../src/late-entry";

describe("calendarDaysBetween", () => {
  it("counts whole calendar days, negative when the end precedes the start", () => {
    expect(calendarDaysBetween("2026-11-17", "2026-11-17")).toBe(0);
    expect(calendarDaysBetween("2026-11-17", "2026-11-24")).toBe(7);
    expect(calendarDaysBetween("2026-11-24", "2026-11-17")).toBe(-7);
  });

  it("is not thrown by a daylight-saving change between the two dates", () => {
    expect(calendarDaysBetween("2026-03-07", "2026-03-09")).toBe(2);
    expect(calendarDaysBetween("2026-10-31", "2026-11-02")).toBe(2);
  });
});

describe("lateEntryTierForDaysLate", () => {
  it.each([
    [0, "normal"],
    [1, "normal"],
    [2, "late_entry"],
    [3, "late_entry"],
    [4, "significant_late_entry"],
    [14, "significant_late_entry"],
    [15, "administrative_override"],
    [400, "administrative_override"],
  ])("%i days late is %s", (days, tier) => {
    expect(lateEntryTierForDaysLate(days)).toBe(tier);
  });

  it("bins on the shared ceilings", () => {
    expect(lateEntryTierForDaysLate(LATE_ENTRY_TIER_DAY_CEILINGS.late_entry)).toBe("late_entry");
    expect(lateEntryTierForDaysLate(LATE_ENTRY_TIER_DAY_CEILINGS.late_entry + 1)).toBe(
      "significant_late_entry",
    );
  });
});

describe("the reason rule", () => {
  it("asks for a reason from late_entry up, never at normal", () => {
    expect(LATE_ENTRY_REASON_TIERS).toEqual([
      "late_entry",
      "significant_late_entry",
      "administrative_override",
    ]);
    expect(LATE_ENTRY_REASON_TIERS).not.toContain("normal");
  });

  it("is 40 characters (Module 8 section 2.5, the encounter CHECK)", () => {
    expect(LATE_ENTRY_REASON_MIN_CHARS).toBe(40);
  });
});
