// apps/backend/src/modules/39-consent/seams.ts — M39-T05 seam registration (spec §4.3).
//
// M39 publishes the `ConsentEvaluator` seam — the disclosure/redaction gate every PHI-egress module
// consults (M28 FHIR, M22 disclosure subsetter, M5 right-of-access, M27/M30/M33 aggregates, M29
// interop) and the surface the eleven §4.7 ABAC predicates resolve through. This module-owned init
// registers the REAL implementation into the M1 seam registry, overwriting the Phase-0 deny-stub;
// the composition root (apps/backend/src/index.ts `wireModuleSeams`) invokes it inside the boot gate,
// after M1's wireSeams() and before validateSeams().
//
// The seam's rich interface lives in @wardenx/consent (§4.3 four typed query methods + the per-
// category redaction-flag shape) — not the leaf @wardenx/types (`leaves-stay-leaves`). So the M1
// registry holds the instance opaquely (`SeamContracts["ConsentEvaluator"] = unknown`); this file is
// the typed boundary: `registerConsentSeams` registers the typed impl and `getConsentEvaluator` hands
// consumers a typed handle. Consumers import the `ConsentEvaluator` TYPE from @wardenx/consent (they
// already list 39 in dependsOn) and resolve the runtime instance through here.
//
// SLICE NOTE: the evaluator is wired over an injected in-memory `ConsentStore` by default (no live
// DB). Production passes the Drizzle-backed store (T07/T09) via `deps.store`. The decision engine
// (post-death scope, per-recipient activeness, fail-closed redaction §4.3.1) lives in the evaluator
// (T04/T05), not the store, so it is honored either way.
import {
  type ConsentEvaluator,
  type ConsentStore,
  createConsentEvaluator,
  createInMemoryConsentStore,
} from "@wardenx/consent";
import { getSeam, registerSeam } from "../../bootstrap/index";

/** Injected production adapter for M39's published seam (slice defaults to in-memory). */
export interface ConsentSeamDeps {
  /** The data port the `ConsentEvaluator` composes over (Drizzle-backed in production, T07/T09). */
  store?: ConsentStore;
}

/** Register M39's `ConsentEvaluator` into the M1 registry (M39-T05; before validateSeams()). */
export function registerConsentSeams(deps: ConsentSeamDeps = {}): void {
  const store = deps.store ?? createInMemoryConsentStore().store;
  registerSeam("ConsentEvaluator", createConsentEvaluator(store));
}

/**
 * Typed resolver for consumers. The M1 registry stores `ConsentEvaluator` opaquely; this re-applies
 * the type at the M39 boundary (the cast is sound — `registerConsentSeams` registered a real
 * `ConsentEvaluator`, and `validateSeams()` guarantees an instance is present, fail-closed, before
 * any consumer runs). Every PHI-egress module resolves the gate through here.
 */
export function getConsentEvaluator(): ConsentEvaluator {
  return getSeam("ConsentEvaluator") as ConsentEvaluator;
}
