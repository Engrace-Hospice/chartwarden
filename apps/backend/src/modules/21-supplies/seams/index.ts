// apps/backend/src/modules/21-supplies/seams — M21's §4.8 / D14 owned seams (M21-T05) + the barrel over the
// consumed side (`./consumed.ts`, M21-T04).
//
// M21 publishes THREE surfaces forward consumers attach to instead of importing M21's schema (architecture
// §25.15 blocks the schema import):
//
//   • `SupplyFulfillmentProvider`  — direct request creation (a coordinator's entry outside the M11 flow)
//                                    plus the request status / terminality read M11's §7.7 cancellation
//                                    cascade branches on, and M22/M28/M30/M33 project;
//   • `ComfortKitDispatchProvider` — M13's bedside controlled-substance inventory (which kits are live for
//                                    this patient, and what lots are in them), the D17 / M37 IPU-room stock
//                                    kit, and the DEA §1304 perpetual-log APPEND M13's drawdown writes;
//   • `SupplyCostProvider`         — per-patient and per-org supply spend in integer CENTS (M23's cap-spend
//                                    analysis, M27's cost report), as TOTALS and COUNTS, never a rate.
//
// `registerSuppliesSeams` registers all three real impls over their boot deny-stubs (before
// validateSeams()), driven from the composition root's `wireModuleSeams()`. All three share ONE injected
// {@link SuppliesSeamStore} — the Drizzle adapter in production (`./store-drizzle`), an in-memory slice for
// tests and a boot without a DB client — the M9…M18 seams/index.ts precedent.
//
// UNLIKE M16-T05, registering these gives a live consumer something real to attach to the day M11 and M13
// flip their reads over: M13's bedside kit inventory and M11's pre-cancellation `isTerminal` check are both
// written against these exact contracts (M21-T04 already consumes M11's side of the same handshake).
// Flipping the consumer is an M11/M13 wiring change (the M26 precedent, PRs #129/#130), not M21's. What
// lands here is the producer side: the contracts are real, registered and boot-validated.
import { getRequestContext } from "@wardenx/tenancy";
import type {
  ComfortKitDispatchProvider,
  IsoInstant,
  OrgId,
  SupplyCostProvider,
  SupplyFulfillmentProvider,
} from "@wardenx/types";
import { getSeam, registerSeam } from "../../../bootstrap/index";
import {
  type SuppliesSeamClock,
  type SuppliesSeamOrgResolver,
  createComfortKitDispatchProvider,
  createSupplyCostProvider,
  createSupplyFulfillmentProvider,
} from "./providers";
import {
  type SuppliesSeamStore,
  type SupplyRequestCreator,
  createInMemorySuppliesSeamStore,
} from "./store";

export { getAdmissionStatusReader, getDeathDischargeReader, getOrderProvider } from "./consumed";
export {
  EMPTY_SUPPLY_COST_TOTALS,
  type InMemorySuppliesSeamStore,
  type SuppliesSeamSeed,
  type SuppliesSeamStore,
  type SupplyCostTotals,
  type SupplyRequestCreator,
  createInMemorySuppliesSeamStore,
} from "./store";
export { buildDrizzleSuppliesSeamStore } from "./store-drizzle";
export {
  type SuppliesSeamClock,
  type SuppliesSeamOrgResolver,
  createComfortKitDispatchProvider,
  createSupplyCostProvider,
  createSupplyFulfillmentProvider,
  orgSpendSummaryOf,
  patientCostSummaryOf,
} from "./providers";

/**
 * The late-bound §4.8 creator. `registerSuppliesSeams()` runs in `wireModuleSeams()` (before
 * `validateSeams()`), but the M21 WRITE service is constructed later, in the route-mount section, because
 * it needs the catalog-validating outbox publisher that lives there. Rather than register a second,
 * outbox-less creation path — which would write supply requests whose §4.5.2 events never went out — the
 * seam registers a PROXY that delegates to whatever {@link bindSupplyRequestCreator} last bound, and raises
 * the typed `M21_ROUTING_NOT_RESOLVED` refusal while nothing is bound.
 *
 * A holder rather than a constructor argument, and deliberately so: the alternative orderings all end with
 * either an event-less write path or a boot that cannot register the seam at all.
 */
let boundCreator: SupplyRequestCreator | undefined;

/** Bind the M21 WRITE service as the §4.8 creation path (called from the composition root's route mount). */
export function bindSupplyRequestCreator(creator: SupplyRequestCreator): void {
  boundCreator = creator;
}

/** Test-only: drop the bound creator so a case can assert the unbound refusal. */
export function __resetSupplyRequestCreatorForTest(): void {
  boundCreator = undefined;
}

/** The proxy registered with the seam — resolves the holder at CALL time, never at registration time. */
const lateBoundCreator: SupplyRequestCreator = {
  async createDirect(input) {
    if (boundCreator === undefined) {
      // Deliberately delegated to the provider's own refusal so the error code and message have one home.
      return createSupplyFulfillmentProvider(
        createInMemorySuppliesSeamStore().store,
      ).createDirectSupplyRequest(input) as never;
    }
    return boundCreator.createDirect(input);
  },
};

/** Deps for M21's owned-seam registration (slice defaults to the in-memory store + the real clock). */
export interface SuppliesSeamDeps {
  /** The §4.8 data port (Drizzle over M21's tables in prod; in-memory slice in tests). */
  store?: SuppliesSeamStore;
  /**
   * The M21 WRITE service, bound so `createDirectSupplyRequest` goes through the SAME creation path as a
   * route and an M11 cascade (D4 routing freeze + per-kind validation + the §4.5.2 emit). Unbound ⇒ the
   * create method raises rather than writing a routing-less row (`M21_ROUTING_NOT_RESOLVED`).
   */
  creator?: SupplyRequestCreator;
  /** Injected clock — the perpetual-log entry stamps from it, so a seam write is deterministic in tests. */
  clock?: SuppliesSeamClock;
  /**
   * The caller's org, for the ONE DTO field that is not a row value. Defaults to the ambient request
   * context — the same scope RLS pinned the read by. Outside a request it answers `""`, which the cost
   * provider treats as "no caller org to compare against" rather than as a match.
   */
  orgOf?: SuppliesSeamOrgResolver;
}

/**
 * Register M21's three §4.8 owned seams into the M1 registry over their boot deny-stubs (M21-T05; before
 * validateSeams()). All three share one {@link SuppliesSeamStore} so a single Drizzle adapter backs the
 * whole request + dispatch + cost read surface. Called by the composition root's `wireModuleSeams()`.
 */
export function registerSuppliesSeams(deps: SuppliesSeamDeps = {}): void {
  const store = deps.store ?? createInMemorySuppliesSeamStore().store;
  const clock: SuppliesSeamClock = deps.clock ?? (() => new Date().toISOString() as IsoInstant);
  const orgOf: SuppliesSeamOrgResolver =
    deps.orgOf ?? (() => (getRequestContext()?.organizationId ?? "") as OrgId);

  registerSeam(
    "SupplyFulfillmentProvider",
    createSupplyFulfillmentProvider(store, deps.creator ?? lateBoundCreator),
  );
  registerSeam("ComfortKitDispatchProvider", createComfortKitDispatchProvider(store, clock));
  registerSeam("SupplyCostProvider", createSupplyCostProvider(store, orgOf));
}

/** Typed resolver for M21's SupplyFulfillmentProvider (M11's cascade, M22/M28/M30/M33 projections). */
export function getSupplyFulfillmentProvider(): SupplyFulfillmentProvider {
  return getSeam("SupplyFulfillmentProvider");
}

/** Typed resolver for M21's ComfortKitDispatchProvider (M13's bedside inventory, M37's IPU-room kit). */
export function getComfortKitDispatchProvider(): ComfortKitDispatchProvider {
  return getSeam("ComfortKitDispatchProvider");
}

/** Typed resolver for M21's SupplyCostProvider (M23's cap-spend analysis, M27's cost report). */
export function getSupplyCostProvider(): SupplyCostProvider {
  return getSeam("SupplyCostProvider");
}
