// apps/backend/__tests__/supplies-consumers.test.ts — M21-T04 (§4.5.1 inbound consumers, §4.5.2 outbox
// catalog, §7.1 W1 acceptance, §7.7 W7 acceptance).
//
// The pure M21 cross-module boundary — no DB, no seams, no clock: every fact is injected. The one file
// that DOES touch a seam (`consumers/order-context.ts`) is exercised only through its pure helper, because
// binding the M1 registry from a unit test would be testing the registry, not the cascade.
import type { AdmissionStatusValue, M21EventName, SupplyRequestStatus } from "@wardenx/types";
import { M21_EVENT_NAMES, M21_SUBSCRIBED_EVENT_NAMES } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  type ComfortKitDispatchContext,
  type M11SupplyFulfillmentRequestedPayload,
  M11_CANCELLATION_CASCADE_REASON,
  M11_ORDER_DISCONTINUED_EVENT,
  M11_SUPPLY_CANCELLATION_REQUESTED_EVENT,
  M11_SUPPLY_FULFILLMENT_REQUESTED_EVENT,
  M13_COMFORT_KIT_DEPLOYED_EVENT,
  M13_CONTROLLED_SUBSTANCE_DISCREPANCY_EVENT,
  M13_REPLENISHMENT_NEEDED_EVENT,
  M13_RETURN_REQUIRED_EVENT,
  type SupplyAdmissionContext,
  type SupplyCancellationTarget,
  type SupplyDiscontinuationTarget,
  type SupplyFulfillmentIntakeFacts,
  type SupplyOrderContext,
  deathCensusWindow,
  decideControlledSubstanceReemit,
  decideDeploymentAck,
  decideOrderDiscontinued,
  decideReplenishmentIntake,
  decideReturnRequired,
  decideSupplyCancellationCascade,
  decideSupplyFulfillmentIntake,
  supplyRequestKindForOrderKind,
} from "../src/modules/21-supplies/consumers/index";
import {
  M21_OUTBOX_EVENTS,
  assertM21EventCatalogComplete,
} from "../src/modules/21-supplies/events-by-m21";

const ORDER = "0a000000-0000-4000-8000-000000000001";
const PATIENT = "0b000000-0000-4000-8000-000000000002";
const ADMISSION = "0c000000-0000-4000-8000-000000000003";
const PROVIDER_ENTITY = "0d000000-0000-4000-8000-000000000004";
const LOCATION = "0e000000-0000-4000-8000-000000000005";
const DISPATCH = "0f000000-0000-4000-8000-000000000006";
const DEPLOYMENT = "10000000-0000-4000-8000-000000000007";
const DISPATCHER = "11000000-0000-4000-8000-000000000008";
const MED_ORDER = "12000000-0000-4000-8000-000000000009";
const OUTBOX_EVENT = "13000000-0000-4000-8000-00000000000a";
const EXISTING_REQUEST = "14000000-0000-4000-8000-00000000000b";

const fulfillment: M11SupplyFulfillmentRequestedPayload = {
  orderId: ORDER,
  kind: "dme",
  supplyDetail: { hcpcs: "E0260" },
  preferredDeliveryWindow: null,
  deploymentSite: null,
};

const order: SupplyOrderContext = {
  orderId: ORDER,
  patientId: PATIENT,
  admissionId: ADMISSION,
  orderStatus: "active",
};

function admissionAt(
  status: AdmissionStatusValue,
  overrides: Partial<SupplyAdmissionContext> = {},
): SupplyAdmissionContext {
  return {
    providerEntityId: PROVIDER_ENTITY,
    locationId: LOCATION,
    status,
    dischargedAt: status === "active" ? null : "2026-07-01",
    deathDischarge: null,
    ...overrides,
  };
}

function facts(
  overrides: Partial<SupplyFulfillmentIntakeFacts> = {},
): SupplyFulfillmentIntakeFacts {
  return {
    existingRequestId: null,
    order,
    admission: admissionAt("active"),
    servingLocationId: LOCATION,
    ...overrides,
  };
}

const dispatch: ComfortKitDispatchContext = {
  dispatchId: DISPATCH,
  supplyRequestId: EXISTING_REQUEST,
  dispatchStatus: "deployed_at_patient",
  patientId: PATIENT,
  admissionId: ADMISSION,
  providerEntityId: PROVIDER_ENTITY,
  locationId: LOCATION,
  dispatchedByMembershipId: DISPATCHER,
  containsControlledSubstance: true,
};

// ── §4.5.2 the emitted catalog ───────────────────────────────────────────────────────────────────────

describe("§4.5.2 — the m21.* outbox catalog", () => {
  it("covers the frozen event list exactly", () => {
    expect(() => assertM21EventCatalogComplete(M21_EVENT_NAMES)).not.toThrow();
    expect(M21_OUTBOX_EVENTS).toHaveLength(M21_EVENT_NAMES.length);
  });

  it("owns every name under the m21. prefix (M01 D8 / M03 D9)", () => {
    for (const entry of M21_OUTBOX_EVENTS) {
      expect(entry.moduleOwner).toBe("m21");
      expect(entry.eventName.startsWith("m21.")).toBe(true);
      // `mN.<resource>.<verb>` — three segments, which is what arch:gaps scans for.
      expect(entry.eventName.split(".")).toHaveLength(3);
    }
  });

  it("declares a non-empty consumer list and a payload schema on every event", () => {
    for (const entry of M21_OUTBOX_EVENTS) {
      // Outbox consumers OR a recorded seam audience — an alert-only event legitimately has no
      // outbox subscriber, but no event should interest nobody at all (#103).
      expect(entry.declaredConsumers.length + (entry.seamConsumers?.length ?? 0)).toBeGreaterThan(
        0,
      );
      expect(entry.payloadSchema).toBeDefined();
      expect(entry.description.length).toBeGreaterThan(20);
    }
  });

  it("routes the two M13 hand-back events to m13 and the cancellation pair to m11", () => {
    const consumersOf = (name: M21EventName): readonly string[] =>
      M21_OUTBOX_EVENTS.find((e) => e.eventName === name)?.declaredConsumers ?? [];
    expect(consumersOf("m21.comfort_kit.deployed_at_patient")).toContain("m13");
    expect(consumersOf("m21.comfort_kit.replenished")).toContain("m13");
    expect(consumersOf("m21.supply_request.cancelled")).toContain("m11");
    // F-166 (#248) — `cancel_no_op` has exactly one producer (M11's OWN cascade reply, on an order it
    // already discontinued itself), so a bound m11 consumer would always no-op; dropped, record-only.
    expect(consumersOf("m21.supply_request.cancel_no_op")).not.toContain("m11");
    expect(consumersOf("m21.supply_request.status_changed")).toContain("m11");
  });

  it("catalogues no event the frozen list does not name", () => {
    const frozen = new Set<string>(M21_EVENT_NAMES);
    for (const entry of M21_OUTBOX_EVENTS) expect(frozen.has(entry.eventName)).toBe(true);
  });
});

// ── §4.5.1 the subscription surface ──────────────────────────────────────────────────────────────────

describe("§4.5.1 — the subscribed event names", () => {
  it("binds every consumer constant to the frozen subscription list", () => {
    const subscribed = new Set<string>(M21_SUBSCRIBED_EVENT_NAMES);
    for (const name of [
      M11_SUPPLY_FULFILLMENT_REQUESTED_EVENT,
      M11_SUPPLY_CANCELLATION_REQUESTED_EVENT,
      M11_ORDER_DISCONTINUED_EVENT,
      M13_REPLENISHMENT_NEEDED_EVENT,
      M13_RETURN_REQUIRED_EVENT,
      M13_COMFORT_KIT_DEPLOYED_EVENT,
      M13_CONTROLLED_SUBSTANCE_DISCREPANCY_EVENT,
    ]) {
      expect(subscribed.has(name)).toBe(true);
    }
  });

  it("does NOT subscribe to m6.admission.discharged — M11/M13 are the cascade recipients (D18)", () => {
    expect(M21_SUBSCRIBED_EVENT_NAMES).not.toContain("m6.admission.discharged");
  });
});

// ── §2.1 / D1 the kind split ─────────────────────────────────────────────────────────────────────────

describe("§2.1 — M11 order kind → M21 request kind", () => {
  it("splits M11's single comfort_kit order kind onto the deploy branch", () => {
    expect(supplyRequestKindForOrderKind("comfort_kit")).toBe("comfort_kit_deploy");
    expect(supplyRequestKindForOrderKind("dme")).toBe("dme");
    expect(supplyRequestKindForOrderKind("supply")).toBe("supply");
  });
});

// ── §7.1 W1: the fulfillment cascade ─────────────────────────────────────────────────────────────────

describe("§7.1 W1 — m11.order.supply_fulfillment_requested", () => {
  it("opens a fully anchored request on the happy path (acceptance 1)", () => {
    const action = decideSupplyFulfillmentIntake(fulfillment, facts());
    expect(action.kind).toBe("open_request");
    if (action.kind !== "open_request") throw new Error("unreachable");
    expect(action.draft).toMatchObject({
      kind: "dme",
      patientId: PATIENT,
      admissionId: ADMISSION,
      providerEntityId: PROVIDER_ENTITY,
      locationId: LOCATION,
      sourceOrderId: ORDER,
      sourceReplenishmentEventId: null,
    });
  });

  it("is idempotent on an outbox redelivery — no write, no re-emit (edge 2)", () => {
    const action = decideSupplyFulfillmentIntake(
      fulfillment,
      facts({ existingRequestId: EXISTING_REQUEST }),
    );
    expect(action).toEqual({ kind: "idempotent_skip", supplyRequestId: EXISTING_REQUEST });
  });

  it("checks idempotency BEFORE the anchors, so a redelivery cannot dead-letter", () => {
    const action = decideSupplyFulfillmentIntake(
      fulfillment,
      facts({ existingRequestId: EXISTING_REQUEST, order: null, servingLocationId: null }),
    );
    expect(action.kind).toBe("idempotent_skip");
  });

  it("dead-letters when OrderProvider resolves no order", () => {
    try {
      decideSupplyFulfillmentIntake(fulfillment, facts({ order: null }));
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("M21_SOURCE_ORDER_UNRESOLVED");
      expect((err as { statusCode?: number }).statusCode).toBe(422);
    }
  });

  it("dead-letters when the admission summary does not resolve (the tenancy anchor)", () => {
    try {
      decideSupplyFulfillmentIntake(fulfillment, facts({ admission: null }));
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("M21_SOURCE_ORDER_UNRESOLVED");
    }
  });

  it("dead-letters rather than guess a Location — location_id is NOT NULL", () => {
    try {
      decideSupplyFulfillmentIntake(fulfillment, facts({ servingLocationId: null }));
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("M21_SERVING_LOCATION_UNRESOLVED");
    }
  });

  it("edge 3 — a death discharge between emit and consume opens THEN cancels", () => {
    const action = decideSupplyFulfillmentIntake(
      fulfillment,
      facts({ admission: admissionAt("discharged", { deathDischarge: true }) }),
    );
    expect(action.kind).toBe("open_and_cancel_request");
    if (action.kind !== "open_and_cancel_request") throw new Error("unreachable");
    expect(action.cancellationReason).toBe("patient_deceased_pre_dispatch");
    // The row is still fully anchored — a cancelled request is a record, not a stub.
    expect(action.draft.locationId).toBe(LOCATION);
  });

  it("edge 4 — a LIVE discharge cancels with its own reason", () => {
    const action = decideSupplyFulfillmentIntake(
      fulfillment,
      facts({ admission: admissionAt("discharged", { deathDischarge: false }) }),
    );
    if (action.kind !== "open_and_cancel_request") throw new Error("expected a cancellation");
    expect(action.cancellationReason).toBe("patient_discharged_live_pre_dispatch");
  });

  it("still cancels when the death census could not be read — only the REASON degrades", () => {
    const action = decideSupplyFulfillmentIntake(
      fulfillment,
      facts({ admission: admissionAt("discharged", { deathDischarge: null }) }),
    );
    if (action.kind !== "open_and_cancel_request") throw new Error("expected a cancellation");
    expect(action.cancellationReason).toBe("admission_closed_pre_dispatch");
  });

  it("reads a bereavement admission as post-death without needing the census", () => {
    const action = decideSupplyFulfillmentIntake(
      fulfillment,
      facts({ admission: admissionAt("bereavement", { deathDischarge: null }) }),
    );
    if (action.kind !== "open_and_cancel_request") throw new Error("expected a cancellation");
    expect(action.cancellationReason).toBe("patient_deceased_pre_dispatch");
  });

  it("does not cancel for an on_hold admission — the patient is still in care", () => {
    expect(
      decideSupplyFulfillmentIntake(fulfillment, facts({ admission: admissionAt("on_hold") })).kind,
    ).toBe("open_request");
  });
});

// ── §7.7 W7: the cancellation cascade ────────────────────────────────────────────────────────────────

function target(status: SupplyRequestStatus): SupplyCancellationTarget {
  return { supplyRequestId: EXISTING_REQUEST, kind: "dme", status };
}

describe("§7.7 W7 — m11.order.supply_cancellation_requested", () => {
  const payload = { orderId: ORDER, originalSupplyRequestRef: null };

  it("cancels immediately from every pre-vendor-commitment state (step 3)", () => {
    for (const status of ["requested", "vendor_assigned"] as const) {
      const action = decideSupplyCancellationCascade(payload, target(status));
      expect(action).toEqual({
        kind: "cancel",
        supplyRequestId: EXISTING_REQUEST,
        reason: M11_CANCELLATION_CASCADE_REASON,
      });
    }
  });

  it("goes two-phase once the vendor has the order (§2.2)", () => {
    for (const status of ["ordered", "in_transit"] as const) {
      const action = decideSupplyCancellationCascade(payload, target(status));
      expect(action.kind).toBe("request_cancellation");
    }
  });

  it("does not re-ask a vendor who has not yet answered", () => {
    expect(decideSupplyCancellationCascade(payload, target("cancellation_pending")).kind).toBe(
      "already_cancelling",
    );
  });

  it("emits cancel_no_op for every state past cancelling, so M11 is never left waiting (step 4)", () => {
    for (const status of [
      "delivered",
      "received_confirmed",
      "completed",
      "cancelled",
      "returned",
    ] as const) {
      const action = decideSupplyCancellationCascade(payload, target(status));
      expect(action.kind).toBe("cancel_no_op");
      if (action.kind !== "cancel_no_op") throw new Error("unreachable");
      expect(action.terminalStatus).toBe(status);
    }
  });

  it("stays silent when no request ever cascaded — no phantom id into M11's order record", () => {
    expect(decideSupplyCancellationCascade(payload, null)).toEqual({ kind: "no_match" });
  });
});

// ── §2.2 the DME monthly-rental close-out ────────────────────────────────────────────────────────────

describe("§2.2 — m11.order.discontinued", () => {
  const payload = {
    orderId: ORDER,
    discontinuationId: OUTBOX_EVENT,
    reason: "goals_of_care_change",
    actorMembershipId: DISPATCHER,
    effectiveAt: "2026-07-20T10:00:00.000Z",
  };
  const rental = (
    status: SupplyRequestStatus,
    over: Partial<SupplyDiscontinuationTarget> = {},
  ): SupplyDiscontinuationTarget => ({
    supplyRequestId: EXISTING_REQUEST,
    kind: "dme",
    status,
    rentalCadence: "monthly",
    ...over,
  });

  it("completes a monthly rental — the one kind §2.2 gates on M11's discontinuation", () => {
    expect(decideOrderDiscontinued(payload, rental("received_confirmed"))).toEqual({
      kind: "complete_rental",
      supplyRequestId: EXISTING_REQUEST,
    });
  });

  it("ignores a one-time purchase — it self-completes on receipt", () => {
    expect(
      decideOrderDiscontinued(
        payload,
        rental("received_confirmed", { rentalCadence: "one_time_purchase" }),
      ).kind,
    ).toBe("no_op");
  });

  it("ignores a non-DME kind and an already-terminal row", () => {
    expect(
      decideOrderDiscontinued(payload, rental("received_confirmed", { kind: "supply" })).kind,
    ).toBe("no_op");
    expect(decideOrderDiscontinued(payload, rental("completed")).kind).toBe("no_op");
    expect(decideOrderDiscontinued(payload, null).kind).toBe("no_op");
  });

  it("ignores a rental that has not reached the state completeRequest is legal from", () => {
    expect(decideOrderDiscontinued(payload, rental("in_transit")).kind).toBe("no_op");
  });
});

// ── §4.5.1 the M13 comfort-kit chain ─────────────────────────────────────────────────────────────────

describe("§4.5.1 — m13.comfort_kit.replenishment_needed", () => {
  const payload = {
    deploymentId: DEPLOYMENT,
    medicationOrderId: MED_ORDER,
    drugName: "morphine sulfate",
    remainingQuantity: 2,
    requestedQuantity: 10.5,
    urgencyKind: "routine",
  };
  const base = {
    sourceReplenishmentEventId: OUTBOX_EVENT,
    existingForEventId: null,
    openReplenishRequestId: null,
    dispatch,
  };

  it("opens a replenish request anchored on the outbox row, never on an order", () => {
    const action = decideReplenishmentIntake(payload, base);
    if (action.kind !== "open_replenish_request") throw new Error("expected an insert");
    expect(action.draft.sourceOrderId).toBeNull();
    expect(action.draft.sourceReplenishmentEventId).toBe(OUTBOX_EVENT);
    expect(action.draft.kind).toBe("comfort_kit_replenish");
  });

  it("normalizes M13's float quantity to a decimal string", () => {
    const action = decideReplenishmentIntake(payload, base);
    if (action.kind !== "open_replenish_request") throw new Error("expected an insert");
    expect(action.draft.requestedQuantity).toBe("10.5");
    expect(typeof action.draft.requestedQuantity).toBe("string");
  });

  it("does not stack a second top-up for one shortfall", () => {
    const action = decideReplenishmentIntake(payload, {
      ...base,
      openReplenishRequestId: EXISTING_REQUEST,
    });
    expect(action).toEqual({ kind: "already_pending", supplyRequestId: EXISTING_REQUEST });
  });

  it("is idempotent on the outbox row id", () => {
    expect(
      decideReplenishmentIntake(payload, { ...base, existingForEventId: EXISTING_REQUEST }).kind,
    ).toBe("idempotent_skip");
  });

  it("dead-letters when the deployment maps to no dispatch", () => {
    try {
      decideReplenishmentIntake(payload, { ...base, dispatch: null });
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("M21_DISPATCH_NOT_FOUND");
    }
  });

  it("dead-letters when the provenance event id is missing (the §3.1 one-upstream CHECK)", () => {
    try {
      decideReplenishmentIntake(payload, { ...base, sourceReplenishmentEventId: null });
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("M21_REPLENISHMENT_PROVENANCE_MISSING");
    }
  });
});

describe("§2.6 — m13.comfort_kit.return_required", () => {
  const payload = {
    deploymentId: DEPLOYMENT,
    patientId: PATIENT,
    admissionId: ADMISSION,
    returnRequiredAt: "2026-07-20T10:00:00.000Z",
  };

  it("opens a `requested` return with the due date computed from the window", () => {
    const action = decideReturnRequired(payload, {
      existingReturnId: null,
      dispatch,
      returnWindowHours: 48,
    });
    if (action.kind !== "open_return") throw new Error("expected an insert");
    expect(action.draft.state).toBe("requested");
    expect(action.draft.returnDueAt).toBe("2026-07-22T10:00:00.000Z");
    expect(action.draft.containsControlledSubstance).toBe(true);
    expect(action.draft.dispatchId).toBe(DISPATCH);
  });

  it("is idempotent — one dispatch, one return obligation", () => {
    const action = decideReturnRequired(payload, {
      existingReturnId: "16000000-0000-4000-8000-00000000000d",
      dispatch,
    });
    expect(action.kind).toBe("idempotent_skip");
  });

  it("dead-letters an unmatched deployment rather than open a return against an unknown kit", () => {
    try {
      decideReturnRequired(payload, { existingReturnId: null, dispatch: null });
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("M21_DISPATCH_NOT_FOUND");
    }
  });
});

describe("§2.5 — m13.comfort_kit.deployed (the ack)", () => {
  const payload = {
    deploymentId: DEPLOYMENT,
    patientId: PATIENT,
    admissionId: ADMISSION,
    contents: [],
  };

  it("binds the deployment id on the first ack", () => {
    expect(decideDeploymentAck(payload, { ...dispatch, m13DeploymentId: null })).toEqual({
      kind: "link_deployment",
      dispatchId: DISPATCH,
      m13DeploymentId: DEPLOYMENT,
    });
  });

  it("never re-binds — the FIRST link is what every later M13 event keys on", () => {
    expect(
      decideDeploymentAck(payload, { ...dispatch, m13DeploymentId: "already-linked" }).kind,
    ).toBe("no_op");
  });

  it("treats an unmatched ack as noise, not a fault (§7.2 makes a late ack non-fatal)", () => {
    expect(decideDeploymentAck(payload, null).kind).toBe("no_op");
  });
});

describe("§4.5.1 — m13.comfort_kit.controlled_substance_discrepancy re-emit", () => {
  const RETURN_ID = "17000000-0000-4000-8000-00000000000e";
  const RETRIEVER = "18000000-0000-4000-8000-00000000000f";
  const WITNESS = "19000000-0000-4000-8000-000000000010";
  const RECONCILER = "1a000000-0000-4000-8000-000000000011";

  const payload = {
    deploymentId: DEPLOYMENT,
    medicationOrderId: MED_ORDER,
    returnId: RETURN_ID,
    deltaQuantity: 1.25,
    deltaPercent: 12.5,
  };
  const returnedContent = {
    returnedContentId: "1b000000-0000-4000-8000-000000000012",
    dispatchedContentId: "1c000000-0000-4000-8000-000000000013",
    comfortKitTemplateMedicationId: "1d000000-0000-4000-8000-000000000014",
    medicationOrderId: MED_ORDER,
    rxnorm: "1666777",
    drugName: "morphine sulfate 20mg/mL",
    isControlledSubstance: true,
    controlledSubstanceSchedule: "CII" as const,
    lotNumber: "LOT-77321",
    dispatchedQuantity: "10",
    quantityReturned: "7.5",
    quantityDisposedAtHome: "0",
    quantityUnaccounted: "1.25",
    discrepancyPct: 12.5,
    discrepancyFlagged: true,
  };
  const custody = {
    retrievingMembershipId: RETRIEVER,
    disposalWitnessMembershipId: WITNESS,
    reconciledByMembershipId: RECONCILER,
  };

  it("joins M13's delta to M21's dispatch context and return custody chain", () => {
    const action = decideControlledSubstanceReemit(payload, dispatch, returnedContent, custody);
    if (action.kind !== "reemit") throw new Error("expected a re-emit");
    expect(action.returnId).toBe(RETURN_ID);
    expect(action.dispatchId).toBe(DISPATCH);
    expect(action.detectionSource).toBe("m13_reemit");
    expect(action.discrepantMedication).toBe(returnedContent);
    expect(action.custodyChain).toEqual({
      dispatchedByMembershipId: DISPATCHER,
      retrievingMembershipId: RETRIEVER,
      disposalWitnessMembershipId: WITNESS,
      reconciledByMembershipId: RECONCILER,
    });
  });

  it("tolerates a return with no retriever/witness recorded yet", () => {
    const action = decideControlledSubstanceReemit(payload, dispatch, returnedContent, {
      retrievingMembershipId: null,
      disposalWitnessMembershipId: null,
      reconciledByMembershipId: RECONCILER,
    });
    if (action.kind !== "reemit") throw new Error("expected a re-emit");
    expect(action.custodyChain.retrievingMembershipId).toBeNull();
    expect(action.custodyChain.disposalWitnessMembershipId).toBeNull();
  });

  it("stays silent with no dispatch, no returned-content row, or no return — M13's own event still reaches M36 directly", () => {
    expect(decideControlledSubstanceReemit(payload, null, returnedContent, custody).kind).toBe(
      "no_enrichment_context",
    );
    expect(decideControlledSubstanceReemit(payload, dispatch, null, custody).kind).toBe(
      "no_enrichment_context",
    );
    expect(decideControlledSubstanceReemit(payload, dispatch, returnedContent, null).kind).toBe(
      "no_enrichment_context",
    );
  });
});

// ── the census window helper ─────────────────────────────────────────────────────────────────────────

describe("§7.1 — the death-census discrimination window", () => {
  it("widens a day either side of the admission's discharge date", () => {
    expect(deathCensusWindow("2026-07-15")).toEqual({ from: "2026-07-14", to: "2026-07-16" });
  });

  it("crosses a month boundary correctly", () => {
    expect(deathCensusWindow("2026-08-01")).toEqual({ from: "2026-07-31", to: "2026-08-02" });
  });
});
