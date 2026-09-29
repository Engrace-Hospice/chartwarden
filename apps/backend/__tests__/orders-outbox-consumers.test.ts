// apps/backend/__tests__/orders-outbox-consumers.test.ts — M11-T07 (§4.4 outbox catalog + the §4.5
// subscriptions). Locks the full `m11.order.*` event catalog (naming/ownership/consumers + the pinned
// `m11.order.hl7_orm_requested` payload — the same invariants arch:gaps enforces) against M11_EVENT_NAMES,
// and exercises the three pure consumer decision cores: the M6 discharge-cascade auto-discontinue
// (§2.6 D13 / W-DC-02), and the M9 / M10 order-suggestion banner consumers (§2.7 D7 / W-AS-01).
import { Value } from "@sinclair/typebox/value";
import { M11_EVENT_NAMES } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  type AdmissionDischargedPayload,
  type HopeJ2051TriggerPayload,
  M11_DOCUMENT_BACKREF_CONSUMER,
  M11_IDG_DECISION_CONSUMER,
  M11_OUTBOX_EVENTS,
  M11_OUTBOX_SUBSCRIPTIONS,
  type SignificantChangePayload,
  type SuggestionFacts,
  decideAssessmentSuggestion,
  decideDischargeCascade,
  decideHopeSuggestion,
} from "../src/modules/11-orders/index";

const ORG = "00000000-0000-4000-8000-0000000000ee";
const ADM = "00000000-0000-4000-8000-0000000000bb";
const PAT = "00000000-0000-4000-8000-0000000000aa";
const ASSESS = "00000000-0000-4000-8000-0000000000a1";
const EVT = "00000000-0000-4000-8000-0000000000f0";

// ── §4.4 outbox event contract ────────────────────────────────────────────────────────────────────────

describe("M11 outbox event contract (§4.4)", () => {
  it("publishes exactly the §4.4 taxonomy (M11_EVENT_NAMES), no more, no less", () => {
    const published = M11_OUTBOX_EVENTS.map((e) => e.eventName).sort();
    expect(published).toEqual([...M11_EVENT_NAMES].sort());
  });

  it("every event is owned by m11 and namespaced under its own prefix", () => {
    for (const e of M11_OUTBOX_EVENTS) {
      expect(e.moduleOwner).toBe("m11");
      expect(e.eventName.startsWith("m11.")).toBe(true);
      expect(e.eventName).toMatch(/^m\d+\.[a-z0-9_]+\.[a-z0-9_.]+$/);
      expect(e.description.length).toBeGreaterThan(0);
    }
  });

  it("declares only real module-id consumers in `mN` form", () => {
    for (const e of M11_OUTBOX_EVENTS) {
      for (const c of e.declaredConsumers) expect(c).toMatch(/^m\d+$/);
    }
  });

  it("has no duplicate event names (catalog is collision-free)", () => {
    const names = M11_OUTBOX_EVENTS.map((e) => e.eventName);
    expect(new Set(names).size).toBe(names.length);
  });

  it("is outbox-only except the live chart-banner suggestion signal (§2.7)", () => {
    for (const e of M11_OUTBOX_EVENTS) {
      const expected = e.eventName !== "m11.order.suggestion_state_changed";
      expect(e.isOutboxOnly).toBe(expected);
    }
  });

  it("`m11.order.signed` fans out to the clinical-record + interop subscriber set (§4.4)", () => {
    const signed = M11_OUTBOX_EVENTS.find((e) => e.eventName === "m11.order.signed");
    // F-115 (#248) — m28 removed: never subscribes to anything (F-035).
    // F-117 (#248) — m22 removed: redundant with `m11.order.document_requested`, emitted in the
    // same `signOrder`/`signOnBehalf` transaction.
    // F-141 (#248) — m29 removed: redundant with the specific `m11.order.hl7_orm_requested` event,
    // which carries the rich PID/ORC/OBR/NTE payload M29's own spec actually names.
    // F-149 (#248) — m30 moved to seamConsumers: M30's own spec states it never subscribes to an
    // upstream module's outbox, only calls seams.
    // F-153 (#248) — m21 removed: redundant with the co-emitted, more specific
    // `m11.order.supply_fulfillment_requested` sibling (same `emitDownstreamSignedEvent` transaction).
    expect(signed?.declaredConsumers).toEqual(expect.arrayContaining(["m14"]));
    expect(signed?.declaredConsumers).not.toContain("m21");
    expect(signed?.declaredConsumers).not.toContain("m22");
    expect(signed?.declaredConsumers).not.toContain("m29");
    expect(signed?.declaredConsumers).not.toContain("m30");
    // M33's reporting intake is a pull over `report_mv.*` — recorded, but not an outbox subscription
    // (#103).
    expect(signed?.seamConsumers).toContain("m33");
    expect(signed?.seamConsumers).toContain("m30");
  });

  it("`m11.order.recertification_signed` reaches M6 for the CTI handshake (W-RC-01)", () => {
    const recert = M11_OUTBOX_EVENTS.find(
      (e) => e.eventName === "m11.order.recertification_signed",
    );
    expect(recert?.declaredConsumers).toEqual(expect.arrayContaining(["m6"]));
  });

  it("`m11.order.level_of_care_change_signed` reaches M6 for the LCP transition (W-LCC-01)", () => {
    const lcc = M11_OUTBOX_EVENTS.find(
      (e) => e.eventName === "m11.order.level_of_care_change_signed",
    );
    expect(lcc?.declaredConsumers).toEqual(expect.arrayContaining(["m6"]));
  });

  it("`m11.order.supply_fulfillment_requested` routes to M21 (deny-stub consumer, Wave F)", () => {
    const supply = M11_OUTBOX_EVENTS.find(
      (e) => e.eventName === "m11.order.supply_fulfillment_requested",
    );
    expect(supply?.declaredConsumers).toEqual(expect.arrayContaining(["m21"]));
  });

  it("`m11.order.hl7_orm_requested` routes to M29 (deny-stub consumer, Wave H)", () => {
    const orm = M11_OUTBOX_EVENTS.find((e) => e.eventName === "m11.order.hl7_orm_requested");
    expect(orm?.declaredConsumers).toEqual(["m29"]);
  });

  it("validates the pinned `m11.order.hl7_orm_requested` payload and rejects a missing key", () => {
    const orm = M11_OUTBOX_EVENTS.find((e) => e.eventName === "m11.order.hl7_orm_requested")!;
    const good = {
      orderId: "ord-1",
      organizationId: ORG,
      labDestinationFacilityId: "feed-1",
      priority: "R",
      requestedAt: "2026-06-22T16:00:00.000Z",
      labOrderPayload: {
        orderId: "ord-1",
        patientId: PAT,
        placerOrderNumber: "ORD1",
        observationIdentifier: { code: "58410-2", text: "CBC panel", codingSystem: "LN" },
        orderingProviderNpi: "1234567893",
        orderingProviderName: { family: "House", given: "Gregory" },
        priority: "R",
        patientDemographics: {
          mrn: "MRN-1",
          internalMrnAuthority: "WARDENX",
          familyName: "Doe",
          givenName: "Jane",
          dateOfBirth: "1950-01-01",
          administrativeSex: "F",
        },
      },
    };
    expect(Value.Check(orm.payloadSchema, good)).toBe(true);
    // illegal priority literal → rejected
    expect(Value.Check(orm.payloadSchema, { ...good, priority: "Z" })).toBe(false);
    // missing organizationId → rejected
    const { organizationId: _drop, ...missingOrg } = good;
    expect(Value.Check(orm.payloadSchema, missingOrg)).toBe(false);
  });
});

// ── §4.5 subscription bindings ──────────────────────────────────────────────────────────────────────────

describe("M11 outbox subscriptions (§4.5)", () => {
  it("binds the three Wave-E events, the live M14 IDG intake, the live M22 back-ref, and the F-152 D8 auto-complete", () => {
    expect(M11_OUTBOX_SUBSCRIPTIONS).toEqual([
      {
        eventName: "m6.admission.discharged",
        consumerName: "m11.admission-discharged-discontinue",
      },
      { eventName: "m9.assessment.significant_change", consumerName: "m11.assessment-trigger" },
      { eventName: "m10.hope.j2051_trigger_fired", consumerName: "m11.hope-trigger" },
      { eventName: "idg.decision_recorded", consumerName: "m11.idg-decision-intake" },
      { eventName: "m22.document.rendered", consumerName: "m11.document-backref" },
      {
        eventName: "m21.supply_request.status_changed",
        consumerName: "m11.m21-fulfillment-status",
      },
      // F-166 (#248) — releases the still-in-flight source order on a staff-initiated M21 cancel.
      {
        eventName: "m21.supply_request.cancelled",
        consumerName: "m11.m21-supply-cancelled",
      },
      // F-177 (#248) — `LabTransmissionApplier`: M29's real outbound HL7 lifecycle events.
      { eventName: "m29.lab_order.transmitted", consumerName: "m11.lab-transmission-applier" },
      { eventName: "m29.lab_order.transmission_failed", consumerName: "m11.lab-transmission-applier" },
      // F-187 (#248) — the worker's row-less refusals, so an order is never silently stuck `pending`.
      { eventName: "m29.lab_order.dispatch_refused", consumerName: "m11.lab-transmission-applier" },
      // F-187 (#248) — SELF-consumption: the lab-order supersession alert (T-29.08 defines no outbound cancel).
      { eventName: "m11.order.discontinued", consumerName: "m11.lab-cancellation-required" },
      { eventName: "m11.order.corrected", consumerName: "m11.lab-cancellation-required" },
      // F-195 (#248) — SELF-consumption: the two-person lab-recovery control's DURABLE compliance alerts.
      { eventName: "m11.order.recovery_alert_requested", consumerName: "m11.recovery-alert" },
    ]);
  });

  it("names every event M11 actually BINDS — the property pinning the list verbatim does not give you", () => {
    // F-095. This list is documented as the shared source of truth for M11's consumer wiring, and the
    // assertion above — the only one it had — pins its contents without ever asking whether they are
    // true of anything. `m22.document.rendered` was bound live in `outbox-consumers/m22-document-rendered.ts`
    // and absent from the list for the whole of that binding's life, and the verbatim assertion passed
    // throughout, because a list and a copy of the same list always agree. Reading the consumer names
    // off the bindings is what makes the two halves able to disagree.
    const bound = [M11_DOCUMENT_BACKREF_CONSUMER, M11_IDG_DECISION_CONSUMER];
    const listed = new Set(M11_OUTBOX_SUBSCRIPTIONS.map((s) => s.eventName));
    for (const consumer of bound) expect(listed).toContain(consumer.eventName);
  });
});

// ── discharge-cascade auto-discontinue (§2.6 D13 / W-DC-02) ─────────────────────────────────────────────

function dischargePayload(
  over: Partial<AdmissionDischargedPayload> = {},
): AdmissionDischargedPayload {
  return { admissionId: ADM, organizationId: ORG, dischargeEventId: EVT, ...over };
}

describe("decideDischargeCascade (M6 discharge consumer, §2.6 / W-DC-02)", () => {
  it("discontinues every in-flight order (pending/verbal/active) with system actor + reason", () => {
    const action = decideDischargeCascade(dischargePayload(), {
      ordersOnAdmission: [
        { orderId: "o1", status: "active", kind: "lab" },
        {
          orderId: "o2",
          status: "verbal_pending",
          kind: "comfort_kit",
        },
        {
          orderId: "o3",
          status: "pending_signature",
          kind: "dme",
        },
      ],
    });
    expect(action.discontinuations).toHaveLength(3);
    expect(action.skippedCount).toBe(0);
    for (const d of action.discontinuations) {
      expect(d.reason).toBe("admission_discharged");
      expect(d.actorMembershipId).toBeNull();
      expect(d.sourceOutboxEventId).toBe(EVT);
    }
  });

  it("leaves terminal orders untouched (completed / discontinued / expired_unsigned / draft)", () => {
    const action = decideDischargeCascade(dischargePayload(), {
      ordersOnAdmission: [
        { orderId: "o1", status: "completed", kind: "lab" },
        { orderId: "o2", status: "discontinued", kind: "dme" },
        {
          orderId: "o3",
          status: "expired_unsigned",
          kind: "comfort_kit",
        },
        { orderId: "o4", status: "draft", kind: "supply" },
        { orderId: "o5", status: "active", kind: "lab" },
      ],
    });
    expect(action.discontinuations.map((d) => d.orderId)).toEqual(["o5"]);
    expect(action.skippedCount).toBe(4);
  });

  // F-102 — this case used to assert `dme + in-flight → true`, `comfort_kit + not-in-flight → false`.
  // The second half was the bug: M11 holds no supply-request reference and the seam that answers
  // "in flight?" takes an id M11 never sees, so the live consumer could only ever have passed `false` and
  // M21 would never have been told about ANY of them. M21's own decider returns `no_match` (emitting
  // nothing) for an order with no request, so asking about every supply-kind order is the cheap direction
  // and not asking is the one that leaves a vendor order standing on a discharged patient.
  it("flags supply cancellation for every supply kind — M21 decides whether anything is open (§2.6)", () => {
    const action = decideDischargeCascade(dischargePayload(), {
      ordersOnAdmission: [
        { orderId: "o1", status: "active", kind: "dme" },
        { orderId: "o2", status: "active", kind: "comfort_kit" },
        { orderId: "o3", status: "active", kind: "supply" },
        { orderId: "o4", status: "active", kind: "lab" },
      ],
    });
    const byId = Object.fromEntries(action.discontinuations.map((d) => [d.orderId, d]));
    expect(byId.o1?.emitSupplyCancellation).toBe(true);
    expect(byId.o2?.emitSupplyCancellation).toBe(true);
    expect(byId.o3?.emitSupplyCancellation).toBe(true);
    expect(byId.o4?.emitSupplyCancellation).toBe(false); // not a supply kind
  });

  it("is idempotent — a redelivery after the cascade ran sees all orders terminal and discontinues none", () => {
    const action = decideDischargeCascade(dischargePayload(), {
      ordersOnAdmission: [
        { orderId: "o1", status: "discontinued", kind: "lab" },
        { orderId: "o2", status: "discontinued", kind: "dme" },
      ],
    });
    expect(action.discontinuations).toHaveLength(0);
    expect(action.skippedCount).toBe(2);
  });
});

// ── M9 assessment-trigger suggestion banner (§2.7 / W-AS-01) ────────────────────────────────────────────

function sigPayload(over: Partial<SignificantChangePayload> = {}): SignificantChangePayload {
  return { patientId: PAT, assessmentId: ASSESS, ruleId: "esas_symptom_ge_7", ...over };
}
const FRESH: SuggestionFacts = { alreadySuggested: false, orderAlreadyCreated: false };

describe("decideAssessmentSuggestion (M9 significant-change consumer, §2.7 / W-AS-01)", () => {
  it("adds a comfort-medication suggestion for esas_symptom_ge_7", () => {
    const action = decideAssessmentSuggestion(sigPayload(), FRESH);
    expect(action.kind).toBe("add_suggestion");
    if (action.kind === "add_suggestion") {
      expect(action.patientId).toBe(PAT);
      expect(action.entry).toEqual({
        triggeringId: ASSESS,
        source: "assessment",
        trigger: "esas_symptom_ge_7",
        suggestedKind: "comfort_kit",
      });
    }
  });

  it("adds a lab suggestion for painad_ge_4 (§2.1 PAINAD → CBC)", () => {
    const action = decideAssessmentSuggestion(sigPayload({ ruleId: "painad_ge_4" }), FRESH);
    expect(action.kind === "add_suggestion" && action.entry.suggestedKind).toBe("lab");
  });

  it("skips rules below the §2.7 banner threshold", () => {
    const action = decideAssessmentSuggestion(
      sigPayload({ ruleId: "esas_symptom_decline" }),
      FRESH,
    );
    expect(action).toEqual({ kind: "skip", reason: "below_threshold" });
  });

  it("is idempotent — a redelivery whose assessment is already suggested is a no-op", () => {
    const action = decideAssessmentSuggestion(sigPayload(), {
      alreadySuggested: true,
      orderAlreadyCreated: false,
    });
    expect(action).toEqual({ kind: "skip", reason: "already_suggested" });
  });

  it("does not re-raise when the clinician already created an order for this assessment (§2.7)", () => {
    const action = decideAssessmentSuggestion(sigPayload(), {
      alreadySuggested: false,
      orderAlreadyCreated: true,
    });
    expect(action).toEqual({ kind: "skip", reason: "order_already_created" });
  });

  it("the order-already-created drop wins over the idempotency skip", () => {
    const action = decideAssessmentSuggestion(sigPayload(), {
      alreadySuggested: true,
      orderAlreadyCreated: true,
    });
    expect(action).toEqual({ kind: "skip", reason: "order_already_created" });
  });
});

// ── M10 hope-trigger suggestion banner (§2.7) ───────────────────────────────────────────────────────────

function hopePayload(over: Partial<HopeJ2051TriggerPayload> = {}): HopeJ2051TriggerPayload {
  return { patientId: PAT, assessmentId: ASSESS, maxSeverity: "severe", ...over };
}

describe("decideHopeSuggestion (M10 J2051 consumer, §2.7)", () => {
  it("adds a comfort-medication suggestion for moderate/severe severity", () => {
    for (const sev of ["moderate", "severe"] as const) {
      const action = decideHopeSuggestion(hopePayload({ maxSeverity: sev }), FRESH);
      expect(action.kind).toBe("add_suggestion");
      if (action.kind === "add_suggestion") {
        expect(action.entry.source).toBe("hope");
        expect(action.entry.trigger).toBe(`j2051:${sev}`);
        expect(action.entry.suggestedKind).toBe("comfort_kit");
      }
    }
  });

  it("skips none/mild severity (below the §2.7 banner threshold)", () => {
    for (const sev of ["none", "mild"] as const) {
      expect(decideHopeSuggestion(hopePayload({ maxSeverity: sev }), FRESH)).toEqual({
        kind: "skip",
        reason: "below_threshold",
      });
    }
  });

  it("is idempotent on redelivery and yields to an already-created order", () => {
    expect(
      decideHopeSuggestion(hopePayload(), { alreadySuggested: true, orderAlreadyCreated: false }),
    ).toEqual({ kind: "skip", reason: "already_suggested" });
    expect(
      decideHopeSuggestion(hopePayload(), { alreadySuggested: false, orderAlreadyCreated: true }),
    ).toEqual({ kind: "skip", reason: "order_already_created" });
  });
});
