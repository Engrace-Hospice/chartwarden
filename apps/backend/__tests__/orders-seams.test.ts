import type { OrderDiscontinuationDto, OrderRecordDto } from "@wardenx/types";
// apps/backend/__tests__/orders-seams.test.ts — M11-T05 (§2.8 D14 OrderSignatureProvider + §4.3
// OrderProvider). Both seams are pure orchestration over an injected OrderSeamStore; these cover the
// polymorphic signature-write primitive (a fixture M12 caller signing a `target_kind='medication_order'`
// row succeeds with NO local M11 order row — the smoke test the §10 done-gate names), the local-order sign
// transitioning to `active`, the verbal-order 48-hour deadline + verbal_pending transition + signed-in-time
// resolution, the discontinuation command + cascade row, and the OrderProvider read narrowing (active / by-
// patient / since / verbal-timeliness / discontinuation / triggering-assessment / care-plan back-ref), plus
// the boot wiring (registerOrderSeams replaces the deny-stubs; validateSeams passes; the deny-stubs deny).
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, getSeam, validateSeams } from "../src/bootstrap/index";
import {
  type OrderSeamSeed,
  createInMemoryOrderSeamStore,
  createOrderProvider,
  createOrderSignatureProvider,
  registerOrderSeams,
} from "../src/modules/11-orders/index";

const PAT = "pat-1";
const ADM = "adm-1";

function order(over: Partial<OrderRecordDto>): OrderRecordDto {
  return {
    orderId: "ord-1",
    patientId: PAT,
    admissionId: ADM,
    kind: "lab",
    status: "active",
    priority: "routine",
    orderingPhysicianMdmId: "phys-1",
    transmissionStatus: "not_required",
    resultsStatus: "not_expected",
    triggeringAssessmentId: null,
    triggeringHopeAssessmentId: null,
    replacesOrderId: null,
    version: 1,
    signedAt: "2026-03-01T12:00:00.000Z",
    createdAt: "2026-03-01T10:00:00.000Z",
    ...over,
  };
}

function discontinuation(over: Partial<OrderDiscontinuationDto>): OrderDiscontinuationDto {
  return {
    discontinuationId: "dc-1",
    orderId: "ord-1",
    reason: "clinical_judgement",
    actorMembershipId: "mem-1",
    effectiveAt: "2026-03-05T00:00:00.000Z",
    ...over,
  };
}

function seed(): OrderSeamSeed {
  return {
    orders: [
      order({
        orderId: "ord-lab",
        kind: "lab",
        status: "active",
        createdAt: "2026-03-01T10:00:00.000Z",
      }),
      order({
        orderId: "ord-dme",
        kind: "dme",
        status: "active",
        createdAt: "2026-03-03T10:00:00.000Z",
      }),
      order({
        orderId: "ord-old",
        kind: "lab",
        status: "completed",
        createdAt: "2026-02-01T10:00:00.000Z",
      }),
      order({
        orderId: "ord-pend",
        kind: "comfort_kit",
        status: "pending_signature",
        signedAt: null,
        createdAt: "2026-03-04T10:00:00.000Z",
      }),
      order({
        orderId: "ord-trig",
        kind: "ancillary_service",
        status: "active",
        triggeringAssessmentId: "asmt-9",
        createdAt: "2026-03-02T10:00:00.000Z",
      }),
      // a different patient, to prove filtering:
      order({
        orderId: "ord-other",
        patientId: "pat-2",
        admissionId: "adm-2",
        status: "active",
        createdAt: "2026-03-02T10:00:00.000Z",
      }),
    ],
    discontinuations: [
      discontinuation({
        discontinuationId: "dc-lab",
        orderId: "ord-lab",
        reason: "patient_request",
      }),
    ],
    verbalOrders: [
      {
        orderId: "ord-vo-ontime",
        deadlineAt: "2026-03-10T00:00:00.000Z",
        signedAt: "2026-03-09T00:00:00.000Z",
        status: "signed_in_time",
      },
      {
        orderId: "ord-vo-pending",
        deadlineAt: "2026-03-20T00:00:00.000Z",
        signedAt: null,
        status: "pending",
      },
    ],
    carePlanInterventionLinks: { "intv-7": "ord-dme" },
  };
}

describe("OrderSignatureProvider (§2.8 D14)", () => {
  it("signOrderTarget records a med-order signature with NO local M11 row (the M12 smoke test)", async () => {
    const provider = createOrderSignatureProvider(createInMemoryOrderSeamStore().store);
    const out = await provider.signOrderTarget({
      organizationId: "org-1",
      targetKind: "medication_order",
      targetId: "med-1",
      signerMembershipId: "mem-md",
      signerDiscipline: "hospice_physician",
      signedAtClient: "2026-03-01T11:59:00.000Z",
      signatureKind: "signature",
    });
    expect(out.signatureId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.orderStatusAfter).toBe("active");
  });

  it("signOrderTarget threads the caller's signerDiscipline to the store write (no sentinel)", async () => {
    // The TASK-002 contract close: `SignOrderTargetInput.signerDiscipline` is REQUIRED and the store
    // records it verbatim on `order_signature.signer_discipline` — the Drizzle adapter no longer writes
    // the `unattested_via_seam` sentinel. Proven against a capturing store because the seam surface has
    // no signature read-back.
    const inMem = createInMemoryOrderSeamStore(seed()).store;
    const inserted: unknown[] = [];
    const capturing: typeof inMem = {
      ...inMem,
      async insertSignature(input) {
        inserted.push(input);
        return inMem.insertSignature(input);
      },
    };
    await createOrderSignatureProvider(capturing).signOrderTarget({
      organizationId: "org-1",
      targetKind: "medication_order",
      targetId: "med-1",
      signerMembershipId: "mem-md",
      signerDiscipline: "medical_director",
      signedAtClient: "2026-03-01T11:59:00.000Z",
      signatureKind: "signature",
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      signerMembershipId: "mem-md",
      signerDiscipline: "medical_director",
    });
    expect((inserted[0] as { signerDiscipline: string }).signerDiscipline).not.toBe(
      "unattested_via_seam",
    );
  });

  it("signOrderTarget transitions a local pending order to active", async () => {
    const { store } = createInMemoryOrderSeamStore(seed());
    const provider = createOrderSignatureProvider(store);
    const out = await provider.signOrderTarget({
      organizationId: "org-1",
      targetKind: "order",
      targetId: "ord-pend",
      signerMembershipId: "mem-md",
      signerDiscipline: "medical_director",
      signedAtClient: "2026-03-04T12:00:00.000Z",
      signatureKind: "signature",
    });
    expect(out.orderStatusAfter).toBe("active");
    expect((await store.getOrder("ord-pend"))?.status).toBe("active");
  });

  it("recordVerbalOrder computes the 48h deadline and moves the order to verbal_pending", async () => {
    const { store } = createInMemoryOrderSeamStore(seed());
    const provider = createOrderSignatureProvider(store);
    const out = await provider.recordVerbalOrder({
      organizationId: "org-1",
      targetKind: "order",
      targetId: "ord-pend",
      recordingMembershipId: "mem-rn",
      orderingPhysicianMdmId: "phys-1",
      verbalAttestation: "x".repeat(120),
      receivedAt: "2026-03-04T10:00:00.000Z",
    });
    expect(out.deadlineAt).toBe("2026-03-06T10:00:00.000Z"); // +48h wall-clock
    expect((await store.getOrder("ord-pend"))?.status).toBe("verbal_pending");
    const timeliness = await createOrderProvider(store).getVerbalOrderTimeliness({
      orderId: "ord-pend",
    });
    expect(timeliness?.status).toBe("pending");
  });

  it("signing a verbal_pending order resolves the verbal row to signed_in_time", async () => {
    const { store } = createInMemoryOrderSeamStore(seed());
    // Inject a server clock before the 48h deadline (2026-03-06T10:00) so the sign lands on time.
    const sig = createOrderSignatureProvider(store, () => "2026-03-04T18:00:00.000Z");
    await sig.recordVerbalOrder({
      organizationId: "org-1",
      targetKind: "order",
      targetId: "ord-pend",
      recordingMembershipId: "mem-rn",
      orderingPhysicianMdmId: "phys-1",
      verbalAttestation: "x".repeat(120),
      receivedAt: "2026-03-04T10:00:00.000Z",
    });
    await sig.signOrderTarget({
      organizationId: "org-1",
      targetKind: "order",
      targetId: "ord-pend",
      signerMembershipId: "mem-md",
      signerDiscipline: "medical_director",
      signedAtClient: "2026-03-04T18:00:00.000Z",
      signatureKind: "signature",
    });
    const t = await createOrderProvider(store).getVerbalOrderTimeliness({ orderId: "ord-pend" });
    expect(t?.status).toBe("signed_in_time");
    expect(t?.onTime).toBe(true);
  });

  it("discontinueOrder records a discontinuation row and moves a local order to discontinued", async () => {
    const { store } = createInMemoryOrderSeamStore(seed());
    const provider = createOrderSignatureProvider(store);
    const out = await provider.discontinueOrder({
      organizationId: "org-1",
      targetKind: "order",
      targetId: "ord-lab",
      actorMembershipId: "mem-1",
      reason: "adverse_event",
      effectiveAt: "2026-03-08T00:00:00.000Z",
    });
    expect(out.discontinuationId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await store.getOrder("ord-lab"))?.status).toBe("discontinued");
    const reason = await createOrderProvider(store).getDiscontinuationReason({
      orderId: "ord-lab",
    });
    expect(reason?.reason).toBe("adverse_event");
  });
});

describe("OrderProvider (§4.3)", () => {
  const provider = () => createOrderProvider(createInMemoryOrderSeamStore(seed()).store);

  it("getOrder resolves one order by id and null for an unknown one (M21-T04 / §2.8)", async () => {
    // M21's supply cascade reads the order back because `m11.order.supply_fulfillment_requested` carries
    // no patient — this is the only method that answers "who is this order for?".
    const found = await provider().getOrder({ orderId: "ord-dme" });
    expect(found?.patientId).toBe(PAT);
    expect(found?.admissionId).toBeTruthy();
    expect(await provider().getOrder({ orderId: "ord-nonexistent" })).toBeNull();
  });

  it("findActiveOrder returns the active order of the kind for the patient", async () => {
    expect((await provider().findActiveOrder({ patientId: PAT, kind: "lab" }))?.orderId).toBe(
      "ord-lab",
    );
    expect(
      await provider().findActiveOrder({ patientId: PAT, kind: "recertification" }),
    ).toBeNull();
  });

  it("listByPatient narrows by status/kinds and applies the limit", async () => {
    const active = await provider().listByPatient({ patientId: PAT, status: ["active"] });
    expect(active.map((o) => o.orderId).sort()).toEqual(["ord-dme", "ord-lab", "ord-trig"]);
    const labs = await provider().listByPatient({ patientId: PAT, kinds: ["lab"] });
    expect(labs.map((o) => o.orderId).sort()).toEqual(["ord-lab", "ord-old"]);
    expect((await provider().listByPatient({ patientId: PAT, limit: 2 })).length).toBe(2);
  });

  it("listByAdmission scopes to the admission", async () => {
    const out = await provider().listByAdmission({ admissionId: ADM, status: ["active"] });
    expect(out.every((o) => o.admissionId === ADM)).toBe(true);
    expect(out.some((o) => o.orderId === "ord-other")).toBe(false);
  });

  it("getOrdersSince returns orders created on/after the cutoff ascending", async () => {
    const out = await provider().getOrdersSince({
      patientId: PAT,
      since: "2026-03-02T00:00:00.000Z",
    });
    expect(out.map((o) => o.orderId)).toEqual(["ord-trig", "ord-dme", "ord-pend"]);
  });

  it("getVerbalOrderTimeliness derives onTime; null when no verbal row", async () => {
    expect((await provider().getVerbalOrderTimeliness({ orderId: "ord-vo-ontime" }))?.onTime).toBe(
      true,
    );
    expect((await provider().getVerbalOrderTimeliness({ orderId: "ord-vo-pending" }))?.onTime).toBe(
      false,
    );
    expect(await provider().getVerbalOrderTimeliness({ orderId: "ord-lab" })).toBeNull();
  });

  it("findByTriggeringAssessment + findByCarePlanIntervention resolve the back-refs", async () => {
    expect((await provider().findByTriggeringAssessment("asmt-9")).map((o) => o.orderId)).toEqual([
      "ord-trig",
    ]);
    expect((await provider().findByCarePlanIntervention("intv-7"))?.orderId).toBe("ord-dme");
    expect(await provider().findByCarePlanIntervention("missing")).toBeNull();
  });
});

describe("boot wiring (registerOrderSeams)", () => {
  afterEach(() => __resetSeamsForTest());

  it("registers both seams so validateSeams passes and they resolve as real impls", async () => {
    registerOrderSeams({ store: createInMemoryOrderSeamStore(seed()).store });
    expect(() => validateSeams()).not.toThrow();
    expect(
      (await getSeam("OrderProvider").findActiveOrder({ patientId: PAT, kind: "lab" }))?.orderId,
    ).toBe("ord-lab");
    const signed = await getSeam("OrderSignatureProvider").signOrderTarget({
      organizationId: "org-1",
      targetKind: "medication_order",
      targetId: "med-1",
      signerMembershipId: "mem-md",
      signerDiscipline: "hospice_physician",
      signedAtClient: "2026-03-01T11:59:00.000Z",
      signatureKind: "signature",
    });
    expect(signed.orderStatusAfter).toBe("active");
  });

  it("threads the cosign attestationText through the seam to the store (M12 medication_order cosign)", async () => {
    const base = createInMemoryOrderSeamStore(seed()).store;
    const seen: Array<Parameters<typeof base.insertCosignature>[0]> = [];
    const store = {
      ...base,
      insertCosignature: (input: Parameters<typeof base.insertCosignature>[0]) => {
        seen.push(input);
        return base.insertCosignature(input);
      },
    };
    const attestationText = "I have reviewed this medication order and concur with it as written.";
    await createOrderSignatureProvider(store).cosignOrder({
      organizationId: "org-1",
      targetKind: "medication_order",
      targetId: "med-1",
      cosignerMembershipId: "mem-sup",
      cosignerRole: "clinical_supervisor",
      attestationText,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ targetKind: "medication_order", attestationText });
  });

  it("falls back to fail-closed deny-stubs when M11 does not register", () => {
    validateSeams();
    expect(() => getSeam("OrderProvider").listByPatient({ patientId: PAT })).toThrow(
      /not implemented/,
    );
    expect(() =>
      getSeam("OrderSignatureProvider").cosignOrder({
        organizationId: "org-1",
        targetKind: "order",
        targetId: "ord-1",
        cosignerMembershipId: "mem-1",
        cosignerRole: "rn_case_manager",
        attestationText: "x".repeat(60),
      }),
    ).toThrow(/not implemented/);
  });
});
