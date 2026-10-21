import type { NppesCanonicalPhysician, NppesConsumerPorts } from "@chartwarden/mdm";
import { describe, expect, it } from "vitest";
// apps/backend/__tests__/mdm-nppes-consumers.test.ts — M40-T09's M29 NPPES-sync consumers (M40 spec
// §4.7, §7.11–7.12).
//
// This file used to accept the opposite state: it asserted `M29_CONSUMERS_DEFERRED === true`, i.e. that
// the two §4.7 consumers were DECLARED but not live-wired (M29 was Wave H, so nothing published the
// events). GAP-099 wired them, and that assertion flipping red is the test doing its job — the deferral
// was the thing under test, and it is over. What replaces it is coverage of the LIVE binding shape.
import {
  M29_CONSUMERS_DEFERRED,
  M29_NPPES_CONSUMERS,
  buildM29NppesPlatformConsumers,
  createM29NppesConsumerHandlers,
} from "../src/modules/40-mdm/index";

describe("M40-T09 — M29 NPPES consumers", () => {
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

  it("is no longer deferred (GAP-099 registered both appliers on the platform binding list)", () => {
    expect(M29_CONSUMERS_DEFERRED).toBe(false);
  });

  it("builds one platform binding per declared consumer, named and scoped to match", () => {
    const bindings = buildM29NppesPlatformConsumers({
      db: {} as never,
      outbox: { publish: async () => undefined },
      alerts: { emit: async () => undefined },
      orgs: { listActiveOrgs: async () => [] },
    });
    expect(bindings.map((b) => b.consumerName)).toEqual(
      M29_NPPES_CONSUMERS.map((c) => c.consumerName),
    );
    expect(bindings.flatMap((b) => [...b.eventTypes])).toEqual(
      M29_NPPES_CONSUMERS.map((c) => c.eventName),
    );
    // Every binding must claim `m40` — `buildOutboxRoutingPlan` throws at boot when a consumer's module
    // is not in the event's `declaredConsumers`, and M29 catalogues these two as `["m40"]`.
    for (const b of bindings) expect(b.consumerModule).toBe("m40");
  });

  it("refuses a malformed payload rather than applying a partial canonical write", async () => {
    const [syncedBinding] = buildM29NppesPlatformConsumers({
      db: {} as never,
      outbox: { publish: async () => undefined },
      alerts: { emit: async () => undefined },
      orgs: { listActiveOrgs: async () => [] },
    });
    // A row written by an older deploy: no `provider` snapshot. The throw fails the delivery into the
    // dispatcher's ordinary retry/dead-letter path instead of reaching the canonical with `undefined`s.
    await expect(
      syncedBinding?.handle({
        id: "e-1",
        eventType: "m29.nppes.provider_synced",
        aggregateKind: "nppes_sync_run",
        aggregateId: "a-1",
        payload: { npi: "1234567893", syncRunId: "run-1" },
        attemptCount: 1,
        createdAt: new Date(),
      }),
    ).rejects.toThrow(/provider/);
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
