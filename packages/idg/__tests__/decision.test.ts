// @wardenx/idg — §2.6 / §2.7 decision recording, quorum, adjournment emission — M14-T03.
import { describe, expect, it } from "vitest";
import {
  evaluateQuorum,
  decisionMeetsQuorum,
  isActionableDecisionKind,
  planDecisionRecord,
  planDecisionEmit,
  planDecisionSupersede,
  outboxEvents,
} from "../src/lifecycle";

const FULL_QUORUM = ["rn_case_manager", "msw", "chaplain", "medical_director"];

describe("§1.1 / D3 quorum evaluation", () => {
  it("is met when every required slot has a present satisfier (either-of resolves)", () => {
    const q = evaluateQuorum([...FULL_QUORUM, "aide"]);
    expect(q.met).toBe(true);
    expect(q.missingDisciplines).toEqual([]);
    expect(decisionMeetsQuorum(q)).toBe(true);
  });

  it("resolves the hospice_physician|medical_director either-of slot via either option", () => {
    expect(evaluateQuorum(["rn_case_manager", "msw", "chaplain", "hospice_physician"]).met).toBe(true);
  });

  it("reports the missing slots when disciplines are absent", () => {
    const q = evaluateQuorum(["rn_case_manager", "msw"]);
    expect(q.met).toBe(false);
    expect(q.missingDisciplines).toEqual(["chaplain", "hospice_physician|medical_director"]);
  });

  it("de-duplicates present disciplines", () => {
    expect(evaluateQuorum(["rn_case_manager", "rn_case_manager"]).presentDisciplines).toEqual(["rn_case_manager"]);
  });
});

describe("§2.7 record (genesis)", () => {
  it("records an open quorate decision with no idg.decision_recorded yet", () => {
    const r = planDecisionRecord({ meetingIsLive: true, patientIncluded: true, presentDisciplines: FULL_QUORUM });
    expect(r.status).toBe("open");
    expect(r.wasQuorate).toBe(true);
    expect(outboxEvents(r.effects)).toEqual(["m14.decision.recorded_open"]);
  });

  it("records a non-quorate decision but flags the coordinator (low-severity alert)", () => {
    const r = planDecisionRecord({ meetingIsLive: true, patientIncluded: true, presentDisciplines: ["rn_case_manager"] });
    expect(r.wasQuorate).toBe(false);
    expect(r.effects).toContainEqual({ kind: "alert", alert: "m14.decision.non_quorate" });
  });

  it("refuses a write when the meeting is not live (422 MEETING_NOT_LIVE)", () => {
    expect(() =>
      planDecisionRecord({ meetingIsLive: false, patientIncluded: true, presentDisciplines: FULL_QUORUM }),
    ).toThrowError(expect.objectContaining({ code: "MEETING_NOT_LIVE", statusCode: 422 }));
  });

  it("refuses a write against a patient off the caseload (422 INCLUSION_CRITERIA_FAILED)", () => {
    expect(() =>
      planDecisionRecord({ meetingIsLive: true, patientIncluded: false, presentDisciplines: FULL_QUORUM }),
    ).toThrowError(expect.objectContaining({ code: "INCLUSION_CRITERIA_FAILED", statusCode: 422 }));
  });
});

describe("§2.7 emit (adjournment burst)", () => {
  it("an actionable kind flips open→emitted and publishes idg.decision_recorded", () => {
    const e = planDecisionEmit({ status: "open", kind: "order_request" });
    expect(outboxEvents(e)).toEqual(["idg.decision_recorded"]);
    expect(e).toContainEqual({ kind: "set_timestamp", field: "emitted_at" });
  });

  it("team_note flips to emitted for the minutes with NO downstream event", () => {
    expect(isActionableDecisionKind("team_note")).toBe(false);
    expect(outboxEvents(planDecisionEmit({ status: "open", kind: "team_note" }))).toEqual([]);
  });

  it("refuses emit of an already-superseded decision (409)", () => {
    expect(() => planDecisionEmit({ status: "superseded", kind: "order_request" })).toThrowError(
      expect.objectContaining({ code: "DECISION_SUPERSEDED", statusCode: 409 }),
    );
  });

  it("refuses emit of a non-open decision (409 DECISION_NOT_OPEN)", () => {
    expect(() => planDecisionEmit({ status: "emitted", kind: "order_request" })).toThrowError(
      expect.objectContaining({ code: "DECISION_NOT_OPEN", statusCode: 409 }),
    );
  });
});

describe("§2.8 supersede", () => {
  it("supersedes an emitted decision", () => {
    const e = planDecisionSupersede({ status: "emitted" });
    expect(e).toContainEqual({ kind: "set_timestamp", field: "superseded_at" });
  });

  it("refuses to re-supersede (409 DECISION_SUPERSEDED)", () => {
    expect(() => planDecisionSupersede({ status: "superseded" })).toThrowError(
      expect.objectContaining({ code: "DECISION_SUPERSEDED" }),
    );
  });

  it("refuses to supersede an uncommitted (open) decision (409 DECISION_NOT_OPEN)", () => {
    expect(() => planDecisionSupersede({ status: "open" })).toThrowError(
      expect.objectContaining({ code: "DECISION_NOT_OPEN" }),
    );
  });
});
