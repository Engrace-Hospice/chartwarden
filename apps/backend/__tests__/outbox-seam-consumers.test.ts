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
import { buildM36ClinicalAlertConsumer } from "../src/modules/36-messaging/outbox-consumers/clinical-alerts";
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

  /** The one exception: M36's clinical-alert consumer BINDS a handful of events live from the outbox
   *  (`m36.clinical-visit-encounter-alerts`). For exactly those, M36 is a real outbox consumer and
   *  belongs in `declaredConsumers` — rule 3 of `arch:outbox-bindings` refuses the binding otherwise. */
  const M36_BOUND = new Set(
    buildM36ClinicalAlertConsumer({ emit: async () => {} } as never).eventTypes,
  );

  it("no event in these contributions declares a seam module as an outbox consumer", () => {
    const offenders: string[] = [];
    for (const [name, entry] of catalog) {
      for (const m of entry.declaredConsumers) {
        if (m === "m36" && M36_BOUND.has(name)) continue;
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

  it("m6.admission.activated keeps its real outbox consumers — the split narrowed nothing real", () => {
    const entry = catalog.get("m6.admission.activated");
    // F-115 (#248) — m30 joined m33/m36 here: it reads this fact via `AdmissionOnsetReader` on its
    // nightly recompute cadence (the `opioid_on_admission_rate` denominator), not by reacting to this
    // event, so it moved out of declaredConsumers alongside the other two seam-only modules.
    expect(entry?.seamConsumers).toEqual(["m30", "m33", "m36"]);
    // This asserted `.length === 14`, then 13, then would have been 14 again — a pinned count on a list
    // that legitimately changes whenever a real consumer is added or a mis-declared one removed, which
    // is two edits in two PRs and neither of them the thing this case is about. What the SEAM SPLIT
    // claims is narrower and is checkable directly: the seam modules moved OUT of the outbox list
    // and the clinical fan-out stayed IN.
    for (const seam of entry?.seamConsumers ?? []) {
      expect(entry?.declaredConsumers).not.toContain(seam);
    }
    for (const clinical of ["m5", "m7", "m10", "m13", "m14", "m15", "m37"]) {
      expect(entry?.declaredConsumers).toContain(clinical);
    }
    // F-134 (#248) — m16 dropped: an admission ACTIVATION carries no fact M16's bereavement program
    // (which starts at death, not admission) needs; M16's own §4.5 outbox-subscriptions table never
    // named this event.
    expect(entry?.declaredConsumers).not.toContain("m16");
    // F-136 (#248) — m23 dropped: an admission ACTIVATION anchors no claim by itself — M23's own §4.4
    // subscription surface names the full M6 outbox catalog BY EVENT, and admission.activated is not
    // among them.
    expect(entry?.declaredConsumers).not.toContain("m23");
    // F-137 (#248) — m11 dropped: M11's own spec's authoritative "Outbox events consumed" list never
    // names this event, and no consumer file, decider, or comment anywhere in `11-orders/` mentions
    // admission activation — the same broad-fan-out-no-rationale shape as m16/m23 above.
    expect(entry?.declaredConsumers).not.toContain("m11");
    // F-140 (#248) — m8 dropped: M8's own spec states outbox publication is the only cross-module
    // communication M8 performs "at the boundary" — every upstream fact is a seam call, never a push.
    expect(entry?.declaredConsumers).not.toContain("m8");
  });
});

// ── F-101 ───────────────────────────────────────────────────────────────────────────────────────
// Seven m6 events declared `m22` and M22's §4.11 consumer table names none of them. `declaredConsumers`
// is a ROUTING input, not a statement of interest, so the effect was not documentary: every emission of
// all seven was deferred and re-claimed every thirty minutes for the life of the deployment. Three had
// `m22` as their ONLY declared consumer, so each was a permanently-pending row on a path with no
// consumer at all — a referral acceptance, a draft admission, a drafted election statement.
//
// The cases below assert the ROUTING outcome rather than the membership of a list: asserting
// `not.toContain("m22")` would pass equally on a catalog where the event had been deleted.
describe("F-101 — m6 events that declare m22 render nothing", () => {
  const catalog = buildBootOutboxCatalog([M6_OUTBOX_EVENTS as never]);

  const RECORD_ONLY = [
    "m6.referral.accepted",
    "m6.admission.draft_created",
    "m6.election.drafted",
  ] as const;

  it.each(RECORD_ONLY)("%s is recordOnly — it dispatches instead of deferring forever", (name) => {
    const plan = buildOutboxRoutingPlan(catalog, []);
    expect(plan.recordOnly.has(name)).toBe(true);
    expect(plan.deferred.has(name)).toBe(false);
  });

  it("the six M22 DOES render still declare it — this narrowed nothing that was working", () => {
    // The F-100 handshake is the control. If a blanket sweep had removed `m22` from every m6 event,
    // these six would have gone recordOnly too and the CoP documents would stop being rendered.
    for (const name of [
      "m6.election.signed",
      "m6.cti.signed",
      "m6.f2f.attested",
      "m6.nor.acknowledged",
      "m6.revocation.created",
      "m6.discharge.created",
    ]) {
      expect(catalog.get(name)?.declaredConsumers).toContain("m22");
    }
  });

  it("the two the M22 spec names but cannot render yet keep m22 — they are deferred, not wrong", () => {
    // `m6.discharge.cosigned` is a new VERSION of an existing document (W2 append path), and
    // `m6.transfer.created` wants a `discharge_summary` transfer variant M22 does not publish. Both
    // stay in scripts/outbox-deferred-consumers.ts, where a reason that will expire belongs.
    expect(catalog.get("m6.discharge.cosigned")?.declaredConsumers).toContain("m22");
    expect(catalog.get("m6.transfer.created")?.declaredConsumers).toContain("m22");
  });

  it("the four that still defer do so on their OTHER consumers, not on m22", () => {
    // Removing `m22` from these did not un-defer them and was never going to: each carries other
    // unbound consumers, which is the true reason they defer. The change is that the reason is now
    // the true one — a list that names a consumer which will never bind cannot be worked off.
    const plan = buildOutboxRoutingPlan(catalog, []);
    for (const name of [
      "m6.admission.activated",
      "m6.admission.discharged",
      "m6.election.period_started",
      "m6.loc.changed",
    ]) {
      expect(catalog.get(name)?.declaredConsumers).not.toContain("m22");
      expect(plan.deferred.has(name)).toBe(true);
      expect(catalog.get(name)?.declaredConsumers.length).toBeGreaterThan(0);
    }
  });
});
