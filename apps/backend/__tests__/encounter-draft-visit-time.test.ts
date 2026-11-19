// S1 PR C2a — `visitAsOf` (VN-D11, design §3.2): the instant a visit note describes the patient at.
// The rule: the earlier of `now` and the last millisecond of the service date in the organization's zone.
import { describe, expect, it } from "vitest";
import { visitAsOf } from "../src/modules/08-encounters/drafting/visit-time";

const NEW_YORK = "America/New_York";
const base = {
  serviceDate: "2026-11-10",
  orgTimeZone: NEW_YORK,
  now: new Date("2026-11-18T15:00:00.000Z"),
};

describe("visitAsOf", () => {
  it("is the last millisecond of the service date once that date has ended", () => {
    // Nov 10 ends at 23:59:59.999 EST = Nov 11 04:59:59.999 UTC, not at 23:59:59.999 UTC.
    expect(visitAsOf(base)).toBe("2026-11-11T04:59:59.999Z");
  });

  it("is now while the service date is still in progress", () => {
    const now = new Date("2026-11-10T20:00:00.000Z"); // 15:00 EST on Nov 10
    expect(visitAsOf({ ...base, now })).toBe("2026-11-10T20:00:00.000Z");
  });

  it("is now for a service date in the future, never a later instant", () => {
    expect(visitAsOf({ ...base, serviceDate: "2026-11-25" })).toBe("2026-11-18T15:00:00.000Z");
  });

  it("covers the whole service date, so documenting after checkout the same day still sees it", () => {
    // 21:30 EST on Nov 10: well after any check-in, and the day is not over.
    const now = new Date("2026-11-11T02:30:00.000Z");
    expect(visitAsOf({ ...base, now })).toBe("2026-11-11T02:30:00.000Z");
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

  it("does not move with `now` once the service date has ended", () => {
    const a = visitAsOf({ ...base, now: new Date("2026-11-12T00:00:00.000Z") });
    const b = visitAsOf({ ...base, now: new Date("2026-12-24T09:00:00.000Z") });
    expect(a).toBe("2026-11-11T04:59:59.999Z");
    expect(b).toBe(a);
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

  it("does not mutate its input date", () => {
    const now = new Date("2026-11-18T15:00:00.000Z");
    visitAsOf({ ...base, now });
    expect(now.toISOString()).toBe("2026-11-18T15:00:00.000Z");
  });

  it("rejects a service date that is not a real calendar date", () => {
    expect(() => visitAsOf({ ...base, serviceDate: "2026-02-30" })).toThrow(RangeError);
    expect(() => visitAsOf({ ...base, serviceDate: "11/10/2026" })).toThrow(RangeError);
  });

  it("rejects an invalid instant", () => {
    expect(() => visitAsOf({ ...base, now: new Date("nope") })).toThrow(RangeError);
  });
});
