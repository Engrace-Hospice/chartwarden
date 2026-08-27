// apps/backend/__tests__/outbox-seam-consumers.test.ts — F-043 / #103, the `seamConsumers` split.
//
// The catalog had ONE word for TWO delivery mechanisms. 623 (module, event) pairs used
// `declaredConsumers` to describe a module that never intended an outbox subscription at all — M4
// captures at the DATABASE layer (write-audit triggers, in the producer's own transaction), M36 alerts
// through the `AlertEmitter` seam, M33 pulls over the `report_mv.*` materialized views.
//
// That was not cosmetic. `buildOutboxRoutingPlan` defers an event while ANY declared consumer is
// unbound, and the relay finalizes a deferred row `pending` with `attemptCount - 1` — so it never
// reaches `maxAttempts`, never dead-letters, and the retention purge (which touches only `dispatched`
// rows) never collects it. Every emission of those 252 events was a row re-claimed every thirty
// minutes for the life of the deployment.
//
// These cases pin the distinction the fix rests on: a seam consumer is INERT for routing.
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { MODULES } from "../../../architecture/module-manifest";
import {
  type OutboxConsumerBinding,
  buildOutboxRoutingPlan,
} from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog } from "../src/bootstrap/outbox-persister";
import { M6_OUTBOX_EVENTS } from "../src/modules/06-admission/events-by-m6";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/events-by-m37";
import { M39_OUTBOX_EVENTS } from "../src/modules/39-consent/events-by-m39";

const payload = Type.Object({ id: Type.String() });

function entry(
  eventName: string,
  declaredConsumers: string[],
  seamConsumers?: string[],
): Record<string, unknown> {
  return {
    eventName,
    moduleOwner: "m6",
    description: `test entry ${eventName}`,
    payloadSchema: payload,
    declaredConsumers,
    ...(seamConsumers ? { seamConsumers } : {}),
    isOutboxOnly: true,
  };
}

const noopBinding = (module: string, name: string, events: string[]): OutboxConsumerBinding =>
  ({
    consumerModule: module,
    consumerName: name,
    eventTypes: events,
    handle: async () => {},
  }) as unknown as OutboxConsumerBinding;

describe("#103 — seamConsumers is inert for routing", () => {
  it("an event whose ONLY interested modules are seam consumers is recordOnly, not deferred", () => {
    // This is the 252-event case. Before the split it read `declaredConsumers: ["m33", "m36"]` and
    // deferred forever; the row now dispatches and becomes purgeable.
    const catalog = buildBootOutboxCatalog([
      [entry("m6.test.seam_only", [], ["m33", "m36"])] as never,
    ]);
    const plan = buildOutboxRoutingPlan(catalog, []);
    expect(plan.recordOnly.has("m6.test.seam_only")).toBe(true);
    expect(plan.deferred.has("m6.test.seam_only")).toBe(false);
  });

  it("the same entry WITHOUT the split — seam modules left in declaredConsumers — defers", () => {
    // The pre-fix shape, asserted directly so the regression is visible rather than remembered.
    const catalog = buildBootOutboxCatalog([[entry("m6.test.pre_fix", ["m33", "m36"])] as never]);
    const plan = buildOutboxRoutingPlan(catalog, []);
    expect(plan.deferred.has("m6.test.pre_fix")).toBe(true);
    expect(plan.recordOnly.has("m6.test.pre_fix")).toBe(false);
  });

  it("a seam consumer does not keep an otherwise fully-bound event deferred", () => {
    const catalog = buildBootOutboxCatalog([[entry("m6.test.mixed", ["m7"], ["m36"])] as never]);
    const plan = buildOutboxRoutingPlan(catalog, [
      noopBinding("m7", "m7.test-consumer", ["m6.test.mixed"]),
    ]);
    expect(plan.deferred.has("m6.test.mixed")).toBe(false);
    expect(plan.live.get("m6.test.mixed")?.length).toBe(1);
  });

  it("a real unbound declared consumer STILL defers — the split narrows the rule, it does not weaken it", () => {
    const catalog = buildBootOutboxCatalog([
      [entry("m6.test.still_deferred", ["m7", "m14"], ["m36"])] as never,
    ]);
    const plan = buildOutboxRoutingPlan(catalog, [
      noopBinding("m7", "m7.test-consumer", ["m6.test.still_deferred"]),
    ]);
    expect(plan.deferred.has("m6.test.still_deferred")).toBe(true);
  });

  it("a seam consumer confers no delivery — it is absent from the live routing entirely", () => {
    const catalog = buildBootOutboxCatalog([
      [entry("m6.test.no_delivery", ["m7"], ["m36"])] as never,
    ]);
    const plan = buildOutboxRoutingPlan(catalog, [
      noopBinding("m7", "m7.test-consumer", ["m6.test.no_delivery"]),
    ]);
    const modules = (plan.live.get("m6.test.no_delivery") ?? []).map((b) => b.consumerModule);
    expect(modules).toEqual(["m7"]);
    expect(modules).not.toContain("m36");
  });
});

// ── the real catalog, not synthetic entries ───────────────────────────────────────────────────────
//
// The cases above pin the MECHANISM, and would pass against the pre-#103 code too (an entry with no
// declared consumers has always been record-only). These pin the MIGRATION, over three real
// contributions that each carried seam declarations. Every one fails against the catalog as it stood
// before the split. The corpus-wide claim is `arch:outbox-bindings`'s (rule 5), not a count here that
// would drift the day a module is added.
describe("#103 — the real catalog no longer declares a seam module as an outbox consumer", () => {
  const catalog = buildBootOutboxCatalog([
    M6_OUTBOX_EVENTS,
    M37_OUTBOX_EVENTS,
    M39_OUTBOX_EVENTS,
  ] as never);

  /** The three modules whose intake is a synchronous seam, never the outbox (M4 triggers, M36
   *  AlertEmitter, M33 MetricsProvider pull). None of them binds anything in these contributions. */
  const SEAM_MODULES = ["m4", "m33", "m36"];

  it("no event in these contributions declares a seam module as an outbox consumer", () => {
    const offenders: string[] = [];
    for (const [name, entry] of catalog) {
      for (const m of entry.declaredConsumers) {
        if (SEAM_MODULES.includes(m)) offenders.push(`${name} → ${m}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no event names the same module in BOTH lists — one delivery mechanism per pair", () => {
    for (const [name, entry] of catalog) {
      for (const m of entry.seamConsumers ?? []) {
        expect(
          entry.declaredConsumers.includes(m),
          `${name} names ${m} in both declaredConsumers and seamConsumers`,
        ).toBe(false);
      }
    }
  });

  it("every module named in a seamConsumers list is a real module", () => {
    const real = new Set(MODULES.map((m) => `m${m.id}`));
    for (const [name, entry] of catalog) {
      for (const m of entry.seamConsumers ?? []) {
        expect(real.has(m), `${name} names unknown module ${m}`).toBe(true);
      }
    }
  });

  it("m37.shift.rn_uncovered — an alert-only event — is record-only now, and used to defer forever", () => {
    // Its whole declared audience was M36, whose alert fires (or does not) through the AlertEmitter
    // seam. Every emission used to leave a row re-claimed every 30 minutes for the life of the
    // deployment; it now dispatches and becomes eligible for the retention purge.
    const plan = buildOutboxRoutingPlan(catalog, []);
    const entry = catalog.get("m37.shift.rn_uncovered");
    expect(entry?.seamConsumers).toContain("m36");
    expect(entry?.declaredConsumers).toEqual([]);
    expect(plan.recordOnly.has("m37.shift.rn_uncovered")).toBe(true);
    expect(plan.deferred.has("m37.shift.rn_uncovered")).toBe(false);
  });

  it("m37.restraint.applied is MIXED — it still defers, on its one real consumer (m30)", () => {
    // The split is not a blanket un-deferral. This event alerts through M36's seam AND is genuinely
    // consumed by M30's incident projection, which is not bound yet — so it correctly keeps deferring,
    // and stays in the register for the reason that is actually true of it.
    const plan = buildOutboxRoutingPlan(catalog, []);
    const entry = catalog.get("m37.restraint.applied");
    expect(entry?.seamConsumers).toEqual(["m36"]);
    expect(entry?.declaredConsumers).toEqual(["m30"]);
    expect(plan.deferred.has("m37.restraint.applied")).toBe(true);
  });

  it("m6.admission.activated keeps its 14 real outbox consumers — the split narrowed nothing real", () => {
    const entry = catalog.get("m6.admission.activated");
    expect(entry?.seamConsumers).toEqual(["m33", "m36"]);
    // The clinical fan-out is untouched: M5/M7/M8/M10/M11/M14/M16/M22/M23/M26/M27/M28/M30/M37.
    expect(entry?.declaredConsumers).toContain("m10");
    expect(entry?.declaredConsumers).toContain("m30");
    expect(entry?.declaredConsumers.length).toBe(14);
  });
});
