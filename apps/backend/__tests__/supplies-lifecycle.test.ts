// apps/backend/__tests__/supplies-lifecycle.test.ts — M21-T03 (§2.2 fulfillment, §2.3 template,
// §2.5 dispatch, §2.6 return + reconciliation, §2.7 par stock, §2.10 detectors).
//
// The pure M21 supplies domain core — no DB, no seams, no clock: every fact is injected.
import type {
  ComfortKitDispatchStatus,
  ComfortKitReturnState,
  RoutingRuleResolved,
  SupplyCourierAttestation,
  SupplyRequestStatus,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  COMFORT_KIT_DISPATCH_GRAPH,
  COMFORT_KIT_RETURN_GRAPH,
  type ComfortKitReturnEvent,
  type DispatchLineInput,
  type DispatchValidationContext,
  PLATFORM_FLOOR_KEYS,
  type ParStockFacts,
  type SupplyRequestEvent,
  applyParStockMovement,
  assertDispatchValid,
  assertMedicationLineDeletable,
  assertParThresholdsOrdered,
  assertTemplateEffective,
  assertTenantTemplateWithinFloor,
  authorTenantTemplate,
  computeReturnDueAt,
  detectReturnEscalation,
  detectSupplyRequestFindings,
  evaluateParStock,
  isTemplateEffectiveAt,
  prepareDispatch,
  reconcileReturn,
  restoreStateAfterRefusal,
  runParMonitor,
  supersedeTemplate,
  transitionComfortKitDispatch,
  transitionComfortKitReturn,
  transitionSupplyRequest,
} from "../src/modules/21-supplies/lifecycle/index";

const DISPATCHER = "11111111-1111-1111-1111-111111111111";
const RETRIEVER = "22222222-2222-2222-2222-222222222222";
const RECONCILER = "33333333-3333-3333-3333-333333333333";
const WITNESS = "44444444-4444-4444-4444-444444444444";
const SUPERVISOR = "55555555-5555-5555-5555-555555555555";
const VENDOR = "66666666-6666-6666-6666-666666666666";
const TEMPLATE = "77777777-7777-7777-7777-777777777777";

const MORPHINE_LINE = "aaaaaaaa-0000-0000-0000-000000000001";
const LORAZEPAM_LINE = "aaaaaaaa-0000-0000-0000-000000000002";
const GLOVES_LINE = "aaaaaaaa-0000-0000-0000-000000000003";

/**
 * Assert a guard raises the exact machine-readable code. `ChartWardenError.message` is prose for the
 * coordinator; the CODE is the contract the UI and the §7 tables key off, so the tests assert on it —
 * `toThrowError(/CODE/)` passes only when the prose happens to contain the token.
 */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect((err as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected a ${code} failure, but nothing was thrown`);
}

const routing = (over: Partial<RoutingRuleResolved> = {}): RoutingRuleResolved => ({
  resolverVersion: "v0.2",
  resolvedAt: "2026-06-09T12:00:00.000Z",
  precedenceLevelUsed: "tenant",
  matchedRuleId: "rule-1",
  assignedVendorId: VENDOR,
  assignedFulfillmentMode: "vendor",
  defaultPharmacyDispatchMode: null,
  candidatesEvaluated: [],
  routingPolicyDigest: "sha256:abc",
  ...over,
});

const attestation = (): SupplyCourierAttestation => ({
  deliveredByMembershipId: DISPATCHER,
  deliveredAt: "2026-06-12T15:00:00.000Z",
  deliveryMethod: "agency_courier",
  evidenceDocumentId: null,
});

const effectKinds = (r: { effects: ReadonlyArray<{ kind: string }> }) =>
  r.effects.map((e) => e.kind);
const outboxEvents = (r: { effects: ReadonlyArray<Record<string, unknown>> }) =>
  r.effects.filter((e) => e.kind === "outbox").map((e) => e.event);
const alerts = (r: { effects: ReadonlyArray<Record<string, unknown>> }) =>
  r.effects.filter((e) => e.kind === "alert").map((e) => e.alert);

// ── §2.2 the fulfillment machine ──────────────────────────────────────────────────────────────────────

describe("§2.2 supply-request lifecycle — the happy path", () => {
  it("walks requested → completed for a one-shot DME purchase", () => {
    let status: SupplyRequestStatus = "requested";
    const steps: ReadonlyArray<SupplyRequestEvent> = [
      {
        type: "assignVendor",
        resolved: routing(),
        vendorActive: true,
        at: "2026-06-09T12:00:00.000Z",
      },
      {
        type: "placeOrderWithVendor",
        vendorOrderReference: "PO-4471",
        at: "2026-06-09T13:00:00.000Z",
      },
      {
        type: "vendorConfirmedShipment",
        trackingNumber: "1Z999",
        carrier: "UPS",
        at: "2026-06-10T09:00:00.000Z",
      },
      { type: "confirmDeliveryAtAddress", attestation: attestation() },
      {
        type: "caregiverOrPatientConfirmsReceipt",
        actor: "caregiver",
        at: "2026-06-12T16:00:00.000Z",
      },
      {
        type: "completeRequest",
        at: "2026-06-12T16:00:00.000Z",
        rentalCadence: "one_time_purchase",
      },
    ];
    const visited: SupplyRequestStatus[] = [];
    for (const event of steps) {
      const t = transitionSupplyRequest(status, "dme", event);
      status = t.to;
      visited.push(status);
    }
    expect(visited).toEqual([
      "vendor_assigned",
      "ordered",
      "in_transit",
      "delivered",
      "received_confirmed",
      "completed",
    ]);
  });

  it("emits status_changed on every transition and audits every one", () => {
    const t = transitionSupplyRequest("requested", "supply", {
      type: "assignVendor",
      resolved: routing(),
      vendorActive: true,
      at: "2026-06-09T12:00:00.000Z",
    });
    expect(effectKinds(t)[0]).toBe("audit");
    expect(outboxEvents(t)).toContain("m21.supply_request.status_changed");
    expect(effectKinds(t)).toContain("freeze_routing");
  });

  it("rejects an edge that does not exist from the current state", () => {
    expectCode(
      () =>
        transitionSupplyRequest("requested", "dme", {
          type: "vendorConfirmedShipment",
          trackingNumber: "1Z",
          carrier: "UPS",
          at: "2026-06-10T09:00:00.000Z",
        }),
      "M21_INVALID_STATUS_TRANSITION",
    );
  });

  it("distinguishes an already-terminal request from an illegal edge (M11's §7.7 cascade branches on it)", () => {
    expectCode(
      () =>
        transitionSupplyRequest("completed", "dme", {
          type: "cancel",
          reason: "operator",
          at: "2026-06-20T00:00:00.000Z",
        }),
      "M21_REQUEST_ALREADY_TERMINAL",
    );
  });
});

describe("§2.2 assignVendor — the D4 routing guards", () => {
  it("refuses a `vendor` resolution that names no vendor", () => {
    expectCode(
      () =>
        transitionSupplyRequest("requested", "dme", {
          type: "assignVendor",
          resolved: routing({ assignedVendorId: null }),
          vendorActive: null,
          at: "2026-06-09T12:00:00.000Z",
        }),
      "M21_ROUTING_VENDOR_INCOHERENT",
    );
  });

  it("refuses an internal-hub resolution that DOES name one", () => {
    expectCode(
      () =>
        transitionSupplyRequest("requested", "comfort_kit_deploy", {
          type: "assignVendor",
          resolved: routing({ assignedFulfillmentMode: "internal_supply_hub" }),
          vendorActive: true,
          at: "2026-06-09T12:00:00.000Z",
        }),
      "M21_ROUTING_VENDOR_INCOHERENT",
    );
  });

  it("refuses an inactive M40 vendor", () => {
    expectCode(
      () =>
        transitionSupplyRequest("requested", "dme", {
          type: "assignVendor",
          resolved: routing(),
          vendorActive: false,
          at: "2026-06-09T12:00:00.000Z",
        }),
      "M21_VENDOR_NOT_ACTIVE",
    );
  });

  it("does not demand a vendor check on the internal-hub path (a null vendor is CORRECT there)", () => {
    const t = transitionSupplyRequest("requested", "comfort_kit_deploy", {
      type: "assignVendor",
      resolved: routing({
        assignedFulfillmentMode: "internal_supply_hub",
        assignedVendorId: null,
        defaultPharmacyDispatchMode: "supply_hub_dispatch",
      }),
      vendorActive: null,
      at: "2026-06-09T12:00:00.000Z",
    });
    expect(t.to).toBe("vendor_assigned");
  });
});

describe("§2.2 kit kinds — the dispatch + deployment coupling", () => {
  it("creates the dispatch row on the SAME transition that places the order", () => {
    const t = transitionSupplyRequest("vendor_assigned", "comfort_kit_deploy", {
      type: "placeOrderWithVendor",
      vendorOrderReference: "HUB-778",
      at: "2026-06-09T13:00:00.000Z",
      dispatchLineCount: 4,
    });
    expect(effectKinds(t)).toContain("create_dispatch");
    expect(outboxEvents(t)).toContain("m21.comfort_kit.dispatched");
  });

  it("refuses an empty kit — a chain-of-custody record of nothing", () => {
    expectCode(
      () =>
        transitionSupplyRequest("vendor_assigned", "comfort_kit_deploy", {
          type: "placeOrderWithVendor",
          vendorOrderReference: "HUB-778",
          at: "2026-06-09T13:00:00.000Z",
          dispatchLineCount: 0,
        }),
      "M21_DISPATCH_CONTENTS_EMPTY",
    );
  });

  it("fires deployed_at_patient on `delivered` for a deploy, and `replenished` for a replenish", () => {
    const deploy = transitionSupplyRequest("in_transit", "comfort_kit_deploy", {
      type: "confirmDeliveryAtAddress",
      attestation: attestation(),
    });
    expect(outboxEvents(deploy)).toContain("m21.comfort_kit.deployed_at_patient");

    const replenish = transitionSupplyRequest("in_transit", "comfort_kit_replenish", {
      type: "confirmDeliveryAtAddress",
      attestation: attestation(),
    });
    expect(outboxEvents(replenish)).toContain("m21.comfort_kit.replenished");
    expect(outboxEvents(replenish)).not.toContain("m21.comfort_kit.deployed_at_patient");
  });

  it("does not fire a kit event for a DME delivery", () => {
    const t = transitionSupplyRequest("in_transit", "dme", {
      type: "confirmDeliveryAtAddress",
      attestation: attestation(),
    });
    expect(outboxEvents(t)).toEqual([
      "m21.supply_request.status_changed",
      "m21.supply_request.delivered",
    ]);
  });

  it("keeps `returned` off the DME branch — a bed pickup is not a controlled-substance reconciliation", () => {
    expectCode(
      () =>
        transitionSupplyRequest("delivered", "dme", {
          type: "initiateReturn",
          at: "2026-07-01T00:00:00.000Z",
        }),
      "M21_INVALID_STATUS_TRANSITION",
    );
    const kit = transitionSupplyRequest("delivered", "comfort_kit_deploy", {
      type: "initiateReturn",
      at: "2026-07-01T00:00:00.000Z",
    });
    expect(kit.to).toBe("returned");
  });
});

describe("§2.2 delivery + receipt confirmation", () => {
  it("refuses a delivery with no courier attestation", () => {
    expectCode(
      () =>
        transitionSupplyRequest("in_transit", "dme", {
          type: "confirmDeliveryAtAddress",
          attestation: { ...attestation(), deliveredByMembershipId: "" },
        }),
      "M21_COURIER_ATTESTATION_REQUIRED",
    );
  });

  it("refuses a system auto-confirm before the 72-hour grace expires", () => {
    expectCode(
      () =>
        transitionSupplyRequest("delivered", "supply", {
          type: "caregiverOrPatientConfirmsReceipt",
          actor: "system_auto_confirm",
          at: "2026-06-13T15:00:00.000Z", // 24h after delivery
          deliveredAt: "2026-06-12T15:00:00.000Z",
        }),
      "M21_AUTO_CONFIRM_WINDOW_NOT_ELAPSED",
    );
  });

  it("allows the auto-confirm once the grace has expired, and records the distinguishing actor", () => {
    const t = transitionSupplyRequest("delivered", "supply", {
      type: "caregiverOrPatientConfirmsReceipt",
      actor: "system_auto_confirm",
      at: "2026-06-15T15:00:00.000Z",
      deliveredAt: "2026-06-12T15:00:00.000Z",
    });
    expect(t.to).toBe("received_confirmed");
    expect(t.effects.find((e) => e.kind === "record_received_confirmation")).toMatchObject({
      actor: "system_auto_confirm",
    });
  });

  it("never gates a HUMAN confirmation on the clock", () => {
    const t = transitionSupplyRequest("delivered", "supply", {
      type: "caregiverOrPatientConfirmsReceipt",
      actor: "caregiver",
      at: "2026-06-12T15:30:00.000Z",
    });
    expect(t.to).toBe("received_confirmed");
  });
});

describe("§2.2 completeRequest — three rules behind one edge", () => {
  it("auto-completes a one-shot supply", () => {
    const t = transitionSupplyRequest("received_confirmed", "supply", {
      type: "completeRequest",
      at: "2026-06-12T16:00:00.000Z",
      rentalCadence: null,
    });
    expect(t.to).toBe("completed");
  });

  it("holds a MONTHLY rental open until M11 discontinues the order", () => {
    expectCode(
      () =>
        transitionSupplyRequest("received_confirmed", "dme", {
          type: "completeRequest",
          at: "2026-06-12T16:00:00.000Z",
          rentalCadence: "monthly",
        }),
      "M21_RENTAL_COMPLETION_REQUIRES_DISCONTINUATION",
    );
    const t = transitionSupplyRequest("received_confirmed", "dme", {
      type: "completeRequest",
      at: "2026-09-30T16:00:00.000Z",
      rentalCadence: "monthly",
      orderDiscontinued: true,
    });
    expect(t.to).toBe("completed");
  });

  it("holds a kit open until M13 acks — a distinct code from the stalled-rental one", () => {
    expectCode(
      () =>
        transitionSupplyRequest("received_confirmed", "comfort_kit_deploy", {
          type: "completeRequest",
          at: "2026-06-12T16:00:00.000Z",
          rentalCadence: null,
        }),
      "M21_KIT_COMPLETION_REQUIRES_M13_ACK",
    );
    const t = transitionSupplyRequest("received_confirmed", "comfort_kit_deploy", {
      type: "completeRequest",
      at: "2026-06-12T16:00:00.000Z",
      rentalCadence: null,
      m13Acked: true,
    });
    expect(t.to).toBe("completed");
  });

  it("refuses to complete a returned kit before its return reconciled", () => {
    expectCode(
      () =>
        transitionSupplyRequest("returned", "comfort_kit_deploy", {
          type: "completeReturnReconciliation",
          at: "2026-07-10T00:00:00.000Z",
          returnReconciled: false,
        }),
      "M21_RETURN_NOT_RECONCILED",
    );
  });
});

describe("§2.2 cancellation — immediate before `ordered`, two-phase after", () => {
  it("cancels immediately from requested and tells M11", () => {
    const t = transitionSupplyRequest("requested", "dme", {
      type: "cancel",
      reason: "m11_cancellation_cascade",
      at: "2026-06-09T12:30:00.000Z",
    });
    expect(t.to).toBe("cancelled");
    expect(outboxEvents(t)).toContain("m21.supply_request.cancelled");
  });

  it("requires a recorded reason", () => {
    expectCode(
      () =>
        transitionSupplyRequest("requested", "dme", {
          type: "cancel",
          reason: "   ",
          at: "2026-06-09T12:30:00.000Z",
        }),
      "M21_CANCELLATION_REASON_REQUIRED",
    );
  });

  it("goes to cancellation_pending after `ordered` and does NOT yet tell M11 the order was released", () => {
    const t = transitionSupplyRequest("ordered", "dme", {
      type: "requestCancellation",
      reason: "family declined the bed",
      at: "2026-06-10T08:00:00.000Z",
    });
    expect(t.to).toBe("cancellation_pending");
    expect(outboxEvents(t)).not.toContain("m21.supply_request.cancelled");
  });

  it("walks the row BACK to the state it actually left when the vendor refuses", () => {
    const back = transitionSupplyRequest("cancellation_pending", "dme", {
      type: "vendorRefusedCancellation",
      restoreTo: "in_transit",
      vendorReason: "already on the truck",
    });
    expect(back.to).toBe("in_transit");
    expect(alerts(back)).toContain("m21.supply_request.vendor_cancellation_refused");

    const backToOrdered = transitionSupplyRequest("cancellation_pending", "dme", {
      type: "vendorRefusedCancellation",
      restoreTo: "ordered",
      vendorReason: null,
    });
    expect(backToOrdered.to).toBe("ordered");
  });

  it("derives the restore state from the shipment record, not from a stored copy", () => {
    expect(restoreStateAfterRefusal(null)).toBe("ordered");
    expect(restoreStateAfterRefusal("2026-06-10T09:00:00.000Z")).toBe("in_transit");
  });

  it("completes the two-phase cancellation when the vendor confirms", () => {
    const t = transitionSupplyRequest("cancellation_pending", "dme", {
      type: "vendorConfirmedCancellation",
      reason: "vendor confirmed",
      at: "2026-06-10T18:00:00.000Z",
    });
    expect(t.to).toBe("cancelled");
    expect(t.effects.find((e) => e.kind === "record_cancellation")).toMatchObject({
      requiredVendorConfirmation: true,
    });
  });
});

// ── §2.10 the lateness detectors ──────────────────────────────────────────────────────────────────────

describe("§2.10 detectSupplyRequestFindings", () => {
  it("flags a vendor confirmation past the 24h default", () => {
    const findings = detectSupplyRequestFindings(
      {
        status: "ordered",
        orderedAt: "2026-06-09T12:00:00.000Z",
        deliveredAt: null,
        deliveryWindowLatest: null,
      },
      new Date("2026-06-10T13:00:00.000Z"),
    );
    expect(findings.map((f) => f.kind)).toEqual(["vendor_confirmation_overdue"]);
  });

  it("honours a TIGHTER tenant window but never a looser one than the ceiling", () => {
    const at = new Date("2026-06-09T22:00:00.000Z");
    expect(
      detectSupplyRequestFindings(
        {
          status: "ordered",
          orderedAt: "2026-06-09T12:00:00.000Z",
          deliveredAt: null,
          deliveryWindowLatest: null,
          vendorConfirmationWindowHours: 8,
        },
        at,
      ),
    ).toHaveLength(1);
    expect(
      detectSupplyRequestFindings(
        {
          status: "ordered",
          orderedAt: "2026-06-09T12:00:00.000Z",
          deliveredAt: null,
          deliveryWindowLatest: null,
          vendorConfirmationWindowHours: 240, // beyond the platform ceiling → ceiling applies
        },
        new Date("2026-06-13T12:00:00.000Z"),
      ),
    ).toHaveLength(1);
  });

  it("flags a delivery past its declared window, and stays silent when none was declared", () => {
    expect(
      detectSupplyRequestFindings(
        {
          status: "in_transit",
          orderedAt: "2026-06-09T12:00:00.000Z",
          deliveredAt: null,
          deliveryWindowLatest: "2026-06-11T12:00:00.000Z",
        },
        new Date("2026-06-12T12:00:00.000Z"),
      ).map((f) => f.kind),
    ).toEqual(["delivery_overdue"]);

    expect(
      detectSupplyRequestFindings(
        {
          status: "in_transit",
          orderedAt: "2026-06-09T12:00:00.000Z",
          deliveredAt: null,
          deliveryWindowLatest: null,
        },
        new Date("2026-07-12T12:00:00.000Z"),
      ),
    ).toEqual([]);
  });

  it("surfaces the 72h auto-confirm as a finding, leaving the transition to the caller", () => {
    expect(
      detectSupplyRequestFindings(
        {
          status: "delivered",
          orderedAt: null,
          deliveredAt: "2026-06-12T15:00:00.000Z",
          deliveryWindowLatest: null,
        },
        new Date("2026-06-15T16:00:00.000Z"),
      ).map((f) => f.kind),
    ).toEqual(["received_confirm_auto_due"]);
  });
});

// ── §2.3 the comfort-kit template ─────────────────────────────────────────────────────────────────────

const floorLines = () => [
  {
    floorKey: "morphine_sulfate_20mg_ml_oral_solution",
    drugName: "Morphine sulfate",
    isControlledSubstance: true,
    expectedQuantity: 30,
    replenishmentThresholdPct: 0.25,
  },
  {
    floorKey: "lorazepam_2mg_ml_oral_solution",
    drugName: "Lorazepam",
    isControlledSubstance: true,
    expectedQuantity: 15,
    replenishmentThresholdPct: 0.25,
  },
  {
    floorKey: "haloperidol_5mg_ml_oral_solution",
    drugName: "Haloperidol",
    isControlledSubstance: false,
    expectedQuantity: 10,
    replenishmentThresholdPct: 0.25,
  },
  {
    floorKey: "atropine_sulfate_1pct_ophthalmic_solution",
    drugName: "Atropine sulfate",
    isControlledSubstance: false,
    expectedQuantity: 5,
    replenishmentThresholdPct: 0.25,
  },
];

describe("§2.3 comfort-kit template — tenant may extend or tighten, never remove or loosen", () => {
  it("exposes the four platform-floor keys", () => {
    expect(PLATFORM_FLOOR_KEYS).toHaveLength(4);
  });

  it("accepts a tenant template that tightens a quantity and RAISES a threshold, plus an addition", () => {
    const lines = floorLines();
    lines[0] = { ...lines[0]!, expectedQuantity: 20, replenishmentThresholdPct: 0.33 };
    expect(() =>
      authorTenantTemplate({
        lines: [
          ...lines,
          {
            floorKey: null,
            drugName: "Glycopyrrolate",
            isControlledSubstance: false,
            expectedQuantity: 10,
            replenishmentThresholdPct: 0.25,
          },
        ],
        effectiveFrom: "2026-06-01T00:00:00.000Z",
        effectiveTo: null,
      }),
    ).not.toThrow();
  });

  it("rejects a removed floor medication", () => {
    expectCode(
      () => assertTenantTemplateWithinFloor(floorLines().slice(1)),
      "M21_TEMPLATE_VIOLATES_PLATFORM_FLOOR",
    );
  });

  it("rejects a LOWERED replenishment threshold — that is the direction that empties a kit unseen", () => {
    const lines = floorLines();
    lines[0] = { ...lines[0]!, replenishmentThresholdPct: 0.1 };
    expectCode(
      () => assertTenantTemplateWithinFloor(lines),
      "M21_TEMPLATE_VIOLATES_PLATFORM_FLOOR",
    );
  });

  it("rejects a quantity outside the half-to-double bounds in both directions", () => {
    const low = floorLines();
    low[0] = { ...low[0]!, expectedQuantity: 10 }; // floor 30 → min 15
    expectCode(() => assertTenantTemplateWithinFloor(low), "M21_TEMPLATE_VIOLATES_PLATFORM_FLOOR");

    const high = floorLines();
    high[0] = { ...high[0]!, expectedQuantity: 90 }; // ceiling 60
    expectCode(() => assertTenantTemplateWithinFloor(high), "M21_TEMPLATE_VIOLATES_PLATFORM_FLOOR");
  });

  it("blocks deleting a system_locked medication line", () => {
    expectCode(
      () => assertMedicationLineDeletable({ systemLocked: true, drugName: "Morphine sulfate" }),
      "M21_TEMPLATE_SYSTEM_LOCKED",
    );
    expect(() =>
      assertMedicationLineDeletable({ systemLocked: false, drugName: "Glycopyrrolate" }),
    ).not.toThrow();
  });
});

describe("§2.3 template effective windows", () => {
  const template = {
    templateId: TEMPLATE,
    isPlatformFloor: false,
    systemLocked: false,
    effectiveFrom: "2026-06-01T00:00:00.000Z",
    effectiveTo: "2026-07-01T00:00:00.000Z",
  };

  it("is half-open: `from` inclusive, `to` exclusive, so a supersession covers no instant twice", () => {
    expect(isTemplateEffectiveAt(template, new Date("2026-06-01T00:00:00.000Z"))).toBe(true);
    expect(isTemplateEffectiveAt(template, new Date("2026-06-30T23:59:59.000Z"))).toBe(true);
    expect(isTemplateEffectiveAt(template, new Date("2026-07-01T00:00:00.000Z"))).toBe(false);
    expect(isTemplateEffectiveAt(template, new Date("2026-05-31T23:59:59.000Z"))).toBe(false);
  });

  it("refuses a dispatch against a retired recipe", () => {
    expectCode(
      () => assertTemplateEffective(template, new Date("2026-08-01T00:00:00.000Z")),
      "M21_TEMPLATE_NOT_EFFECTIVE",
    );
  });

  it("closes the predecessor exactly where the successor opens", () => {
    const r = supersedeTemplate({
      predecessor: { ...template, effectiveTo: null },
      successorEffectiveFrom: "2026-07-01T00:00:00.000Z",
      lines: floorLines(),
    });
    expect(r.effects).toContainEqual({
      kind: "set_timestamp",
      field: "effective_to",
      at: "2026-07-01T00:00:00.000Z",
    });
  });

  it("refuses to supersede the platform-floor template from a tenant edit", () => {
    expectCode(
      () =>
        supersedeTemplate({
          predecessor: { ...template, isPlatformFloor: true, effectiveTo: null },
          successorEffectiveFrom: "2026-07-01T00:00:00.000Z",
          lines: floorLines(),
        }),
      "M21_TEMPLATE_SYSTEM_LOCKED",
    );
  });

  it("refuses a successor that predates the version it replaces, and a double supersession", () => {
    expectCode(
      () =>
        supersedeTemplate({
          predecessor: { ...template, effectiveTo: null },
          successorEffectiveFrom: "2026-05-01T00:00:00.000Z",
          lines: floorLines(),
        }),
      "M21_TEMPLATE_EFFECTIVE_WINDOW_INVALID",
    );
    expectCode(
      () =>
        supersedeTemplate({
          predecessor: template,
          successorEffectiveFrom: "2026-08-01T00:00:00.000Z",
          lines: floorLines(),
        }),
      "M21_TEMPLATE_EFFECTIVE_WINDOW_INVALID",
    );
  });
});

// ── §2.5 dispatch ─────────────────────────────────────────────────────────────────────────────────────

const line = (over: Partial<DispatchLineInput> = {}): DispatchLineInput => ({
  comfortKitTemplateMedicationId: MORPHINE_LINE,
  drugName: "Morphine sulfate",
  isControlledSubstance: true,
  controlledSubstanceSchedule: "CII",
  dispatchedQuantity: "30",
  dispatchedUnit: "mL",
  lotNumber: "LOT-88",
  expirationDate: "2027-01-31",
  ...over,
});

const ctx = (over: Partial<DispatchValidationContext> = {}): DispatchValidationContext => ({
  templateMedicationIds: [MORPHINE_LINE, LORAZEPAM_LINE, GLOVES_LINE],
  floorTemplateMedicationIds: [MORPHINE_LINE, LORAZEPAM_LINE],
  dispatcherControlledEligible: true,
  dispatchedAt: new Date("2026-06-09T12:00:00.000Z"),
  isReplenishment: false,
  ...over,
});

const floorPair = (): DispatchLineInput[] => [
  line(),
  line({
    comfortKitTemplateMedicationId: LORAZEPAM_LINE,
    drugName: "Lorazepam",
    controlledSubstanceSchedule: "CIV",
    dispatchedQuantity: "15",
    lotNumber: "LOT-91",
  }),
];

describe("§2.5 dispatch validation — five fail-closed refusals", () => {
  it("accepts a complete, in-window, fully-lotted kit", () => {
    expect(() => assertDispatchValid(floorPair(), ctx())).not.toThrow();
  });

  it("refuses an empty dispatch", () => {
    expectCode(() => assertDispatchValid([], ctx()), "M21_DISPATCH_CONTENTS_EMPTY");
  });

  it("refuses an ineligible dispatcher ONLY when the kit carries a controlled line", () => {
    expectCode(
      () => assertDispatchValid(floorPair(), ctx({ dispatcherControlledEligible: false })),
      "M21_CONTROLLED_SUBSTANCE_DISPATCHER_DENIED",
    );
    // A non-controlled-only kit does not require the credential — otherwise agencies grant it broadly.
    expect(() =>
      assertDispatchValid(
        [
          line({
            comfortKitTemplateMedicationId: GLOVES_LINE,
            drugName: "Nitrile gloves",
            isControlledSubstance: false,
            controlledSubstanceSchedule: null,
            lotNumber: null,
            expirationDate: null,
          }),
        ],
        ctx({
          dispatcherControlledEligible: false,
          floorTemplateMedicationIds: [],
        }),
      ),
    ).not.toThrow();
  });

  it("refuses a controlled line with no lot number", () => {
    expectCode(
      () => assertDispatchValid([line({ lotNumber: null }), ...floorPair().slice(1)], ctx()),
      "M21_LOT_NUMBER_REQUIRED",
    );
  });

  it("refuses a lot with no expiration date", () => {
    expectCode(
      () =>
        assertDispatchValid(
          [
            line({
              comfortKitTemplateMedicationId: GLOVES_LINE,
              drugName: "Nitrile gloves",
              isControlledSubstance: false,
              controlledSubstanceSchedule: null,
              lotNumber: "LOT-12",
              expirationDate: null,
            }),
          ],
          ctx({ floorTemplateMedicationIds: [] }),
        ),
      "M21_EXPIRATION_REQUIRED_WITH_LOT",
    );
  });

  it("refuses a controlled line expiring inside the 30-day window", () => {
    expectCode(
      () =>
        assertDispatchValid(
          [line({ expirationDate: "2026-06-20" }), ...floorPair().slice(1)],
          ctx(),
        ),
      "M21_CONTROLLED_EXPIRATION_WINDOW",
    );
  });

  it("applies the 14-day SQL floor rather than a tenant policy that sits below it", () => {
    expectCode(
      () =>
        assertDispatchValid(
          [line({ expirationDate: "2026-06-15" }), ...floorPair().slice(1)],
          ctx({ controlledExpirationMinDays: 2 }),
        ),
      "M21_CONTROLLED_EXPIRATION_WINDOW",
    );
  });

  it("refuses a line the referenced template does not contain", () => {
    expectCode(
      () =>
        assertDispatchValid(
          [line({ comfortKitTemplateMedicationId: "99999999-9999-9999-9999-999999999999" })],
          ctx(),
        ),
      "M21_DISPATCH_CONTENT_NOT_IN_TEMPLATE",
    );
  });

  it("refuses a mismatched controlled/schedule pair in both directions", () => {
    expectCode(
      () => assertDispatchValid([line({ controlledSubstanceSchedule: null })], ctx()),
      "M21_CONTROLLED_SCHEDULE_MISMATCH",
    );
    expectCode(
      () =>
        assertDispatchValid(
          [line({ isControlledSubstance: false, lotNumber: null, expirationDate: null })],
          ctx(),
        ),
      "M21_CONTROLLED_SCHEDULE_MISMATCH",
    );
  });

  it("refuses a non-positive quantity", () => {
    expectCode(
      () => assertDispatchValid([line({ dispatchedQuantity: "0" })], ctx()),
      "M21_DISPATCH_QUANTITY_INVALID",
    );
  });

  it("catches a hand-assembled kit that omitted a floor medication", () => {
    expectCode(() => assertDispatchValid([line()], ctx()), "M21_TEMPLATE_VIOLATES_PLATFORM_FLOOR");
  });

  it("EXEMPTS a replenishment from floor coverage — it ships only what crossed threshold", () => {
    expect(() => assertDispatchValid([line()], ctx({ isReplenishment: true }))).not.toThrow();
  });
});

describe("§2.5 prepareDispatch header", () => {
  const header = {
    kitSerialNumber: "KIT-0091",
    dispatchedByMembershipId: DISPATCHER,
    dispatchSource: "supply_hub" as const,
    pharmacyDispatchMode: "supply_hub_dispatch" as const,
    pharmacyPartnerId: null,
    controlledSubstanceHandlingPolicyDigest: "sha256:policy",
  };

  it("declares the dispatch writes plus the BOL request", () => {
    const effects = prepareDispatch(floorPair(), header, ctx());
    expect(effects.map((e) => e.kind)).toEqual([
      "audit",
      "create_dispatch",
      "set_dispatch_status",
      "outbox",
      "request_document",
    ]);
  });

  it("refuses a kit with no serial and one with no frozen handling-policy digest", () => {
    expectCode(
      () => prepareDispatch(floorPair(), { ...header, kitSerialNumber: " " }, ctx()),
      "M21_KIT_SERIAL_REQUIRED",
    );
    expectCode(
      () =>
        prepareDispatch(
          floorPair(),
          { ...header, controlledSubstanceHandlingPolicyDigest: "" },
          ctx(),
        ),
      "M21_HANDLING_POLICY_DIGEST_REQUIRED",
    );
  });
});

describe("M21-F04 dispatch status machine", () => {
  it("gates deployment on `dispatched` so two racing deploys are safe (§7.2)", () => {
    const t = transitionComfortKitDispatch("dispatched", {
      type: "deployAtPatient",
      deployedByMembershipId: DISPATCHER,
      at: "2026-06-12T15:00:00.000Z",
      isReplenishment: false,
    });
    expect(t.to).toBe("deployed_at_patient");
    expectCode(
      () =>
        transitionComfortKitDispatch("deployed_at_patient", {
          type: "deployAtPatient",
          deployedByMembershipId: DISPATCHER,
          at: "2026-06-12T15:05:00.000Z",
          isReplenishment: false,
        }),
      "M21_DISPATCH_NOT_DEPLOYABLE",
    );
  });

  it("accepts M13's late ack in every non-terminal status WITHOUT moving the status", () => {
    const nonTerminal: ComfortKitDispatchStatus[] = [
      "dispatched",
      "deployed_at_patient",
      "partially_returned",
      "fully_returned",
    ];
    for (const status of nonTerminal) {
      const t = transitionComfortKitDispatch(status, {
        type: "linkM13Deployment",
        m13DeploymentId: "dep-1",
      });
      expect(t.to).toBe(status);
      expect(effectKinds(t)).toContain("link_m13_deployment");
    }
  });

  it("picks the terminal status from the computed discrepancy", () => {
    expect(
      transitionComfortKitDispatch("fully_returned", {
        type: "recordReconciliation",
        discrepancyDetected: false,
      }).to,
    ).toBe("reconciled");
    expect(
      transitionComfortKitDispatch("fully_returned", {
        type: "recordReconciliation",
        discrepancyDetected: true,
      }).to,
    ).toBe("reconciled_with_discrepancy");
  });

  it("leaves both reconciled statuses terminal", () => {
    expect(COMFORT_KIT_DISPATCH_GRAPH.reconciled).toEqual([]);
    expect(COMFORT_KIT_DISPATCH_GRAPH.reconciled_with_discrepancy).toEqual([]);
    expectCode(
      () =>
        transitionComfortKitDispatch("reconciled", {
          type: "recordPartialReturn",
        }),
      "M21_DISPATCH_STATUS_TRANSITION_INVALID",
    );
  });
});

// ── §2.6 return + reconciliation ──────────────────────────────────────────────────────────────────────

const DISPATCHED_A = "bbbbbbbb-0000-0000-0000-000000000001";
const DISPATCHED_B = "bbbbbbbb-0000-0000-0000-000000000002";

const reconcileEvent = (
  over: Partial<Extract<ComfortKitReturnEvent, { type: "reconcile" }>> = {},
): Extract<ComfortKitReturnEvent, { type: "reconcile" }> => ({
  type: "reconcile",
  at: "2026-07-05T12:00:00.000Z",
  reconciledByMembershipId: RECONCILER,
  disposalMethod: "take_back_by_supply_team",
  disposalWitnessMembershipId: null,
  disposalMethodJurisdictionPolicyDigest: "sha256:or-disposal",
  dispatchedContentIds: [DISPATCHED_A, DISPATCHED_B],
  dispatchedByMembershipId: DISPATCHER,
  assignedRetrievingMembershipId: RETRIEVER,
  lines: [
    {
      dispatchedContentId: DISPATCHED_A,
      drugName: "Morphine sulfate",
      dispatchedQuantity: "30",
      quantityReturned: "20",
      quantityDisposedAtHome: "10",
      isControlledSubstance: true,
      controlledSubstanceSchedule: "CII",
    },
    {
      dispatchedContentId: DISPATCHED_B,
      drugName: "Haloperidol",
      dispatchedQuantity: "10",
      quantityReturned: "4",
      quantityDisposedAtHome: "0",
      isControlledSubstance: false,
      controlledSubstanceSchedule: null,
    },
  ],
  ...over,
});

describe("§2.6 return machine", () => {
  it("walks requested → reconciled", () => {
    let state: ComfortKitReturnState = "requested";
    state = transitionComfortKitReturn(state, {
      type: "assignRetriever",
      retrievingMembershipId: RETRIEVER,
      at: "2026-07-02T09:00:00.000Z",
    }).to;
    expect(state).toBe("assigned");
    state = transitionComfortKitReturn(state, {
      type: "markEnRoute",
      at: "2026-07-02T10:00:00.000Z",
    }).to;
    expect(state).toBe("retrieving");
    state = transitionComfortKitReturn(state, {
      type: "markRetrieved",
      at: "2026-07-02T11:00:00.000Z",
      returnedToHubAt: "2026-07-02T13:00:00.000Z",
    }).to;
    expect(state).toBe("retrieved");
    state = transitionComfortKitReturn(state, reconcileEvent()).to;
    expect(state).toBe("reconciled");
  });

  it("keeps `overdue` recoverable — a kit found on day 40 is still counted", () => {
    expect(COMFORT_KIT_RETURN_GRAPH.overdue).toContain("reconcile");
    const t = transitionComfortKitReturn("overdue", {
      type: "markRetrieved",
      at: "2026-08-10T11:00:00.000Z",
      returnedToHubAt: null,
    });
    expect(t.to).toBe("retrieved");
  });

  it("tells the second of two racing reconcilers exactly what happened (§7.3)", () => {
    expectCode(
      () => transitionComfortKitReturn("reconciled", reconcileEvent()),
      "M21_RETURN_ALREADY_RECONCILED",
    );
  });

  it("computes return_due_at from the tenant window", () => {
    expect(computeReturnDueAt("2026-07-01T00:00:00.000Z")).toBe("2026-07-04T00:00:00.000Z");
    expect(computeReturnDueAt("2026-07-01T00:00:00.000Z", 24)).toBe("2026-07-02T00:00:00.000Z");
  });

  it("refuses `markOverdue` before the 30-day boundary", () => {
    expectCode(
      () =>
        transitionComfortKitReturn("requested", {
          type: "markOverdue",
          at: "2026-07-10T00:00:00.000Z",
          returnRequiredAt: "2026-07-01T00:00:00.000Z",
          containsControlledSubstance: true,
        }),
      "M21_RETURN_NOT_YET_OVERDUE",
    );
  });

  it("escalates at 30 days with the compliance surface", () => {
    const t = transitionComfortKitReturn("requested", {
      type: "markOverdue",
      at: "2026-07-31T00:00:00.000Z",
      returnRequiredAt: "2026-07-01T00:00:00.000Z",
      containsControlledSubstance: true,
    });
    expect(t.to).toBe("overdue");
    expect(outboxEvents(t)).toContain("m21.comfort_kit.return_overdue");
    expect(outboxEvents(t)).not.toContain("m21.controlled_substance.discrepancy_detected");
  });

  it("takes the assumption of loss at 90 days and fires the discrepancy for controlled content", () => {
    const t = transitionComfortKitReturn("overdue", {
      type: "markUnreturnable",
      at: "2026-10-01T00:00:00.000Z",
      returnRequiredAt: "2026-07-01T00:00:00.000Z",
      reason: "residence vacated; family unreachable after six documented attempts",
      attestedByMembershipId: SUPERVISOR,
      containsControlledSubstance: true,
    });
    expect(t.to).toBe("unreturnable");
    expect(outboxEvents(t)).toContain("m21.controlled_substance.discrepancy_detected");
    expect(effectKinds(t)).toContain("record_unreturnable");
  });

  it("does not fire a controlled discrepancy on a kit with no controlled content", () => {
    const t = transitionComfortKitReturn("overdue", {
      type: "markUnreturnable",
      at: "2026-10-01T00:00:00.000Z",
      returnRequiredAt: "2026-07-01T00:00:00.000Z",
      reason: "kit destroyed in a house fire; incident report filed",
      attestedByMembershipId: SUPERVISOR,
      containsControlledSubstance: false,
    });
    expect(outboxEvents(t)).not.toContain("m21.controlled_substance.discrepancy_detected");
  });

  it("requires an attested reason for the 90-day disposition", () => {
    expectCode(
      () =>
        transitionComfortKitReturn("overdue", {
          type: "markUnreturnable",
          at: "2026-10-01T00:00:00.000Z",
          returnRequiredAt: "2026-07-01T00:00:00.000Z",
          reason: "  ",
          attestedByMembershipId: SUPERVISOR,
          containsControlledSubstance: false,
        }),
      "M21_UNRETURNABLE_REASON_REQUIRED",
    );
  });
});

describe("§2.6 / D8 reconciliation", () => {
  it("computes the per-line accounting and stays unflagged when everything is accounted for", () => {
    const outcome = reconcileReturn("retrieved", reconcileEvent());
    expect(outcome.discrepancyDetected).toBe(false);
    expect(outcome.lines[0]).toMatchObject({
      dispatchedContentId: DISPATCHED_A,
      quantityUnaccounted: "0",
      discrepancyFlagged: false,
    });
    // A non-controlled line short by 60% is NOT flagged: gloves get used.
    expect(outcome.lines[1]?.discrepancyFlagged).toBe(false);
    expect(outboxEvents(outcome.transition)).toEqual([
      "m21.comfort_kit.returned",
      "m21.comfort_kit.return_reconciliation",
    ]);
  });

  it("flags a controlled line short by 5% or more, and fires the survey surfaces", () => {
    const outcome = reconcileReturn(
      "retrieved",
      reconcileEvent({
        lines: [
          {
            dispatchedContentId: DISPATCHED_A,
            drugName: "Morphine sulfate",
            dispatchedQuantity: "30",
            quantityReturned: "20",
            quantityDisposedAtHome: "8",
            isControlledSubstance: true,
            controlledSubstanceSchedule: "CII",
          },
          {
            dispatchedContentId: DISPATCHED_B,
            drugName: "Haloperidol",
            dispatchedQuantity: "10",
            quantityReturned: "10",
            quantityDisposedAtHome: "0",
            isControlledSubstance: false,
            controlledSubstanceSchedule: null,
          },
        ],
      }),
    );
    expect(outcome.discrepancyDetected).toBe(true);
    expect(outcome.flaggedLineCount).toBe(1);
    expect(outcome.lines[0]?.quantityUnaccounted).toBe("2");
    expect(outboxEvents(outcome.transition)).toContain(
      "m21.controlled_substance.discrepancy_detected",
    );
    expect(alerts(outcome.transition)).toContain("m21.controlled_substance.discrepancy");
  });

  it("refuses an over-return rather than writing a negative unaccounted quantity", () => {
    expectCode(
      () =>
        reconcileReturn(
          "retrieved",
          reconcileEvent({
            lines: [
              {
                dispatchedContentId: DISPATCHED_A,
                drugName: "Morphine sulfate",
                dispatchedQuantity: "30",
                quantityReturned: "35",
                quantityDisposedAtHome: "0",
                isControlledSubstance: true,
                controlledSubstanceSchedule: "CII",
              },
              {
                dispatchedContentId: DISPATCHED_B,
                drugName: "Haloperidol",
                dispatchedQuantity: "10",
                quantityReturned: "10",
                quantityDisposedAtHome: "0",
                isControlledSubstance: false,
                controlledSubstanceSchedule: null,
              },
            ],
          }),
        ),
      "M21_INVALID_RECONCILIATION_QUANTITY",
    );
  });

  it("refuses a reconciliation that omits a dispatched line", () => {
    expectCode(
      () =>
        reconcileReturn(
          "retrieved",
          reconcileEvent({
            lines: [
              {
                dispatchedContentId: DISPATCHED_A,
                drugName: "Morphine sulfate",
                dispatchedQuantity: "30",
                quantityReturned: "30",
                quantityDisposedAtHome: "0",
                isControlledSubstance: true,
                controlledSubstanceSchedule: "CII",
              },
            ],
          }),
        ),
      "M21_RECONCILIATION_LINE_COVERAGE_INCOMPLETE",
    );
  });

  it("refuses a reconciler who is the dispatcher (§7.3 separation of duties)", () => {
    expectCode(
      () => reconcileReturn("retrieved", reconcileEvent({ reconciledByMembershipId: DISPATCHER })),
      "M21_RECONCILIATION_SEPARATION_OF_DUTIES_VIOLATION",
    );
  });

  it("requires a witness for at-home witnessed destruction", () => {
    expectCode(
      () =>
        reconcileReturn(
          "retrieved",
          reconcileEvent({
            disposalMethod: "dispose_at_home_by_witnessed_destruction",
            disposalWitnessMembershipId: null,
          }),
        ),
      "M21_WITNESS_REQUIRED_FOR_CONTROLLED_SUBSTANCE",
    );
  });

  it("refuses a witness who is the retriever or the reconciler", () => {
    expectCode(
      () =>
        reconcileReturn(
          "retrieved",
          reconcileEvent({
            disposalMethod: "dispose_at_home_by_witnessed_destruction",
            disposalWitnessMembershipId: RETRIEVER,
          }),
        ),
      "M21_RECONCILIATION_SEPARATION_OF_DUTIES_VIOLATION",
    );
    expectCode(
      () =>
        reconcileReturn(
          "retrieved",
          reconcileEvent({
            disposalMethod: "dispose_at_home_by_witnessed_destruction",
            disposalWitnessMembershipId: RECONCILER,
          }),
        ),
      "M21_RECONCILIATION_SEPARATION_OF_DUTIES_VIOLATION",
    );
    const ok = reconcileReturn(
      "retrieved",
      reconcileEvent({
        disposalMethod: "dispose_at_home_by_witnessed_destruction",
        disposalWitnessMembershipId: WITNESS,
      }),
    );
    expect(ok.transition.to).toBe("reconciled");
  });

  it("requires the jurisdiction disposal policy digest to be frozen onto the record", () => {
    expectCode(
      () =>
        reconcileReturn(
          "retrieved",
          reconcileEvent({ disposalMethodJurisdictionPolicyDigest: "" }),
        ),
      "M21_DISPOSAL_METHOD_REQUIRED",
    );
  });
});

describe("§2.6 / §7.6 escalation scan", () => {
  it("says nothing before 30 days", () => {
    expect(
      detectReturnEscalation(
        { state: "assigned", returnRequiredAt: "2026-07-01T00:00:00.000Z" },
        new Date("2026-07-20T00:00:00.000Z"),
      ),
    ).toEqual({ kind: "none" });
  });

  it("escalates medium at 30 days and high at 90", () => {
    expect(
      detectReturnEscalation(
        { state: "assigned", returnRequiredAt: "2026-07-01T00:00:00.000Z" },
        new Date("2026-08-01T00:00:00.000Z"),
      ),
    ).toMatchObject({ kind: "overdue_30d", severity: "medium" });
    expect(
      detectReturnEscalation(
        { state: "overdue", returnRequiredAt: "2026-07-01T00:00:00.000Z" },
        new Date("2026-10-01T00:00:00.000Z"),
      ),
    ).toMatchObject({ kind: "unreturnable_90d", severity: "high" });
  });

  it("never re-escalates a terminal return", () => {
    for (const state of ["reconciled", "unreturnable"] as const) {
      expect(
        detectReturnEscalation(
          { state, returnRequiredAt: "2026-01-01T00:00:00.000Z" },
          new Date("2026-12-01T00:00:00.000Z"),
        ),
      ).toEqual({ kind: "none" });
    }
  });
});

// ── §2.7 par stock ────────────────────────────────────────────────────────────────────────────────────

const par = (over: Partial<ParStockFacts> = {}): ParStockFacts => ({
  parStockId: "cccccccc-0000-0000-0000-000000000001",
  currentQuantity: "12",
  reorderPoint: "10",
  minSafetyStock: "4",
  reorderQuantity: "50",
  unit: "box",
  isActive: true,
  ...over,
});

describe("§2.7 par-stock monitoring", () => {
  const asOf = new Date("2026-06-20T11:00:00.000Z");

  it("skips a retired row entirely", () => {
    expect(evaluateParStock(par({ isActive: false }), asOf)).toBeNull();
  });

  it("reports an ok shelf with no events (so the sweep can count what it looked at)", () => {
    const f = evaluateParStock(par(), asOf);
    expect(f).toMatchObject({ severity: "ok", events: [] });
  });

  it("emits BOTH threshold events at the safety floor — the reorder queue must still see it", () => {
    const f = evaluateParStock(par({ currentQuantity: "3" }), asOf);
    expect(f?.events).toEqual(["m21.par.below_threshold", "m21.par.stockout_imminent"]);
    expect(f?.severity).toBe("critical_low");
  });

  it("returns only the rows that tripped from the nightly sweep", () => {
    const findings = runParMonitor(
      [par(), par({ parStockId: "low", currentQuantity: "2" }), par({ isActive: false })],
      asOf,
    );
    expect(findings.map((f) => f.parStockId)).toEqual(["low"]);
  });
});

describe("§2.7 par-stock movement", () => {
  it("decrements on a dispatch and increments on a vendor receipt", () => {
    expect(
      applyParStockMovement(par(), { kind: "dispatch_decrement", quantity: "2" }).nextQuantity,
    ).toBe("10");
    expect(
      applyParStockMovement(par(), { kind: "vendor_receipt_increment", quantity: "8" })
        .nextQuantity,
    ).toBe("20");
  });

  it("REFUSES a decrement that would drive the shelf negative (§2.5 rolls the dispatch back)", () => {
    expectCode(
      () =>
        applyParStockMovement(par({ currentQuantity: "1" }), {
          kind: "dispatch_decrement",
          quantity: "4",
        }),
      "M21_PAR_STOCK_INSUFFICIENT",
    );
  });

  it("emits NO threshold event on a movement — §7.5 makes the nightly cron the canonical emitter", () => {
    const moved = applyParStockMovement(par({ currentQuantity: "11" }), {
      kind: "dispatch_decrement",
      quantity: "9",
    });
    expect(moved.effects.filter((e) => e.kind === "outbox")).toEqual([]);
    expect(moved.nextQuantity).toBe("2");
  });

  it("stamps the review timestamp on a manual recount", () => {
    const moved = applyParStockMovement(par(), {
      kind: "manual_adjustment",
      delta: "-3",
      reviewedAt: "2026-06-20T11:00:00.000Z",
    });
    expect(moved.effects).toContainEqual({
      kind: "set_timestamp",
      field: "last_par_review_at",
      at: "2026-06-20T11:00:00.000Z",
    });
  });

  it("refuses to move a retired row", () => {
    expectCode(
      () =>
        applyParStockMovement(par({ isActive: false }), {
          kind: "dispatch_decrement",
          quantity: "1",
        }),
      "M21_PAR_STOCK_INACTIVE",
    );
  });

  it("rejects inverted thresholds at the write boundary", () => {
    expectCode(
      () =>
        assertParThresholdsOrdered({
          reorderPoint: "4",
          minSafetyStock: "10",
          reorderQuantity: "20",
        }),
      "M21_PAR_THRESHOLDS_INVERTED",
    );
  });
});
