import { describe, expect, it } from "vitest";
import {
  parseStrictInstant,
  scheduleContains,
  shiftWindowContains,
  validateShiftSchedule,
} from "../src/escalation/shift-window";

const NIGHT = { startTime: "19:00", endTime: "07:00" } as const;
const DAY = { startTime: "07:00", endTime: "19:00" } as const;
const NY = "America/New_York";

describe("shiftWindowContains", () => {
  it("includes the start instant and excludes the end instant", () => {
    // Arrange: 07:00-19:00 New York on 2026-03-02 (EST, UTC-5) = 12:00Z to 24:00Z
    // Act / Assert
    expect(shiftWindowContains(NY, DAY, "2026-03-02T11:59:59Z")).toBe(false);
    expect(shiftWindowContains(NY, DAY, "2026-03-02T12:00:00Z")).toBe(true);
    expect(shiftWindowContains(NY, DAY, "2026-03-02T23:59:59Z")).toBe(true);
    expect(shiftWindowContains(NY, DAY, "2026-03-03T00:00:00Z")).toBe(false);
  });

  it("evaluates in the schedule zone, not the server zone", () => {
    // 2026-06-01T03:00Z is 23:00 the evening before in New York (EDT) and 12:00 in Tokyo.
    expect(shiftWindowContains(NY, NIGHT, "2026-06-01T03:00:00Z")).toBe(true);
    expect(shiftWindowContains("Asia/Tokyo", NIGHT, "2026-06-01T03:00:00Z")).toBe(false);
    expect(shiftWindowContains("Asia/Tokyo", DAY, "2026-06-01T03:00:00Z")).toBe(true);
  });

  it("gives the same answer whatever the process zone is", () => {
    const before = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Auckland";
      const a = shiftWindowContains(NY, NIGHT, "2026-06-01T03:00:00Z");
      process.env.TZ = "America/Los_Angeles";
      const b = shiftWindowContains(NY, NIGHT, "2026-06-01T03:00:00Z");
      expect(a).toBe(true);
      expect(b).toBe(a);
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, "TZ");
      else process.env.TZ = before;
    }
  });

  it("covers a midnight-crossing shift on both sides of midnight", () => {
    // 19:00-07:00 New York in June (EDT, UTC-4): 23:00Z to 11:00Z next day
    expect(shiftWindowContains(NY, NIGHT, "2026-06-01T22:59:59Z")).toBe(false);
    expect(shiftWindowContains(NY, NIGHT, "2026-06-01T23:00:00Z")).toBe(true);
    expect(shiftWindowContains(NY, NIGHT, "2026-06-02T04:00:00Z")).toBe(true); // 00:00 local
    expect(shiftWindowContains(NY, NIGHT, "2026-06-02T10:59:59Z")).toBe(true);
    expect(shiftWindowContains(NY, NIGHT, "2026-06-02T11:00:00Z")).toBe(false);
  });

  it("keeps adjacent day and night shifts gapless and non-overlapping across spring-forward", () => {
    // 2026-03-08 02:00 -> 03:00 does not exist in New York. Every minute belongs to exactly one of DAY/NIGHT.
    const start = Date.parse("2026-03-07T00:00:00Z");
    for (let t = start; t < start + 72 * 3_600_000; t += 60_000) {
      const iso = new Date(t).toISOString();
      const day = shiftWindowContains(NY, DAY, iso);
      const night = shiftWindowContains(NY, NIGHT, iso);
      expect(day !== night).toBe(true);
    }
  });

  it("keeps adjacent shifts gapless and non-overlapping across fall-back", () => {
    // 2026-11-01 01:00-02:00 happens twice in New York.
    const start = Date.parse("2026-10-31T00:00:00Z");
    for (let t = start; t < start + 72 * 3_600_000; t += 60_000) {
      const iso = new Date(t).toISOString();
      expect(shiftWindowContains(NY, DAY, iso) !== shiftWindowContains(NY, NIGHT, iso)).toBe(true);
    }
  });

  it("starts a shift whose wall-clock start does not exist at the first instant after the gap", () => {
    // 02:30-06:00 on spring-forward day: 02:30 local never occurs; the shift begins when 03:00 EDT (07:00Z) arrives.
    const w = { startTime: "02:30", endTime: "06:00" } as const;
    expect(shiftWindowContains(NY, w, "2026-03-08T06:59:59Z")).toBe(false); // 01:59:59 EST
    expect(shiftWindowContains(NY, w, "2026-03-08T07:00:00Z")).toBe(true); // 03:00:00 EDT
  });

  it("treats a repeated fall-back hour as inside a shift that spans it on both passes", () => {
    const w = { startTime: "00:30", endTime: "01:45" } as const;
    expect(shiftWindowContains(NY, w, "2026-11-01T05:30:00Z")).toBe(true); // 01:30 EDT, first pass
    expect(shiftWindowContains(NY, w, "2026-11-01T06:30:00Z")).toBe(true); // 01:30 EST, second pass
    expect(shiftWindowContains(NY, w, "2026-11-01T06:45:00Z")).toBe(false); // 01:45 EST, end exclusive
  });

  it("applies days to the day the shift starts on", () => {
    // Night shift starting Friday (5) runs to Saturday 07:00; Saturday 03:00 belongs to Friday's shift.
    const fridayNight = { ...NIGHT, days: [5] } as const;
    // 2026-06-06 is a Saturday. 03:00 local = 07:00Z
    expect(shiftWindowContains(NY, fridayNight, "2026-06-06T07:00:00Z")).toBe(true);
    // Saturday 21:00 local belongs to a Saturday-start shift, which is not listed.
    expect(shiftWindowContains(NY, fridayNight, "2026-06-07T01:00:00Z")).toBe(false);
    // Sunday 03:00 local would belong to Saturday's shift: not listed.
    expect(shiftWindowContains(NY, fridayNight, "2026-06-07T07:00:00Z")).toBe(false);
  });

  it("rejects an unknown time zone instead of falling back to the server zone", () => {
    expect(() => shiftWindowContains("Mars/Olympus", DAY, "2026-06-01T03:00:00Z")).toThrow(
      /time zone/i,
    );
  });

  it("rejects malformed times, an empty window and an unparsable instant", () => {
    expect(() =>
      shiftWindowContains(NY, { startTime: "7:00", endTime: "19:00" }, "2026-06-01T03:00:00Z"),
    ).toThrow();
    expect(() =>
      shiftWindowContains(NY, { startTime: "07:00", endTime: "07:00" }, "2026-06-01T03:00:00Z"),
    ).toThrow();
    expect(() => shiftWindowContains(NY, DAY, "not-a-date")).toThrow();
    expect(() => shiftWindowContains(NY, { ...DAY, days: [7] }, "2026-06-01T03:00:00Z")).toThrow();
  });
});

describe("scheduleContains", () => {
  it("is true when any window of the schedule contains the instant", () => {
    const schedule = { timeZone: NY, windows: [DAY, { startTime: "21:00", endTime: "22:00" }] };
    expect(scheduleContains(schedule, "2026-06-02T01:30:00Z")).toBe(true); // 21:30 EDT
    expect(scheduleContains(schedule, "2026-06-02T03:00:00Z")).toBe(false); // 23:00 EDT
  });
});

describe("parseStrictInstant", () => {
  it("accepts Z and offset instants with optional seconds and fractions", () => {
    expect(parseStrictInstant("2026-06-01T16:00:00Z")).toBe(Date.parse("2026-06-01T16:00:00Z"));
    expect(parseStrictInstant("2026-06-01T12:00-04:00")).toBe(Date.parse("2026-06-01T16:00:00Z"));
    expect(parseStrictInstant("2026-06-01T16:00:00.250+00:00")).toBe(
      Date.parse("2026-06-01T16:00:00.250Z"),
    );
  });

  it("refuses offset-less, loose, bare-date and over-long strings, whatever the process zone", () => {
    const before = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Auckland";
      for (const bad of [
        "2026-06-01T16:00:00",
        "June 1 2026",
        "2026-06-01",
        "2026-06-01 16:00:00Z",
        "2026-13-45T99:99:99Z",
        `2026-06-01T16:00:00Z${" ".repeat(40)}`,
        "",
      ]) {
        expect(() => parseStrictInstant(bad), bad).toThrow(/instant/i);
      }
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, "TZ");
      else process.env.TZ = before;
    }
  });

  it("is what shiftWindowContains uses, so an offset-less string is refused there too", () => {
    expect(() => shiftWindowContains(NY, DAY, "2026-06-01T16:00:00")).toThrow(/instant/i);
  });
});

describe("validateShiftSchedule", () => {
  it("rejects a malformed later window even when an earlier window matches", () => {
    const schedule = { timeZone: NY, windows: [DAY, { startTime: "25:00", endTime: "26:00" }] };
    expect(() => validateShiftSchedule(schedule)).toThrow();
    expect(() => scheduleContains(schedule, "2026-06-01T16:00:00Z")).toThrow();
  });

  it("rejects a bad zone, an empty window and a bad weekday", () => {
    expect(() => validateShiftSchedule({ timeZone: "Nowhere/Land", windows: [DAY] })).toThrow(
      /time zone/i,
    );
    expect(() =>
      validateShiftSchedule({ timeZone: NY, windows: [{ startTime: "07:00", endTime: "07:00" }] }),
    ).toThrow();
    expect(() =>
      validateShiftSchedule({ timeZone: NY, windows: [{ ...DAY, days: [9] }] }),
    ).toThrow();
  });

  it("accepts a valid schedule", () => {
    expect(() => validateShiftSchedule({ timeZone: NY, windows: [DAY, NIGHT] })).not.toThrow();
  });
});
