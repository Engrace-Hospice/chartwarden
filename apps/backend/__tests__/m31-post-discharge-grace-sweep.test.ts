// F-222 (#248) — unit tests for the PURE parts of M31's post-discharge-grace sweep (the DB-facing behaviour is
// proven on real rows in `m31-post-discharge-grace-sweep.live.test.ts`).
import { describe, expect, it } from "vitest";
import { isPastGraceAndNotReadmitted } from "../src/modules/06-admission/seams/portal-discharge-grace-for-org";
import {
  M31_POST_DISCHARGE_GRACE_FLOOR_DAYS,
  effectiveGraceDays,
  graceCutoffDate,
} from "../src/modules/31-portal/jobs/index";

describe("effectiveGraceDays — the 30-day floor is never shortened", () => {
  it("defaults to the floor when nothing is configured", () => {
    expect(effectiveGraceDays(null)).toBe(M31_POST_DISCHARGE_GRACE_FLOOR_DAYS);
    expect(effectiveGraceDays(undefined)).toBe(30);
    expect(effectiveGraceDays(Number.NaN)).toBe(30);
  });
  it("clamps a shorter tenant value UP to the floor and honours a longer one", () => {
    expect(effectiveGraceDays(0)).toBe(30);
    expect(effectiveGraceDays(7)).toBe(30);
    expect(effectiveGraceDays(29.9)).toBe(30);
    expect(effectiveGraceDays(30)).toBe(30);
    expect(effectiveGraceDays(45.7)).toBe(45);
    expect(effectiveGraceDays(90)).toBe(90);
  });
});

describe("graceCutoffDate", () => {
  it("is the UTC calendar day `graceDays` before now, independent of time of day", () => {
    expect(graceCutoffDate(new Date("2026-09-30T02:30:00Z"), 30)).toBe("2026-08-31");
    expect(graceCutoffDate(new Date("2026-09-30T23:59:59Z"), 30)).toBe("2026-08-31");
    expect(graceCutoffDate(new Date("2026-03-01T00:00:00Z"), 30)).toBe("2026-01-30");
  });
});

describe("isPastGraceAndNotReadmitted — the strict-less-than floor", () => {
  const base = { latestDischargeType: "transfer", cutoffDate: "2026-08-31", hasOpenAdmission: false };
  it("revokes only when the discharge is STRICTLY before the cutoff", () => {
    expect(isPastGraceAndNotReadmitted({ ...base, latestEffectiveAt: "2026-08-30" })).toBe(true);
    // exactly on the cutoff = discharge+graceDays today => still inside the floor.
    expect(isPastGraceAndNotReadmitted({ ...base, latestEffectiveAt: "2026-08-31" })).toBe(false);
    expect(isPastGraceAndNotReadmitted({ ...base, latestEffectiveAt: "2026-09-15" })).toBe(false);
  });
  it("never a candidate when re-admitted or when the latest discharge was a death", () => {
    expect(
      isPastGraceAndNotReadmitted({ ...base, latestEffectiveAt: "2026-01-01", hasOpenAdmission: true }),
    ).toBe(false);
    expect(
      isPastGraceAndNotReadmitted({ ...base, latestEffectiveAt: "2026-01-01", latestDischargeType: "death" }),
    ).toBe(false);
  });
});
