// The consecutive-daily-refusal counter for automatic activation, kept in server-controlled
// tenant_account.metadata. Pure: a reducer over (previous state, refusal reason, today).
import { describe, expect, it } from "vitest";
import {
  ACTIVATION_REFUSAL_ALERT_THRESHOLD,
  ACTIVATION_REFUSAL_METADATA_KEY,
  nextActivationRefusal,
  shouldAlertActivationRefusal,
  withActivationRefusal,
  withoutActivationRefusal,
} from "../src/services/activation-refusal-streak";

const D1 = "2026-10-10";
const D2 = "2026-10-11";
const D4 = "2026-10-13";

describe("nextActivationRefusal", () => {
  it("starts a streak at 1 when nothing is recorded", () => {
    expect(nextActivationRefusal(undefined, "BAA_NOT_EXECUTED", D1)).toEqual({
      state: { reason: "BAA_NOT_EXECUTED", days: 1, lastDay: D1 },
      advanced: true,
    });
  });

  it("counts the next consecutive day with the same reason", () => {
    const prev = { reason: "BAA_NOT_EXECUTED", days: 1, lastDay: D1 };
    expect(nextActivationRefusal(prev, "BAA_NOT_EXECUTED", D2).state.days).toBe(2);
  });

  it("does not double count a retried sweep on the same day", () => {
    const prev = { reason: "BAA_NOT_EXECUTED", days: 2, lastDay: D2 };
    expect(nextActivationRefusal(prev, "BAA_NOT_EXECUTED", D2)).toEqual({
      state: prev,
      advanced: false,
    });
  });

  it("restarts at 1 when the reason class changes", () => {
    const prev = { reason: "BAA_NOT_EXECUTED", days: 2, lastDay: D1 };
    expect(nextActivationRefusal(prev, "TASKS_NOT_SETTLED", D2).state).toEqual({
      reason: "TASKS_NOT_SETTLED",
      days: 1,
      lastDay: D2,
    });
  });

  it("restarts at 1 after a skipped day (not consecutive)", () => {
    const prev = { reason: "X", days: 2, lastDay: D1 };
    expect(nextActivationRefusal(prev, "X", D4).state.days).toBe(1);
  });

  it("treats malformed stored state as absent", () => {
    expect(nextActivationRefusal({ days: "lots" }, "X", D1).state.days).toBe(1);
  });

  it("counts across a month boundary", () => {
    const prev = { reason: "X", days: 4, lastDay: "2026-01-31" };
    expect(nextActivationRefusal(prev, "X", "2026-02-01").state.days).toBe(5);
  });

  it("counts across a year boundary", () => {
    const prev = { reason: "X", days: 4, lastDay: "2026-12-31" };
    expect(nextActivationRefusal(prev, "X", "2027-01-01").state.days).toBe(5);
  });

  it("restarts at 1 when the reason flips and again when it flips back", () => {
    const a1 = nextActivationRefusal(undefined, "A", D1).state;
    const a2 = nextActivationRefusal(a1, "A", D2).state;
    const b = nextActivationRefusal(a2, "B", "2026-10-12").state;
    const a3 = nextActivationRefusal(b, "A", "2026-10-13").state;
    expect([a2.days, b.days, a3.days]).toEqual([2, 1, 1]);
  });
});

describe("metadata helpers", () => {
  it("sets and clears only its own key, without mutating the input", () => {
    const meta = Object.freeze({ keep: 1 });
    const state = { reason: "X", days: 1, lastDay: D1 };
    const set = withActivationRefusal(meta, state);
    expect(set).toEqual({ keep: 1, [ACTIVATION_REFUSAL_METADATA_KEY]: state });
    expect(withoutActivationRefusal(set)).toEqual({ keep: 1 });
    expect(meta).toEqual({ keep: 1 });
  });
});

describe("alert condition over the real reducer", () => {
  it("pins the policy: alert from the third consecutive daily refusal", () => {
    expect(ACTIVATION_REFUSAL_ALERT_THRESHOLD).toBe(3);
  });

  const T = ACTIVATION_REFUSAL_ALERT_THRESHOLD;
  const dayN = (n: number) => new Date(Date.UTC(2026, 11, 20 + n)).toISOString().slice(0, 10);

  /** Feed `count` consecutive daily refusals; return the alert decision for each day. */
  function alertsOverDays(count: number): boolean[] {
    let stored: unknown;
    const out: boolean[] = [];
    for (let n = 0; n < count; n++) {
      const { state, advanced } = nextActivationRefusal(stored, "BAA_NOT_EXECUTED", dayN(n));
      stored = state;
      out.push(shouldAlertActivationRefusal({ days: state.days, advanced }));
    }
    return out;
  }

  it("flips from quiet to alerting exactly on day THRESHOLD, and keeps alerting after it", () => {
    const decisions = alertsOverDays(T + 2);
    expect(decisions.slice(0, T - 1).every((d) => d === false)).toBe(true);
    expect(decisions[T - 1]).toBe(true);
    expect(decisions[T]).toBe(true); // day THRESHOLD + 1 alerts too
    expect(decisions[T + 1]).toBe(true);
  });

  it("does not alert on a same-day retry even past the threshold", () => {
    const state = { reason: "X", days: T + 1, lastDay: D1 };
    const { advanced } = nextActivationRefusal(state, "X", D1);
    expect(shouldAlertActivationRefusal({ days: state.days, advanced })).toBe(false);
  });

  it("a reason flip mid-streak silences the alert until it re-reaches the threshold", () => {
    let stored: unknown;
    for (let n = 0; n < T; n++) stored = nextActivationRefusal(stored, "A", dayN(n)).state;
    const flipped = nextActivationRefusal(stored, "B", dayN(T));
    expect(
      shouldAlertActivationRefusal({ days: flipped.state.days, advanced: flipped.advanced }),
    ).toBe(false);
  });
});
