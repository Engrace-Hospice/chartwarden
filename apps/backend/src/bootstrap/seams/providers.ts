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
  AuditorSessionMinter,
  CaseloadProvider,
  ConsentEvaluator,
  DocumentRenderer,
  PatientReader,
  SessionContextResolver,
} from "../interfaces";

export class NotImplementedError extends Error {
  constructor(seam: string) {
    super(`${seam}: Phase-0 deny-stub — not implemented until its owning module lands`);
    this.name = "NotImplementedError";
  }
}

export const caseloadDenyStub: CaseloadProvider = {
  patientsForActor() {
    throw new NotImplementedError("CaseloadProvider");
  },
};

export const patientReaderDenyStub: PatientReader = {
  exists() {
    throw new NotImplementedError("PatientReader");
  },
};

export const documentRendererDenyStub: DocumentRenderer = {
  render() {
    throw new NotImplementedError("DocumentRenderer");
  },
};

export const consentEvaluatorDenyStub: ConsentEvaluator = {
  evaluateForDisclosure() {
    throw new NotImplementedError("ConsentEvaluator");
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
