// @chartwarden/emar — §2.2 D6 administration-record lifecycle state machine — M13-T03.
import { describe, expect, it } from "vitest";
import {
  ADMINISTRATION_GRAPH,
  type AdministrationSideEffect,
  type RecordAdministrationInput,
  VOID_REASON_MIN_LENGTH,
  planRecordAdministration,
  planRecordCaregiverAttested,
  transitionAdministration,
} from "../src/lifecycle";

/** Collect the `m13.*` outbox events a transition declares (order-preserving). */
function outboxEvents(effects: ReadonlyArray<AdministrationSideEffect>): string[] {
  return effects
    .filter((e): e is Extract<AdministrationSideEffect, { kind: "outbox" }> => e.kind === "outbox")
    .map((e) => e.event);
}

/** Collect the typed M36 alerts a transition declares. */
function alerts(effects: ReadonlyArray<AdministrationSideEffect>): string[] {
  return effects
    .filter((e): e is Extract<AdministrationSideEffect, { kind: "alert" }> => e.kind === "alert")
    .map((e) => e.alert);
}

/** Collect the side-effect `kind`s a transition declares. */
function kinds(effects: ReadonlyArray<AdministrationSideEffect>): string[] {
  return effects.map((e) => e.kind);
}

const goodGate: RecordAdministrationInput = {
  administeringClinicianEligible: true,
  isControlled: false,
  witnessEligible: false,
  m12AllowAdministration: true,
  fiveRightsPassed: true,
  lateEntryTierResolved: true,
};

// The commit event's PAYLOAD only. `type` used to live here too, so every call site's explicit
// `{ type: "commit", ...goodCommit }` was silently overwritten by the spread — harmless while both said
// "commit", and it would have quietly discarded any call site that meant a different event.
const goodCommit = {
  isControlled: false,
  hasWastage: false,
  isPrn: false,
  isScheduled: false,
  hasOpenEncounter: false,
  isComfortKitDrawdown: false,
  kitDrawdownSucceeded: true,
  perAdministrationPdfRequired: false,
};

describe("§2.2 transition graph", () => {
  it("terminal states accept no events", () => {
    expect(ADMINISTRATION_GRAPH.superseded).toEqual([]);
    expect(ADMINISTRATION_GRAPH.voided).toEqual([]);
  });
  it("rejects an event illegal from the current state", () => {
    expect(() => transitionAdministration("committed", { type: "commit", ...goodCommit })).toThrow(
      /cannot commit from 'committed'/,
    );
  });
});

describe("§2.2 D6 recordAdministration gate", () => {
  it("a clean gate enters committing and audits the intent", () => {
    const t = planRecordAdministration(goodGate);
    expect(t.to).toBe("committing");
    expect(kinds(t.effects)).toEqual(["audit"]);
    expect(outboxEvents(t.effects)).toEqual([]); // no outbox until commit
  });
  it("an ineligible administering clinician is refused", () => {
    expect(() =>
      planRecordAdministration({ ...goodGate, administeringClinicianEligible: false }),
    ).toThrow(expect.objectContaining({ code: "ADMINISTERING_CLINICIAN_NOT_ELIGIBLE" }));
  });
  it("a controlled order requires an eligible witness", () => {
    expect(() =>
      planRecordAdministration({ ...goodGate, isControlled: true, witnessEligible: false }),
    ).toThrow(expect.objectContaining({ code: "CONTROLLED_WITNESS_NOT_ELIGIBLE" }));
    // …and passes when the witness is eligible.
    expect(
      planRecordAdministration({ ...goodGate, isControlled: true, witnessEligible: true }).to,
    ).toBe("committing");
  });
  it("an M12 block (order not active) is refused", () => {
    expect(() => planRecordAdministration({ ...goodGate, m12AllowAdministration: false })).toThrow(
      expect.objectContaining({ code: "ADMINISTRATION_BLOCKED" }),
    );
  });
  it("a five-rights failure is refused", () => {
    expect(() => planRecordAdministration({ ...goodGate, fiveRightsPassed: false })).toThrow(
      expect.objectContaining({ code: "FIVE_RIGHTS_VIOLATION" }),
    );
  });
  it("an unresolved late-entry tier is refused", () => {
    expect(() => planRecordAdministration({ ...goodGate, lateEntryTierResolved: false })).toThrow(
      expect.objectContaining({ code: "LATE_ENTRY_TIER_UNRESOLVED" }),
    );
  });
});

describe("§2.2 commit", () => {
  it("a plain single dose commits with audit + recorded outbox", () => {
    const t = transitionAdministration("committing", { type: "commit", ...goodCommit });
    expect(t.to).toBe("committed");
    expect(outboxEvents(t.effects)).toEqual(["m13.administration.recorded"]);
  });
  it("a controlled administration adds the witnessed event; wastage adds the wasted event", () => {
    const t = transitionAdministration("committing", {
      type: "commit",
      ...goodCommit,
      isControlled: true,
      hasWastage: true,
    });
    expect(outboxEvents(t.effects)).toEqual([
      "m13.administration.recorded",
      "m13.administration.controlled_witnessed",
      "m13.administration.controlled_wasted",
    ]);
  });
  it("a PRN administration emits the reassessment trigger (D3)", () => {
    const t = transitionAdministration("committing", {
      type: "commit",
      ...goodCommit,
      isPrn: true,
    });
    expect(kinds(t.effects)).toContain("emit_prn_reassessment_trigger");
    expect(outboxEvents(t.effects)).toContain("m13.prn_administration_recorded");
  });
  it("a scheduled administration links the scheduled dose; an in-flight encounter auto-links (D9)", () => {
    const t = transitionAdministration("committing", {
      type: "commit",
      ...goodCommit,
      isScheduled: true,
      hasOpenEncounter: true,
    });
    expect(kinds(t.effects)).toContain("link_scheduled_dose");
    expect(kinds(t.effects)).toContain("link_encounter");
  });
  it("a kit drawdown that would go negative is rejected (D5)", () => {
    expect(() =>
      transitionAdministration("committing", {
        type: "commit",
        ...goodCommit,
        isComfortKitDrawdown: true,
        kitDrawdownSucceeded: false,
      }),
    ).toThrow(expect.objectContaining({ code: "KIT_INSUFFICIENT_QUANTITY" }));
  });
  it("a kit drawdown that reconciles decrements the drawdown", () => {
    const t = transitionAdministration("committing", {
      type: "commit",
      ...goodCommit,
      isComfortKitDrawdown: true,
      kitDrawdownSucceeded: true,
    });
    expect(kinds(t.effects)).toContain("decrement_kit_drawdown");
  });
  it("per-administration PDF policy requests the document (IPU, D9)", () => {
    const t = transitionAdministration("committing", {
      type: "commit",
      ...goodCommit,
      perAdministrationPdfRequired: true,
    });
    expect(outboxEvents(t.effects)).toContain("m13.administration_record.document_requested");
  });
});

describe("§2.9 D10 caregiver-attested path", () => {
  const goodCaregiver = {
    actorIsCaregiver: true,
    m12AllowAdministration: true,
    fiveRightsPassed: true,
    attestationRecorded: true,
  };
  it("enters pending_caregiver_review with requires_rn_review + the pending alert", () => {
    const t = planRecordCaregiverAttested(goodCaregiver);
    expect(t.to).toBe("pending_caregiver_review");
    expect(outboxEvents(t.effects)).toEqual(["m13.administration.recorded_caregiver_attested"]);
    expect(alerts(t.effects)).toEqual(["m13.caregiver_attested_pending_review"]);
    expect(t.effects).toContainEqual({ kind: "set_requires_rn_review", value: true });
  });
  it("a non-caregiver actor is refused", () => {
    expect(() =>
      planRecordCaregiverAttested({ ...goodCaregiver, actorIsCaregiver: false }),
    ).toThrow(expect.objectContaining({ code: "CAREGIVER_ACTOR_REQUIRED" }));
  });
  it("a missing attestation is refused", () => {
    expect(() =>
      planRecordCaregiverAttested({ ...goodCaregiver, attestationRecorded: false }),
    ).toThrow(expect.objectContaining({ code: "CAREGIVER_ATTESTATION_REQUIRED" }));
  });
  it("a case manager on caseload acknowledges → committed", () => {
    const t = transitionAdministration("pending_caregiver_review", {
      type: "acknowledgeByCaseManager",
      caseManagerOnCaseload: true,
    });
    expect(t.to).toBe("committed");
    expect(outboxEvents(t.effects)).toEqual(["m13.caregiver_administration.acknowledged"]);
    expect(t.effects).toContainEqual({ kind: "set_requires_rn_review", value: false });
  });
  it("an acknowledgment by a clinician not on caseload is refused", () => {
    expect(() =>
      transitionAdministration("pending_caregiver_review", {
        type: "acknowledgeByCaseManager",
        caseManagerOnCaseload: false,
      }),
    ).toThrow(expect.objectContaining({ code: "CASE_MANAGER_ACK_NOT_PERMITTED" }));
  });
});

describe("§5.12 supersede + §2.2 void", () => {
  it("the correction trigger supersedes the original (system actor only)", () => {
    const t = transitionAdministration("committed", { type: "supersede", isSystemActor: true });
    expect(t.to).toBe("superseded");
    expect(outboxEvents(t.effects)).toEqual(["m13.administration.corrected"]);
  });
  it("a human-actor supersede is refused", () => {
    expect(() =>
      transitionAdministration("committed", { type: "supersede", isSystemActor: false }),
    ).toThrow(expect.objectContaining({ code: "NOT_SYSTEM_ACTOR" }));
  });
  it("a permitted, stepped-up void with a long reason flips to voided + high-severity alert", () => {
    const reason = "Wrong patient selected from the eMAR list; recorded in error, voiding the row.";
    expect(reason.length).toBeGreaterThanOrEqual(VOID_REASON_MIN_LENGTH);
    const t = transitionAdministration("committed", {
      type: "void",
      hasVoidPermission: true,
      stepUpCompleted: true,
      reason,
    });
    expect(t.to).toBe("voided");
    expect(outboxEvents(t.effects)).toEqual(["m13.administration.voided"]);
    expect(alerts(t.effects)).toEqual(["m13.administration_voided"]);
  });
  it("void without permission / step-up / a long-enough reason is refused", () => {
    const base = {
      type: "void" as const,
      hasVoidPermission: true,
      stepUpCompleted: true,
      reason: "x".repeat(40),
    };
    expect(() =>
      transitionAdministration("committed", { ...base, hasVoidPermission: false }),
    ).toThrow(expect.objectContaining({ code: "VOID_NOT_PERMITTED" }));
    expect(() =>
      transitionAdministration("committed", { ...base, stepUpCompleted: false }),
    ).toThrow(expect.objectContaining({ code: "VOID_STEP_UP_REQUIRED" }));
    expect(() => transitionAdministration("committed", { ...base, reason: "too short" })).toThrow(
      expect.objectContaining({ code: "VOID_REASON_TOO_SHORT" }),
    );
  });
  it("a pending_caregiver_review row can also be voided", () => {
    const t = transitionAdministration("pending_caregiver_review", {
      type: "void",
      hasVoidPermission: true,
      stepUpCompleted: true,
      reason: "Caregiver reported a dose the clinician confirms was not given; voiding in error.",
    });
    expect(t.to).toBe("voided");
  });
});
