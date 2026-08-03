// apps/backend/src/modules/18-evv/seams — M18's published §4.3 owned seams (M18-T05). M18 publishes SIX
// leaf-typed READ surfaces forward consumers attach to instead of importing M18's schema (architecture §25.15
// blocks the schema import): `EvvBracketResolver` — published over M8's EXISTING `resolveBracket` contract, the
// "is the visit EVV-bracketed" read M8 consumes at encounter authoring + sign (CLOSES M8's `encounter.period`
// forward seam, M8 D9); `EvvComplianceReader` — the billing pre-submission compliance gate M23/M24 + the M30
// HQRP measure consume; `EvvAggregatorReferenceReader` — the state-aggregator transaction-id back-link M24
// (claim) + M25 (denial) consume; `EvvLocationProvider` — the last-known-clinician-location read M20 field-safety
// live-awareness consumes (the only coordinate-bearing seam, D10); `EvvMetricsProvider` — the productivity +
// quality measures M30/M33 dashboards consume; `EvvVerificationProvider` — the M31 portal "Nurse arrived at
// HH:MM" surface (timestamp only, no coordinates). `registerEvvSeams` registers all six real impls over their
// boot deny-stubs (before validateSeams()), driven from the composition root's wireModuleSeams(). All six share
// ONE injected EvvSeamStore (in-memory slice here; Drizzle in prod, reads under the consumer's RLS) — mirrors the
// M9/M10/M11/M12/M13/M14/M17 seams/index.ts precedents. None is a mutate path: M18 owns the EVV lifecycle internally.
import type {
  EvvAggregatorReferenceReader,
  EvvBracketResolver,
  EvvComplianceReader,
  EvvLocationProvider,
  EvvMetricsProvider,
  EvvVerificationProvider,
} from "@wardenx/types";
import { getSeam, registerSeam } from "../../../bootstrap/index";
import {
  createEvvAggregatorReferenceReader,
  createEvvBracketResolver,
  createEvvComplianceReader,
  createEvvLocationProvider,
  createEvvMetricsProvider,
  createEvvVerificationProvider,
} from "./providers";
import { type EvvSeamStore, createInMemoryEvvSeamStore } from "./store";

export {
  type EvvAggregatorWindowCounts,
  type EvvAggregatorWindowSeedRow,
  type EvvArrival,
  type EvvComplianceState,
  type EvvDeviceCoverage,
  type EvvMetricWindowCounts,
  type EvvSeamSeed,
  type EvvSeamStore,
  type EvvVerificationSummary,
  type EvvWindowSeedRow,
  createInMemoryEvvSeamStore,
} from "./store";
export {
  createEvvAggregatorReferenceReader,
  createEvvBracketResolver,
  createEvvComplianceReader,
  createEvvLocationProvider,
  createEvvMetricsProvider,
  createEvvVerificationProvider,
} from "./providers";
export { createDrizzleEvvSeamStore } from "./drizzle-store";

/** Deps for M18's owned-seam registration (slice defaults to the in-memory store). */
export interface EvvSeamDeps {
  /** The §4.3 data port (Drizzle over M18's tables in prod; in-memory slice in tests). */
  store?: EvvSeamStore;
}

/**
 * Register M18's six §4.3 owned seams into the M1 registry over their boot deny-stubs (M18-T05; before
 * validateSeams()). All six share one {@link EvvSeamStore} so a single Drizzle adapter backs the whole bracket +
 * compliance + aggregator-reference + location + metrics + verification read surface. `EvvBracketResolver` is
 * registered over M8's EXISTING contract — this is the registration that closes M8's `encounter.period` forward
 * seam (M8 D9). Called by the composition root's wireModuleSeams().
 */
export function registerEvvSeams(deps: EvvSeamDeps = {}): void {
  const store = deps.store ?? createInMemoryEvvSeamStore().store;
  registerSeam("EvvBracketResolver", createEvvBracketResolver(store));
  registerSeam("EvvComplianceReader", createEvvComplianceReader(store));
  registerSeam("EvvAggregatorReferenceReader", createEvvAggregatorReferenceReader(store));
  registerSeam("EvvLocationProvider", createEvvLocationProvider(store));
  registerSeam("EvvMetricsProvider", createEvvMetricsProvider(store));
  registerSeam("EvvVerificationProvider", createEvvVerificationProvider(store));
}

/** Typed resolver for M18's EvvBracketResolver (M8 encounter authoring + sign consumes it; closes M8 D9). */
export function getEvvBracketResolver(): EvvBracketResolver {
  return getSeam("EvvBracketResolver");
}

/** Typed resolver for M18's EvvComplianceReader (M23/M24 billing gate + M30 HQRP measure consume the seam). */
export function getEvvComplianceReader(): EvvComplianceReader {
  return getSeam("EvvComplianceReader");
}

/** Typed resolver for M18's EvvAggregatorReferenceReader (M24 claim builder + M25 denial back-link consume it). */
export function getEvvAggregatorReferenceReader(): EvvAggregatorReferenceReader {
  return getSeam("EvvAggregatorReferenceReader");
}

/** Typed resolver for M18's EvvLocationProvider (M20 field-safety live-awareness consumes the coordinate seam). */
export function getEvvLocationProvider(): EvvLocationProvider {
  return getSeam("EvvLocationProvider");
}

/** Typed resolver for M18's EvvMetricsProvider (M30/M33 productivity + quality dashboards consume the seam). */
export function getEvvMetricsProvider(): EvvMetricsProvider {
  return getSeam("EvvMetricsProvider");
}

/** Typed resolver for M18's EvvVerificationProvider (M31 portal arrival surface consumes the seam). */
export function getEvvVerificationProvider(): EvvVerificationProvider {
  return getSeam("EvvVerificationProvider");
}
