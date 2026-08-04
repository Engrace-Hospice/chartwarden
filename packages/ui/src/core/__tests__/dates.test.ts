// PARAM-004 — `ageYears`/`parseLocalDateOnly` were 11 copy-pasted, buggy `new Date(dob)` calls
// across apps/web screens: parsing a bare `YYYY-MM-DD` string as a UTC instant reads back one day
// early in any negative-UTC-offset timezone (every US timezone) once local getters (`getDate()`
// etc.) are applied. This test pins `process.env.TZ` to a real negative-offset zone to reproduce
// the exact failure mode the bug had, rather than relying on whatever timezone the test runner
// happens to be in.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageYears, parseLocalDateOnly } from "../dates";

const ORIGINAL_TZ = process.env.TZ;

describe("parseLocalDateOnly / ageYears — negative-UTC-offset timezone (PARAM-004)", () => {
  beforeAll(() => {
    process.env.TZ = "America/Los_Angeles"; // UTC-7/UTC-8 — the exact class of bug this fixes
  });
  afterAll(() => {
    process.env.TZ = ORIGINAL_TZ;
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
