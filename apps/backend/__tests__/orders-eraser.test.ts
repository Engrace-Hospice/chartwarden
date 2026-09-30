// apps/backend/__tests__/orders-eraser.test.ts — M11-T08 the `order_record` eraser (§7.7, D12, D7/D8).
// Proves the two destruction paths (partition-detach-and-drop, mixed-partition row-delete), the per-patient
// advisory lock, idempotency, the org-scoped `order_verbal_policy` being left untouched, and that M11
// registers the REAL eraser over the Phase-0 deny-stub so validateErasers() passes at a real boot.
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetErasersForTest,
  getEraser,
  validateErasers,
} from "../src/bootstrap/erasers/registry";
import { buildServer } from "../src/bootstrap/index";
import { wireModuleErasers, wireModuleSeams } from "../src/index";
import {
  eraseOrderRecord,
  createInMemoryOrderEraseStore as makeEraseStore,
  registerOrderErasers,
} from "../src/modules/11-orders/index";

const NOW = "2026-06-22T00:00:00.000Z";

describe("M11-T08 — order_record eraser (§7.7, D12, D7/D8)", () => {
  beforeEach(() => __resetErasersForTest());

  it("partition-detach-and-drop path: locks the patient, drops whole partitions, reports the total", async () => {
    const { store, locked } = makeEraseStore({
      counts: {
        orders: 6,
        signatures: 8,
        verbalOrders: 2,
        standingInstances: 3,
        discontinuations: 1,
        standingOrders: 2,
        partitionsDropped: 2,
      },
    });
    const { erased, counts } = await eraseOrderRecord("org_a", "pat_1", store, { now: () => NOW });
    // 6 + 8 + 2 + 3 + 1 + 2 (partitionsDropped is bookkeeping, already counted in `orders`)
    expect(erased).toBe(22);
    expect(counts.partitionsDropped).toBe(2);
    expect(counts.orders).toBe(6);
    expect(locked).toEqual(["pat_1"]); // advisory lock acquired before the deletes (§7.7 #1)
  });

  it("mixed-partition row-delete path: orders row-deleted, no partitions dropped", async () => {
    const { store } = makeEraseStore({
      counts: { orders: 3, signatures: 4, standingOrders: 1, partitionsDropped: 0 },
    });
    const { erased, counts } = await eraseOrderRecord("org_a", "pat_1", store, { now: () => NOW });
    expect(erased).toBe(8); // 3 + 4 + 0 + 0 + 0 + 1
    expect(counts.partitionsDropped).toBe(0);
    expect(counts.orders).toBe(3);
  });

  it("F-202: the attested-recovery ledger and the two-person requests count toward what was erased", async () => {
    // Both tables hold the lab contact's NAME and reference for a patient's order; a destruction certificate that
    // omitted them would report success while leaving them behind.
    const { store } = makeEraseStore({
      counts: { orders: 2, transmissionAttestations: 3, recoveryRequests: 2 },
    });
    const { erased, counts } = await eraseOrderRecord("org_a", "pat_1", store, { now: () => NOW });
    expect(erased).toBe(7); // 2 orders + 3 attestations + 2 recovery requests
    expect(counts.transmissionAttestations).toBe(3);
    expect(counts.recoveryRequests).toBe(2);
  });

  it("retentionAsOf defaults to now() when the cert omits it", async () => {
    let seen: string | null = null;
    const store = {
      async lockPatient() {},
      async eraseOrdersSubtree(_org: string, _pat: string, retentionAsOf: string) {
        seen = retentionAsOf;
        return {
          orders: 1,
          signatures: 0,
          verbalOrders: 0,
          standingInstances: 0,
          discontinuations: 0,
          transmissionAttestations: 0,
          recoveryRequests: 0,
          standingOrders: 0,
          partitionsDropped: 0,
        };
      },
    };
    await eraseOrderRecord("org_a", "pat_1", store, { now: () => NOW });
    expect(seen).toBe(NOW);
  });

  it("is idempotent — a second erase removes nothing", async () => {
    const { store } = makeEraseStore({ counts: { orders: 2, signatures: 1 } });
    expect((await eraseOrderRecord("org_a", "pat_1", store, { now: () => NOW })).erased).toBe(3);
    expect((await eraseOrderRecord("org_a", "pat_1", store, { now: () => NOW })).erased).toBe(0);
  });

  it("registers over the deny-stub; the boot hook makes validateErasers() pass for the data class", async () => {
    registerOrderErasers({ store: makeEraseStore({ counts: { orders: 1 } }).store });
    const r = await getEraser("order_record").erase({ orgId: "org_a" }, "pat_1");
    expect(r.erased).toBe(1);
  });

  it("a real buildServer() boot wires the eraser so validateErasers() passes", async () => {
    const app = buildServer({
      registerModuleSeams: wireModuleSeams,
      registerModuleErasers: wireModuleErasers,
    });
    expect(() => validateErasers()).not.toThrow();
    const r = await getEraser("order_record").erase({ orgId: "org_a" }, "pat_unseeded");
    expect(r.erased).toBe(0);
    await app.close();
  });
});
