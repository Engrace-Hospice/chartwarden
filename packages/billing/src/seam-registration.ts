// @wardenx/billing — boot-time seam registration + consumed-seam binding (§4.3 / §4.4).
//
// Mirrors M27/M30's M1-bootstrap posture: the FIVE published-seam contracts are registered into the M1
// SeamRegistry; consumed seams are resolved through it. M23 takes NO `apps/backend` edge here — the
// registry `registerSeam` / `getSeam` surfaces are injected as PORTS, and the composition root binds them
// to the real M1 registry at boot (P3). This file is the single wiring site.
//
// Two halves:
//  1. PUBLISH — `registerM23PublishedSeams` registers M23's five seams. The live Drizzle/adapter-backed
//     providers are supplied by the caller once the §3 services + adapters are wired (P3).
//  2. CONSUME — the §4.4 consumed-seam names. LIVE producers: M2/M5/M6/M8/M18/M36/M38/M40 + the M23-owned
//     `X12WorkerClient` (housed in `@wardenx/x12-837-client`). FORWARD-SEAM DENY-STUBS today:
//       • `CapProjectionProvider` (M26, D8) — degrades to `status:"unavailable"` so the cap rules WARN
//         rather than throw; tightens to `error` when M26 locks (NOT a hard fail-closed).
//       • `MbiUnlockReader` (M5 post-M23-lock revision, §3.6) — fail-closed THROW (MBI is security-
//         sensitive; this stub NEVER degrades-open).
import type {
  CapOrgProjectionResult,
  CapPatientProjectionResult,
  CapProjectionProvider,
  ClaimDayProjectionProvider,
  ClaimMetricsProvider,
  ClaimReader,
  ClaimSubmissionReader,
  MacCredentialAdmin,
  MbiUnlockReader,
} from "./seams";
import { M23_PUBLISHED_SEAM_NAMES } from "./seams";

/** The M1 SeamRegistry `registerSeam` surface, injected as a port (no apps/backend edge). */
export interface M23SeamRegistrar {
  registerSeam(name: string, impl: unknown): void;
}

/** The live published-seam implementations the composition root supplies once P3 services land. */
export interface M23PublishedSeamImpls {
  claimReader: ClaimReader;
  claimDayProjectionProvider: ClaimDayProjectionProvider;
  claimSubmissionReader: ClaimSubmissionReader;
  claimMetricsProvider: ClaimMetricsProvider;
  macCredentialAdmin: MacCredentialAdmin;
}

/** Registers M23's five published seams into the M1 registry (idempotent at the registry layer). */
export function registerM23PublishedSeams(
  registrar: M23SeamRegistrar,
  impls: M23PublishedSeamImpls,
): void {
  registrar.registerSeam("ClaimReader", impls.claimReader);
  registrar.registerSeam("ClaimDayProjectionProvider", impls.claimDayProjectionProvider);
  registrar.registerSeam("ClaimSubmissionReader", impls.claimSubmissionReader);
  registrar.registerSeam("ClaimMetricsProvider", impls.claimMetricsProvider);
  registrar.registerSeam("MacCredentialAdmin", impls.macCredentialAdmin);
}

/** Sanity: the publish set matches the §4.3 published-name tuple (asserted in test). */
export const M23_PUBLISHED_SEAMS = M23_PUBLISHED_SEAM_NAMES;

/**
 * The §4.4 consumed-seam names (REQUIRED_SEAMS contract). LIVE producers: M2 / M5 / M6 / M8 / M18 / M36 /
 * M38 / M40 + the M23-owned `X12WorkerClient`. FORWARD-SEAM DENY-STUBS today: `CapProjectionProvider`
 * (M26, D8) + `MbiUnlockReader` (M5 post-M23-lock revision).
 */
export const M23_REQUIRED_SEAMS = [
  // M2 — actor / membership / credential resolution
  "MembershipReader",
  "CredentialReader",
  // M5 — patient + payer + caseload
  "PatientReader",
  "PatientPayerReader",
  "MbiUnlockReader",
  "CaseloadProvider",
  // M6 — admission / election / certification / F2F / level-of-care
  "ElectionPeriodReader",
  "AdmissionStatusReader",
  "CertificationReader",
  "FaceToFaceReader",
  "LevelOfCareReader",
  // M8 — encounters
  "BillableEncounterReader",
  "SignedEncountersReader",
  // M18 — EVV
  "EvvComplianceReader",
  // M26 — cap projection (DENY-STUB until M26 lock, D8)
  "CapProjectionProvider",
  // M36 — messaging + alerts
  "MessagingProvider",
  "AlertEmitter",
  // M38 — terminology
  "TerminologyProvider",
  // M40 — master data / NPI
  "MdmEntityProvider",
  // M23-owned vendor adapter (housed in @wardenx/x12-837-client)
  "X12WorkerClient",
] as const;

export type M23RequiredSeamName = (typeof M23_REQUIRED_SEAMS)[number];

/** The forward-seam (deny-stub) consumed names — wired live when the producing module locks. */
export const M23_FORWARD_SEAM_NAMES = ["CapProjectionProvider", "MbiUnlockReader"] as const;

export type M23ForwardSeamName = (typeof M23_FORWARD_SEAM_NAMES)[number];

/** Thrown by every fail-closed forward-seam deny-stub method until the producing module locks. */
export const SEAM_NOT_BOUND = "SEAM_NOT_BOUND" as const;

/**
 * Builds a fail-closed deny-stub whose every accessed method rejects with `SEAM_NOT_BOUND`. NEVER fails
 * open. Used for `MbiUnlockReader` (MBI is security-sensitive — must throw, never degrade-open) and any
 * other not-yet-bound seam. Replaced in place when the producing module binds its live provider.
 */
export function makeDenyStub(seamName: string): Record<string, (...args: unknown[]) => never> {
  return new Proxy(
    {},
    {
      get(_t, _prop) {
        return () => {
          throw new Error(`${SEAM_NOT_BOUND}: ${seamName}`);
        };
      },
    },
  ) as Record<string, (...args: unknown[]) => never>;
}

/** The degraded-unavailable per-patient cap projection the D8 deny-stub returns (drives WARN, not error). */
const CAP_PATIENT_UNAVAILABLE: CapPatientProjectionResult = {
  status: "unavailable",
  projectedCapCents: null,
  capLimitCents: null,
  withinCap: null,
};

/** The degraded-unavailable org-wide cap projection the D8 deny-stub returns. */
const CAP_ORG_UNAVAILABLE: CapOrgProjectionResult = {
  status: "unavailable",
  aggregateProjectedCents: null,
  aggregateCapCents: null,
  pctOfCap: null,
  ipuWithinCap: null,
};

/**
 * The M26 `CapProjectionProvider` DENY-STUB (D8). Unlike `makeDenyStub`, this DEGRADES rather than throws:
 * every method resolves to a `status:"unavailable"` projection so the §11.A `aggregate_cap_projection` /
 * `ipu_cap_projection` rules fall back to `warn` severity. Replaced in place by M26's real reader at M26
 * lock, at which point the rules tighten to `error`. NEVER blocks claim submission while degraded.
 */
export function makeCapProjectionDenyStub(): CapProjectionProvider {
  return {
    projectionForPatient: async () => CAP_PATIENT_UNAVAILABLE,
    projectionForOrg: async () => CAP_ORG_UNAVAILABLE,
  };
}

/** The `MbiUnlockReader` DENY-STUB (§3.6) — fail-closed THROW (MBI must never degrade-open). */
export function makeMbiUnlockDenyStub(): MbiUnlockReader {
  return {
    unlockMbiForRequest: async () => {
      throw new Error(`${SEAM_NOT_BOUND}: MbiUnlockReader`);
    },
  };
}
