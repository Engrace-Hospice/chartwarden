// TASK-001 (production-readiness audit 2026-08-03) — the in-memory-binding ledger + boot assertion.
// The acceptance criterion from the task backlog: a PLANTED in-memory binding fails a db boot,
// naming the registrar; a db-less boot stays silent (the in-memory slice is the documented posture).
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryBindingError,
  __resetInMemoryLedgerForTest,
  assertNoInMemoryBindingsOnDbBoot,
  inMemoryBindingNotes,
  noteInMemoryBinding,
  resolveInMemoryAssertMode,
} from "../in-memory-ledger";

afterEach(() => __resetInMemoryLedgerForTest());

const planted = () =>
  noteInMemoryBinding({
    kind: "eraser",
    label: "M99 registerPlantedErasers — 'planted_record' erase store",
    task: "TASK-003",
  });

describe("resolveInMemoryAssertMode", () => {
  it("enforces in production by default and warns elsewhere", () => {
    expect(resolveInMemoryAssertMode({ NODE_ENV: "production" })).toBe("enforce");
    expect(resolveInMemoryAssertMode({ NODE_ENV: "development" })).toBe("warn");
    expect(resolveInMemoryAssertMode({})).toBe("warn");
  });

  it("honors the explicit flag, including the production warn-only rollback", () => {
    expect(
      resolveInMemoryAssertMode({ WARDENX_INMEM_ASSERT: "warn", NODE_ENV: "production" }),
    ).toBe("warn");
    expect(resolveInMemoryAssertMode({ WARDENX_INMEM_ASSERT: "enforce" })).toBe("enforce");
  });

  it("fails closed on a typo'd flag value (never silently downgrades to warn)", () => {
    expect(resolveInMemoryAssertMode({ WARDENX_INMEM_ASSERT: "wran" })).toBe("enforce");
    expect(resolveInMemoryAssertMode({ WARDENX_INMEM_ASSERT: "off" })).toBe("enforce");
  });
});

describe("assertNoInMemoryBindingsOnDbBoot", () => {
  it("throws in enforce mode, naming the planted registrar and its backlog task", () => {
    planted();
    expect(() =>
      assertNoInMemoryBindingsOnDbBoot({
        dbPresent: true,
        env: { WARDENX_INMEM_ASSERT: "enforce" },
      }),
    ).toThrowError(InMemoryBindingError);
    try {
      assertNoInMemoryBindingsOnDbBoot({
        dbPresent: true,
        env: { WARDENX_INMEM_ASSERT: "enforce" },
      });
      expect.unreachable("must throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("M99 registerPlantedErasers");
      expect(message).toContain("TASK-003");
      expect(message).toContain("Refusing to boot");
    }
  });

  it("is a no-op on a db-less boot — the in-memory slice is the documented posture", () => {
    planted();
    let warned = "";
    expect(() =>
      assertNoInMemoryBindingsOnDbBoot({
        dbPresent: false,
        env: { WARDENX_INMEM_ASSERT: "enforce" },
        warn: (m) => (warned = m),
      }),
    ).not.toThrow();
    expect(warned).toBe("");
  });

  it("warns (never silently) in warn mode, listing every binding once", () => {
    planted();
    planted(); // same label twice — the ledger de-duplicates
    noteInMemoryBinding({
      kind: "seam",
      label: "M98 registerPlantedSeams — PlantedReader on an in-memory store",
      task: "TASK-002",
    });
    let warned = "";
    assertNoInMemoryBindingsOnDbBoot({
      dbPresent: true,
      env: { WARDENX_INMEM_ASSERT: "warn" },
      warn: (m) => (warned = m),
    });
    expect(warned).toContain("2 in-memory binding(s)");
    expect(warned).toContain("M98 registerPlantedSeams");
    expect(warned).toContain("M99 registerPlantedErasers");
  });

  it("passes silently when the ledger is empty on a db boot — the Phase-1 target state", () => {
    let warned = "";
    assertNoInMemoryBindingsOnDbBoot({
      dbPresent: true,
      env: { NODE_ENV: "production" },
      warn: (m) => (warned = m),
    });
    expect(warned).toBe("");
  });

  it("returns notes stable-sorted for deterministic boot logs", () => {
    noteInMemoryBinding({ kind: "seam", label: "Z last", task: "t" });
    noteInMemoryBinding({ kind: "eraser", label: "A first", task: "t" });
    expect(inMemoryBindingNotes().map((n) => n.label)).toEqual(["A first", "Z last"]);
  });
});
