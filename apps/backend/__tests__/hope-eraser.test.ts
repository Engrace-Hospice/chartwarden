// apps/backend/__tests__/hope-eraser.test.ts — M10-T08 the `hope_record` eraser (§8.4, D7/D8). Proves the
// four §9.1 paths (partition-detach-and-drop, mixed-partition row-delete, extended-retention block,
// legal-hold override), the pure CMS-10-year retention core, and that M10 registers the REAL eraser over the
// Phase-0 deny-stub so validateErasers() passes at a real boot.
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetErasersForTest,
  getEraser,
  validateErasers,
} from "../src/bootstrap/erasers/registry";
import { buildServer } from "../src/bootstrap/index";
import { wireModuleErasers, wireModuleSeams } from "../src/index";
import {
  HopeRetentionBlockedError,
  addYears,
  earliestErasableInstant,
  eraseHopeRecord,
  isHopeErasureBlocked,
  createInMemoryHopeEraseStore as makeEraseStore,
  registerHopeErasers,
} from "../src/modules/10-hope/index";

const NOW = "2026-06-22T00:00:00.000Z";

describe("M10-T08 — pure CMS-10-year retention core (§8.4 step 1)", () => {
  it("addYears advances the calendar year preserving month/day", () => {
    expect(addYears("2020-03-15T12:00:00.000Z", 10)).toBe("2030-03-15T12:00:00.000Z");
  });

  it("earliestErasableInstant is null with nothing submitted, else youngest.transmittedAt + 10y", () => {
    expect(earliestErasableInstant([])).toBeNull();
    const earliest = earliestErasableInstant([
      { id: "a", transmittedAt: "2020-01-01T00:00:00.000Z" },
      { id: "b", transmittedAt: "2024-06-01T00:00:00.000Z" }, // youngest drives the floor
    ]);
    expect(earliest).toBe("2034-06-01T00:00:00.000Z");
  });

  it("isHopeErasureBlocked: blocked when inside retention, not blocked with override or when past the floor", () => {
    const submitted = [{ id: "a", transmittedAt: "2024-06-01T00:00:00.000Z" }];
    expect(isHopeErasureBlocked(submitted, NOW, false)).toBe(true); // 2026 < 2034 → blocked
    expect(isHopeErasureBlocked(submitted, NOW, true)).toBe(false); // legal-hold override
    expect(isHopeErasureBlocked(submitted, "2035-01-01T00:00:00.000Z", false)).toBe(false); // past floor
    expect(isHopeErasureBlocked([], NOW, false)).toBe(false); // nothing submitted
  });
});

describe("M10-T08 — hope_record eraser (§8.4, D7/D8)", () => {
  beforeEach(() => __resetErasersForTest());

  it("partition-detach-and-drop path: locks the patient, drops whole partitions, reports the total", async () => {
    const { store, locked } = makeEraseStore({
      counts: {
        schedules: 4,
        sfvs: 2,
        validationFindings: 1,
        assessments: 6,
        partitionsDropped: 2,
      },
    });
    const { erased, counts } = await eraseHopeRecord("org_a", "pat_1", store, { now: () => NOW });
    expect(erased).toBe(13); // 4 + 2 + 1 + 6 (partitionsDropped is bookkeeping, already in assessments)
    expect(counts.partitionsDropped).toBe(2);
    expect(counts.assessments).toBe(6);
    expect(locked).toEqual(["pat_1"]); // advisory lock acquired before the deletes (§8.4 #1)
  });

  it("mixed-partition row-delete path: assessments row-deleted, no partitions dropped", async () => {
    const { store } = makeEraseStore({
      counts: {
        schedules: 1,
        sfvs: 0,
        validationFindings: 2,
        assessments: 3,
        partitionsDropped: 0,
      },
    });
    const { erased, counts } = await eraseHopeRecord("org_a", "pat_1", store, { now: () => NOW });
    expect(erased).toBe(6);
    expect(counts.partitionsDropped).toBe(0);
    expect(counts.assessments).toBe(3);
  });

  it("extended-retention block path: refuses while submitted assessments are inside the 10-year horizon", async () => {
    const { store } = makeEraseStore({
      counts: { assessments: 3 },
      submitted: [{ id: "a", transmittedAt: "2024-06-01T00:00:00.000Z" }],
    });
    await expect(
      eraseHopeRecord("org_a", "pat_1", store, { now: () => NOW }),
    ).rejects.toBeInstanceOf(HopeRetentionBlockedError);
    try {
      await eraseHopeRecord("org_a", "pat_1", store, { now: () => NOW });
    } catch (e) {
      const err = e as HopeRetentionBlockedError;
      expect(err.earliestErasable).toBe("2034-06-01T00:00:00.000Z");
      expect(err.submittedCount).toBe(1);
    }
  });

  it("legal-hold-override path: proceeds despite submitted assessments inside the retention horizon", async () => {
    const { store } = makeEraseStore({
      counts: { schedules: 1, assessments: 3 },
      submitted: [{ id: "a", transmittedAt: "2024-06-01T00:00:00.000Z" }],
    });
    const { erased } = await eraseHopeRecord("org_a", "pat_1", store, {
      now: () => NOW,
      legalHoldOverride: true,
    });
    expect(erased).toBe(4);
  });

  it("is idempotent — a second erase removes nothing", async () => {
    const { store } = makeEraseStore({ counts: { schedules: 1, assessments: 2 } });
    expect((await eraseHopeRecord("org_a", "pat_1", store, { now: () => NOW })).erased).toBe(3);
    expect((await eraseHopeRecord("org_a", "pat_1", store, { now: () => NOW })).erased).toBe(0);
  });

  it("registers over the deny-stub; the boot hook makes validateErasers() pass for the data class", async () => {
    registerHopeErasers({ store: makeEraseStore({ counts: { assessments: 1 } }).store });
    const r = await getEraser("hope_record").erase({ orgId: "org_a" }, "pat_1");
    expect(r.erased).toBe(1);
  });

  it("a real buildServer() boot wires the eraser so validateErasers() passes", async () => {
    const app = buildServer({
      registerModuleSeams: wireModuleSeams,
      registerModuleErasers: wireModuleErasers,
    });
    expect(() => validateErasers()).not.toThrow();
    const r = await getEraser("hope_record").erase({ orgId: "org_a" }, "pat_unseeded");
    expect(r.erased).toBe(0);
    await app.close();
  });
});
