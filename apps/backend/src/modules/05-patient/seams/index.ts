// apps/backend/src/modules/05-patient/seams — M5's published cross-module seams (M5-T07/T08).
// M5 closes THREE M3/Wave-A boot-gate deny-stubs, all required by validateSeams(): CaseloadProvider
// (§4.1, T07 — also wires the `caseload_membership` ABAC predicate), PatientReader (§4.8, T08), and
// PatientMutator (§4.9, T08). `registerPatientSeams` registers them all from the composition root.
import { type CaseloadSeamDeps, registerCaseloadSeam } from "./caseload-provider";
import {
  type PatientReaderStore,
  createInMemoryPatientReaderStore,
  createPatientReader,
} from "./patient-reader";
import {
  type PatientMutatorStore,
  createInMemoryPatientMutatorStore,
  createPatientMutator,
} from "./patient-mutator";
import { registerSeam, getSeam } from "../../../bootstrap/index";
import type { PatientMutator, PatientReader } from "@wardenx/types";

export {
  type CaseloadStore,
  type CaseloadSeamDeps,
  type SeedAssignment,
  CASELOAD_MEMBERSHIP_PREDICATE,
  createCaseloadProvider,
  createInMemoryCaseloadStore,
  registerCaseloadSeam,
  getCaseloadProvider,
} from "./caseload-provider";
export {
  type PatientReaderStore,
  MAX_MERGE_HOPS,
  createPatientReader,
  createInMemoryPatientReaderStore,
} from "./patient-reader";
export {
  type PatientMutatorStore,
  FORBIDDEN_PATCH_FIELDS,
  createPatientMutator,
  createInMemoryPatientMutatorStore,
} from "./patient-mutator";

/** Deps for M5's seam registration (slice defaults to in-memory stores). */
export interface PatientSeamDeps {
  caseload?: CaseloadSeamDeps;
  /** PatientReader data port (Drizzle in prod; in-memory slice). */
  readerStore?: PatientReaderStore;
  /** PatientMutator data port (Drizzle in prod; in-memory slice). */
  mutatorStore?: PatientMutatorStore;
}

/**
 * Register every M5 published seam into the M1 registry (M5-T07/T08; before validateSeams()), so the
 * three boot-gate deny-stubs (CaseloadProvider / PatientReader / PatientMutator) are replaced by real
 * impls — all three are required by validateSeams(). Called by the composition root's wireModuleSeams().
 */
export function registerPatientSeams(deps: PatientSeamDeps = {}): void {
  registerCaseloadSeam(deps.caseload);
  registerSeam(
    "PatientReader",
    createPatientReader(deps.readerStore ?? createInMemoryPatientReaderStore().store),
  );
  registerSeam(
    "PatientMutator",
    createPatientMutator(deps.mutatorStore ?? createInMemoryPatientMutatorStore().store),
  );
}

/** Typed resolver for M5's PatientReader seam (sound: registered real impl, validateSeams guarantees it). */
export function getPatientReader(): PatientReader {
  return getSeam("PatientReader");
}

/** Typed resolver for M5's PatientMutator seam. */
export function getPatientMutator(): PatientMutator {
  return getSeam("PatientMutator");
}
