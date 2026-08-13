import type { DbClient } from "@wardenx/db";
import type {
  PatientAddressReader,
  PatientCoverageReader,
  PatientMutator,
  PatientReader,
} from "@wardenx/types";
import { getSeam, registerSeam } from "../../../bootstrap/index";
// apps/backend/src/modules/05-patient/seams — M5's published cross-module seams (M5-T07/T08).
// M5 closes THREE M3/Wave-A boot-gate deny-stubs, all required by validateSeams(): CaseloadProvider
// (§4.1, T07 — also wires the `caseload_membership` ABAC predicate), PatientReader (§4.8, T08), and
// PatientMutator (§4.9, T08). `registerPatientSeams` registers them all from the composition root.
import { buildPatientAddressReader } from "../address-reader";
import { buildPatientCoverageReader } from "../coverage-reader";
import { type CareTeamSeamDeps, registerCareTeamSeam } from "./care-team-provider";
import { type CaseloadSeamDeps, registerCaseloadSeam } from "./caseload-provider";
import {
  type PatientMutatorStore,
  createInMemoryPatientMutatorStore,
  createPatientMutator,
} from "./patient-mutator";
import {
  type PatientReaderStore,
  createInMemoryPatientReaderStore,
  createPatientReader,
} from "./patient-reader";

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
  type CareTeamStore,
  type CareTeamSeamDeps,
  type SeedCareTeamAssignment,
  createCareTeamProvider,
  createInMemoryCareTeamStore,
  registerCareTeamSeam,
  getCareTeamProvider,
} from "./care-team-provider";
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
export {
  type DrizzlePatientMutatorStoreDeps,
  createDrizzleCaseloadStore,
  createDrizzleCareTeamStore,
  createDrizzlePatientMutatorStore,
  createDrizzlePatientReaderStore,
} from "./drizzle-stores";

/** Deps for M5's seam registration (slice defaults to in-memory stores). */
export interface PatientSeamDeps {
  caseload?: CaseloadSeamDeps;
  careTeam?: CareTeamSeamDeps;
  /** PatientReader data port (Drizzle in prod; in-memory slice). */
  readerStore?: PatientReaderStore;
  /** PatientMutator data port (Drizzle in prod; in-memory slice). */
  mutatorStore?: PatientMutatorStore;
  /** Drizzle client — presence registers the §3.4 PatientCoverageReader over the real coverage rows. */
  db?: DbClient;
}

/**
 * Register every M5 published seam into the M1 registry (M5-T07/T08; before validateSeams()), so the
 * three boot-gate deny-stubs (CaseloadProvider / PatientReader / PatientMutator) are replaced by real
 * impls — all three are required by validateSeams(). Called by the composition root's wireModuleSeams().
 */
export function registerPatientSeams(deps: PatientSeamDeps = {}): void {
  registerCaseloadSeam(deps.caseload);
  registerCareTeamSeam(deps.careTeam);
  // §3.4 — the coverage read M23/M24 resolve a claim's billed payer from. Registered ONLY when a db is
  // present: without one there is no coverage data to project, and the deny-stub's loud failure is the
  // honest answer (an empty coverage list would read as "this patient has no insurance").
  if (deps.db) registerSeam("PatientCoverageReader", buildPatientCoverageReader(deps.db));
  // TASK-015/ARCH-018 — the M31 two-party-recording-consent residence-state read. Same posture as
  // PatientCoverageReader: registered only with a db present, since there is no address data to read
  // without one and the deny-stub's loud failure is honest (the ABAC predicate already fails closed
  // on an unreadable residence — see the interface doc).
  if (deps.db) registerSeam("PatientAddressReader", buildPatientAddressReader(deps.db));
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

/** Typed resolver for M5's §3.4 PatientCoverageReader seam (the billing payer-resolution read). */
export function getPatientCoverageReader(): PatientCoverageReader {
  return getSeam("PatientCoverageReader");
}

/** Typed resolver for M5's PatientAddressReader seam (the M31 two-party-recording-consent read). */
export function getPatientAddressReader(): PatientAddressReader {
  return getSeam("PatientAddressReader");
}

/** Typed resolver for M5's PatientMutator seam. */
export function getPatientMutator(): PatientMutator {
  return getSeam("PatientMutator");
}
