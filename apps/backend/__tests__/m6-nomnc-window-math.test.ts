// M6 milestone 10a — wallTimeToOrgInstant: a typed local date + time becomes an instant, never a default.
import { describe, expect, it } from "vitest";
import {
  localDateOfInstant,
  wallTimeToOrgInstant,
} from "../src/modules/06-admission/certification/window-math";

const LA = "America/Los_Angeles";

describe("wallTimeToOrgInstant", () => {
  it("converts a winter wall minute (PST, UTC-8)", () => {
    expect(wallTimeToOrgInstant("2026-01-15", "12:00", LA)).toEqual({
      ok: true,
      instant: "2026-01-15T20:00:00.000Z",
    });
  });

  it("converts a summer wall minute (PDT, UTC-7) to the minute", () => {
    expect(wallTimeToOrgInstant("2026-07-15", "16:47", LA)).toEqual({
      ok: true,
      instant: "2026-07-15T23:47:00.000Z",
    });
  });

  it("refuses a missing time (never defaults to noon or end of day)", () => {
    expect(wallTimeToOrgInstant("2026-07-15", undefined, LA)).toEqual({
      ok: false,
      code: "TIME_REQUIRED",
    });
    expect(wallTimeToOrgInstant("2026-07-15", "", LA)).toEqual({ ok: false, code: "TIME_REQUIRED" });
  });

  it("refuses a missing or malformed date and a malformed time", () => {
    expect(wallTimeToOrgInstant(null, "10:00", LA)).toEqual({ ok: false, code: "DATE_REQUIRED" });
    expect(wallTimeToOrgInstant("2026-02-30", "10:00", LA)).toEqual({
      ok: false,
      code: "DATE_INVALID",
    });
    expect(wallTimeToOrgInstant("07/15/2026", "10:00", LA)).toEqual({
      ok: false,
      code: "DATE_INVALID",
    });
    expect(wallTimeToOrgInstant("2026-07-15", "24:00", LA)).toEqual({
      ok: false,
      code: "TIME_INVALID",
    });
    expect(wallTimeToOrgInstant("2026-07-15", "9:5", LA)).toEqual({
      ok: false,
      code: "TIME_INVALID",
    });
  });

  it("refuses a local time inside the spring DST gap", () => {
    // 2026-03-08 02:30 does not exist in America/Los_Angeles.
    expect(wallTimeToOrgInstant("2026-03-08", "02:30", LA)).toEqual({
      ok: false,
      code: "TIME_NONEXISTENT",
    });
    expect(wallTimeToOrgInstant("2026-03-08", "03:00", LA)).toEqual({
      ok: true,
      instant: "2026-03-08T10:00:00.000Z",
    });
  });

  it("takes the earlier instant for an ambiguous autumn-overlap time", () => {
    // 2026-11-01 01:30 happens twice; the earlier is PDT (UTC-7) = 08:30Z.
    expect(wallTimeToOrgInstant("2026-11-01", "01:30", LA)).toEqual({
      ok: true,
      instant: "2026-11-01T08:30:00.000Z",
    });
  });

  it("round-trips with localDateOfInstant", () => {
    const r = wallTimeToOrgInstant("2026-07-15", "23:59", LA);
    expect(r.ok && localDateOfInstant(r.instant, LA)).toBe("2026-07-15");
  });

  it("works for a zone east of UTC", () => {
    expect(wallTimeToOrgInstant("2026-01-15", "09:00", "Asia/Kolkata")).toEqual({
      ok: true,
      instant: "2026-01-15T03:30:00.000Z",
    });
  });
});
