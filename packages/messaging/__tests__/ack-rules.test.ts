// M36 WP 4.2 - the acknowledgment-request state machine and deadline policy (pure).
import { ACK_CLASSES, ACK_DEADLINE_POLICY, ACK_STATUSES, type AckStatus } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  ACK_TRANSITIONS,
  ackClassFor,
  assertTransition,
  canTransition,
  defaultDeadline,
  maxDeadline,
  viewerActionsFor,
} from "../src/ack-requests/ack-rules";

describe("ack state machine", () => {
  it("terminal states have no way out", () => {
    expect(ACK_TRANSITIONS.resolved).toEqual([]);
    expect(ACK_TRANSITIONS.cancelled).toEqual([]);
  });

  it("resolving needs an acknowledgment first (pending cannot resolve)", () => {
    expect(canTransition("pending", "resolved")).toBe(false);
    expect(canTransition("escalated", "resolved")).toBe(false);
    expect(canTransition("acknowledged", "resolved")).toBe(true);
  });

  it("failed_unreachable is never terminal in effect", () => {
    expect(ACK_TRANSITIONS.failed_unreachable).toEqual(
      expect.arrayContaining(["acknowledged", "resolved", "pending", "cancelled"]),
    );
  });

  it("every status appears as a key and only lists known statuses", () => {
    for (const status of ACK_STATUSES) {
      expect(ACK_TRANSITIONS).toHaveProperty(status);
      for (const to of ACK_TRANSITIONS[status]) expect(ACK_STATUSES).toContain(to);
      expect(ACK_TRANSITIONS[status]).not.toContain(status);
    }
  });

  it("assertTransition raises the 409 conflict code for an illegal move", () => {
    expect(() => assertTransition("resolved", "pending")).toThrowError(
      expect.objectContaining({ code: "ACK_STATE_INVALID", statusCode: 409 }),
    );
    expect(() => assertTransition("pending", "acknowledged")).not.toThrow();
  });
});

describe("ack deadline policy", () => {
  const start = new Date("2026-10-15T12:00:00.000Z");

  it.each(ACK_CLASSES)("the %s default never exceeds its maximum", (ackClass) => {
    const { defaultMinutes, maxMinutes } = ACK_DEADLINE_POLICY[ackClass];
    expect(defaultMinutes).toBeLessThanOrEqual(maxMinutes);
    expect(defaultDeadline(ackClass, start).getTime()).toBeLessThanOrEqual(
      maxDeadline(ackClass, start).getTime(),
    );
  });

  it("uses the D4 table: important 60/120, urgent 15/30, critical 5/10", () => {
    expect(defaultDeadline("important", start).toISOString()).toBe("2026-10-15T13:00:00.000Z");
    expect(maxDeadline("important", start).toISOString()).toBe("2026-10-15T14:00:00.000Z");
    expect(defaultDeadline("urgent", start).toISOString()).toBe("2026-10-15T12:15:00.000Z");
    expect(maxDeadline("urgent", start).toISOString()).toBe("2026-10-15T12:30:00.000Z");
    expect(defaultDeadline("critical_symptom", start).toISOString()).toBe(
      "2026-10-15T12:05:00.000Z",
    );
    expect(maxDeadline("critical_symptom", start).toISOString()).toBe("2026-10-15T12:10:00.000Z");
  });

  it("derives the class from the message urgency, never from a caller", () => {
    expect(ackClassFor("urgent")).toBe("urgent");
    expect(ackClassFor("routine")).toBe("important");
    expect(ackClassFor("important")).toBe("important");
  });
});

describe("viewer hints", () => {
  const base = { requester_user_id: "req", assigned_user_id: "ass" };
  const hints = (status: AckStatus, viewer: string) =>
    viewerActionsFor({ ...base, status }, viewer);

  it("only the assignee is offered acknowledge, and only while it is waiting", () => {
    expect(hints("pending", "ass").can_acknowledge).toBe(true);
    expect(hints("pending", "req").can_acknowledge).toBe(false);
    expect(hints("pending", "other").can_acknowledge).toBe(false);
    expect(hints("acknowledged", "ass").can_acknowledge).toBe(false);
    expect(hints("resolved", "ass").can_acknowledge).toBe(false);
  });

  it("resolve is offered to the assignee after acknowledging only", () => {
    expect(hints("acknowledged", "ass").can_resolve).toBe(true);
    expect(hints("pending", "ass").can_resolve).toBe(false);
    expect(hints("acknowledged", "req").can_resolve).toBe(false);
  });

  it("reassign is offered to the two parties while the request is open", () => {
    expect(hints("pending", "req").can_reassign).toBe(true);
    expect(hints("acknowledged", "ass").can_reassign).toBe(true);
    expect(hints("pending", "other").can_reassign).toBe(false);
    expect(hints("cancelled", "req").can_reassign).toBe(false);
  });
});
