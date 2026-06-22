// @wardenx/orders — §2.3 D3 verbal-order workflow + 48h timer — M11-T04.
import { describe, expect, it } from "vitest";
import {
  VERBAL_PLATFORM_FLOOR_HOURS,
  validateVerbalWindowHours,
  computeVerbalDeadline,
  classifyPreExpiryTier,
  isVerbalExpired,
  hoursOverdue,
  planVerbalExpiry,
  type VerbalDeadlinePolicy,
} from "../src/lifecycle/verbal-window";
import { OrderStateError } from "../src/lifecycle/errors";
import type { OrderSideEffect } from "../src/lifecycle/effects";

const HOUR = 3_600_000;
const at = (ms: number): string => new Date(ms).toISOString();

function outboxEvents(effects: ReadonlyArray<OrderSideEffect>): string[] {
  return effects.filter((e): e is Extract<OrderSideEffect, { kind: "outbox" }> => e.kind === "outbox").map((e) => e.event);
}

describe("§2.3 D3 validateVerbalWindowHours (tighten-only floor)", () => {
  it("accepts the full [1, 48] range", () => {
    expect(() => validateVerbalWindowHours(1)).not.toThrow();
    expect(() => validateVerbalWindowHours(24)).not.toThrow();
    expect(() => validateVerbalWindowHours(VERBAL_PLATFORM_FLOOR_HOURS)).not.toThrow();
  });

  it("rejects > 48h (tenants may tighten, never loosen)", () => {
    try {
      validateVerbalWindowHours(72);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(OrderStateError);
      expect((e as OrderStateError).code).toBe("VERBAL_WINDOW_EXCEEDS_FLOOR");
    }
  });

  it("rejects < 1h and non-integers", () => {
    expect(() => validateVerbalWindowHours(0)).toThrowError(expect.objectContaining({ code: "VERBAL_WINDOW_OUT_OF_RANGE" }));
    expect(() => validateVerbalWindowHours(-4)).toThrowError(expect.objectContaining({ code: "VERBAL_WINDOW_OUT_OF_RANGE" }));
    expect(() => validateVerbalWindowHours(12.5)).toThrowError(expect.objectContaining({ code: "VERBAL_WINDOW_OUT_OF_RANGE" }));
  });
});

describe("§2.3 D3 computeVerbalDeadline (wall-clock)", () => {
  it("adds exactly window_hours of real time (default 48h)", () => {
    const received = "2026-06-22T10:00:00.000Z";
    expect(computeVerbalDeadline(received)).toBe(at(Date.parse(received) + 48 * HOUR));
  });

  it("honours a tightened 24h tenant window", () => {
    const received = "2026-06-22T10:00:00.000Z";
    const policy: VerbalDeadlinePolicy = { windowHours: 24, businessHoursOnly: false, policyVersion: "v2" };
    expect(computeVerbalDeadline(received, policy)).toBe(at(Date.parse(received) + 24 * HOUR));
  });

  it("validates the window before computing", () => {
    expect(() =>
      computeVerbalDeadline("2026-06-22T10:00:00.000Z", { windowHours: 96, businessHoursOnly: false, policyVersion: "x" }),
    ).toThrowError(expect.objectContaining({ code: "VERBAL_WINDOW_EXCEEDS_FLOOR" }));
  });
});

describe("§2.3 D3 computeVerbalDeadline (business-hours, weekend/holiday-skip)", () => {
  const tz = "America/Los_Angeles";

  it("pauses the clock across the weekend (Friday-afternoon order)", () => {
    // 2026-06-19 is a Friday. 09:00 PT = 16:00Z. An 8-business-hour window opened at 16:00Z (09:00 PT)
    // consumes Fri 09:00–17:00 PT only → deadline is Fri 17:00 PT = Sat 00:00Z.
    const received = "2026-06-19T16:00:00.000Z";
    const policy: VerbalDeadlinePolicy = { windowHours: 8, businessHoursOnly: true, timeZone: tz, policyVersion: "biz" };
    const deadline = computeVerbalDeadline(received, policy);
    expect(deadline).toBe(at(Date.parse(received) + 8 * HOUR));
  });

  it("skips the full weekend when the window straddles it", () => {
    // Friday 22:00 PT (Sat 05:00Z). A 4-business-hour window: Fri 22:00–24:00 PT count (2h), then Sat/Sun
    // skip, then Mon 00:00–02:00 PT count (2h) → deadline Mon 02:00 PT.
    const received = "2026-06-20T05:00:00.000Z"; // Fri 22:00 PT
    const policy: VerbalDeadlinePolicy = { windowHours: 4, businessHoursOnly: true, timeZone: tz, policyVersion: "biz" };
    const deadline = computeVerbalDeadline(received, policy);
    // Monday is 2026-06-22; 00:00 PT = 07:00Z; +2h = 09:00Z.
    expect(deadline).toBe("2026-06-22T09:00:00.000Z");
  });

  it("skips a tenant holiday like a weekend day", () => {
    // Thursday 2026-06-18 23:00 PT (Fri 06:00Z); 4 business hours; Friday 2026-06-19 is a tenant holiday.
    // Thu 23:00–24:00 PT counts (1h), Fri holiday skips, Sat/Sun skip, Mon 00:00–03:00 PT counts (3h).
    const received = "2026-06-19T06:00:00.000Z"; // Thu 23:00 PT
    const policy: VerbalDeadlinePolicy = {
      windowHours: 4,
      businessHoursOnly: true,
      timeZone: tz,
      holidays: ["2026-06-19"],
      policyVersion: "biz",
    };
    const deadline = computeVerbalDeadline(received, policy);
    // Monday 2026-06-22 00:00 PT = 07:00Z; +3h = 10:00Z.
    expect(deadline).toBe("2026-06-22T10:00:00.000Z");
  });
});

describe("§2.3 / §4.9 classifyPreExpiryTier", () => {
  const deadline = "2026-06-24T10:00:00.000Z";

  it("fires the 12h-pre tier (medium) within tolerance", () => {
    const alert = classifyPreExpiryTier(at(Date.parse(deadline) - 12 * HOUR), deadline);
    expect(alert).toEqual({ tier: "twelve_hour", severity: "medium", hoursUntilDeadline: 12 });
  });

  it("fires the 2h-pre tier (high) within tolerance", () => {
    const alert = classifyPreExpiryTier(at(Date.parse(deadline) - 2 * HOUR + 5 * 60_000), deadline);
    expect(alert).toEqual({ tier: "two_hour", severity: "high", hoursUntilDeadline: 2 });
  });

  it("returns null outside both marks", () => {
    expect(classifyPreExpiryTier(at(Date.parse(deadline) - 6 * HOUR), deadline)).toBeNull();
    expect(classifyPreExpiryTier(at(Date.parse(deadline) - 20 * HOUR), deadline)).toBeNull();
  });

  it("does not fire a mark just outside the ±15-min tolerance", () => {
    expect(classifyPreExpiryTier(at(Date.parse(deadline) - 12 * HOUR - 16 * 60_000), deadline)).toBeNull();
  });
});

describe("§2.2 isVerbalExpired / hoursOverdue", () => {
  const deadline = "2026-06-24T10:00:00.000Z";

  it("is millisecond-exact at the boundary", () => {
    expect(isVerbalExpired(deadline, deadline)).toBe(true);
    expect(isVerbalExpired(at(Date.parse(deadline) - 1), deadline)).toBe(false);
    expect(isVerbalExpired(at(Date.parse(deadline) + 1), deadline)).toBe(true);
  });

  it("computes whole hours overdue (never negative)", () => {
    expect(hoursOverdue(at(Date.parse(deadline) + 5 * HOUR + 30 * 60_000), deadline)).toBe(5);
    expect(hoursOverdue(at(Date.parse(deadline) - HOUR), deadline)).toBe(0);
  });
});

describe("§2.2 / W-VO-02 planVerbalExpiry", () => {
  const deadline = "2026-06-24T10:00:00.000Z";

  it("composes the expire transition + verbal-row flip + audit-symmetry discontinuation", () => {
    const t = planVerbalExpiry(at(Date.parse(deadline) + HOUR), deadline);
    expect(t.from).toBe("verbal_pending");
    expect(t.to).toBe("expired_unsigned");
    expect(outboxEvents(t.effects)).toEqual(["m11.order.verbal_expired_unsigned"]);
    expect(t.effects).toContainEqual({ kind: "set_verbal_status", status: "expired_unsigned" });
    expect(t.effects).toContainEqual({ kind: "write_discontinuation", reason: "expired_verbal" });
  });

  it("refuses to expire before the deadline (worker clock guard)", () => {
    expect(() => planVerbalExpiry(at(Date.parse(deadline) - HOUR), deadline)).toThrowError(
      expect.objectContaining({ code: "VERBAL_DEADLINE_NOT_REACHED" }),
    );
  });
});
