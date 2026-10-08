import { describe, expect, it } from "vitest";
import { availableIncidentActions, incidentActionError } from "./incident-lifecycle";

describe("availableIncidentActions", () => {
  it("offers only the transition the state machine accepts from each state", () => {
    expect(availableIncidentActions("draft").map((a) => a.action)).toEqual(["submit"]);
    expect(availableIncidentActions("under_investigation").map((a) => a.action)).toEqual([
      "resolve",
    ]);
    expect(availableIncidentActions("resolved").map((a) => a.action)).toEqual(["close"]);
    expect(availableIncidentActions("closed_followup_complete").map((a) => a.action)).toEqual([
      "reopen",
    ]);
    expect(availableIncidentActions("reopened").map((a) => a.action)).toEqual(["reopen"]);
  });

  it("offers nothing where the unbuilt triage / investigation surfaces are needed", () => {
    expect(availableIncidentActions("submitted")).toEqual([]);
    expect(availableIncidentActions("triaged")).toEqual([]);
  });

  it("requires a note for resolve and a reason for reopen, nothing for submit/close", () => {
    expect(availableIncidentActions("under_investigation")[0]?.textField?.name).toBe(
      "resolutionNote",
    );
    expect(availableIncidentActions("reopened")[0]?.textField?.name).toBe("reopenReason");
    expect(availableIncidentActions("draft")[0]?.textField).toBeNull();
    expect(availableIncidentActions("resolved")[0]?.textField).toBeNull();
  });
});

describe("incidentActionError", () => {
  it("distinguishes a permission refusal from a stale state and a validation failure", () => {
    expect(incidentActionError(403)).toMatch(/not permitted/i);
    expect(incidentActionError(409)).toMatch(/reload/i);
    expect(incidentActionError(422)).toMatch(/required fields/i);
    expect(incidentActionError(undefined)).toMatch(/could not be reached/i);
  });
});
