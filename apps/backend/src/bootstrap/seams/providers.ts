// apps/backend/src/bootstrap/seams/providers.ts — DENY-STUB seam implementations +
// the Phase-1 module-registration hook.
//
// This is the "deny-stub" home (PHASE_0_SCAFFOLD_PLAN.md PR-0.4): code stubs, NOT manifest
// edges. Each required seam has a deny-stub whose every method throws NotImplementedError.
// REQUIRED_SEAMS (registry.ts) references these as its fail-closed defaults, and
// validateSeams() applies them for any seam no module registered (§3.18.3) — so an
// unregistered cross-module contract denies LOUDLY on call instead of failing open. The
// owning module (M5/M17 CaseloadProvider+PatientReader, M22 DocumentRenderer, M39
// ConsentEvaluator) overwrites its stub by calling registerSeam() in its own init();
// wireSeams() is where boot invokes those Phase-1 registrations.

import type {
  AdmissionCensusReader,
  AdmissionStatusReader,
  AuditorSessionMinter,
  CaseloadProvider,
  CertificationReader,
  DocumentRenderer,
  ElectionPeriodReader,
  FaceToFaceReader,
  LevelOfCareReader,
  PatientMutator,
  PatientReader,
  SeamName,
  SessionContextResolver,
} from "../interfaces";

export class NotImplementedError extends Error {
  constructor(seam: string) {
    super(`${seam}: Phase-0 deny-stub — not implemented until its owning module lands`);
    this.name = "NotImplementedError";
  }
}

export const caseloadDenyStub: CaseloadProvider = {
  isInCaseload() {
    throw new NotImplementedError("CaseloadProvider");
  },
  caseloadPatientIds() {
    throw new NotImplementedError("CaseloadProvider");
  },
};

export const patientReaderDenyStub: PatientReader = {
  findByMrn() {
    throw new NotImplementedError("PatientReader");
  },
  findByExternalMrn() {
    throw new NotImplementedError("PatientReader");
  },
  findBySsnLast4AndDob() {
    throw new NotImplementedError("PatientReader");
  },
  findByNameDobSex() {
    throw new NotImplementedError("PatientReader");
  },
  findByLooseName() {
    throw new NotImplementedError("PatientReader");
  },
  findById() {
    throw new NotImplementedError("PatientReader");
  },
};

export const patientMutatorDenyStub: PatientMutator = {
  apply() {
    throw new NotImplementedError("PatientMutator");
  },
};

export const documentRendererDenyStub: DocumentRenderer = {
  render() {
    throw new NotImplementedError("DocumentRenderer");
  },
};

export const sessionContextResolverDenyStub: SessionContextResolver = {
  resolveActor() {
    throw new NotImplementedError("SessionContextResolver");
  },
  resolveStepUpState() {
    throw new NotImplementedError("SessionContextResolver");
  },
};

export const auditorSessionMinterDenyStub: AuditorSessionMinter = {
  mintAuditorSession() {
    throw new NotImplementedError("AuditorSessionMinter");
  },
};

/**
 * Generic fail-closed deny-stub for a seam whose interface is too rich to live in the leaf
 * @wardenx/types (so M1 cannot name it here). Every property access yields a function that
 * throws NotImplementedError, so an unregistered such seam denies LOUDLY on its first call
 * rather than failing open. M38's `TerminologyProvider` is the first of these (M40's
 * MdmEntityProvider/BaaStatusProvider and M36's AlertEmitter follow the same shape).
 */
function denyingSeamProxy(seam: SeamName): unknown {
  return new Proxy(
    {},
    {
      get() {
        return () => {
          throw new NotImplementedError(seam);
        };
      },
    },
  );
}

/** M38 — version-aware terminology resolution. Denies until M38 registers the real provider. */
export const terminologyProviderDenyStub: unknown = denyingSeamProxy("TerminologyProvider");

/** M36 — event → rules/recipients/fan-out. Denies until M36 registers the real emitter (T06). */
export const alertEmitterDenyStub: unknown = denyingSeamProxy("AlertEmitter");

/** M36 — channel/message surface (DEK-encrypted bodies). Denies until M36 registers the real
 *  provider (its DB-backed impl lands with the routes/realtime tasks, M36-T07/T08). */
export const messagingProviderDenyStub: unknown = denyingSeamProxy("MessagingProvider");

/** M40 — master-data read surface (physician/facility/payer; merge-aware). Denies until M40
 *  registers the real provider (M40-T05). */
export const mdmEntityProviderDenyStub: unknown = denyingSeamProxy("MdmEntityProvider");

/** M40 — focused §7.7 BAA disclosure gate (as-of). Denies until M40 registers the real provider
 *  (M40-T06). M22/M28/M29 consume this before any PHI leaves the perimeter. */
export const baaStatusProviderDenyStub: unknown = denyingSeamProxy("BaaStatusProvider");

/** M39 — the §4.3 disclosure/redaction gate. Rich-seam pattern (interface in @wardenx/consent).
 *  Denies until M39 registers the real evaluator (M39-T05). Every PHI-egress module consumes it. */
export const consentEvaluatorDenyStub: unknown = denyingSeamProxy("ConsentEvaluator");

// M6 (Admission) reader seams (§4.7). These are LEAF-TYPED (interfaces in @wardenx/types), so —
// unlike the opaque rich-seams above — they get concrete typed deny-stubs (like CaseloadProvider /
// PatientReader). Each denies LOUDLY until M6 registers the real Drizzle-backed reader (M6-T05).

/** M6 — election-period reads (M23 NOE/NOTR window math). Denies until M6 registers the real reader. */
export const electionPeriodReaderDenyStub: ElectionPeriodReader = {
  findActivePeriodForPatient() {
    throw new NotImplementedError("ElectionPeriodReader");
  },
  listPeriodsForAdmission() {
    throw new NotImplementedError("ElectionPeriodReader");
  },
};

/** M6 — CTI recert-gating reads. Denies until M6 registers the real reader. */
export const certificationReaderDenyStub: CertificationReader = {
  getActiveCertification() {
    throw new NotImplementedError("CertificationReader");
  },
  isCertificationSignedForPeriod() {
    throw new NotImplementedError("CertificationReader");
  },
};

/** M6 — F2F recert-gating reads. Denies until M6 registers the real reader. */
export const faceToFaceReaderDenyStub: FaceToFaceReader = {
  getAttestedF2fForPeriod() {
    throw new NotImplementedError("FaceToFaceReader");
  },
  isF2fAttestedForPeriod() {
    throw new NotImplementedError("FaceToFaceReader");
  },
};

/** M6 — level-of-care reads (current LOC + LOC-days, M26 cap). Denies until M6 registers the reader. */
export const levelOfCareReaderDenyStub: LevelOfCareReader = {
  getCurrentLevelOfCare() {
    throw new NotImplementedError("LevelOfCareReader");
  },
  getLevelOfCareDays() {
    throw new NotImplementedError("LevelOfCareReader");
  },
};

/** M6 — admission-status projection (M14/M30 queues). Denies until M6 registers the real reader. */
export const admissionStatusReaderDenyStub: AdmissionStatusReader = {
  getAdmissionSummary() {
    throw new NotImplementedError("AdmissionStatusReader");
  },
};

/** M6 — active-admission census/list. Denies until M6 registers the real reader. */
export const admissionCensusReaderDenyStub: AdmissionCensusReader = {
  listActiveAdmissions() {
    throw new NotImplementedError("AdmissionCensusReader");
  },
};

/**
 * Boot hook for Phase-1 seam registration. Each producer module registers its REAL seam
 * implementation here (or from its own init), e.g. M5 `registerSeam("CaseloadProvider", …)`.
 * M1 (this file) may not import a downstream module, so the actual producer registrations
 * are driven from the composition root (apps/backend/src/index.ts `wireModuleSeams`) via the
 * `registerModuleSeams` boot hook — which runs after this no-op and before validateSeams().
 * For any seam still unregistered, `validateSeams()` applies the REQUIRED_SEAMS deny-stub
 * default, leaving it wired FAIL-CLOSED (present, but throwing on call). This hook still runs
 * in the boot sequence so the M1-local wiring site stays explicit.
 */
export function wireSeams(): void {
  // Phase 1 producer registrations driven from the composition root, ahead of validateSeams():
  //   M2 registerIdentitySeams()  →  registerSeam("SessionContextResolver" | "AuditorSessionMinter", …)
  //   M5 registerSeam("CaseloadProvider" | "PatientReader", …)
  //   M22 registerSeam("DocumentRenderer", …) · M39 registerSeam("ConsentEvaluator", …)
}
