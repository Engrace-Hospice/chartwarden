// @chartwarden/idg — §2.2 IDG meeting lifecycle state machine — M14-T03.
import { describe, expect, it } from "vitest";
import {
  MEETING_GRAPH,
  type MeetingEvent,
  outboxEvents,
  planMeetingScheduled,
  transitionMeeting,
} from "../src/lifecycle";

const floorClear = { reviewFloorClear: true, overrideAuthorized: false } as const;

describe("§2.2 transition graph", () => {
  it("scheduled genesis emits meeting.scheduled", () => {
    expect(outboxEvents(planMeetingScheduled())).toEqual(["m14.meeting.scheduled"]);
  });

  it("terminal states accept no events", () => {
    expect(MEETING_GRAPH.adjourned).toEqual([]);
    expect(MEETING_GRAPH.cancelled).toEqual([]);
    expect(MEETING_GRAPH.rescheduled).toEqual([]);
  });

  it("rejects an off-graph event (409 ILLEGAL_MEETING_TRANSITION)", () => {
    expect(() => transitionMeeting("live", { type: "START" })).toThrowError(
      expect.objectContaining({ code: "ILLEGAL_MEETING_TRANSITION", statusCode: 409 }),
    );
    expect(() =>
      transitionMeeting("scheduled", { type: "ADJOURN", stepUpFresh: true }),
    ).toThrowError(expect.objectContaining({ code: "ILLEGAL_MEETING_TRANSITION" }));
  });
});

describe("§2.7 happy path", () => {
  it("BUILD_PACKETS enqueues builds + advances to packets_building", () => {
    const t = transitionMeeting("scheduled", { type: "BUILD_PACKETS", includedPatientCount: 4 });
    expect(t.to).toBe("packets_building");
    expect(t.effects).toContainEqual({ kind: "enqueue_packet_builds" });
    expect(outboxEvents(t.effects)).toEqual(["m14.packets.build_started"]);
  });

  it("BUILD_FAILED returns to scheduled for retry", () => {
    const t = transitionMeeting("packets_building", { type: "BUILD_FAILED" });
    expect(t.to).toBe("scheduled");
    expect(outboxEvents(t.effects)).toEqual([]);
  });

  it("PACKETS_READY emits the T-24h reminder", () => {
    const t = transitionMeeting("packets_building", { type: "PACKETS_READY", builtPacketCount: 4 });
    expect(t.to).toBe("packets_ready");
    expect(outboxEvents(t.effects)).toEqual(["m14.packets.ready"]);
    expect(t.effects).toContainEqual({ kind: "alert", alert: "m14.packets.ready" });
  });

  it("START opens the write path + goes live", () => {
    const t = transitionMeeting("packets_ready", { type: "START" });
    expect(t.to).toBe("live");
    expect(outboxEvents(t.effects)).toEqual(["m14.meeting.started"]);
  });
});

describe("§2.2 D13 ADJOURN — the commit point", () => {
  it("freezes packets, stamps the review floor, bursts decisions + finalizes minutes", () => {
    const t = transitionMeeting("live", { type: "ADJOURN", stepUpFresh: true });
    expect(t.to).toBe("adjourned");
    expect(t.effects).toContainEqual({ kind: "freeze_packets" });
    expect(t.effects).toContainEqual({ kind: "stamp_review_floor" });
    expect(t.effects).toContainEqual({ kind: "emit_open_decisions" });
    expect(t.effects).toContainEqual({ kind: "assign_action_items" });
    expect(t.effects).toContainEqual({ kind: "finalize_minutes" });
    expect(outboxEvents(t.effects)).toEqual([
      "idg.decision_recorded",
      "m14.meeting.adjourned",
      "m14.minutes.signed",
      "m14.packet.frozen",
    ]);
  });

  it("refuses adjournment without fresh step-up (412 STEP_UP_REQUIRED)", () => {
    expect(() => transitionMeeting("live", { type: "ADJOURN", stepUpFresh: false })).toThrowError(
      expect.objectContaining({ code: "STEP_UP_REQUIRED", statusCode: 412 }),
    );
  });
});

describe("§2.2 / M14-F01 per-patient review-floor guard on CANCEL / RESCHEDULE", () => {
  it("CANCEL proceeds when the floor is clear", () => {
    const t = transitionMeeting("scheduled", {
      type: "CANCEL",
      reason: "venue change",
      ...floorClear,
    });
    expect(t.to).toBe("cancelled");
    expect(outboxEvents(t.effects)).toEqual(["m14.meeting.cancelled"]);
  });

  it("RESCHEDULE spawns a new meeting when the floor is clear", () => {
    const t = transitionMeeting("packets_ready", {
      type: "RESCHEDULE",
      reason: "quorum lost",
      ...floorClear,
    });
    expect(t.to).toBe("rescheduled");
    expect(t.effects).toContainEqual({ kind: "spawn_rescheduled_meeting" });
    expect(outboxEvents(t.effects)).toEqual(["m14.meeting.rescheduled"]);
  });

  it("refuses CANCEL that breaches a per-patient floor with no override (422)", () => {
    expect(() =>
      transitionMeeting("scheduled", {
        type: "CANCEL",
        reason: "venue change",
        reviewFloorClear: false,
        overrideAuthorized: false,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "PER_PATIENT_REVIEW_FLOOR_BREACH", statusCode: 422 }),
    );
  });

  it("allows the audited override path and emits review_floor.override_recorded", () => {
    const t = transitionMeeting("scheduled", {
      type: "CANCEL",
      reason: "patient died; no covering meeting needed",
      reviewFloorClear: false,
      overrideAuthorized: true,
      breachingPatients: [{ patientId: "p1", floorAt: "2026-07-01T00:00:00Z" }],
    });
    expect(t.to).toBe("cancelled");
    expect(outboxEvents(t.effects)).toEqual([
      "m14.review_floor.override_recorded",
      "m14.meeting.cancelled",
    ]);
    expect(t.effects).toContainEqual({
      kind: "alert",
      alert: "m14.review_floor.override_recorded",
    });
  });

  it("refuses CANCEL/RESCHEDULE without a reason (422)", () => {
    expect(() =>
      transitionMeeting("scheduled", { type: "CANCEL", reason: "   ", ...floorClear }),
    ).toThrowError(
      expect.objectContaining({ code: "MEETING_TRANSITION_REASON_REQUIRED", statusCode: 422 }),
    );
  });
});
