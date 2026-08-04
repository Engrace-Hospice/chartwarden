// @wardenx/scheduling — §2.2.6 D7 time_off lifecycle + §2.2.5 availability validator — M17-T03.
import { describe, expect, it } from "vitest";
import {
  TIME_OFF_GRAPH,
  assertAvailabilityWindowValid,
  outboxEvents,
  planTimeOffRequested,
  transitionTimeOff,
} from "../src/lifecycle";

describe("§2.2.6 time_off lifecycle", () => {
  it("genesis emits m17.time_off.requested + the supervisor alert", () => {
    const effects = planTimeOffRequested();
    expect(outboxEvents(effects)).toEqual(["m17.time_off.requested"]);
    expect(effects).toContainEqual({ kind: "alert", alert: "time_off_requested" });
  });

  it("terminal states accept no events", () => {
    expect(TIME_OFF_GRAPH.denied).toEqual([]);
    expect(TIME_OFF_GRAPH.cancelled).toEqual([]);
    expect(TIME_OFF_GRAPH.consumed).toEqual([]);
  });

  it("approve triggers the reassignment scan + emits time_off.approved", () => {
    const t = transitionTimeOff("requested", {
      type: "approve",
      approverPresent: true,
      conflictingVisitCount: 3,
    });
    expect(t.to).toBe("approved");
    expect(t.effects).toContainEqual({ kind: "trigger_reassignment_scan" });
    expect(outboxEvents(t.effects)).toEqual(["m17.time_off.approved"]);
  });

  it("approve requires an approver (422)", () => {
    expect(() =>
      transitionTimeOff("requested", {
        type: "approve",
        approverPresent: false,
        conflictingVisitCount: 0,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "TIME_OFF_APPROVER_REQUIRED", statusCode: 422 }),
    );
  });

  it("deny requires a ≥20-char reason and emits time_off.denied", () => {
    const t = transitionTimeOff("requested", {
      type: "deny",
      reason: "Insufficient coverage for that week",
    });
    expect(t.to).toBe("denied");
    expect(outboxEvents(t.effects)).toEqual(["m17.time_off.denied"]);
    expect(() => transitionTimeOff("requested", { type: "deny", reason: "no" })).toThrowError(
      expect.objectContaining({ code: "TIME_OFF_DENIAL_REASON_TOO_SHORT" }),
    );
  });

  it("cancel is pre-start only (409 after start)", () => {
    expect(transitionTimeOff("approved", { type: "cancel", windowStarted: false }).to).toBe(
      "cancelled",
    );
    expect(() =>
      transitionTimeOff("approved", { type: "cancel", windowStarted: true }),
    ).toThrowError(
      expect.objectContaining({ code: "TIME_OFF_CANCEL_AFTER_START", statusCode: 409 }),
    );
  });

  it("consume is system-only and requires the window to have passed", () => {
    expect(
      transitionTimeOff("approved", { type: "consume", isSystemActor: true, windowPassed: true })
        .to,
    ).toBe("consumed");
    expect(() =>
      transitionTimeOff("approved", { type: "consume", isSystemActor: false, windowPassed: true }),
    ).toThrowError(expect.objectContaining({ code: "NOT_SYSTEM_ACTOR" }));
    expect(() =>
      transitionTimeOff("approved", { type: "consume", isSystemActor: true, windowPassed: false }),
    ).toThrowError(expect.objectContaining({ code: "TIME_OFF_WINDOW_NOT_PASSED" }));
  });

  it("rejects an off-graph event (409 ILLEGAL_TIME_OFF_TRANSITION)", () => {
    expect(() =>
      transitionTimeOff("denied", {
        type: "approve",
        approverPresent: true,
        conflictingVisitCount: 0,
      }),
    ).toThrowError(expect.objectContaining({ code: "ILLEGAL_TIME_OFF_TRANSITION" }));
  });
});

describe("§2.2.5 clinician_availability window validation", () => {
  it("accepts a well-ordered window", () => {
    expect(() => assertAvailabilityWindowValid("08:00", "17:00")).not.toThrow();
  });

  it("rejects start >= end (overnight splits into two rows)", () => {
    expect(() => assertAvailabilityWindowValid("22:00", "06:00")).toThrowError(
      expect.objectContaining({ code: "AVAILABILITY_WINDOW_INVALID", statusCode: 422 }),
    );
    expect(() => assertAvailabilityWindowValid("09:00", "09:00")).toThrowError(
      expect.objectContaining({ code: "AVAILABILITY_WINDOW_INVALID" }),
    );
  });
});
