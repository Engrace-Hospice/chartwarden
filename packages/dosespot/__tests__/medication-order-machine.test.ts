// @wardenx/dosespot — §2.2 D2 medication-order lifecycle state machine — M12-T03.
import { describe, expect, it } from "vitest";
import {
  MEDICATION_ORDER_GRAPH,
  type MedicationOrderSideEffect,
  isEpcsRequired,
  planDraftCreation,
  transitionMedicationOrder,
} from "../src/lifecycle";

/** Collect the `m12.*` outbox events a transition declares (order-preserving). */
function outboxEvents(effects: ReadonlyArray<MedicationOrderSideEffect>): string[] {
  return effects
    .filter((e): e is Extract<MedicationOrderSideEffect, { kind: "outbox" }> => e.kind === "outbox")
    .map((e) => e.event);
}

/** Collect the typed M36 alerts a transition declares. */
function alerts(effects: ReadonlyArray<MedicationOrderSideEffect>): string[] {
  return effects
    .filter((e): e is Extract<MedicationOrderSideEffect, { kind: "alert" }> => e.kind === "alert")
    .map((e) => e.alert);
}

// A complete, passing `requestSignature` for a standard med.
const goodRequest = {
  type: "requestSignature" as const,
  medClass: "standard" as const,
  containsControlled: false,
  requiredDataComplete: true,
  prescriberEligible: true,
  allergyCheckPassed: true,
  sudConsentSatisfied: true,
  tenantEpcsCertified: false,
};

describe("§2.1 / §2.4 isEpcsRequired", () => {
  it("standard never requires EPCS", () => {
    expect(isEpcsRequired("standard", false)).toBe(false);
    expect(isEpcsRequired("standard", true)).toBe(false);
  });
  it("controlled_substance always requires EPCS", () => {
    expect(isEpcsRequired("controlled_substance", false)).toBe(true);
  });
  it("compounded requires EPCS only when contains_controlled", () => {
    expect(isEpcsRequired("compounded", false)).toBe(false);
    expect(isEpcsRequired("compounded", true)).toBe(true);
  });
});

describe("§2.2 transition graph", () => {
  it("draft genesis emits draft_created", () => {
    expect(outboxEvents(planDraftCreation())).toEqual(["m12.medication_order.draft_created"]);
  });
  it("draft-from-extraction genesis swaps the event", () => {
    expect(outboxEvents(planDraftCreation(true))).toEqual([
      "m12.medication_order.draft_created_from_extraction",
    ]);
  });
  it("terminal states accept no events", () => {
    expect(MEDICATION_ORDER_GRAPH.completed).toEqual([]);
    expect(MEDICATION_ORDER_GRAPH.discontinued).toEqual([]);
    expect(MEDICATION_ORDER_GRAPH.transmission_failed).toEqual([]);
    expect(MEDICATION_ORDER_GRAPH.expired_unsigned).toEqual([]);
  });
  it("rejects an off-graph event (409 ILLEGAL_MEDICATION_ORDER_TRANSITION)", () => {
    expect(() => transitionMedicationOrder("active", goodRequest)).toThrowError(
      expect.objectContaining({ code: "ILLEGAL_MEDICATION_ORDER_TRANSITION", statusCode: 409 }),
    );
    expect(() =>
      transitionMedicationOrder("completed", { type: "complete", criterionMet: true }),
    ).toThrowError(expect.objectContaining({ code: "ILLEGAL_MEDICATION_ORDER_TRANSITION" }));
  });
});

describe("§2.2 requestSignature (draft → pending_signature)", () => {
  it("advances and emits signature_requested for a complete standard order", () => {
    const t = transitionMedicationOrder("draft", goodRequest);
    expect(t.to).toBe("pending_signature");
    expect(outboxEvents(t.effects)).toEqual(["m12.medication_order.signature_requested"]);
  });
  it("refuses when required data is incomplete (422)", () => {
    expect(() =>
      transitionMedicationOrder("draft", { ...goodRequest, requiredDataComplete: false }),
    ).toThrowError(
      expect.objectContaining({
        code: "MEDICATION_ORDER_REQUIRED_DATA_INCOMPLETE",
        statusCode: 422,
      }),
    );
  });
  it("refuses an ineligible prescriber (403)", () => {
    expect(() =>
      transitionMedicationOrder("draft", { ...goodRequest, prescriberEligible: false }),
    ).toThrowError(expect.objectContaining({ code: "PRESCRIBER_NOT_ELIGIBLE", statusCode: 403 }));
  });
  it("refuses on a failed allergy check (422)", () => {
    expect(() =>
      transitionMedicationOrder("draft", { ...goodRequest, allergyCheckPassed: false }),
    ).toThrowError(expect.objectContaining({ code: "ALLERGY_CHECK_NOT_PASSED" }));
  });
  it("refuses without SUD consent (412)", () => {
    expect(() =>
      transitionMedicationOrder("draft", { ...goodRequest, sudConsentSatisfied: false }),
    ).toThrowError(expect.objectContaining({ code: "SUD_CONSENT_REQUIRED", statusCode: 412 }));
  });
  it("blocks a controlled order on an uncertified tenant (403 EPCS_NOT_CERTIFIED, D18)", () => {
    expect(() =>
      transitionMedicationOrder("draft", {
        ...goodRequest,
        medClass: "controlled_substance",
        tenantEpcsCertified: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "EPCS_NOT_CERTIFIED", statusCode: 403 }));
  });
  it("allows a controlled order on a certified tenant", () => {
    const t = transitionMedicationOrder("draft", {
      ...goodRequest,
      medClass: "controlled_substance",
      tenantEpcsCertified: true,
    });
    expect(t.to).toBe("pending_signature");
  });
});

describe("§2.2 discardDraft (draft → discontinued)", () => {
  it("discards with no downstream event", () => {
    const t = transitionMedicationOrder("draft", {
      type: "discardDraft",
      actorMayDiscard: true,
      hasExternalReferences: false,
    });
    expect(t.to).toBe("discontinued");
    expect(outboxEvents(t.effects)).toEqual([]);
  });
  it("refuses an unauthorized actor (403)", () => {
    expect(() =>
      transitionMedicationOrder("draft", {
        type: "discardDraft",
        actorMayDiscard: false,
        hasExternalReferences: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "DISCARD_NOT_PERMITTED" }));
  });
  it("refuses when externally referenced (409)", () => {
    expect(() =>
      transitionMedicationOrder("draft", {
        type: "discardDraft",
        actorMayDiscard: true,
        hasExternalReferences: true,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "MEDICATION_ORDER_HAS_EXTERNAL_REFERENCES",
        statusCode: 409,
      }),
    );
  });
});

describe("§2.2 sign — standard (pending_signature → signed)", () => {
  const goodSign = {
    type: "sign" as const,
    medClass: "standard" as const,
    containsControlled: false,
    signerEligible: true,
    signerIsOrderingPhysician: true,
  };
  it("signs via the M11 seam and emits signed", () => {
    const t = transitionMedicationOrder("pending_signature", goodSign);
    expect(t.to).toBe("signed");
    expect(outboxEvents(t.effects)).toEqual(["m12.medication_order.signed"]);
    expect(t.effects).toContainEqual({ kind: "sign_via_m11", signatureKind: "signature" });
    expect(t.effects).toContainEqual({ kind: "set_timestamp", field: "signed_at" });
    expect(t.effects).toContainEqual({ kind: "bump_version" });
  });
  it("routes a controlled order away from the standard sign (422 SIGN_REQUIRES_EPCS)", () => {
    expect(() =>
      transitionMedicationOrder("pending_signature", {
        ...goodSign,
        medClass: "controlled_substance",
      }),
    ).toThrowError(expect.objectContaining({ code: "SIGN_REQUIRES_EPCS", statusCode: 422 }));
  });
  it("refuses an ineligible signer (403)", () => {
    expect(() =>
      transitionMedicationOrder("pending_signature", { ...goodSign, signerEligible: false }),
    ).toThrowError(expect.objectContaining({ code: "SIGNER_NOT_ELIGIBLE" }));
  });
  it("refuses a non-ordering-physician signer (403)", () => {
    expect(() =>
      transitionMedicationOrder("pending_signature", {
        ...goodSign,
        signerIsOrderingPhysician: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "SIGNER_NOT_ORDERING_PHYSICIAN" }));
  });
});

describe("§2.4 EPCS controlled-substance branch", () => {
  const goodSignControlled = {
    type: "signControlled" as const,
    medClass: "controlled_substance" as const,
    containsControlled: false,
    deaScheduleAuthorized: true,
    prescriberIal2Verified: true,
    tenantEpcsCertified: true,
  };
  it("enters epcs_identity_pending (no signature yet)", () => {
    const t = transitionMedicationOrder("pending_signature", goodSignControlled);
    expect(t.to).toBe("epcs_identity_pending");
    expect(t.effects.some((e) => e.kind === "sign_via_m11")).toBe(false);
  });
  it("refuses signControlled on a non-controlled order (422)", () => {
    expect(() =>
      transitionMedicationOrder("pending_signature", {
        ...goodSignControlled,
        medClass: "standard",
      }),
    ).toThrowError(expect.objectContaining({ code: "NOT_CONTROLLED_FOR_EPCS" }));
  });
  it("refuses an unauthorized DEA schedule (403)", () => {
    expect(() =>
      transitionMedicationOrder("pending_signature", {
        ...goodSignControlled,
        deaScheduleAuthorized: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "DEA_SCHEDULE_NOT_AUTHORIZED" }));
  });
  it("refuses an unverified prescriber (403 EPCS_PRESCRIBER_NOT_VERIFIED)", () => {
    expect(() =>
      transitionMedicationOrder("pending_signature", {
        ...goodSignControlled,
        prescriberIal2Verified: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "EPCS_PRESCRIBER_NOT_VERIFIED" }));
  });
  it("completeSecondFactor signs with the second-factor type populated", () => {
    const t = transitionMedicationOrder("epcs_identity_pending", {
      type: "completeSecondFactor",
      challengeCompletedInTime: true,
      secondFactorType: "totp",
    });
    expect(t.to).toBe("signed");
    expect(t.effects).toContainEqual({
      kind: "sign_via_m11",
      signatureKind: "signature",
      secondFactorType: "totp",
    });
  });
  it("completeSecondFactor refuses an expired challenge (422 EPCS_2FA_EXPIRED)", () => {
    expect(() =>
      transitionMedicationOrder("epcs_identity_pending", {
        type: "completeSecondFactor",
        challengeCompletedInTime: false,
        secondFactorType: "passkey",
      }),
    ).toThrowError(expect.objectContaining({ code: "EPCS_2FA_EXPIRED" }));
  });
  it("secondFactorFailed returns to pending_signature + emits epcs_2fa_failed", () => {
    const t = transitionMedicationOrder("epcs_identity_pending", {
      type: "secondFactorFailed",
      isSystemActor: true,
    });
    expect(t.to).toBe("pending_signature");
    expect(outboxEvents(t.effects)).toEqual(["m12.medication_order.epcs_2fa_failed"]);
  });
  it("secondFactorFailed refuses a human actor (403)", () => {
    expect(() =>
      transitionMedicationOrder("epcs_identity_pending", {
        type: "secondFactorFailed",
        isSystemActor: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "NOT_SYSTEM_ACTOR" }));
  });
});

describe("§2.3 recordVerbal (pending_signature → verbal_pending)", () => {
  const goodVerbal = {
    type: "recordVerbal" as const,
    medClass: "standard" as const,
    containsControlled: false,
    recorderEligible: true,
    namedPrescriberPresent: true,
    attestationRecorded: true,
  };
  it("records the verbal via the M11 seam + emits verbal_received", () => {
    const t = transitionMedicationOrder("pending_signature", goodVerbal);
    expect(t.to).toBe("verbal_pending");
    expect(t.effects).toContainEqual({ kind: "record_verbal_via_m11" });
    expect(outboxEvents(t.effects)).toEqual(["m12.medication_order.verbal_received"]);
  });
  it("blocks a controlled-substance verbal (403 EPCS_VERBAL_NOT_PERMITTED, D18)", () => {
    expect(() =>
      transitionMedicationOrder("pending_signature", {
        ...goodVerbal,
        medClass: "controlled_substance",
      }),
    ).toThrowError(expect.objectContaining({ code: "EPCS_VERBAL_NOT_PERMITTED", statusCode: 403 }));
  });
  it("blocks a compounded-with-controlled verbal", () => {
    expect(() =>
      transitionMedicationOrder("pending_signature", {
        ...goodVerbal,
        medClass: "compounded",
        containsControlled: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "EPCS_VERBAL_NOT_PERMITTED" }));
  });
  it("refuses an ineligible recorder (403)", () => {
    expect(() =>
      transitionMedicationOrder("pending_signature", { ...goodVerbal, recorderEligible: false }),
    ).toThrowError(expect.objectContaining({ code: "VERBAL_RECORDER_NOT_ELIGIBLE" }));
  });
  it("refuses without a named prescriber (422)", () => {
    expect(() =>
      transitionMedicationOrder("pending_signature", {
        ...goodVerbal,
        namedPrescriberPresent: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "VERBAL_PRESCRIBER_REQUIRED" }));
  });
  it("refuses without an attestation (422)", () => {
    expect(() =>
      transitionMedicationOrder("pending_signature", { ...goodVerbal, attestationRecorded: false }),
    ).toThrowError(expect.objectContaining({ code: "VERBAL_ATTESTATION_REQUIRED" }));
  });
});

describe("§2.3 verbal follow-up sign (verbal_pending → signed)", () => {
  const verbalSign = {
    type: "sign" as const,
    medClass: "standard" as const,
    containsControlled: false,
    signerEligible: true,
    signerIsOrderingPhysician: true,
  };
  it("the named prescriber signs in time", () => {
    const t = transitionMedicationOrder("verbal_pending", verbalSign);
    expect(t.to).toBe("signed");
    expect(outboxEvents(t.effects)).toEqual([
      "m12.medication_order.signed",
      "m12.medication_order.verbal_received",
    ]);
  });
  it("refuses an on-behalf signer in the verbal flow (403 VERBAL_SIGNER_NOT_NAMED_PRESCRIBER)", () => {
    expect(() =>
      transitionMedicationOrder("verbal_pending", {
        ...verbalSign,
        signerIsOrderingPhysician: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "VERBAL_SIGNER_NOT_NAMED_PRESCRIBER" }));
  });
  it("expire (system actor, deadline reached) → expired_unsigned + verbal-expiry alert", () => {
    const t = transitionMedicationOrder("verbal_pending", {
      type: "expire",
      isSystemActor: true,
      deadlineReached: true,
    });
    expect(t.to).toBe("expired_unsigned");
    expect(alerts(t.effects)).toEqual(["medication_order.verbal_expired_unsigned"]);
  });
  it("expire refuses before the deadline (422)", () => {
    expect(() =>
      transitionMedicationOrder("verbal_pending", {
        type: "expire",
        isSystemActor: true,
        deadlineReached: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "VERBAL_DEADLINE_NOT_REACHED" }));
  });
  it("expire refuses a human actor (403)", () => {
    expect(() =>
      transitionMedicationOrder("verbal_pending", {
        type: "expire",
        isSystemActor: false,
        deadlineReached: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "NOT_SYSTEM_ACTOR" }));
  });
});

describe("§2.2 transmission chain (signed → … → active)", () => {
  it("enqueueTransmission writes the transmission row + queues the job", () => {
    const t = transitionMedicationOrder("signed", {
      type: "enqueueTransmission",
      isSystemActor: true,
    });
    expect(t.to).toBe("queued_for_transmission");
    expect(t.effects).toContainEqual({ kind: "write_transmission" });
    expect(t.effects).toContainEqual({ kind: "enqueue_transmission_job" });
    expect(t.effects).toContainEqual({ kind: "set_send_state", state: "queued" });
    expect(outboxEvents(t.effects)).toEqual(["m12.medication_order.queued_for_transmission"]);
  });
  it("transmissionSucceeded → transmitted", () => {
    const t = transitionMedicationOrder("queued_for_transmission", {
      type: "transmissionSucceeded",
      isSystemActor: true,
    });
    expect(t.to).toBe("transmitted");
    expect(t.effects).toContainEqual({ kind: "update_transmission", outcome: "succeeded" });
    expect(t.effects).toContainEqual({ kind: "set_timestamp", field: "transmitted_at" });
    expect(outboxEvents(t.effects)).toEqual(["m12.medication_order.transmitted"]);
  });
  it("transmissionExhausted → transmission_failed (terminal) + alert", () => {
    const t = transitionMedicationOrder("queued_for_transmission", {
      type: "transmissionExhausted",
      isSystemActor: true,
    });
    expect(t.to).toBe("transmission_failed");
    expect(outboxEvents(t.effects)).toEqual(["m12.medication_order.transmission_failed"]);
    expect(alerts(t.effects)).toEqual(["medication_order.transmission_failed"]);
    expect(MEDICATION_ORDER_GRAPH.transmission_failed).toEqual([]);
  });
  it("pharmacyAck → ack_received, then activate → active", () => {
    const ack = transitionMedicationOrder("transmitted", {
      type: "pharmacyAck",
      isSystemActor: true,
    });
    expect(ack.to).toBe("ack_received");
    expect(outboxEvents(ack.effects)).toEqual(["m12.medication_order.ack_received"]);
    const active = transitionMedicationOrder("ack_received", {
      type: "activate",
      isSystemActor: true,
    });
    expect(active.to).toBe("active");
    expect(active.effects).toContainEqual({ kind: "set_timestamp", field: "activated_at" });
    expect(outboxEvents(active.effects)).toEqual(["m12.medication_order.active"]);
  });
  it("pharmacyNack → nack_received + high-sev alert, then prescriber discontinues", () => {
    const nack = transitionMedicationOrder("transmitted", {
      type: "pharmacyNack",
      isSystemActor: true,
      rejectionReason: "RxFillError",
    });
    expect(nack.to).toBe("nack_received");
    expect(alerts(nack.effects)).toEqual(["medication_order.nack_received"]);
    const dc = transitionMedicationOrder("nack_received", {
      type: "discontinue",
      reason: "pharmacy_nack",
    });
    expect(dc.to).toBe("discontinued");
    expect(dc.effects).toContainEqual({ kind: "write_discontinuation", reason: "pharmacy_nack" });
  });
  it("enqueueTransmission refuses a human actor (403)", () => {
    expect(() =>
      transitionMedicationOrder("signed", { type: "enqueueTransmission", isSystemActor: false }),
    ).toThrowError(expect.objectContaining({ code: "NOT_SYSTEM_ACTOR" }));
  });
});

describe("§2.2 active terminal transitions", () => {
  it("complete → completed", () => {
    const t = transitionMedicationOrder("active", { type: "complete", criterionMet: true });
    expect(t.to).toBe("completed");
    expect(outboxEvents(t.effects)).toEqual(["m12.medication_order.completed"]);
  });
  it("complete refuses an unmet criterion (422)", () => {
    expect(() =>
      transitionMedicationOrder("active", { type: "complete", criterionMet: false }),
    ).toThrowError(expect.objectContaining({ code: "COMPLETION_CRITERION_NOT_MET" }));
  });
  it("discontinue writes the discontinuation row + emits discontinued", () => {
    const t = transitionMedicationOrder("active", { type: "discontinue", reason: "adverse_event" });
    expect(t.to).toBe("discontinued");
    expect(t.effects).toContainEqual({ kind: "write_discontinuation", reason: "adverse_event" });
    expect(outboxEvents(t.effects)).toEqual(["m12.medication_order.discontinued"]);
  });
  it("withdraw (pending_signature) → discontinued (clinical_judgement)", () => {
    const t = transitionMedicationOrder("pending_signature", {
      type: "withdraw",
      actorMayWithdraw: true,
    });
    expect(t.to).toBe("discontinued");
    expect(t.effects).toContainEqual({
      kind: "write_discontinuation",
      reason: "clinical_judgement",
    });
  });
});

describe("§2.2 D13 discharge cascade", () => {
  it.each([
    "pending_signature",
    "epcs_identity_pending",
    "queued_for_transmission",
    "active",
  ] as const)("cascadeDiscontinue from %s → discontinued (admission_discharged)", (from) => {
    const t = transitionMedicationOrder(from, { type: "cascadeDiscontinue", isSystemActor: true });
    expect(t.to).toBe("discontinued");
    expect(t.effects).toContainEqual({
      kind: "write_discontinuation",
      reason: "admission_discharged",
    });
    expect(outboxEvents(t.effects)).toEqual(["m12.medication_order.discontinued"]);
  });
  it("cascadeDiscontinue refuses a human actor (403)", () => {
    expect(() =>
      transitionMedicationOrder("active", { type: "cascadeDiscontinue", isSystemActor: false }),
    ).toThrowError(expect.objectContaining({ code: "NOT_SYSTEM_ACTOR" }));
  });
});
