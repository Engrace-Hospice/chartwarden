// @chartwarden/inpatient — M37-T06 unit tests for the §2.5 D6 IRC 5-day cap enforcer.
import { describe, expect, it } from "vitest";
import { IpuStateError } from "../src/errors";
import {
  IRC_CAP_OVERRIDE_MAX_DAYS,
  computeIrcState,
  effectiveCapDays,
  isWithinCap,
  planCapOverride,
  planIrcDailyTick,
  resumedStartingDayCount,
} from "../src/machines/irc-episode";

const DAY = 86_400_000;
const outboxOf = (effs: readonly { kind: string; event?: string }[]) =>
  effs.filter((e) => e.kind === "outbox").map((e) => e.event);

describe("cap state from day count (§2.5)", () => {
  it("active days 1–3, approaching day 4, breached day 5+", () => {
    expect(computeIrcState(1)).toBe("active");
    expect(computeIrcState(3)).toBe("active");
    expect(computeIrcState(4)).toBe("approaching_cap");
    expect(computeIrcState(5)).toBe("breached");
    expect(computeIrcState(9)).toBe("breached");
  });

  it("an override extension moves both thresholds out (clamped to 2 days)", () => {
    expect(effectiveCapDays(2)).toBe(7);
    expect(effectiveCapDays(5)).toBe(7); // clamped to +2
    expect(computeIrcState(5, 2)).toBe("active"); // cap now 7, day 5 back to active
    expect(computeIrcState(6, 2)).toBe("approaching_cap");
    expect(computeIrcState(7, 2)).toBe("breached");
  });

  it("within_cap is false only when breached (the ABAC billing gate)", () => {
    expect(isWithinCap("active")).toBe(true);
    expect(isWithinCap("approaching_cap")).toBe(true);
    expect(isWithinCap("breached")).toBe(false);
    expect(isWithinCap("closed")).toBe(true);
  });
});

describe("daily watchdog tick", () => {
  it("emits cap_approaching on entering day 4 and cap_breached on day 5", () => {
    const toApproach = planIrcDailyTick({ consecutiveDayCount: 3, state: "active" });
    expect(toApproach.state).toBe("approaching_cap");
    expect(outboxOf(toApproach.effects)).toEqual(["m37.irc_episode.cap_approaching"]);
    const toBreach = planIrcDailyTick({ consecutiveDayCount: 4, state: "approaching_cap" });
    expect(toBreach.state).toBe("breached");
    expect(outboxOf(toBreach.effects)).toEqual(["m37.irc_episode.cap_breached"]);
  });

  it("is idempotent — re-ticking an already-breached episode emits no new alert", () => {
    const t = planIrcDailyTick({ consecutiveDayCount: 5, state: "breached" });
    expect(t.state).toBe("breached");
    expect(outboxOf(t.effects)).toEqual([]);
    expect(t.consecutiveDayCount).toBe(6);
  });

  it("refuses to tick a closed episode", () => {
    expect(() => planIrcDailyTick({ consecutiveDayCount: 3, state: "closed" })).toThrow(
      IpuStateError,
    );
  });
});

describe("resumption look-back (§2.5 — no reset within 30 days)", () => {
  const now = 100 * DAY;
  it("continues the count from a prior episode closed within 30 days", () => {
    expect(
      resumedStartingDayCount([{ closedAtMs: now - 10 * DAY, consecutiveDayCount: 3 }], now),
    ).toBe(4);
  });
  it("resets to day 1 when the prior episode closed beyond 30 days", () => {
    expect(
      resumedStartingDayCount([{ closedAtMs: now - 40 * DAY, consecutiveDayCount: 3 }], now),
    ).toBe(1);
  });
  it("resets to day 1 with no prior episodes", () => {
    expect(resumedStartingDayCount([], now)).toBe(1);
  });
  it("carries the max count across multiple in-window episodes (blocks the split workaround)", () => {
    expect(
      resumedStartingDayCount(
        [
          { closedAtMs: now - 20 * DAY, consecutiveDayCount: 2 },
          { closedAtMs: now - 5 * DAY, consecutiveDayCount: 3 },
        ],
        now,
      ),
    ).toBe(4);
  });
});

describe("cap override break-glass (§2.5)", () => {
  const ok = { reason: "x".repeat(100), extensionDays: 2, stepUpVerified: true };
  it("grants a valid override and emits cap_override_invoked", () => {
    const r = planCapOverride(ok);
    expect(r.extensionDays).toBe(2);
    expect(outboxOf(r.effects)).toEqual(["m37.irc_episode.cap_override_invoked"]);
  });
  it("requires step-up", () => {
    expect(() => planCapOverride({ ...ok, stepUpVerified: false })).toThrow(
      /IRC_CAP_OVERRIDE_STEP_UP_REQUIRED|step-up/,
    );
  });
  it("requires a 100-char reason", () => {
    try {
      planCapOverride({ ...ok, reason: "short" });
    } catch (e) {
      expect((e as IpuStateError).code).toBe("IRC_CAP_OVERRIDE_REASON_TOO_SHORT");
    }
  });
  it("rejects an extension beyond the 2-day floor", () => {
    try {
      planCapOverride({ ...ok, extensionDays: IRC_CAP_OVERRIDE_MAX_DAYS + 1 });
    } catch (e) {
      expect((e as IpuStateError).code).toBe("IRC_CAP_OVERRIDE_EXTENSION_TOO_LONG");
    }
  });
});
