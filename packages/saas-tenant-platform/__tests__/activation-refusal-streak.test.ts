// The consecutive-daily-refusal counter for automatic activation, kept in server-controlled
// tenant_account.metadata. Pure: a reducer over (previous state, refusal reason, today).
import { describe, expect, it } from "vitest";
import {
  ACTIVATION_REFUSAL_ALERT_THRESHOLD,
  ACTIVATION_REFUSAL_METADATA_KEY,
  nextActivationRefusal,
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

  it("alerts from the third consecutive day", () => {
    expect(ACTIVATION_REFUSAL_ALERT_THRESHOLD).toBe(3);
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
