// apps/backend/__tests__/mdm-nppes-consumers.test.ts — M40-T09 the M29 NPPES-sync consumers as a
// Phase-1 forward-seam / deny-stub (M40 spec §4.7, §7.11–7.12).
//
// Accept (M40-T09): the two §4.7 consumers are PRESENT as declared (event → consumer) bindings but
// DEFERRED (not live-wired until M29, Wave H); the T08 nightly job is the Phase-1 authoritative path.
// The handler factory binds the real @wardenx/mdm logic over injected ports so M29 wiring is
// mechanical when it lands (W-M40-12/13).
import {
  M29_CONSUMERS_DEFERRED,
  M29_NPPES_CONSUMERS,
  createM29NppesConsumerHandlers,
} from "../src/modules/40-mdm/index";
import type { NppesCanonicalPhysician, NppesConsumerPorts } from "@wardenx/mdm";
import { describe, expect, it } from "vitest";

describe("M40-T09 — M29 NPPES consumers (forward-seam / deny-stub)", () => {
  it("declares both §4.7 consumers against M29-owned events with m40.* handler names", () => {
    expect(M29_NPPES_CONSUMERS.map((c) => c.eventName)).toEqual([
      "m29.nppes.provider_synced",
      "m29.nppes.provider_deactivated",
    ]);
    for (const c of M29_NPPES_CONSUMERS) {
      expect(c.eventName.startsWith("m29.")).toBe(true); // M29 owns the event catalog entry
      expect(c.consumerName.startsWith("m40.")).toBe(true); // M40 owns the consumer
    }
  });

  it("is DEFERRED in Phase 1 (M29 is Wave H; the T08 nightly job is the fallback)", () => {
    expect(M29_CONSUMERS_DEFERRED).toBe(true);
  });

  it("the handler factory binds the real apply logic over ports (ready for M29 wiring)", async () => {
    const canon: NppesCanonicalPhysician = {
      id: "c-1",
      npi: "1234567893",
      status: "active",
      firstName: "Jane",
      lastName: "OLD",
      credentials: "MD",
      specialtyTaxonomy: null,
    };
    const emitted: string[] = [];
    const ports: NppesConsumerPorts = {
      findCanonicalByNpi: async () => canon,
      applyCanonicalUpdate: async () => undefined,
      applyDeactivation: async () => undefined,
      emitCanonicalUpdated: async (e) => void emitted.push(e.id),
      tenantsToAlert: async () => [],
      emitDeactivationAlert: async () => undefined,
      writeDeactivationObservedAudit: async () => undefined,
    };
    const handlers = createM29NppesConsumerHandlers(ports);
    const decision = await handlers.onProviderSynced({
      npi: "1234567893",
      action: "updated",
      changedFields: ["lastName"],
      syncedAt: "2026-06-19T02:30:00Z",
      syncRunId: "run-1",
      provider: { firstName: "Jane", lastName: "NEW", credentials: "MD", specialtyTaxonomy: null },
    });
    expect(decision.outcome).toBe("updated_canonical");
    expect(emitted).toEqual(["c-1"]);
  });
});
