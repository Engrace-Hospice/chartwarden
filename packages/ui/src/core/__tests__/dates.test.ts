// PARAM-004 — `ageYears`/`parseLocalDateOnly` were 11 copy-pasted, buggy `new Date(dob)` calls
// across apps/web screens: parsing a bare `YYYY-MM-DD` string as a UTC instant reads back one day
// early in any negative-UTC-offset timezone (every US timezone) once local getters (`getDate()`
// etc.) are applied. This test pins `process.env.TZ` to a real negative-offset zone to reproduce
// the exact failure mode the bug had, rather than relying on whatever timezone the test runner
// happens to be in.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageYears, formatDateOnly, parseLocalDateOnly } from "../dates";

const ORIGINAL_TZ = process.env.TZ;
const restoreTz = () => {
  if (ORIGINAL_TZ === undefined) Reflect.deleteProperty(process.env, "TZ");
  else process.env.TZ = ORIGINAL_TZ;
};

describe("parseLocalDateOnly / ageYears — negative-UTC-offset timezone (PARAM-004)", () => {
  beforeAll(() => {
    process.env.TZ = "America/Los_Angeles"; // UTC-7/UTC-8 — the exact class of bug this fixes
  });
  afterAll(() => {
    restoreTz();
  });

  it("parses the LOCAL calendar date, not the UTC-instant-shifted one", () => {
    const d = parseLocalDateOnly("1950-03-15");
    expect(d).not.toBeNull();
    // The old `new Date("1950-03-15")` bug reads this back as March 14 in America/Los_Angeles
    // (UTC midnight on the 15th is 16:00 local on the 14th) — this must read the 15th.
    expect(d?.getFullYear()).toBe(1950);
    expect(d?.getMonth()).toBe(2); // 0-indexed: March
    expect(d?.getDate()).toBe(15);
  });

  it("rejects a malformed date-only string", () => {
    expect(parseLocalDateOnly("not-a-date")).toBeNull();
    expect(parseLocalDateOnly("")).toBeNull();
  });

  it("rejects a component that would silently roll over (e.g. day 32)", () => {
    expect(parseLocalDateOnly("2026-01-32")).toBeNull();
  });

  it("computes a stable age for a fixed reference DOB (no off-by-one at a day boundary)", () => {
    // A DOB exactly 40 years before "today" — old `new Date(dob)` UTC-instant parsing could
    // silently read one day early, occasionally shifting this by a full year around a birthday.
    const now = new Date();
    const dob = `${now.getFullYear() - 40}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(ageYears(dob)).toBe(40);
  });

  it("returns null for an unparseable dob and for an implausible age", () => {
    expect(ageYears("garbage")).toBeNull();
    expect(ageYears("1850-01-01")).toBeNull(); // >= 150 years
  });
});

// Finding 8: a date-only value must render as the calendar day stored in EVERY zone. Only the
// America/Los_Angeles run discriminates against `new Date(value)` (UTC midnight reads a day early
// west of UTC); Pacific/Auckland is a regression guard that the day stays put east of UTC.
describe.each(["America/Los_Angeles", "Pacific/Auckland"])("formatDateOnly in %s", (zone) => {
  beforeAll(() => {
    process.env.TZ = zone;
  });
  afterAll(() => {
    restoreTz();
  });

  it("shows the stored calendar day", () => {
    expect(formatDateOnly("1950-03-15")).toBe("Mar 15, 1950");
  });

  it("handles a leap day and a month rollover boundary", () => {
    expect(formatDateOnly("2024-02-29")).toBe("Feb 29, 2024");
    expect(formatDateOnly("2026-01-01")).toBe("Jan 1, 2026");
    expect(formatDateOnly("2026-12-31")).toBe("Dec 31, 2026");
  });

  it("accepts the midnight-UTC serialization of a date column", () => {
    expect(formatDateOnly("1950-03-15T00:00:00.000Z")).toBe("Mar 15, 1950");
    expect(formatDateOnly("1950-03-15T00:00:00Z")).toBe("Mar 15, 1950");
  });

  it("returns a non-midnight instant unchanged (its day depends on the viewer's zone)", () => {
    expect(formatDateOnly("1950-03-15T23:30:00.000Z")).toBe("1950-03-15T23:30:00.000Z");
    expect(formatDateOnly("1950-03-15T00:00:00+05:00")).toBe("1950-03-15T00:00:00+05:00");
  });

  it("returns unparseable input unchanged", () => {
    expect(formatDateOnly("garbage")).toBe("garbage");
    expect(formatDateOnly("")).toBe("");
    expect(formatDateOnly("2026-02-31")).toBe("2026-02-31");
  });

  it("honours custom format options", () => {
    expect(formatDateOnly("1950-03-15", { month: "long", year: "numeric" })).toBe("March 1950");
    expect(
      formatDateOnly("1950-03-15", { month: "2-digit", day: "2-digit", year: "numeric" }),
    ).toBe("03/15/1950");
  });
});
