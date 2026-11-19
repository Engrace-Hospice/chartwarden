// S1 PR C2a — `visitAsOf` (VN-D11, design §3.2): the instant a visit note describes the patient at.
import { describe, expect, it } from "vitest";
import { visitAsOf } from "../src/modules/08-encounters/drafting/visit-time";

const NEW_YORK = "America/New_York";
const base = {
  startedAt: null,
  clockStartedAt: null,
  serviceDate: "2026-11-10",
  orgTimeZone: NEW_YORK,
  now: new Date("2026-11-18T15:00:00.000Z"),
};

describe("visitAsOf", () => {
  it("is started_at when it is earlier than now", () => {
    const startedAt = new Date("2026-11-10T14:30:00.000Z");
    expect(visitAsOf({ ...base, startedAt })).toBe("2026-11-10T14:30:00.000Z");
  });

  it("prefers started_at over clock_started_at", () => {
    const startedAt = new Date("2026-11-10T14:30:00.000Z");
    const clockStartedAt = new Date("2026-11-10T13:00:00.000Z");
    expect(visitAsOf({ ...base, startedAt, clockStartedAt })).toBe("2026-11-10T14:30:00.000Z");
  });

  it("falls back to clock_started_at when there is no started_at", () => {
    const clockStartedAt = new Date("2026-11-10T13:00:00.000Z");
    expect(visitAsOf({ ...base, clockStartedAt })).toBe("2026-11-10T13:00:00.000Z");
  });

  it("is now when started_at is in the future (a device clock that ran ahead)", () => {
    const startedAt = new Date("2026-11-19T09:00:00.000Z");
    expect(visitAsOf({ ...base, startedAt })).toBe("2026-11-18T15:00:00.000Z");
  });

  it("is now when clock_started_at is in the future", () => {
    const clockStartedAt = new Date("2026-11-19T09:00:00.000Z");
    expect(visitAsOf({ ...base, clockStartedAt })).toBe("2026-11-18T15:00:00.000Z");
  });

  it("is the last millisecond of the service date in the org zone when no start is known", () => {
    // Nov 10 ends at 23:59:59.999 EST = Nov 11 04:59:59.999 UTC, not at 23:59:59.999 UTC.
    expect(visitAsOf(base)).toBe("2026-11-11T04:59:59.999Z");
  });

  it("is now when the service date has not ended yet", () => {
    const now = new Date("2026-11-10T20:00:00.000Z");
    expect(visitAsOf({ ...base, now })).toBe("2026-11-10T20:00:00.000Z");
  });

  it("keeps a late evening visit on its own org-local day when UTC has already rolled over", () => {
    // 22:00 EST on Nov 10 is already Nov 11 in UTC; the Nov 10 visit has not ended yet.
    const now = new Date("2026-11-11T03:00:00.000Z");
    expect(visitAsOf({ ...base, now })).toBe("2026-11-11T03:00:00.000Z");
  });

  it("ends the day at local midnight once the org zone has crossed it", () => {
    const now = new Date("2026-11-11T05:00:00.000Z"); // 00:00 EST, Nov 11
    expect(visitAsOf({ ...base, now })).toBe("2026-11-11T04:59:59.999Z");
  });

  it("uses the zone east of UTC when the org is there", () => {
    // Auckland is UTC+13 in November: Nov 10 ends at 10:59:59.999 UTC the same day.
    expect(visitAsOf({ ...base, orgTimeZone: "Pacific/Auckland" })).toBe(
      "2026-11-10T10:59:59.999Z",
    );
  });

  it("handles the 25-hour fall-back day", () => {
    // 2026-11-01 in New York ends at 00:00 EST on Nov 2 = 05:00 UTC.
    expect(visitAsOf({ ...base, serviceDate: "2026-11-01" })).toBe("2026-11-02T04:59:59.999Z");
  });

  it("handles the 23-hour spring-forward day", () => {
    // 2026-03-08 in New York ends at 00:00 EDT on Mar 9 = 04:00 UTC.
    expect(visitAsOf({ ...base, serviceDate: "2026-03-08" })).toBe("2026-03-09T03:59:59.999Z");
  });

  it("does not mutate its input dates", () => {
    const startedAt = new Date("2026-11-10T14:30:00.000Z");
    const now = new Date("2026-11-18T15:00:00.000Z");
    visitAsOf({ ...base, startedAt, now });
    expect(startedAt.toISOString()).toBe("2026-11-10T14:30:00.000Z");
    expect(now.toISOString()).toBe("2026-11-18T15:00:00.000Z");
  });

  it("rejects a service date that is not a real calendar date", () => {
    expect(() => visitAsOf({ ...base, serviceDate: "2026-02-30" })).toThrow(RangeError);
    expect(() => visitAsOf({ ...base, serviceDate: "11/10/2026" })).toThrow(RangeError);
  });

  it("rejects an invalid instant", () => {
    expect(() => visitAsOf({ ...base, now: new Date("nope") })).toThrow(RangeError);
    expect(() => visitAsOf({ ...base, startedAt: new Date("nope") })).toThrow(RangeError);
  });
});
