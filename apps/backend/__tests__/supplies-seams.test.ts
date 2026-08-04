// apps/backend/__tests__/supplies-seams.test.ts — M21-T05 (§4.8 / D14 the seams M21 PUBLISHES).
//
// Three surfaces registered into the M1 registry by `registerSuppliesSeams`. The properties guarded here
// are the ones the providers exist to preserve:
//   • all three are boot-REQUIRED with a fail-closed deny-stub, so a boot that does not wire M21 refuses
//     on call rather than answering emptily — which for `listActiveDispatchesForPatient` is the difference
//     between an error state and a nurse being shown "there is no morphine in this kit";
//   • `isTerminal` distinguishes `cancellation_pending` (the vendor has not answered) from a real terminal,
//     because M11's §7.7 cascade branches on exactly that, and returns `null` — not a fabricated verdict —
//     when the id does not resolve in the caller's org;
//   • `getIpuRoomKitInventory` is room-scoped with no patient in it at all (D17);
//   • the drawdown APPENDS to the DEA §1304 perpetual log and never decides a discrepancy — the D8 verdict
//     belongs to §2.6's reconciliation, and a flag a seam caller could set is one they could clear;
//   • an unresolvable dispatched line RAISES rather than silently dropping a controlled-substance count;
//   • the cost summaries return TOTALS and COUNTS, sum their own parts, and REFUSE to relabel one tenant's
//     numbers with another tenant's org id.
import type { DispatchDetailView, OrgId, SupplyRequestStatusView } from "@wardenx/types";
import { afterEach, describe, expect, it } from "vitest";
import { REQUIRED_SEAMS, __resetSeamsForTest, validateSeams } from "../src/bootstrap/index";
import {
  createComfortKitDispatchProvider,
  createInMemorySuppliesSeamStore,
  createSupplyCostProvider,
  createSupplyFulfillmentProvider,
  getComfortKitDispatchProvider,
  getSupplyCostProvider,
  getSupplyFulfillmentProvider,
  registerSuppliesSeams,
} from "../src/modules/21-supplies/index";

const ORG = "org-1" as OrgId;
const CLOCK = () => "2026-07-31T12:00:00.000Z" as never;

const requestRow = (over: Partial<SupplyRequestStatusView> = {}): SupplyRequestStatusView =>
  ({
    supplyRequestId: "req-1",
    orgId: ORG,
    patientId: "pat-1",
    admissionId: "adm-1",
    kind: "dme",
    status: "in_transit",
    sourceOrderId: null,
    assignedVendorId: null,
    routingRuleResolved: null,
    vendorOrderReference: null,
    trackingNumber: null,
    carrier: null,
    orderedAt: null,
    deliveredAt: null,
    receivedConfirmedAt: null,
    receivedConfirmedActor: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...over,
  }) as SupplyRequestStatusView;

const dispatchRow = (over: Partial<DispatchDetailView> = {}): DispatchDetailView =>
  ({
    dispatchId: "disp-1",
    supplyRequestId: "req-1",
    orgId: ORG,
    patientId: "pat-1",
    comfortKitTemplateId: "tmpl-1",
    kitSerialNumber: "KIT-0001",
    deploymentSite: "home",
    ipuRoomId: null,
    dispatchStatus: "deployed_at_patient",
    dispatchedAt: "2026-07-02T00:00:00.000Z",
    m13DeploymentId: "m13-1",
    containsControlledSubstance: true,
    dispatchSource: "supply_hub",
    pharmacyDispatchMode: "supply_hub_dispatch",
    pharmacyPartnerId: null,
    dispatchedByMembershipId: "mem-dispatcher",
    bolDocumentId: null,
    controlledSubstanceHandlingPolicyDigest: "digest",
    contents: [
      {
        dispatchedContentId: "line-1",
        comfortKitTemplateMedicationId: "tm-1",
        medicationOrderId: null,
        rxnorm: "894801",
        ndc: null,
        drugName: "Morphine sulfate",
        strength: "20 mg/mL",
        dosageForm: "oral solution",
        routeOfAdministration: "oral",
        isControlledSubstance: true,
        controlledSubstanceSchedule: "CII",
        dispatchedQuantity: "30",
        dispatchedUnit: "mL",
        lotNumber: "LOT-A",
        expirationDate: "2027-01-01",
        manufacturerNdc: null,
        replenishmentThresholdPct: 0.25,
      },
    ],
    ...over,
  }) as DispatchDetailView;

afterEach(() => {
  __resetSeamsForTest();
});

describe("M21-T05 §4.8 — registration + the fail-closed boot posture", () => {
  it("all three seams are boot-REQUIRED with a deny-stub, owned by M21", () => {
    const m21 = REQUIRED_SEAMS.filter((s) => s.ownerModule === 21);
    expect(m21.map((s) => s.key).sort()).toEqual([
      "ComfortKitDispatchProvider",
      "SupplyCostProvider",
      "SupplyFulfillmentProvider",
    ]);
    for (const seam of m21) {
      expect(seam.denyStub).toBeDefined();
      // Every M21 seam is patient-linked at its widest method — the classification is per SEAM.
      expect(seam.phi).toBe(true);
    }
  });

  it("a boot that does NOT wire M21 leaves the seams DENYING, not answering emptily", () => {
    validateSeams(); // applies the deny-stub defaults
    // The stubs throw SYNCHRONOUSLY (they are not async), so a `.rejects` assertion here would pass on a
    // stub that returned `[]` — the exact false-green this test exists to rule out.
    expect(() =>
      getComfortKitDispatchProvider().listActiveDispatchesForPatient("pat-1" as never),
    ).toThrow(/ComfortKitDispatchProvider/);
    expect(() => getSupplyFulfillmentProvider().isTerminal("req-1" as never)).toThrow(
      /SupplyFulfillmentProvider/,
    );
  });

  it("registerSuppliesSeams stands the real impls over the stubs", async () => {
    const { store } = createInMemorySuppliesSeamStore({ dispatches: [dispatchRow()] });
    registerSuppliesSeams({ store, clock: CLOCK, orgOf: () => ORG });
    validateSeams();
    await expect(
      getComfortKitDispatchProvider().listActiveDispatchesForPatient("pat-1" as never),
    ).resolves.toHaveLength(1);
    expect(getSupplyCostProvider()).toBeDefined();
  });
});

describe("M21-T05 §4.8 — SupplyFulfillmentProvider", () => {
  it("`cancellation_pending` is NOT terminal — M11's §7.7 cascade branches on the difference", async () => {
    const { store } = createInMemorySuppliesSeamStore({
      requests: [
        requestRow({ supplyRequestId: "pending", status: "cancellation_pending" }),
        requestRow({ supplyRequestId: "done", status: "completed" }),
        requestRow({ supplyRequestId: "gone", status: "cancelled" }),
      ],
    });
    const provider = createSupplyFulfillmentProvider(store);
    expect(await provider.isTerminal("pending" as never)).toEqual({
      isTerminal: false,
      currentStatus: "cancellation_pending",
    });
    expect((await provider.isTerminal("done" as never))?.isTerminal).toBe(true);
    expect((await provider.isTerminal("gone" as never))?.isTerminal).toBe(true);
  });

  it("an id that does not resolve in the caller's org answers null, not a fabricated verdict", async () => {
    const { store } = createInMemorySuppliesSeamStore();
    const provider = createSupplyFulfillmentProvider(store);
    expect(await provider.isTerminal("nope" as never)).toBeNull();
    expect(await provider.getSupplyRequestStatus("nope" as never)).toBeNull();
  });

  it("createDirectSupplyRequest REFUSES loudly when no write service is bound", async () => {
    const { store } = createInMemorySuppliesSeamStore();
    const provider = createSupplyFulfillmentProvider(store);
    // A supply request written without its D4 resolution frozen on cannot answer "why this vendor" at
    // survey, and §3.1.7's CHECK would refuse to let it leave `requested`.
    await expect(
      provider.createDirectSupplyRequest({
        patientId: "p" as never,
        admissionId: "a" as never,
        locationId: "l" as never,
        kind: "supply",
        data: {},
        sourceOrderId: null,
        sourceReplenishmentEventId: null,
        requestedByMembershipId: "m" as never,
      }),
    ).rejects.toMatchObject({ code: "M21_ROUTING_NOT_RESOLVED" });
  });

  it("delegates to the bound creator when one is present", async () => {
    const { store } = createInMemorySuppliesSeamStore();
    const provider = createSupplyFulfillmentProvider(store, {
      async createDirect() {
        return { supplyRequestId: "new-1" as never, routingRuleResolved: {} as never };
      },
    });
    const created = await provider.createDirectSupplyRequest({
      patientId: "p" as never,
      admissionId: "a" as never,
      locationId: "l" as never,
      kind: "supply",
      data: {},
      sourceOrderId: null,
      sourceReplenishmentEventId: null,
      requestedByMembershipId: "m" as never,
    });
    expect(created.supplyRequestId).toBe("new-1");
  });
});

describe("M21-T05 §4.8 — ComfortKitDispatchProvider", () => {
  it("lists only kits that are `deployed_at_patient` (§4.8, verbatim)", async () => {
    const { store } = createInMemorySuppliesSeamStore({
      dispatches: [
        dispatchRow(),
        dispatchRow({ dispatchId: "disp-2", dispatchStatus: "dispatched" }),
        dispatchRow({ dispatchId: "disp-3", dispatchStatus: "reconciled" }),
      ],
    });
    const provider = createComfortKitDispatchProvider(store, CLOCK);
    const active = await provider.listActiveDispatchesForPatient("pat-1" as never);
    expect(active.map((d) => d.dispatchId)).toEqual(["disp-1"]);
  });

  it("the IPU-room inventory is ROOM-scoped with no patient in it (D17)", async () => {
    const { store } = createInMemorySuppliesSeamStore({
      dispatches: [
        dispatchRow({ dispatchId: "ipu-1", deploymentSite: "ipu_room", ipuRoomId: "room-7" }),
        dispatchRow({ dispatchId: "home-1" }),
      ],
    });
    const provider = createComfortKitDispatchProvider(store, CLOCK);
    const view = await provider.getIpuRoomKitInventory("loc-1" as never, "room-7" as never);
    expect(view.ipuRoomId).toBe("room-7");
    expect(view.dispatches.map((d) => d.dispatchId)).toEqual(["ipu-1"]);
  });

  it("a drawdown APPENDS to the DEA §1304 log and never decides a discrepancy", async () => {
    const { store, perpetualLog } = createInMemorySuppliesSeamStore({
      dispatches: [dispatchRow()],
    });
    const provider = createComfortKitDispatchProvider(store, CLOCK);
    await provider.notifyAdministrationDrawdown({
      dispatchId: "disp-1" as never,
      dispatchedContentId: "line-1" as never,
      observedRemainingQuantity: "25",
      expectedRemainingQuantity: "30",
      observedByMembershipId: "mem-nurse" as never,
      observedAt: "2026-07-10T09:00:00.000Z" as never,
    });
    const entries = perpetualLog.get("line-1") ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      transactionKind: "administer_drawdown",
      quantityDelta: "-5",
      balanceAfterQuantity: "25",
      recordedByMembershipId: "mem-nurse",
    });
    // The entry records the observation. The D8 verdict is §2.6's, computed at close-out from the
    // dispatched-vs-returned quantities — nothing here flags anything.
    expect(Object.keys(entries[0] ?? {})).not.toContain("discrepancyFlagged");
  });

  it("an unresolvable dispatched line RAISES rather than silently dropping the count", async () => {
    const { store } = createInMemorySuppliesSeamStore({ dispatches: [dispatchRow()] });
    const provider = createComfortKitDispatchProvider(store, CLOCK);
    await expect(
      provider.notifyAdministrationDrawdown({
        dispatchId: "disp-1" as never,
        dispatchedContentId: "does-not-exist" as never,
        observedRemainingQuantity: "25",
        expectedRemainingQuantity: "30",
        observedByMembershipId: "mem-nurse" as never,
        observedAt: "2026-07-10T09:00:00.000Z" as never,
      }),
    ).rejects.toMatchObject({ code: "M21_DISPATCH_NOT_FOUND" });
  });

  it("a dispatch id that does not resolve answers null (indistinguishable from absent, on purpose)", async () => {
    const { store } = createInMemorySuppliesSeamStore();
    const provider = createComfortKitDispatchProvider(store, CLOCK);
    expect(await provider.getDispatchDetail("nope" as never)).toBeNull();
  });
});

describe("M21-T05 §4.8 — SupplyCostProvider", () => {
  const totals = {
    dmeTotalCents: 12_000,
    supplyTotalCents: 3_400,
    comfortKitTotalCents: 8_600,
    accruedRequestCount: 5,
    unreconciledRequestCount: 2,
    patientCount: 1,
    requestCount: 5,
  };

  it("returns TOTALS and COUNTS, never a rate, and sums its own parts", async () => {
    const { store } = createInMemorySuppliesSeamStore({ costByPatient: { "pat-1": totals } });
    const provider = createSupplyCostProvider(store, () => ORG);
    const summary = await provider.getPatientSupplyCostSummary({
      patientId: "pat-1" as never,
      fromDate: "2026-07-01" as never,
      toDate: "2026-07-31" as never,
    });
    expect(summary.totalCents).toBe(24_000);
    expect(summary.orgId).toBe(ORG);
    expect(summary.accruedRequestCount).toBe(5);
    expect(summary.unreconciledRequestCount).toBe(2);
    // A per-patient-day rate would strand the denominator CMS small-N suppression needs downstream.
    expect(summary).not.toHaveProperty("costPerPatientDay");
  });

  it("REFUSES to relabel this tenant's numbers with another tenant's org id", async () => {
    const { store } = createInMemorySuppliesSeamStore({ costByPatient: { "pat-1": totals } });
    const provider = createSupplyCostProvider(store, () => ORG);
    await expect(
      provider.getOrgSupplySpendSummary({
        orgId: "some-other-org" as OrgId,
        fromDate: "2026-07-01" as never,
        toDate: "2026-07-31" as never,
      }),
    ).rejects.toMatchObject({ code: "M21_SERVING_LOCATION_UNRESOLVED" });
  });

  it("answers the caller's own org roll", async () => {
    const { store } = createInMemorySuppliesSeamStore({ costByPatient: { "pat-1": totals } });
    const provider = createSupplyCostProvider(store, () => ORG);
    const summary = await provider.getOrgSupplySpendSummary({
      orgId: ORG,
      fromDate: "2026-07-01" as never,
      toDate: "2026-07-31" as never,
    });
    expect(summary.totalCents).toBe(24_000);
    expect(summary.patientCount).toBe(1);
    expect(summary.requestCount).toBe(5);
  });
});
