// apps/backend/src/modules/38-terminology/seams.ts — M38-T05 seam registration (spec §4.5).
//
// M38 publishes ONE boot-validated cross-module seam — `TerminologyProvider`, the version-aware
// code/value-set resolution surface every clinical/billing/interop module consumes. This
// module-owned init registers its REAL implementation into the M1 seam registry, overwriting
// the Phase-0 deny-stub; the composition root (apps/backend/src/index.ts `wireModuleSeams`)
// invokes it inside the boot gate, after M1's wireSeams() and before validateSeams().
//
// The seam's rich interface lives in the feature package @wardenx/terminology (not the leaf
// @wardenx/types — `leaves-stay-leaves` forbids the leaf importing it). So the M1 registry
// holds the instance opaquely (`SeamContracts["TerminologyProvider"] = unknown`); this file is
// the typed boundary: `registerTerminologySeams` registers the typed impl and
// `getTerminologyProvider` hands consumers a typed handle. Consumers import the
// `TerminologyProvider` TYPE from @wardenx/terminology (they already list 38 in dependsOn) and
// resolve the runtime instance through here.
//
// SLICE NOTE: the provider is wired over an injected slice-safe in-memory store by default (no
// live DB/Valkey). Production passes the Drizzle/Valkey-backed `TerminologyStore` (T06/T07) via
// `deps.store`.
import {
  type TerminologyProvider,
  type TerminologyStore,
  createInMemoryTerminologyStore,
  createTerminologyProvider,
} from "@wardenx/terminology";
import { getSeam, registerSeam } from "../../bootstrap/index";

/** Injected production adapter for M38's published seam (slice defaults to in-memory). */
export interface TerminologySeamDeps {
  /** The data port the provider composes over (Drizzle/Valkey-backed in production). */
  store?: TerminologyStore;
}

/** Register M38's `TerminologyProvider` into the M1 registry (M38-T05; before validateSeams()). */
export function registerTerminologySeams(deps: TerminologySeamDeps = {}): void {
  const store = deps.store ?? createInMemoryTerminologyStore().store;
  registerSeam("TerminologyProvider", createTerminologyProvider(store));
}

/**
 * Typed resolver for consumers. The M1 registry stores `TerminologyProvider` opaquely; this
 * re-applies the type at the M38 boundary (the cast is sound — `registerTerminologySeams`
 * registered a real `TerminologyProvider`, and `validateSeams()` guarantees an instance is
 * present, fail-closed, before any consumer runs).
 */
export function getTerminologyProvider(): TerminologyProvider {
  return getSeam("TerminologyProvider") as TerminologyProvider;
}
