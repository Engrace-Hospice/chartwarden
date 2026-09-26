// apps/backend/__tests__/dosespot-workflow-acceptance.test.ts — M12-T10 the §5 workflow-acceptance suite
// (the FINAL M12 task). One scenario per the three plan-named §5 workflows — W-MR-01 (standard prescription:
// draft → request-signature → sign → transmit → active), W-MR-04 (refill inbox: receive → approve → mint /
// deny), W-MR-05 (medication-history pull + reconciliation) — exercised end-to-end over the in-memory
// `MedicationOrderRouteService` (the same backend the §4.1 routes compose over, M12-T08) plus the pure
// `@wardenx/dosespot` lifecycle machine the §4.10 transmission worker + webhook handler drive. Deterministic:
// no infra, injected clock.
//
// The route-auth handshake (§4.6/§4.7) + the wire status codes live in dosespot-routes.test.ts; the pure
// machines have their own unit suites in packages/dosespot. This asserts the WORKFLOW outcomes (state
// transitions, the transmission chain to `active`, the refill mint, the reconciliation carry-forward) and the
// §9.3 security/race guarantees of the §2.2 graph (anti-escalation, the EPCS-certification gate D18, the
// terminal-state race). The RLS layer-independence (§9.4) lives in rls-isolation.live (the M12 block).
import { transitionMedicationOrder } from "@wardenx/dosespot";
import { describe, expect, it } from "vitest";
import { createInMemoryDoseSpotBackend } from "../src/modules/12-dosespot/index";

const ORG = "org_a";
const ORG_B = "org_b";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "33333333-3333-4333-8333-333333333333";
const PHYS = "44444444-4444-4444-8444-444444444444";
const PHARMACY = "55555555-5555-4555-8555-555555555555";
const SRC_ORDER = "00000000-0000-4000-8000-0000000000a1";
const REFILL = "00000000-0000-4000-8000-0000000000b1";
const REFILL_DENY = "00000000-0000-4000-8000-0000000000b2";
const NOW = "2026-06-08T12:00:00.000Z";

function backend(now: string = NOW) {
  return createInMemoryDoseSpotBackend({ now: () => now });
}

/** The §2.2 / §4.10 system-actor post-sign chain a `signed` order rides to `active` (worker + webhook). */
function eventNames(events: ReadonlyArray<{ eventName: string }>): string[] {
  return events.map((e) => e.eventName);
}

/** Complete standard.v1 payload (aspirin 81 mg, 1 tab PO daily, 30-day supply); request-signature
 *  enforces the full shape from packages/dosespot/src/classes/contracts.ts. */
const ASPIRIN_DATA = {
  sigStructured: {
    doseQuantity: 1,
    doseUnit: "tablet",
    route: "oral",
    frequencyCode: "QD",
    asNeeded: false,
  },
  sigFreeText: "1 tablet by mouth daily",
  refillsAuthorized: 3,
  dispenseQuantity: { value: 30, unit: "tablet" },
  daysSupply: 30,
  daw: false,
};
/** The edited sig: 2 tablets daily (dispense/refills adjusted to stay coherent with the new dose). */
const ASPIRIN_DATA_EDITED = {
  ...ASPIRIN_DATA,
  sigStructured: { ...ASPIRIN_DATA.sigStructured, doseQuantity: 2 },
  sigFreeText: "2 tablets by mouth daily",
  refillsAuthorized: 1,
  dispenseQuantity: { value: 60, unit: "tablet" },
};
/** controlled_substance.v1 (oxycodone 5 mg, Schedule II → non-refillable; indication/justification/DEA required). */
const OXYCODONE_DATA = {
  sigStructured: {
    doseQuantity: 1,
    doseUnit: "tablet",
    route: "oral",
    frequencyCode: "Q4H",
    asNeeded: true,
    asNeededReasonCode: "pain",
  },
  sigFreeText: "1 tablet by mouth every 4 hours as needed for pain",
  indication: "Severe cancer-related pain",
  clinicalJustification:
    "Opioid required for pain uncontrolled on non-opioid analgesics at end of life.",
  refillsAuthorized: 0,
  dispenseQuantity: { value: 42, unit: "tablet" },
  daysSupply: 7,
  daw: false,
  deaSchedule: "II",
  prescriberDea: "AB1234563",
};

describe("M12-T10 §5 workflow acceptance", () => {
  it("W-MR-01 — standard prescription: draft → request-signature → sign → transmit → active", async () => {
    const svc = backend();
    const draft = await svc.createDraft(ORG, PHYS, {
      patientId: PATIENT,
      admissionId: ADMISSION,
      medClass: "standard",
      rxnormRxcui: "1191",
      ndc: null,
      drugName: "Aspirin",
      strength: "81 mg",
      doseForm: "tablet",
      route: "oral",
      data: ASPIRIN_DATA,
      prescriberDiscipline: "hospice_physician",
      prescribingPhysicianMdmId: PHYS,
      dispensingPharmacyMdmId: PHARMACY,
      refillsAuthorized: 3,
    });
    expect(draft.status).toBe("draft");
    expect(draft.isControlledSubstance).toBe(false);
    expect(draft.data).toEqual(ASPIRIN_DATA);
    expect(draft.refillsAuthorized).toBe(3);
    expect(eventNames(svc.drainEvents())).toContain("m12.medication_order.draft_created");

    const edited = await svc.editDraft(ORG, draft.id, {
      data: ASPIRIN_DATA_EDITED,
      refillsAuthorized: 1,
    });
    expect(edited.data).toEqual(ASPIRIN_DATA_EDITED);
    expect(edited.refillsAuthorized).toBe(1);
    expect(edited.refillsRemaining).toBe(1);
    expect(edited.version).toBe(2);

    const pending = await svc.requestSignature(ORG, edited.id, "hospice_physician");
    expect(pending.status).toBe("pending_signature");
    expect(eventNames(svc.drainEvents())).toContain("m12.medication_order.signature_requested");

    // §2.2 — the prescriber self-signs (the standard, non-EPCS sign path) → `signed`; the M11 OrderSignature
    // seam writes the order_signature row, the service stamps signed_at/signed_by, and `enqueueTransmission`
    // runs in the same tx. The in-mem slice lands the row on `signed`; the transmission chain below is the
    // §4.10 worker + the §2.2 webhook driving the pure machine to `active`.
    const signed = await svc.signOrder(ORG, PHYS, draft.id, {
      signerDiscipline: "hospice_physician",
      signedAtClient: NOW,
    });
    expect(signed.status).toBe("signed");
    expect(signed.signedAt).toBe(NOW);
    expect(signed.signedBy).toBe(PHYS);
    expect(eventNames(svc.drainEvents())).toContain("m12.medication_order.signed");

    // The §4.10 worker enqueues + transmits; the §2.2 ScriptStatusUpdate webhook acks then activates.
    const queued = transitionMedicationOrder("signed", {
      type: "enqueueTransmission",
      isSystemActor: true,
    });
    expect(queued.to).toBe("queued_for_transmission");
    const transmitted = transitionMedicationOrder("queued_for_transmission", {
      type: "transmissionSucceeded",
      isSystemActor: true,
    });
    expect(transmitted.to).toBe("transmitted");
    const acked = transitionMedicationOrder("transmitted", {
      type: "pharmacyAck",
      isSystemActor: true,
    });
    expect(acked.to).toBe("ack_received");
    const active = transitionMedicationOrder("ack_received", {
      type: "activate",
      isSystemActor: true,
    });
    expect(active.to).toBe("active");
    // Each system-actor transition carries exactly one §4.4 outbox effect (the relay publishes it in-tx).
    expect(active.effects).toContainEqual({ kind: "outbox", event: "m12.medication_order.active" });
  });

  it("W-MR-04 — refill inbox: receive → approve mints a new order; deny responds via the adapter", async () => {
    // Given: a previously-active source order (Tramadol-like, non-controlled here) and two pending refills.
    const svcSeeded = createInMemoryDoseSpotBackend({
      now: () => NOW,
      orders: [
        {
          id: SRC_ORDER,
          organizationId: ORG,
          patientId: PATIENT,
          admissionId: ADMISSION,
          medClass: "standard",
          status: "active",
          drugName: "Tramadol",
          strength: "50 mg",
          doseForm: "tablet",
          route: "oral",
          prescriberMembershipId: PHYS,
          prescriberDiscipline: "hospice_physician",
          refillsRemaining: 2,
        },
      ],
      refills: [
        { id: REFILL, organizationId: ORG, patientId: PATIENT, sourceMedicationOrderId: SRC_ORDER },
        {
          id: REFILL_DENY,
          organizationId: ORG,
          patientId: PATIENT,
          sourceMedicationOrderId: SRC_ORDER,
        },
      ],
    });

    const beforePending = await svcSeeded.getRefill(ORG, REFILL);
    expect(beforePending.status).toBe("pending");

    // Approve → a NEW medication_order is minted (a refill is a new prescription, not a status flip, D9).
    const { resultingOrderId } = await svcSeeded.approveRefill(ORG, PHYS, REFILL, {
      refillsAuthorized: 1,
    });
    expect(resultingOrderId).toBeTruthy();
    const minted = await svcSeeded.getOrder(ORG, resultingOrderId);
    expect(minted.derivedFromRefillId).toBe(REFILL);
    expect(minted.replacesMedicationOrderId).toBeNull(); // a refill replaces nothing
    expect(minted.drugName).toBe("Tramadol");
    const approved = await svcSeeded.getRefill(ORG, REFILL);
    expect(approved.status).toBe("approved");
    expect(approved.resultingMedicationOrderId).toBe(resultingOrderId);
    expect(eventNames(svcSeeded.drainEvents())).toContain("m12.refill_request_approved");

    // Deny → no order minted; the adapter is told the denial + reason; care-team notified.
    const deny = await svcSeeded.denyRefill(ORG, PHYS, REFILL_DENY, {
      denialReason: "Patient has a duplicate active order for this medication.",
    });
    expect(deny.status).toBe("denied");
    expect((await svcSeeded.getRefill(ORG, REFILL_DENY)).status).toBe("denied");
    expect(eventNames(svcSeeded.drainEvents())).toContain("m12.refill_request_denied");
  });

  it("W-MR-05 — medication-history pull + reconciliation carry-forward / document-only", async () => {
    const svc = backend();
    // The m6.admission.activated consumer enqueues the MedHx fetch; the worker pulls + persists.
    const { jobId } = await svc.refreshHistory(ORG, PATIENT);
    expect(jobId).toBe(`dosespot.fetch_medhx:${PATIENT}`);
    expect((await svc.medicationHistory(ORG, PATIENT)).records).toEqual([]);

    // The admitting RN reviews each history entry — carry_forward mints a draft to complete + sign;
    // document_only is informational and mints nothing.
    const carried = await svc.reconcileHistory(ORG, "rn_1", "hist_1", "carry_forward");
    expect(carried.resultingOrderId).toBeTruthy();
    const documented = await svc.reconcileHistory(ORG, "rn_1", "hist_2", "document_only");
    expect(documented.resultingOrderId).toBeNull();
    const discontinued = await svc.reconcileHistory(ORG, "rn_1", "hist_3", "discontinue");
    expect(discontinued.resultingOrderId).toBeNull();
  });
});

describe("M12-T10 §9.3 security & authorization (anti-escalation, EPCS gate D18, terminal-state race)", () => {
  it("anti-escalation — an RN cannot sign a standard medication order (prescriber-only, §4.6)", async () => {
    const svc = backend();
    const draft = await svc.createDraft(ORG, PHYS, {
      patientId: PATIENT,
      admissionId: ADMISSION,
      medClass: "standard",
      rxnormRxcui: "1191",
      ndc: null,
      drugName: "Aspirin",
      strength: "81 mg",
      doseForm: "tablet",
      route: "oral",
      data: { ...ASPIRIN_DATA, refillsAuthorized: 0 },
      prescriberDiscipline: "hospice_physician",
      prescribingPhysicianMdmId: PHYS,
      refillsAuthorized: 0,
    });
    await svc.requestSignature(ORG, draft.id, "hospice_physician");
    await expect(
      svc.signOrder(ORG, "rn_1", draft.id, {
        signerDiscipline: "rn_case_manager",
        signedAtClient: NOW,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "SIGNER_NOT_ELIGIBLE", statusCode: 403 }),
    );
  });

  it("EPCS certification gate (D18) — a controlled-substance sign is blocked while the tenant is not certified", async () => {
    const svc = backend();
    const draft = await svc.createDraft(ORG, PHYS, {
      patientId: PATIENT,
      admissionId: ADMISSION,
      medClass: "controlled_substance",
      rxnormRxcui: "1819",
      ndc: null,
      drugName: "Oxycodone",
      strength: "5 mg",
      doseForm: "tablet",
      route: "oral",
      data: OXYCODONE_DATA,
      prescriberDiscipline: "hospice_physician",
      prescribingPhysicianMdmId: PHYS,
      deaSchedule: "II",
      containsControlled: true,
      refillsAuthorized: 0,
    });
    expect(draft.isControlledSubstance).toBe(true);
    // EPCS is OFF in Phase 1 (epcs_certification_status='not_certified'); the D18 gate fires the moment the
    // controlled order is pushed toward signature — it never even reaches `pending_signature`.
    await expect(svc.requestSignature(ORG, draft.id, "hospice_physician")).rejects.toThrowError(
      expect.objectContaining({ code: "EPCS_NOT_CERTIFIED", statusCode: 403 }),
    );
    // And a controlled order may NEVER ride the standard `sign` path (it routes to EPCS).
    expect(() =>
      transitionMedicationOrder("pending_signature", {
        type: "sign",
        medClass: "controlled_substance",
        containsControlled: true,
        signerEligible: true,
        signerIsOrderingPhysician: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "SIGN_REQUIRES_EPCS", statusCode: 422 }));
  });

  it("terminal-state race — once `active`, a late transmission-failure transition is rejected (no-op for the worker)", () => {
    // The webhook acked + activated; a stale transmission-exhausted job fires a beat later. The §2.2 graph
    // admits no `transmissionExhausted` from `active` → the worker's redelivery is a guarded no-op.
    expect(() =>
      transitionMedicationOrder("active", { type: "transmissionExhausted", isSystemActor: true }),
    ).toThrowError(
      expect.objectContaining({ code: "ILLEGAL_MEDICATION_ORDER_TRANSITION", statusCode: 409 }),
    );
  });
});

describe("M12-T10 cross-tenant isolation (service-layer non-leaking 404; live-PG RLS in rls-isolation.live)", () => {
  it("an order created in org_a is invisible to org_b (non-leaking NotFound)", async () => {
    const svc = backend();
    const draft = await svc.createDraft(ORG, PHYS, {
      patientId: PATIENT,
      admissionId: ADMISSION,
      medClass: "standard",
      rxnormRxcui: "1191",
      ndc: null,
      drugName: "Aspirin",
      strength: "81 mg",
      doseForm: "tablet",
      route: "oral",
      data: {},
      prescriberDiscipline: "hospice_physician",
      prescribingPhysicianMdmId: PHYS,
      refillsAuthorized: 0,
    });
    await expect(svc.getOrder(ORG_B, draft.id)).rejects.toThrow();
    expect((await svc.listOrders(ORG_B, {})).orders).toEqual([]);
  });

  it("a refill request in org_a is invisible to org_b (non-leaking NotFound)", async () => {
    const svc = createInMemoryDoseSpotBackend({
      now: () => NOW,
      refills: [
        { id: REFILL, organizationId: ORG, patientId: PATIENT, sourceMedicationOrderId: SRC_ORDER },
      ],
    });
    await expect(svc.getRefill(ORG_B, REFILL)).rejects.toThrow();
  });
});
