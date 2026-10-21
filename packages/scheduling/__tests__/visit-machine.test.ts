// @chartwarden/scheduling — §2.2.1 D3 visit lifecycle state machine — M17-T03.
import { describe, expect, it } from "vitest";
import {
  VISIT_GRAPH,
  type VisitEvent,
  outboxEvents,
  planVisitProposed,
  transitionVisit,
} from "../src/lifecycle";

const evvSource = { via: "evv" } as const;
const selfAttest = {
  via: "self_attest",
  evvMissingReason:
    "Cell signal failure at patient location — verified by patient signature on tablet",
  stepUpSatisfied: true,
} as const;

describe("§2.2.1 transition graph", () => {
  it("genesis factory emits m17.visit.proposed + a genesis history row", () => {
    const effects = planVisitProposed();
    expect(outboxEvents(effects)).toEqual(["m17.visit.proposed"]);
    expect(effects).toContainEqual({
      kind: "write_state_history",
      from: "proposed",
      to: "proposed",
      reason: null,
      systemDriven: true,
    });
  });

  it("terminal states accept no events", () => {
    expect(VISIT_GRAPH.completed).toEqual([]);
    expect(VISIT_GRAPH.cancelled).toEqual([]);
    expect(VISIT_GRAPH.no_show).toEqual([]);
    expect(VISIT_GRAPH.rescheduled).toEqual([]);
  });

  it("rejects an off-graph event (409 ILLEGAL_VISIT_TRANSITION)", () => {
    expect(() => transitionVisit("proposed", { type: "start", source: evvSource })).toThrowError(
      expect.objectContaining({ code: "ILLEGAL_VISIT_TRANSITION", statusCode: 409 }),
    );
    expect(() =>
      transitionVisit("completed", {
        type: "cancel",
        reason: "x".repeat(20),
        cancelledByPresent: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "ILLEGAL_VISIT_TRANSITION" }));
  });
});

describe("§2.2.1 publish (proposed → published)", () => {
  it("emits visit.assigned + visit.published and appends history when the gate passes", () => {
    const t = transitionVisit("proposed", { type: "publish", gatePassed: true });
    expect(t.to).toBe("published");
    expect(outboxEvents(t.effects)).toEqual(["m17.visit.assigned", "m17.visit.published"]);
    expect(t.effects).toContainEqual({
      kind: "write_state_history",
      from: "proposed",
      to: "published",
      reason: null,
      systemDriven: false,
    });
    expect(t.effects).toContainEqual({ kind: "bump_version" });
    expect(t.effects).toContainEqual({ kind: "audit" });
  });

  it("refuses to publish when the D8 pre-schedule gate is unmet (422)", () => {
    expect(() => transitionVisit("proposed", { type: "publish", gatePassed: false })).toThrowError(
      expect.objectContaining({ code: "VISIT_PRE_SCHEDULE_GATE_UNMET", statusCode: 422 }),
    );
  });

  it("dismiss (proposal rejected) cancels with no caseload/seeding event", () => {
    const t = transitionVisit("proposed", { type: "dismiss", reason: "duplicate proposal" });
    expect(t.to).toBe("cancelled");
    expect(outboxEvents(t.effects)).toEqual([]);
  });
});

describe("§2.2.1 EVV-authoritative vs self-attest advance", () => {
  it("EVV-driven start is system-driven and sets evv_present", () => {
    const t = transitionVisit("published", { type: "start", source: evvSource });
    expect(t.to).toBe("en_route");
    expect(outboxEvents(t.effects)).toEqual(["m17.visit.started"]);
    expect(t.effects).toContainEqual({ kind: "set_evv_bracket", state: "evv_present" });
    expect(t.effects).toContainEqual({
      kind: "write_state_history",
      from: "published",
      to: "en_route",
      reason: null,
      systemDriven: true,
    });
  });

  it("self-attest start sets evv_missing_documented, captures the reason, and is human-driven", () => {
    const t = transitionVisit("published", { type: "start", source: selfAttest });
    expect(t.to).toBe("en_route");
    expect(t.effects).toContainEqual({ kind: "set_evv_bracket", state: "evv_missing_documented" });
    expect(t.effects).toContainEqual({
      kind: "capture_reason",
      field: "evv_missing_reason",
      value: selfAttest.evvMissingReason,
    });
    expect(t.effects).toContainEqual({
      kind: "write_state_history",
      from: "published",
      to: "en_route",
      reason: null,
      systemDriven: false,
    });
  });

  it("self-attest requires the SESSION_POLICY step-up (403)", () => {
    expect(() =>
      transitionVisit("published", {
        type: "start",
        source: { ...selfAttest, stepUpSatisfied: false },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "EVV_SELF_ATTEST_STEP_UP_REQUIRED", statusCode: 403 }),
    );
  });

  it("self-attest reason must be ≥ 40 chars (422)", () => {
    expect(() =>
      transitionVisit("published", {
        type: "start",
        source: { ...selfAttest, evvMissingReason: "too short" },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "EVV_MISSING_REASON_TOO_SHORT", statusCode: 422 }),
    );
  });

  it("arrive advances en_route → in_visit (self-attest re-runs the same guards)", () => {
    const t = transitionVisit("en_route", { type: "arrive", source: evvSource });
    expect(t.to).toBe("in_visit");
    expect(t.effects).toContainEqual({ kind: "set_evv_bracket", state: "evv_present" });
  });
});

describe("§2.2.1 complete / cancel / reschedule / no_show", () => {
  it("complete requires the system actor (m8.encounter.signed) and emits visit.completed", () => {
    const t = transitionVisit("in_visit", { type: "complete", isSystemActor: true });
    expect(t.to).toBe("completed");
    expect(outboxEvents(t.effects)).toEqual(["m17.visit.completed"]);
    expect(() =>
      transitionVisit("in_visit", { type: "complete", isSystemActor: false }),
    ).toThrowError(expect.objectContaining({ code: "NOT_SYSTEM_ACTOR", statusCode: 403 }));
  });

  it("cancel needs cancelled_by + a ≥20-char reason; emits unassigned + cancelled", () => {
    const t = transitionVisit("published", {
      type: "cancel",
      reason: "Patient admitted to inpatient unit today",
      cancelledByPresent: true,
    });
    expect(t.to).toBe("cancelled");
    expect(outboxEvents(t.effects)).toEqual(["m17.visit.unassigned", "m17.visit.cancelled"]);
    expect(t.effects).toContainEqual({
      kind: "capture_reason",
      field: "cancellation_reason",
      value: "Patient admitted to inpatient unit today",
    });
    expect(() =>
      transitionVisit("published", { type: "cancel", reason: "short", cancelledByPresent: true }),
    ).toThrowError(expect.objectContaining({ code: "VISIT_CANCELLATION_REASON_TOO_SHORT" }));
    expect(() =>
      transitionVisit("published", {
        type: "cancel",
        reason: "x".repeat(20),
        cancelledByPresent: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "VISIT_CANCELLED_BY_REQUIRED" }));
  });

  it("cancel is legal from en_route and in_visit (rare, documented)", () => {
    expect(
      transitionVisit("en_route", {
        type: "cancel",
        reason: "x".repeat(20),
        cancelledByPresent: true,
      }).to,
    ).toBe("cancelled");
    expect(
      transitionVisit("in_visit", {
        type: "cancel",
        reason: "x".repeat(20),
        cancelledByPresent: true,
      }).to,
    ).toBe("cancelled");
  });

  it("reschedule needs a ≥20-char reason; links the new visit and emits unassigned + rescheduled", () => {
    const t = transitionVisit("published", {
      type: "reschedule",
      reason: "Clinician PTO approved for that day",
    });
    expect(t.to).toBe("rescheduled");
    expect(outboxEvents(t.effects)).toEqual(["m17.visit.unassigned", "m17.visit.rescheduled"]);
    expect(t.effects).toContainEqual({ kind: "link_rescheduled_into" });
    expect(() => transitionVisit("published", { type: "reschedule", reason: "nope" })).toThrowError(
      expect.objectContaining({ code: "VISIT_RESCHEDULE_REASON_TOO_SHORT" }),
    );
  });

  it("no_show emits unassigned + no_show_detected (reason optional)", () => {
    const t = transitionVisit("published", { type: "no_show" });
    expect(t.to).toBe("no_show");
    expect(outboxEvents(t.effects)).toEqual(["m17.visit.unassigned", "m17.visit.no_show_detected"]);
    const withReason = transitionVisit("published", { type: "no_show", reason: "patient at ER" });
    expect(withReason.effects).toContainEqual({
      kind: "capture_reason",
      field: "no_show_reason",
      value: "patient at ER",
    });
  });
});
