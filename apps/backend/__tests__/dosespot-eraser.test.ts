// apps/backend/__tests__/dosespot-eraser.test.ts — M12-T09 the `medication_order_record` eraser (§7.7, D15,
// D7/D8). Proves the two destruction paths (partition-detach-and-drop, mixed-partition row-delete), the
// per-patient advisory lock, idempotency, the org-scoped DoseSpot config / encrypted webhook receipts being
// left untouched, and that M12 registers the REAL eraser over the Phase-0 deny-stub so validateErasers()
// passes at a real boot.
import { beforeEach, describe, expect, it } from "vitest";
import { __resetErasersForTest, getEraser, validateErasers } from "../src/bootstrap/erasers/registry";
import { buildServer } from "../src/bootstrap/index";
import {
  createInMemoryMedicationOrderEraseStore as makeEraseStore,
  eraseMedicationOrderRecord,
  registerDoseSpotErasers,
} from "../src/modules/12-dosespot/index";
import { wireModuleErasers, wireModuleSeams } from "../src/index";

const NOW = "2026-06-22T00:00:00.000Z";

describe("M12-T09 — medication_order_record eraser (§7.7, D15, D7/D8)", () => {
  beforeEach(() => __resetErasersForTest());

  it("partition-detach-and-drop path: locks the patient, drops whole partitions, reports the total", async () => {
    const { store, locked } = makeEraseStore({
      counts: {
        medicationOrders: 5,
        transmissions: 4,
        refillRequests: 2,
        epcsSigningAttempts: 1,
        partitionsDropped: 2,
      },
    });
    const { erased, counts } = await eraseMedicationOrderRecord("org_a", "pat_1", store, { now: () => NOW });
    // 5 + 4 + 2 + 1 (partitionsDropped is bookkeeping, already counted in `medicationOrders`)
    expect(erased).toBe(12);
    expect(counts.partitionsDropped).toBe(2);
    expect(counts.medicationOrders).toBe(5);
    expect(locked).toEqual(["pat_1"]); // advisory lock acquired before the deletes (§7.7 #1)
  });

  it("mixed-partition row-delete path: orders row-deleted, no partitions dropped", async () => {
    const { store } = makeEraseStore({
      counts: { medicationOrders: 3, transmissions: 2, refillRequests: 1, partitionsDropped: 0 },
    });
    const { erased, counts } = await eraseMedicationOrderRecord("org_a", "pat_1", store, { now: () => NOW });
    expect(erased).toBe(6); // 3 + 2 + 1 + 0
    expect(counts.partitionsDropped).toBe(0);
    expect(counts.medicationOrders).toBe(3);
  });

  it("retentionAsOf defaults to now() when the cert omits it", async () => {
    let seen: string | null = null;
    const store = {
      async lockPatient() {},
      async eraseMedicationOrdersSubtree(_org: string, _pat: string, retentionAsOf: string) {
        seen = retentionAsOf;
        return {
          medicationOrders: 1,
          transmissions: 0,
          refillRequests: 0,
          epcsSigningAttempts: 0,
          partitionsDropped: 0,
        };
      },
    };
    await eraseMedicationOrderRecord("org_a", "pat_1", store, { now: () => NOW });
    expect(seen).toBe(NOW);
  });

  it("is idempotent — a second erase removes nothing", async () => {
    const { store } = makeEraseStore({ counts: { medicationOrders: 2, transmissions: 1 } });
    expect((await eraseMedicationOrderRecord("org_a", "pat_1", store, { now: () => NOW })).erased).toBe(3);
    expect((await eraseMedicationOrderRecord("org_a", "pat_1", store, { now: () => NOW })).erased).toBe(0);
  });

  it("registers over the deny-stub; the boot hook makes validateErasers() pass for the data class", async () => {
    registerDoseSpotErasers({ store: makeEraseStore({ counts: { medicationOrders: 1 } }).store });
    const r = await getEraser("medication_order_record").erase({ orgId: "org_a" }, "pat_1");
    expect(r.erased).toBe(1);
  });

  it("a real buildServer() boot wires the eraser so validateErasers() passes", async () => {
    const app = buildServer({
      registerModuleSeams: wireModuleSeams,
      registerModuleErasers: wireModuleErasers,
    });
    expect(() => validateErasers()).not.toThrow();
    const r = await getEraser("medication_order_record").erase({ orgId: "org_a" }, "pat_unseeded");
    expect(r.erased).toBe(0);
    await app.close();
  });
});
