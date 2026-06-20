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
  alertEmitterDenyStub,
  auditorSessionMinterDenyStub,
  baaStatusProviderDenyStub,
  caseloadDenyStub,
  consentEvaluatorDenyStub,
  documentRendererDenyStub,
  mdmEntityProviderDenyStub,
  messagingProviderDenyStub,
  patientMutatorDenyStub,
  patientReaderDenyStub,
  sessionContextResolverDenyStub,
  terminologyProviderDenyStub,
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
  // M5 (§4.9) — applies an M29-proposal/amendment field diff (D12 strip). PHI write surface;
  // boot-validated and fail-closed until M5 registers the real mutator (M5-T08).
  { key: "PatientMutator", ownerModule: 5, phi: true, denyStub: patientMutatorDenyStub },
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
  // M38 (Terminology) — the version-aware code/value-set resolution surface every clinical and
  // billing module imports (§4.5). Reference data, not a patient record → not PHI; still
  // boot-validated and fail-closed (denies on call) until M38 registers the real provider.
  {
    key: "TerminologyProvider",
    ownerModule: 38,
    phi: false,
    denyStub: terminologyProviderDenyStub,
  },
  // M36 (Messaging) — the alert routing surface every clinical/billing module emits through
  // (§4.6). Not a PHI READ surface (events route in; PHI never leaves out-of-band by rule, §4.7);
  // boot-validated and fail-closed until M36 registers the real emitter (T06).
  {
    key: "AlertEmitter",
    ownerModule: 36,
    phi: false,
    denyStub: alertEmitterDenyStub,
  },
  // M36 (Messaging) — the channel/message surface; `listMessages` decrypts bodies for entitled
  // readers, so this DOES guard a PHI read surface. Declared fail-closed here; its DB-backed
  // implementation registers over the deny-stub with the routes/realtime tasks (M36-T07/T08).
  {
    key: "MessagingProvider",
    ownerModule: 36,
    phi: true,
    denyStub: messagingProviderDenyStub,
  },
  // M40 (MDM) — the master-data read surface (physician/facility/payer; merge-aware, §4.5) every
  // clinical/billing/interop module consumes. Canonical reference data + this-tenant overlay, not a
  // patient record → not PHI; boot-validated and fail-closed until M40 registers the real provider.
  {
    key: "MdmEntityProvider",
    ownerModule: 40,
    phi: false,
    denyStub: mdmEntityProviderDenyStub,
  },
  // M40 (MDM) — the focused §7.7 BAA disclosure gate (as-of time-travel + sending-facility
  // resolution), registered separately from the omnibus above. M22/M28/M29 consult it before any
  // PHI leaves the perimeter. BAA status metadata, not a patient record → not PHI; fail-closed.
  {
    key: "BaaStatusProvider",
    ownerModule: 40,
    phi: false,
    denyStub: baaStatusProviderDenyStub,
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
