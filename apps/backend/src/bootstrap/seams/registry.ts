// apps/backend/src/bootstrap/seams/registry.ts — the M1 SEAM REGISTRY.
//
// Cross-module contracts are injected at boot (ADR-0005 D1). Each producer module's
// init calls registerSeam(); consumers call getSeam(). After ALL modules initialize
// and BEFORE the server listens, validateSeams() runs and FAILS CLOSED if any required
// seam is unregistered — boot aborts with an actionable message rather than serving a
// half-wired system.
//
// This file lives under seams/ so check-fitness-gaps.ts (seam-registry sub-check) scans
// it: REQUIRED_SEAMS + registerSeam/getSeam are the tokens it keys on.

import type { SeamContracts, SeamName } from "../interfaces";

export class SeamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeamError";
  }
}

const registry = new Map<SeamName, unknown>();

/** Every seam the platform requires before it may serve traffic. */
export const REQUIRED_SEAMS: readonly SeamName[] = [
  "CaseloadProvider",
  "PatientReader",
  "DocumentRenderer",
  "ConsentEvaluator",
];

/** A producer module registers its implementation of a published seam. */
export function registerSeam<K extends SeamName>(name: K, impl: SeamContracts[K]): void {
  registry.set(name, impl);
}

/** A consumer resolves a seam implementation (throws if requested before registration). */
export function getSeam<K extends SeamName>(name: K): SeamContracts[K] {
  const impl = registry.get(name);
  if (impl === undefined) throw new SeamError(`seam '${name}' requested before registration`);
  return impl as SeamContracts[K];
}

/** Boot gate: throw listing every required seam that no module registered. */
export function validateSeams(): void {
  const missing = REQUIRED_SEAMS.filter((s) => !registry.has(s));
  if (missing.length > 0) {
    throw new SeamError(
      `validateSeams: ${missing.length} required seam(s) unregistered — refusing to start: ${missing.join(", ")}`,
    );
  }
}

/** Test-only: clear the registry between cases. */
export function __resetSeamsForTest(): void {
  registry.clear();
}
