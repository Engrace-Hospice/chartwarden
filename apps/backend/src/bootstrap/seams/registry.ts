// apps/backend/src/bootstrap/seams/registry.ts — the M1 SEAM REGISTRY + boot gate (§3.18).
//
// Cross-module contracts are injected at boot (ADR-0005 D1): a producer module's init calls
// registerSeam(); consumers call getSeam(). After ALL modules initialize and BEFORE the
// server listens, validateSeams() runs (§3.18.3). For every required seam that no module
// registered it applies that seam's deny-stub default — so the contract is ALWAYS present
// and fails CLOSED (denies on call) rather than open — and it refuses to boot only when an
// entry has neither a registration nor a deny-stub: an unrecoverable contract gap.
//
// M1 owns the registry + the gate (resolves M03-F12: M1 cannot import an M3-owned registry,
// so REQUIRED_SEAMS is M1-owned, with each owning module's entry declared here until those
// modules contribute their own at init). This file lives under seams/ so
// check-fitness-gaps.ts (seam-registry sub-check) scans it: the `REQUIRED_SEAMS = [...]`
// literal and registerSeam/getSeam are the tokens it keys on.

import type { RequiredSeam, SeamContracts, SeamName } from "../interfaces";
import {
  auditorSessionMinterDenyStub,
  caseloadDenyStub,
  consentEvaluatorDenyStub,
  documentRendererDenyStub,
  patientReaderDenyStub,
  sessionContextResolverDenyStub,
} from "./providers";

export class SeamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeamError";
  }
}

const registry = new Map<SeamName, unknown>();

/**
 * Every seam the platform requires before it may serve traffic, each with its owning
 * module, a fail-closed deny-stub default, and whether it guards PHI (§3.18.2). Written as
 * a `satisfies` literal so the keys stay statically discoverable to the seam-registry
 * fitness check. Phase-1 producer modules register their REAL implementation over the
 * deny-stub via registerSeam() at init.
 */
export const REQUIRED_SEAMS = [
  { key: "CaseloadProvider", ownerModule: 5, phi: true, denyStub: caseloadDenyStub },
  { key: "PatientReader", ownerModule: 5, phi: true, denyStub: patientReaderDenyStub },
  { key: "DocumentRenderer", ownerModule: 22, phi: true, denyStub: documentRendererDenyStub },
  { key: "ConsentEvaluator", ownerModule: 39, phi: true, denyStub: consentEvaluatorDenyStub },
  // M2 published seams (§4.7): authenticated request context + auditor session minter. Not PHI
  // (identity/session metadata, not a patient record), but still boot-validated and fail-closed.
  {
    key: "SessionContextResolver",
    ownerModule: 2,
    phi: false,
    denyStub: sessionContextResolverDenyStub,
  },
  {
    key: "AuditorSessionMinter",
    ownerModule: 2,
    phi: false,
    denyStub: auditorSessionMinterDenyStub,
  },
] satisfies readonly RequiredSeam[];

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

/**
 * Boot gate (§3.18.3): for every required seam that no module registered, apply its
 * deny-stub default so the seam fails CLOSED (denies on call). Refuse to boot — throwing
 * SeamError — only when a required seam has neither a registration nor a deny-stub. Run
 * after every module init() (wireSeams) and before server.listen().
 */
export function validateSeams(): void {
  const missing: string[] = [];
  for (const r of REQUIRED_SEAMS) {
    if (registry.has(r.key)) continue;
    if (r.denyStub !== undefined) {
      registry.set(r.key, r.denyStub); // fail closed: present, but denies on call
    } else {
      missing.push(`seam:${r.key} (owner M${r.ownerModule})`);
    }
  }
  if (missing.length > 0) {
    throw new SeamError(
      `validateSeams: ${missing.length} required seam(s) without a registration or deny-stub — refusing to start: ${missing.join(", ")}`,
    );
  }
}

/** Test-only: clear the registry between cases. */
export function __resetSeamsForTest(): void {
  registry.clear();
}
