import { ValidationError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  calendarDateOfIso,
  isRealCalendarDate,
  requireCalendarDateTime,
  requireCalendarTargetDate,
} from "../src/modules/10-hope/hope-calendar-date";

describe("isRealCalendarDate", () => {
  it.each([
    ["a leap day in a leap year", 2028, 2, 29],
    ["a leap day in a 400-year leap year", 2000, 2, 29],
    ["the last day of a 31-day month", 2026, 1, 31],
    ["the last day of a 30-day month", 2026, 4, 30],
  ])("accepts %s", (_label, y, m, d) => {
    expect(isRealCalendarDate(y, m, d)).toBe(true);
  });

  it.each([
    ["a Feb 30", 2026, 2, 30],
    ["a Feb 29 in a common year", 2026, 2, 29],
    ["a Feb 29 in a century that is not a leap year", 1900, 2, 29],
    ["an Apr 31", 2026, 4, 31],
    ["month 13", 2026, 13, 1],
    ["month 0", 2026, 0, 10],
    ["day 0", 2026, 6, 0],
    ["a non-integer day", 2026, 6, 1.5],
  ])("refuses %s", (_label, y, m, d) => {
    expect(isRealCalendarDate(y, m, d)).toBe(false);
  });
});

describe("calendarDateOfIso", () => {
  it.each([
    [
      "a western-offset evening keeps the date as written, not the UTC day",
      "2026-06-01T20:00:00-07:00",
      "2026-06-01",
    ],
    [
      "an eastern-offset morning keeps the date as written, not the UTC day",
      "2026-06-02T01:30:00+09:00",
      "2026-06-02",
    ],
    ["the extreme eastern offset", "2026-06-01T05:00:00+14:00", "2026-06-01"],
    ["a UTC instant with milliseconds", "2028-02-29T10:00:00.123Z", "2028-02-29"],
    ["a timestamp without seconds", "2026-06-01T10:00Z", "2026-06-01"],
  ])("returns the written date for %s", (_label, iso, expected) => {
    expect(calendarDateOfIso(iso)).toBe(expected);
  });

  it.each([
    ["the earliest accepted instant", "1900-01-01T00:00:00Z", "1900-01-01"],
    ["the last accepted instant", "2200-12-31T23:59:59Z", "2200-12-31"],
    [
      "a western-offset morning on the last accepted day (UTC is still 2200)",
      "2200-12-31T10:00:00-07:00",
      "2200-12-31",
    ],
  ])("accepts %s", (_label, iso, expected) => {
    expect(calendarDateOfIso(iso)).toBe(expected);
  });

  it.each([
    ["the instant before the earliest accepted year", "1899-12-31T23:59:59Z"],
    ["the instant after the last accepted year", "2201-01-01T00:00:00Z"],
    [
      "year 9999 in the extreme western offset, which is year 10000 in UTC",
      "9999-12-31T23:59:59-14:00",
    ],
    ["year 0001", "0001-01-01T00:00:00Z"],
    [
      "an instant that is in the last year only as written (UTC is already 2201)",
      "2200-12-31T23:59:59-14:00",
    ],
    [
      "an instant that is in the first year only as written (UTC is still 1899)",
      "1900-01-01T00:00:00+14:00",
    ],
  ])("refuses %s", (_label, iso) => {
    expect(calendarDateOfIso(iso)).toBeNull();
  });

  it.each([
    ["a Feb 30 (a JS Date would roll it to Mar 2)", "2026-02-30T00:00:00.000Z"],
    ["a non-leap Feb 29", "2026-02-29T09:00:00.000Z"],
    ["an Apr 31", "2026-04-31T09:00:00.000Z"],
    ["hour 24 (V8 parses it as the next midnight)", "2026-06-01T24:00:00Z"],
    ["a timestamp with no offset (V8 reads it in the server's local time)", "2026-06-01T09:00:00"],
    ["a date with no time at all", "2026-06-01"],
    ["a leap second (Date.parse rejects it)", "2026-06-01T23:59:60Z"],
    ["an offset hour of 24", "2026-06-01T09:00:00+24:00"],
    ["an offset without a colon", "2026-06-01T09:00:00+0700"],
    ["minute 60", "2026-06-01T09:60:00Z"],
    ["trailing text", "2026-06-01T09:00:00Z and more"],
    ["a month name", "June 1 2026 09:00 GMT"],
    ["the empty string", ""],
  ])("refuses %s", (_label, iso) => {
    expect(calendarDateOfIso(iso)).toBeNull();
  });
});

describe("requireCalendarDateTime", () => {
  it("names the field it was given, echoing nothing the client sent", () => {
    let refusal: unknown;
    try {
      requireCalendarDateTime("2026-02-30T10:00:00Z", "submittedAt");
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(ValidationError);
    expect(JSON.stringify((refusal as ValidationError).details)).toContain("submittedAt");
    expect(JSON.stringify(refusal)).not.toContain("2026-02-30");
  });

  it("returns the written date for a valid value", () => {
    expect(requireCalendarDateTime("2026-06-01T20:00:00-07:00", "submissionDate")).toBe(
      "2026-06-01",
    );
  });
});

describe("requireCalendarTargetDate", () => {
  it("returns the written calendar date", () => {
    expect(requireCalendarTargetDate("2026-06-01T20:00:00-07:00")).toBe("2026-06-01");
  });

  it("refuses with a 422 naming the field and echoing nothing the client sent", () => {
    let refusal: unknown;
    try {
      requireCalendarTargetDate("2026-02-30T00:00:00.000Z");
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(ValidationError);
    expect(refusal).toMatchObject({ statusCode: 422 });
    expect(JSON.stringify(refusal)).not.toContain("2026-02-30");
    expect(JSON.stringify((refusal as ValidationError).details)).toContain("targetDate");
  });
});
