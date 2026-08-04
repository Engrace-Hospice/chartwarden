// PARAM-004 follow-up — org-local-date. Proves the actual bug this fixes: naive UTC-instant
// slicing reads the WRONG calendar date for a large fraction of every US business day.
import { describe, expect, it } from "vitest";
import { isValidTimeZone, localDateInTimeZone, orgLocalDateToday } from "../src/dates/org-local-date";

describe("localDateInTimeZone", () => {
  it("reads the correct LOCAL calendar date even when UTC has already rolled to the next day", () => {
    // 8pm Pacific on March 15 is 03:00 UTC on March 16 — naive `.toISOString().slice(0,10)` would
    // read "2026-03-16", a full day ahead of the org's actual local date.
    const instant = new Date("2026-03-16T03:00:00Z");
    expect(localDateInTimeZone(instant, "America/Los_Angeles")).toBe("2026-03-15");
    // The same instant in a positive-offset zone reads later still.
    expect(localDateInTimeZone(instant, "Asia/Tokyo")).toBe("2026-03-16");
  });

  it("agrees with naive UTC slicing near UTC midnight, when no timezone difference is in play", () => {
    const instant = new Date("2026-03-16T12:00:00Z");
    expect(localDateInTimeZone(instant, "UTC")).toBe("2026-03-16");
  });

  it("throws RangeError for an unrecognized IANA zone (callers fail closed on this)", () => {
    expect(() => localDateInTimeZone(new Date(), "Not/AZone")).toThrow(RangeError);
  });
});

describe("orgLocalDateToday", () => {
  it("returns today in the given zone, matching localDateInTimeZone(new Date(), tz)", () => {
    expect(orgLocalDateToday("America/New_York")).toBe(localDateInTimeZone(new Date(), "America/New_York"));
  });
});

describe("isValidTimeZone", () => {
  it("accepts real IANA zones and UTC", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("America/Los_Angeles")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("rejects a made-up zone rather than throwing", () => {
    expect(isValidTimeZone("Not/AZone")).toBe(false);
  });
});
