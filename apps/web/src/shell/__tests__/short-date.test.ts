import { describe, expect, it } from "vitest";
import { shortDate } from "../short-date";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

describe("shortDate", () => {
  it("writes a date-only value as that calendar day, with the year", () => {
    expect(shortDate("2026-11-04")).toBe("Nov 4, 2026");
  });

  it("writes an ISO instant as the date it falls on in the viewer's time zone", () => {
    const instant = "2026-11-19T15:30:00.000Z";
    const local = new Date(instant);
    // Worked out from the local calendar parts, not by the code under test: one day, whichever zone the suite runs in.
    expect(shortDate(instant)).toBe(
      `${MONTHS[local.getMonth()]} ${local.getDate()}, ${local.getFullYear()}`,
    );
  });

  it("leaves the year off a date in the year given, and keeps it for another year", () => {
    const now = new Date(2026, 10, 19);
    expect(shortDate("2026-11-04", { yearlessIn: now })).toBe("Nov 4");
    expect(shortDate("2025-11-04", { yearlessIn: now })).toBe("Nov 4, 2025");
  });

  it("answers a dash for nothing and returns what it was given when it is not a date", () => {
    expect(shortDate(null)).toBe("—");
    expect(shortDate("")).toBe("—");
    expect(shortDate("last week")).toBe("last week");
    expect(shortDate("2026-13-01")).toBe("2026-13-01");
    expect(shortDate("2026-02-30")).toBe("2026-02-30");
  });
});
