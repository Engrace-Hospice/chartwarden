// M36 WP 4.4 - the pure rules of the escalation timers: the per-tier window, the deterministic job id, the record cadence.
import { ACK_CLASSES, ACK_DEADLINE_POLICY } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  ACK_TIER_WINDOW_MINUTES,
  escalationJobId,
  isEscalationDue,
  tierWindowMinutes,
} from "../src/ack-requests/ack-timer-rules";

const REQUEST = "00000000-0000-4000-8000-0000000000a1";

describe("tierWindowMinutes (ADR-0056 D4, provisional)", () => {
  it("follows the D4 table: urgent 7 then 5, critical 3 then 2, important halves down to a 5 minute floor", () => {
    expect([1, 2, 3, 9].map((t) => tierWindowMinutes("urgent", t))).toEqual([7, 5, 5, 5]);
    expect([1, 2, 3, 9].map((t) => tierWindowMinutes("critical_symptom", t))).toEqual([3, 2, 2, 2]);
    expect([1, 2, 3, 4, 9].map((t) => tierWindowMinutes("important", t))).toEqual([
      30, 15, 7, 5, 5,
    ]);
  });

  it("tier 0 is the class default and no window ever exceeds the platform maximum or drops below 1 minute", () => {
    for (const ackClass of ACK_CLASSES) {
      const { defaultMinutes, maxMinutes } = ACK_DEADLINE_POLICY[ackClass];
      expect(tierWindowMinutes(ackClass, 0)).toBe(defaultMinutes);
      for (const tier of ACK_TIER_WINDOW_MINUTES[ackClass].keys()) {
        const minutes = tierWindowMinutes(ackClass, tier + 1);
        expect(minutes).toBeGreaterThanOrEqual(1);
        expect(minutes).toBeLessThanOrEqual(maxMinutes);
      }
    }
  });

  it("refuses a negative or non-integer tier", () => {
    expect(() => tierWindowMinutes("urgent", -1)).toThrow();
    expect(() => tierWindowMinutes("urgent", 1.5)).toThrow();
  });
});

describe("escalationJobId", () => {
  it("is deterministic per (request, tier, window deadline) and contains no colon (BullMQ forbids it)", () => {
    const deadline = new Date("2026-10-15T12:00:00.000Z");
    const id = escalationJobId(REQUEST, 0, deadline);
    expect(id).toBe(escalationJobId(REQUEST, 0, new Date(deadline.getTime())));
    expect(id).not.toContain(":");
  });

  it("differs when the tier or the deadline differs (a reassign restarts the window under a new id)", () => {
    const a = new Date("2026-10-15T12:00:00.000Z");
    const b = new Date("2026-10-15T12:15:00.000Z");
    const ids = new Set([
      escalationJobId(REQUEST, 0, a),
      escalationJobId(REQUEST, 1, a),
      escalationJobId(REQUEST, 0, b),
    ]);
    expect(ids.size).toBe(3);
  });
});

describe("isEscalationDue", () => {
  const deadline = new Date("2026-10-15T12:00:00.000Z");
  it("is due at the deadline instant and after, not before", () => {
    expect(isEscalationDue("pending", deadline, new Date(deadline.getTime() - 1))).toBe(false);
    expect(isEscalationDue("pending", deadline, deadline)).toBe(true);
    expect(isEscalationDue("escalated", deadline, new Date(deadline.getTime() + 1))).toBe(true);
  });

  it("only a request nobody has taken can be due", () => {
    for (const status of ["acknowledged", "resolved", "cancelled", "failed_unreachable"] as const) {
      expect(isEscalationDue(status, deadline, new Date(deadline.getTime() + 60_000))).toBe(false);
    }
  });
});
