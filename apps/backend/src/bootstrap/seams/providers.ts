// apps/backend/src/bootstrap/seams/providers.ts — Phase 0 DENY-STUB providers.
//
// This is the correct home for the "deny-stub" concept (PHASE_0_SCAFFOLD_PLAN.md PR-0.4):
// code stubs, NOT manifest edges. Each required seam is registered with an implementation
// that throws NotImplementedError, so validateSeams() passes at boot (the contract is
// present) while any actual call fails loudly until the owning module replaces the stub
// with real behavior in Phase 1.

import type {
  CaseloadProvider,
  ConsentEvaluator,
  DocumentRenderer,
  PatientReader,
} from "../interfaces";
import { registerSeam } from "./registry";

export class NotImplementedError extends Error {
  constructor(seam: string) {
    super(`${seam}: Phase-0 deny-stub — not implemented until its owning module lands`);
    this.name = "NotImplementedError";
  }
}

const caseloadDenyStub: CaseloadProvider = {
  patientsForActor() {
    throw new NotImplementedError("CaseloadProvider");
  },
};

const patientReaderDenyStub: PatientReader = {
  exists() {
    throw new NotImplementedError("PatientReader");
  },
};

const documentRendererDenyStub: DocumentRenderer = {
  render() {
    throw new NotImplementedError("DocumentRenderer");
  },
};

const consentEvaluatorDenyStub: ConsentEvaluator = {
  evaluateForDisclosure() {
    throw new NotImplementedError("ConsentEvaluator");
  },
};

/** Register all Phase-0 deny-stubs. Real modules overwrite these at their own init. */
export function wireSeams(): void {
  registerSeam("CaseloadProvider", caseloadDenyStub);
  registerSeam("PatientReader", patientReaderDenyStub);
  registerSeam("DocumentRenderer", documentRendererDenyStub);
  registerSeam("ConsentEvaluator", consentEvaluatorDenyStub);
}
