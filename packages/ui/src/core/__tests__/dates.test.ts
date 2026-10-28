// PARAM-004 — `ageYears`/`parseLocalDateOnly` were 11 copy-pasted, buggy `new Date(dob)` calls
// across apps/web screens: parsing a bare `YYYY-MM-DD` string as a UTC instant reads back one day
// early in any negative-UTC-offset timezone (every US timezone) once local getters (`getDate()`
// etc.) are applied. This test pins `process.env.TZ` to a real negative-offset zone to reproduce
// the exact failure mode the bug had, rather than relying on whatever timezone the test runner
// happens to be in.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ageYears,
  formatDateOnly,
  isoToLocalInput,
  localInputToIso,
  nowLocalInput,
  parseLocalDateOnly,
  toLocalInput,
} from "../dates";

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

// #595 — datetime-local defaults were `new Date().toISOString().slice(0, 16)`: the UTC wall clock, read back as
// local, so a 19:15 PDT submit stored an instant 7 h in the future.
describe("datetime-local helpers — non-UTC timezone (#595)", () => {
  beforeAll(() => {
    process.env.TZ = "America/Los_Angeles";
  });
  afterAll(() => {
    restoreTz();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to the local wall clock, not the UTC one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T02:15:00Z")); // 19:15 PDT on the 22nd
    expect(nowLocalInput()).toBe("2026-10-22T19:15");
    expect(new Date().toISOString().slice(0, 16)).toBe("2026-10-23T02:15"); // the old, wrong default
  });

  it("round-trips the same instant through the field", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T02:15:00Z"));
    expect(localInputToIso(nowLocalInput())).toBe("2026-10-23T02:15:00.000Z");
  });

  it("shows a server instant in the viewer's zone (and stays stable across edits)", () => {
    expect(isoToLocalInput("2026-10-23T02:15:00.000Z")).toBe("2026-10-22T19:15");
    expect(localInputToIso(isoToLocalInput("2026-10-23T02:15:00.000Z"))).toBe(
      "2026-10-23T02:15:00.000Z",
    );
  });

  it("pads single digits and honours the winter offset", () => {
    expect(toLocalInput(new Date(2026, 0, 5, 3, 7))).toBe("2026-01-05T03:07");
  });

  it("returns an empty string for empty or unparseable input", () => {
    expect(isoToLocalInput(undefined)).toBe("");
    expect(isoToLocalInput("nope")).toBe("");
    expect(localInputToIso("")).toBe("");
    expect(localInputToIso("nope")).toBe("");
  });
});
