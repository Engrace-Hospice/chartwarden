import type { CostReportState } from "@wardenx/cost-report";
import {
  COST_REPORT_TRANSITIONS,
  type CostReportTransitionEvent,
  applyTransition,
  canApproveForSubmit,
  canTransition,
} from "@wardenx/cost-report";
// @wardenx/cost-report — M27 lifecycle reducer (§2.2) pure-domain unit tests.
//
// The reducer is a flat transition table over (state, event): every legal edge in
// COST_REPORT_TRANSITIONS must apply, every illegal (state, event) pair must be rejected
// (canTransition=false / applyTransition throws INVALID_TRANSITION), the §2.3 approve_for_submit guard
// must block when unresolved blocking failures > 0 (and fail-closed when the count is absent), and
// `closed` must be terminal.
import { describe, expect, it } from "vitest";

const ALL_STATES: readonly CostReportState[] = [
  "draft",
  "populating",
  "validating",
  "ready_for_review",
  "approved_for_submit",
  "submitted",
  "accepted",
  "rejected",
  "reopened",
  "closed",
];

// approve_for_submit is the only guarded event; supply a passing guard context for table-driven checks.
function ctxFor(event: CostReportTransitionEvent) {
  return event === "approve_for_submit" ? { unresolvedBlockingFailures: 0 } : {};
}

describe("COST_REPORT_TRANSITIONS — every legal edge applies", () => {
  for (const t of COST_REPORT_TRANSITIONS) {
    it(`${t.from} --${t.event}--> ${t.to}`, () => {
      const ctx = ctxFor(t.event);
      expect(canTransition(t.from, t.event, ctx)).toBe(true);
      expect(applyTransition(t.from, t.event, ctx)).toBe(t.to);
    });
  }

  it("the table is non-empty and self-consistent (from/to are valid states)", () => {
    expect(COST_REPORT_TRANSITIONS.length).toBeGreaterThan(0);
    for (const t of COST_REPORT_TRANSITIONS) {
      expect(ALL_STATES).toContain(t.from);
      expect(ALL_STATES).toContain(t.to);
    }
  });
});

describe("illegal transitions are rejected", () => {
  it("draft → submit is illegal (submit only from approved_for_submit)", () => {
    expect(canTransition("draft", "submit")).toBe(false);
    expect(() => applyTransition("draft", "submit")).toThrow(/INVALID_TRANSITION/);
  });

  it("submitted cannot be reset straight to draft (needs reopen → reset_to_draft)", () => {
    expect(canTransition("submitted", "reset_to_draft")).toBe(false);
    expect(() => applyTransition("submitted", "reset_to_draft")).toThrow(/INVALID_TRANSITION/);
  });

  it("validating → submit is illegal", () => {
    expect(canTransition("validating", "submit")).toBe(false);
    expect(() => applyTransition("validating", "submit")).toThrow(/INVALID_TRANSITION/);
  });

  it("reopen is illegal from submitted (only accepted/rejected)", () => {
    expect(canTransition("submitted", "reopen")).toBe(false);
    expect(() => applyTransition("submitted", "reopen")).toThrow(/INVALID_TRANSITION/);
  });

  it("the reopen → reset_to_draft path is the only way back to draft", () => {
    expect(applyTransition("accepted", "reopen")).toBe("reopened");
    expect(applyTransition("reopened", "reset_to_draft")).toBe("draft");
  });
});

describe("§2.3 approve_for_submit guard", () => {
  it("passes only when unresolved blocking failures is exactly 0", () => {
    expect(canApproveForSubmit(0)).toBe(true);
    expect(canApproveForSubmit(1)).toBe(false);
    expect(canApproveForSubmit(5)).toBe(false);
  });

  it("is blocked when unresolved blocking failures > 0", () => {
    expect(
      canTransition("ready_for_review", "approve_for_submit", { unresolvedBlockingFailures: 2 }),
    ).toBe(false);
    expect(() =>
      applyTransition("ready_for_review", "approve_for_submit", { unresolvedBlockingFailures: 2 }),
    ).toThrow(/GUARD_FAILED/);
  });

  it("fails CLOSED when the guard context value is absent", () => {
    expect(canTransition("ready_for_review", "approve_for_submit")).toBe(false);
    expect(() => applyTransition("ready_for_review", "approve_for_submit")).toThrow(/GUARD_FAILED/);
  });

  it("succeeds and reaches approved_for_submit with zero unresolved failures", () => {
    expect(
      applyTransition("ready_for_review", "approve_for_submit", { unresolvedBlockingFailures: 0 }),
    ).toBe("approved_for_submit");
  });
});

describe("closed is terminal", () => {
  it("no transition originates from closed", () => {
    expect(COST_REPORT_TRANSITIONS.some((t) => t.from === "closed")).toBe(false);
  });

  it("every event is rejected out of closed", () => {
    const events: readonly CostReportTransitionEvent[] = [
      "refresh_inputs",
      "validate",
      "validation_complete_pass",
      "validation_complete_fail",
      "approve_for_submit",
      "return_to_draft",
      "submit",
      "record_acknowledgment",
      "record_rejection",
      "reopen",
      "reset_to_draft",
      "offboard",
    ];
    for (const event of events) {
      expect(canTransition("closed", event, ctxFor(event))).toBe(false);
      expect(() => applyTransition("closed", event, ctxFor(event))).toThrow(/INVALID_TRANSITION/);
    }
  });
});
