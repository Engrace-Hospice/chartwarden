// @wardenx/orders — §2.2 D2 order lifecycle state machine — M11-T03.
import { describe, expect, it } from "vitest";
import {
  transitionOrder,
  planDraftCreation,
  ORDER_GRAPH,
  type OrderEvent,
  type OrderSideEffect,
} from "../src/lifecycle/order-machine";

/** Collect the `m11.*` outbox events a transition declares (order-preserving). */
function outboxEvents(effects: ReadonlyArray<OrderSideEffect>): string[] {
  return effects.filter((e): e is Extract<OrderSideEffect, { kind: "outbox" }> => e.kind === "outbox").map((e) => e.event);
}

describe("§2.2 transition graph", () => {
  it("draft genesis emits draft_created", () => {
    expect(outboxEvents(planDraftCreation())).toEqual(["m11.order.draft_created"]);
  });

  it("terminal states accept no events", () => {
    expect(ORDER_GRAPH.completed).toEqual([]);
    expect(ORDER_GRAPH.discontinued).toEqual([]);
    expect(ORDER_GRAPH.expired_unsigned).toEqual([]);
  });

  it("rejects an off-graph event (409 ILLEGAL_ORDER_TRANSITION)", () => {
    expect(() => transitionOrder("active", { type: "requestSignature", requiredFieldsComplete: true, cosignRequired: false })).toThrowError(
      expect.objectContaining({ code: "ILLEGAL_ORDER_TRANSITION", statusCode: 409 }),
    );
    expect(() => transitionOrder("completed", { type: "complete", criterionMet: true })).toThrowError(
      expect.objectContaining({ code: "ILLEGAL_ORDER_TRANSITION" }),
    );
  });
});

describe("§2.2 requestSignature (draft → pending_signature)", () => {
  it("advances and emits signature_requested when fields complete and no cosign needed", () => {
    const t = transitionOrder("draft", { type: "requestSignature", requiredFieldsComplete: true, cosignRequired: false });
    expect(t.to).toBe("pending_signature");
    expect(outboxEvents(t.effects)).toEqual(["m11.order.signature_requested"]);
    expect(t.effects).toContainEqual({ kind: "set_cosign_overlay", required: false, status: "attached" });
  });

  it("opens the cosign overlay + emits cosign_requested when cosign is required", () => {
    const t = transitionOrder("draft", {
      type: "requestSignature",
      requiredFieldsComplete: true,
      cosignRequired: true,
      cosignerRoleNeeded: "rn_case_manager",
    });
    expect(outboxEvents(t.effects)).toEqual(["m11.order.signature_requested", "m11.order.cosign_requested"]);
    expect(t.effects).toContainEqual({ kind: "set_cosign_overlay", required: true, status: "pending" });
  });

  it("refuses when required fields are incomplete (422)", () => {
    expect(() => transitionOrder("draft", { type: "requestSignature", requiredFieldsComplete: false, cosignRequired: false })).toThrowError(
      expect.objectContaining({ code: "ORDER_REQUIRED_FIELDS_INCOMPLETE", statusCode: 422 }),
    );
  });
});

describe("§2.2 discardDraft (draft → discontinued)", () => {
  it("discards with audit only — a draft is never visible to consumers", () => {
    const t = transitionOrder("draft", { type: "discardDraft", actorMayDiscard: true, hasExternalReferences: false });
    expect(t.to).toBe("discontinued");
    expect(outboxEvents(t.effects)).toEqual([]);
    expect(t.effects).toEqual([{ kind: "audit" }]);
  });

  it("refuses an unauthorized discard (403) and an externally-referenced draft (409)", () => {
    expect(() => transitionOrder("draft", { type: "discardDraft", actorMayDiscard: false, hasExternalReferences: false })).toThrowError(
      expect.objectContaining({ code: "DISCARD_NOT_PERMITTED", statusCode: 403 }),
    );
    expect(() => transitionOrder("draft", { type: "discardDraft", actorMayDiscard: true, hasExternalReferences: true })).toThrowError(
      expect.objectContaining({ code: "ORDER_HAS_EXTERNAL_REFERENCES", statusCode: 409 }),
    );
  });
});

describe("§2.2 sign (pending_signature → active)", () => {
  it("signs a lab order and emits signed + the kind's downstream hl7_orm_requested", () => {
    const t = transitionOrder("pending_signature", { type: "sign", kind: "lab", cosignAttached: true, onBehalf: false });
    expect(t.to).toBe("active");
    expect(outboxEvents(t.effects)).toEqual(["m11.order.signed", "m11.order.hl7_orm_requested"]);
    expect(t.effects).toContainEqual({ kind: "write_signature", signature: "signature" });
    expect(t.effects).toContainEqual({ kind: "bump_version" });
  });

  it("emits signed_on_behalf before the downstream event when signing on behalf", () => {
    const t = transitionOrder("pending_signature", { type: "sign", kind: "dme", cosignAttached: true, onBehalf: true });
    expect(outboxEvents(t.effects)).toEqual([
      "m11.order.signed",
      "m11.order.signed_on_behalf",
      "m11.order.supply_fulfillment_requested",
    ]);
  });

  it("is blocked while the cosignature is pending (412 COSIGN_PENDING)", () => {
    expect(() => transitionOrder("pending_signature", { type: "sign", kind: "lab", cosignAttached: false, onBehalf: false })).toThrowError(
      expect.objectContaining({ code: "COSIGN_PENDING", statusCode: 412 }),
    );
  });

  it("ancillary_service signs with no downstream event", () => {
    const t = transitionOrder("pending_signature", { type: "sign", kind: "ancillary_service", cosignAttached: true, onBehalf: false });
    expect(outboxEvents(t.effects)).toEqual(["m11.order.signed"]);
  });
});

describe("§2.2 / §2.3 recordVerbal (pending_signature → verbal_pending)", () => {
  it("records a verbal lab order with an attestation row + verbal_received", () => {
    const t = transitionOrder("pending_signature", {
      type: "recordVerbal",
      kind: "lab",
      attestationRecorded: true,
      recorderEligible: true,
    });
    expect(t.to).toBe("verbal_pending");
    expect(outboxEvents(t.effects)).toEqual(["m11.order.verbal_received"]);
    expect(t.effects).toContainEqual({ kind: "write_verbal_order" });
    expect(t.effects).toContainEqual({ kind: "write_signature", signature: "verbal_attestation" });
  });

  it("refuses a verbal order for a written-ab-initio kind (422 VERBAL_NOT_ALLOWED_FOR_KIND)", () => {
    for (const kind of ["recertification", "level_of_care_change"] as const) {
      expect(() => transitionOrder("pending_signature", { type: "recordVerbal", kind, attestationRecorded: true, recorderEligible: true })).toThrowError(
        expect.objectContaining({ code: "VERBAL_NOT_ALLOWED_FOR_KIND", statusCode: 422 }),
      );
    }
  });

  it("refuses an ineligible recorder (403) and a missing attestation (422)", () => {
    expect(() => transitionOrder("pending_signature", { type: "recordVerbal", kind: "lab", attestationRecorded: true, recorderEligible: false })).toThrowError(
      expect.objectContaining({ code: "VERBAL_RECORDER_NOT_ELIGIBLE", statusCode: 403 }),
    );
    expect(() => transitionOrder("pending_signature", { type: "recordVerbal", kind: "lab", attestationRecorded: false, recorderEligible: true })).toThrowError(
      expect.objectContaining({ code: "VERBAL_ATTESTATION_REQUIRED", statusCode: 422 }),
    );
  });
});

describe("§2.2 sign-in-time (verbal_pending → active)", () => {
  it("signs and additionally emits verbal_signed_in_time", () => {
    const t = transitionOrder("verbal_pending", { type: "sign", kind: "lab", cosignAttached: true, onBehalf: false });
    expect(t.to).toBe("active");
    expect(outboxEvents(t.effects)).toEqual([
      "m11.order.signed",
      "m11.order.verbal_signed_in_time",
      "m11.order.hl7_orm_requested",
    ]);
  });
});

describe("§2.2 expire (verbal_pending → expired_unsigned)", () => {
  it("expires when the system worker fires past the deadline", () => {
    const t = transitionOrder("verbal_pending", { type: "expire", isSystemActor: true, deadlineReached: true });
    expect(t.to).toBe("expired_unsigned");
    expect(outboxEvents(t.effects)).toEqual(["m11.order.verbal_expired_unsigned"]);
  });

  it("refuses a human actor (403) and a not-yet-reached deadline (422)", () => {
    expect(() => transitionOrder("verbal_pending", { type: "expire", isSystemActor: false, deadlineReached: true })).toThrowError(
      expect.objectContaining({ code: "NOT_SYSTEM_ACTOR", statusCode: 403 }),
    );
    expect(() => transitionOrder("verbal_pending", { type: "expire", isSystemActor: true, deadlineReached: false })).toThrowError(
      expect.objectContaining({ code: "VERBAL_DEADLINE_NOT_REACHED", statusCode: 422 }),
    );
  });
});

describe("§2.2 withdraw / complete", () => {
  it("withdraws a pending order with a discontinuation row", () => {
    const t = transitionOrder("pending_signature", { type: "withdraw", actorMayWithdraw: true });
    expect(t.to).toBe("discontinued");
    expect(outboxEvents(t.effects)).toEqual(["m11.order.discontinued"]);
    expect(t.effects).toContainEqual({ kind: "write_discontinuation", reason: "clinical_judgement" });
  });

  it("refuses an unauthorized withdraw (403)", () => {
    expect(() => transitionOrder("pending_signature", { type: "withdraw", actorMayWithdraw: false })).toThrowError(
      expect.objectContaining({ code: "WITHDRAW_NOT_PERMITTED", statusCode: 403 }),
    );
  });

  it("completes an active order when the criterion is met", () => {
    const t = transitionOrder("active", { type: "complete", criterionMet: true });
    expect(t.to).toBe("completed");
    expect(outboxEvents(t.effects)).toEqual(["m11.order.completed"]);
  });

  it("refuses completion when the criterion is unmet (422)", () => {
    expect(() => transitionOrder("active", { type: "complete", criterionMet: false })).toThrowError(
      expect.objectContaining({ code: "COMPLETION_CRITERION_NOT_MET", statusCode: 422 }),
    );
  });
});

describe("§2.6 D13 discontinue + cascade (→ discontinued)", () => {
  it("discontinues an active supply order with an in-flight fulfillment → also cancels supply", () => {
    const t = transitionOrder("active", {
      type: "discontinue",
      kind: "supply",
      reason: "clinical_judgement",
      fulfillmentInFlight: true,
    });
    expect(t.to).toBe("discontinued");
    expect(outboxEvents(t.effects)).toEqual(["m11.order.discontinued", "m11.order.supply_cancellation_requested"]);
    expect(t.effects).toContainEqual({ kind: "write_discontinuation", reason: "clinical_judgement" });
  });

  it("a non-supply kind never emits a supply cancellation", () => {
    const t = transitionOrder("active", { type: "discontinue", kind: "lab", reason: "patient_request", fulfillmentInFlight: true });
    expect(outboxEvents(t.effects)).toEqual(["m11.order.discontinued"]);
  });

  it("cascade-discontinues from pending / verbal / active (m6.admission.discharged consumer)", () => {
    for (const from of ["pending_signature", "verbal_pending", "active"] as const) {
      const t = transitionOrder(from, { type: "cascadeDiscontinue", isSystemActor: true, reason: "admission_discharged" });
      expect(t.to).toBe("discontinued");
      expect(t.effects).toContainEqual({ kind: "write_discontinuation", reason: "admission_discharged" });
    }
  });

  it("refuses a human-actor cascade (403 NOT_SYSTEM_ACTOR)", () => {
    expect(() => transitionOrder("active", { type: "cascadeDiscontinue", isSystemActor: false, reason: "admission_discharged" })).toThrowError(
      expect.objectContaining({ code: "NOT_SYSTEM_ACTOR", statusCode: 403 }),
    );
  });
});
