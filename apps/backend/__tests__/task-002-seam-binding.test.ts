// TASK-002 acceptance (production-readiness audit 2026-08-03, ARCH-003): on a db boot the
// composition root must bind a Drizzle store behind every published seam — zero TASK-002
// in-memory seam fallbacks may be recorded. This is the regression gate for the burn-down:
// a future registrar that quietly reverts to its in-memory default fails here, not in prod.
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetInMemoryLedgerForTest,
  inMemoryBindingNotes,
} from "../src/bootstrap/in-memory-ledger";
import { __resetErasersForTest } from "../src/bootstrap/erasers/registry";
import { __resetSeamsForTest } from "../src/bootstrap/seams/registry";
import { wireModuleErasers, wireModuleSeams } from "../src/index";

afterEach(() => {
  __resetInMemoryLedgerForTest();
  __resetSeamsForTest();
  __resetErasersForTest();
});

describe("TASK-002 — Drizzle seam binding on a db boot", () => {
  it("records no TASK-002 seam fallbacks when db + outbox publisher are supplied", () => {
    // The factories only capture the client (no query runs at construction), so a bare object
    // stands in for DbClient here — this test asserts BINDING decisions, not query behavior.
    wireModuleSeams({
      db: {} as never,
      outboxPublisher: { publish: async () => {} },
    });
    const task002SeamFallbacks = inMemoryBindingNotes().filter(
      (n) => n.kind === "seam" && n.task.startsWith("TASK-002"),
    );
    expect(task002SeamFallbacks).toEqual([]);
  });

  it("still records the M5 mutator fallback when no outbox publisher is supplied", () => {
    wireModuleSeams({ db: {} as never });
    const labels = inMemoryBindingNotes().map((n) => n.label);
    expect(labels.some((l) => l.includes("PatientMutator"))).toBe(true);
  });
});

describe("TASK-003 — Drizzle erase-store binding on a db boot", () => {
  it("records no TASK-003 eraser fallbacks when db + platformDb are supplied", () => {
    wireModuleErasers({ db: {} as never, platformDb: {} as never });
    const eraserFallbacks = inMemoryBindingNotes().filter(
      (n) => n.kind === "eraser" && n.task.startsWith("TASK-003"),
    );
    expect(eraserFallbacks).toEqual([]);
  });

  it("records the M34 platform-credential gap when platformDb is absent", () => {
    wireModuleErasers({ db: {} as never });
    const labels = inMemoryBindingNotes()
      .filter((n) => n.kind === "eraser")
      .map((n) => n.label);
    expect(labels.some((l) => l.includes("saas_tenant_platform_class"))).toBe(true);
    expect(labels).toHaveLength(1); // every other data class is Drizzle-bound
  });
});
