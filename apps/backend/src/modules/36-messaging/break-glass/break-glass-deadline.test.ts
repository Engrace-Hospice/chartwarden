// ADR-0087 D5 - the review deadline arithmetic (business days, UTC) and the overdue rule.
import { describe, expect, it } from "vitest";
import {
  addBusinessDays,
  grantEndedAt,
  isReviewOverdue,
  reviewDueAt,
  reviewEscalateAt,
} from "./break-glass-deadline";

const at = (iso: string) => new Date(iso);
// 2026-10-19 is a Monday.
const MON = "2026-10-19T15:30:00.000Z";
const WED = "2026-10-21T15:30:00.000Z";
const FRI = "2026-10-23T15:30:00.000Z";
const SAT = "2026-10-24T09:00:00.000Z";
const SUN = "2026-10-25T09:00:00.000Z";

describe("addBusinessDays", () => {
  it("keeps the time of day and skips the weekend", () => {
    expect(addBusinessDays(at(WED), 1).toISOString()).toBe("2026-10-22T15:30:00.000Z");
    expect(addBusinessDays(at(FRI), 1).toISOString()).toBe("2026-10-26T15:30:00.000Z");
    expect(addBusinessDays(at(FRI), 5).toISOString()).toBe("2026-10-30T15:30:00.000Z");
    expect(addBusinessDays(at(MON), 0).toISOString()).toBe(MON);
  });

  it("a grant that ends on a weekend is due the next Monday, the same time of day", () => {
    expect(addBusinessDays(at(SAT), 1).toISOString()).toBe("2026-10-26T09:00:00.000Z");
    expect(addBusinessDays(at(SUN), 1).toISOString()).toBe("2026-10-26T09:00:00.000Z");
  });

  it("refuses a negative or fractional count", () => {
    expect(() => addBusinessDays(at(MON), -1)).toThrow(RangeError);
    expect(() => addBusinessDays(at(MON), 1.5)).toThrow(RangeError);
  });
});

describe("review deadlines", () => {
  it("due one business day after the end; escalates three calendar days after the end", () => {
    expect(reviewDueAt(at(FRI)).toISOString()).toBe("2026-10-26T15:30:00.000Z");
    expect(reviewEscalateAt(at(WED)).toISOString()).toBe("2026-10-24T15:30:00.000Z");
  });

  it("a grant ends at the earlier of its expiry and its revocation", () => {
    const expiry = at("2026-10-21T19:00:00.000Z");
    expect(grantEndedAt(expiry, null)).toEqual(expiry);
    expect(grantEndedAt(expiry, at("2026-10-21T17:00:00.000Z")).toISOString()).toBe(
      "2026-10-21T17:00:00.000Z",
    );
    expect(grantEndedAt(expiry, at("2026-10-22T01:00:00.000Z"))).toEqual(expiry);
  });

  it("is overdue only while pending and strictly past the due instant", () => {
    const endedAt = at(WED);
    const due = reviewDueAt(endedAt);
    expect(isReviewOverdue({ completed: false, endedAt }, new Date(due.getTime()))).toBe(false);
    expect(isReviewOverdue({ completed: false, endedAt }, new Date(due.getTime() + 1))).toBe(true);
    expect(isReviewOverdue({ completed: true, endedAt }, new Date(due.getTime() + 1))).toBe(false);
  });
});
