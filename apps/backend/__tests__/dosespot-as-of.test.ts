// apps/backend/__tests__/dosespot-as-of.test.ts — VN-D11 (visit-note drafting, S1): the as-of reads on the M12
// MedicationOrderProvider. `getActiveMedications` answers "now" from the current status; a late visit note needs
// "what was active at the visit time", decided from each order's own start and stop instants, never from the
// status it has today. `getMedicationChangesBetween` answers "what changed since the last visit", each change
// tagged with its kind. Windows are (from, to]: an event at `from` is already in the as-of picture at `from`.
import type { MedicationOrderDto } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  createInMemoryDoseSpotSeamStore,
  createMedicationOrderProvider,
} from "../src/modules/12-dosespot/index";

const ORG = "org-1";
const PAT = "pat-1";
const ADM = "adm-1";

const T1 = "2026-03-01T12:00:00.000Z";
const T2 = "2026-03-05T12:00:00.000Z";
const T3 = "2026-03-10T12:00:00.000Z";
const T4 = "2026-03-15T12:00:00.000Z";

function order(over: Partial<MedicationOrderDto> & { id: string }): MedicationOrderDto {
  return {
    organizationId: ORG,
    patientId: PAT,
    admissionId: ADM,
    medClass: "standard",
    status: "active",
    rxnormRxcui: null,
    ndc: null,
    drugName: "Morphine Sulfate",
    strength: "20 mg/mL",
    doseForm: "oral solution",
    route: "oral",
    sigStructured: {
      doseQuantity: 0.5,
      doseUnit: "mL",
      route: "by mouth",
      frequencyCode: "every 4 hours",
      asNeeded: false,
    },
    prescriberMembershipId: "mem-md",
    prescribingPhysicianMdmId: "phys-1",
    dispensingPharmacyMdmId: null,
    refillsRemaining: 0,
    signedAt: "2026-03-01T11:55:00.000Z",
    transmittedAt: null,
    activatedAt: T1,
    discontinuedAt: null,
    completedAt: null,
    isControlledSubstance: false,
    deaSchedule: null,
    isSudTreatment: false,
    derivedFromRefillId: null,
    derivedFromHistoryId: null,
    replacesMedicationOrderId: null,
    documentId: null,
    ...over,
  };
}

function providerOver(orders: readonly MedicationOrderDto[]) {
  const { store } = createInMemoryDoseSpotSeamStore({ medicationOrders: orders });
  return createMedicationOrderProvider(store);
}

const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id).sort();

describe("MedicationOrderProvider.getMedicationsAsOf (VN-D11)", () => {
  it("includes an order from the instant it was activated", async () => {
    const provider = providerOver([order({ id: "m1", activatedAt: T2 })]);

    expect(ids(await provider.getMedicationsAsOf(ORG, PAT, "2026-03-05T11:59:59.999Z"))).toEqual(
      [],
    );
    expect(ids(await provider.getMedicationsAsOf(ORG, PAT, T2))).toEqual(["m1"]);
    expect(ids(await provider.getMedicationsAsOf(ORG, PAT, T3))).toEqual(["m1"]);
  });

  it("excludes a discontinued order from the instant it was discontinued, not before", async () => {
    // Its status today is 'discontinued'; the as-of answer must not depend on that.
    const provider = providerOver([
      order({ id: "m1", status: "discontinued", activatedAt: T1, discontinuedAt: T3 }),
    ]);

    expect(ids(await provider.getMedicationsAsOf(ORG, PAT, T2))).toEqual(["m1"]);
    expect(ids(await provider.getMedicationsAsOf(ORG, PAT, "2026-03-10T11:59:59.999Z"))).toEqual([
      "m1",
    ]);
    expect(ids(await provider.getMedicationsAsOf(ORG, PAT, T3))).toEqual([]);
    expect(ids(await provider.getMedicationsAsOf(ORG, PAT, T4))).toEqual([]);
  });

  it("excludes a completed order from its completion instant", async () => {
    const provider = providerOver([
      order({ id: "m1", status: "completed", activatedAt: T1, completedAt: T3 }),
    ]);

    expect(ids(await provider.getMedicationsAsOf(ORG, PAT, T2))).toEqual(["m1"]);
    expect(ids(await provider.getMedicationsAsOf(ORG, PAT, T3))).toEqual([]);
  });

  it("includes an order that is still active today at an instant after it started", async () => {
    const provider = providerOver([order({ id: "m1", status: "active", activatedAt: T1 })]);

    expect(ids(await provider.getMedicationsAsOf(ORG, PAT, "2030-01-01T00:00:00.000Z"))).toEqual([
      "m1",
    ]);
  });

  it("never reports an order that was never activated (signed, transmission failed, expired)", async () => {
    const provider = providerOver([
      order({ id: "failed", status: "transmission_failed", activatedAt: null }),
      order({ id: "expired", status: "expired_unsigned", activatedAt: null, signedAt: null }),
      order({ id: "draft", status: "draft", activatedAt: null, signedAt: null }),
    ]);

    expect(await provider.getMedicationsAsOf(ORG, PAT, T4)).toEqual([]);
  });

  it("fails closed on an order whose status says it ended but carries no end instant", async () => {
    const provider = providerOver([
      order({ id: "gone", status: "discontinued", discontinuedAt: null }),
      order({ id: "done", status: "completed", completedAt: null }),
    ]);

    expect(await provider.getMedicationsAsOf(ORG, PAT, T2)).toEqual([]);
  });

  it("lets a replacement take over from its predecessor at the replacement's activation", async () => {
    // The predecessor keeps status 'active' and no discontinued_at; only the replacement's activation ends it.
    const provider = providerOver([
      order({ id: "old", activatedAt: T1 }),
      order({ id: "new", activatedAt: T3, replacesMedicationOrderId: "old" }),
    ]);

    expect(ids(await provider.getMedicationsAsOf(ORG, PAT, T2))).toEqual(["old"]);
    expect(ids(await provider.getMedicationsAsOf(ORG, PAT, "2026-03-10T11:59:59.999Z"))).toEqual([
      "old",
    ]);
    expect(ids(await provider.getMedicationsAsOf(ORG, PAT, T3))).toEqual(["new"]);
    expect(ids(await provider.getMedicationsAsOf(ORG, PAT, T4))).toEqual(["new"]);
  });

  it("does not let an unactivated replacement end its predecessor", async () => {
    const provider = providerOver([
      order({ id: "old", activatedAt: T1 }),
      order({
        id: "new",
        status: "pending_signature",
        activatedAt: null,
        replacesMedicationOrderId: "old",
      }),
    ]);

    expect(ids(await provider.getMedicationsAsOf(ORG, PAT, T4))).toEqual(["old"]);
  });

  it("returns only the requested patient's orders", async () => {
    const provider = providerOver([
      order({ id: "mine" }),
      order({ id: "theirs", patientId: "pat-other" }),
    ]);

    expect(ids(await provider.getMedicationsAsOf(ORG, PAT, T4))).toEqual(["mine"]);
  });

  it("compares instants, not strings: an offset-formatted asOf lands on the same instant", async () => {
    const provider = providerOver([order({ id: "m1", activatedAt: T2 })]);

    // 2026-03-05T13:00:00+01:00 is exactly T2
    expect(ids(await provider.getMedicationsAsOf(ORG, PAT, "2026-03-05T13:00:00+01:00"))).toEqual([
      "m1",
    ]);
    expect(ids(await provider.getMedicationsAsOf(ORG, PAT, "2026-03-05T12:59:59+01:00"))).toEqual(
      [],
    );
  });

  it("rejects an asOf that is not an instant rather than guessing", async () => {
    const provider = providerOver([order({ id: "m1" })]);

    await expect(provider.getMedicationsAsOf(ORG, PAT, "yesterday")).rejects.toThrow(RangeError);
  });
});

describe("MedicationOrderProvider.getMedicationChangesBetween (VN-D11)", () => {
  it("tags an order activated inside the window as started", async () => {
    const provider = providerOver([order({ id: "m1", activatedAt: T2 })]);

    const out = await provider.getMedicationChangesBetween(ORG, PAT, T1, T3);

    expect(out.map((c) => [c.kind, c.at, c.order.id])).toEqual([["started", T2, "m1"]]);
  });

  it("treats the window as (from, to]: an event at from is excluded, an event at to is included", async () => {
    const provider = providerOver([
      order({ id: "atFrom", activatedAt: T1 }),
      order({ id: "atTo", activatedAt: T3 }),
    ]);

    const out = await provider.getMedicationChangesBetween(ORG, PAT, T1, T3);

    expect(out.map((c) => c.order.id)).toEqual(["atTo"]);
  });

  it("tags a discontinuation inside the window as discontinued", async () => {
    const provider = providerOver([
      order({ id: "m1", status: "discontinued", activatedAt: T1, discontinuedAt: T3 }),
    ]);

    const out = await provider.getMedicationChangesBetween(ORG, PAT, T2, T4);

    expect(out.map((c) => [c.kind, c.at, c.order.id])).toEqual([["discontinued", T3, "m1"]]);
  });

  it("tags a course ending inside the window as completed", async () => {
    const provider = providerOver([
      order({ id: "m1", status: "completed", activatedAt: T1, completedAt: T3 }),
    ]);

    const out = await provider.getMedicationChangesBetween(ORG, PAT, T2, T4);

    expect(out.map((c) => [c.kind, c.order.id])).toEqual([["completed", "m1"]]);
  });

  it("reports a replacement of an order that had been active as one 'changed', not started plus discontinued", async () => {
    const provider = providerOver([
      order({ id: "old", activatedAt: T1 }),
      order({ id: "new", activatedAt: T3, replacesMedicationOrderId: "old" }),
    ]);

    const out = await provider.getMedicationChangesBetween(ORG, PAT, T2, T4);

    expect(out.map((c) => [c.kind, c.at, c.order.id])).toEqual([["changed", T3, "new"]]);
  });

  it("reports a replacement of an order that never became active (a retransmit) as started", async () => {
    const provider = providerOver([
      order({ id: "failed", status: "transmission_failed", activatedAt: null }),
      order({ id: "retry", activatedAt: T3, replacesMedicationOrderId: "failed" }),
    ]);

    const out = await provider.getMedicationChangesBetween(ORG, PAT, T2, T4);

    expect(out.map((c) => [c.kind, c.order.id])).toEqual([["started", "retry"]]);
  });

  it("reports an order started and stopped inside the window as two changes, in time order", async () => {
    const provider = providerOver([
      order({ id: "m1", status: "discontinued", activatedAt: T2, discontinuedAt: T3 }),
    ]);

    const out = await provider.getMedicationChangesBetween(ORG, PAT, T1, T4);

    expect(out.map((c) => [c.kind, c.at])).toEqual([
      ["started", T2],
      ["discontinued", T3],
    ]);
  });

  it("orders changes ascending by instant across orders", async () => {
    const provider = providerOver([
      order({ id: "late", activatedAt: T3 }),
      order({ id: "early", activatedAt: T2 }),
    ]);

    const out = await provider.getMedicationChangesBetween(ORG, PAT, T1, T4);

    expect(out.map((c) => c.order.id)).toEqual(["early", "late"]);
  });

  it("reports nothing when nothing changed, and never another patient's orders", async () => {
    const provider = providerOver([
      order({ id: "steady", activatedAt: T1 }),
      order({ id: "theirs", patientId: "pat-other", activatedAt: T3 }),
    ]);

    expect(await provider.getMedicationChangesBetween(ORG, PAT, T2, T4)).toEqual([]);
  });

  it("agrees with getMedicationsAsOf: as-of(from) plus the changes equals as-of(to)", async () => {
    const provider = providerOver([
      order({ id: "kept", activatedAt: T1 }),
      order({ id: "stopped", status: "discontinued", activatedAt: T1, discontinuedAt: T3 }),
      order({ id: "added", activatedAt: "2026-03-12T12:00:00.000Z" }),
    ]);

    const before = ids(await provider.getMedicationsAsOf(ORG, PAT, T2));
    const after = ids(await provider.getMedicationsAsOf(ORG, PAT, T4));
    const changes = await provider.getMedicationChangesBetween(ORG, PAT, T2, T4);

    expect(before).toEqual(["kept", "stopped"]);
    expect(after).toEqual(["added", "kept"]);
    expect(changes.map((c) => [c.kind, c.order.id])).toEqual([
      ["discontinued", "stopped"],
      ["started", "added"],
    ]);
  });

  it("rejects a window that is reversed or not made of instants rather than guessing", async () => {
    const provider = providerOver([order({ id: "m1" })]);

    await expect(provider.getMedicationChangesBetween(ORG, PAT, T3, T1)).rejects.toThrow(
      RangeError,
    );
    await expect(provider.getMedicationChangesBetween(ORG, PAT, "x", T1)).rejects.toThrow(
      RangeError,
    );
    await expect(provider.getMedicationChangesBetween(ORG, PAT, T1, "x")).rejects.toThrow(
      RangeError,
    );
  });
});
