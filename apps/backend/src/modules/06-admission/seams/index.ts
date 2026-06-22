// apps/backend/src/modules/06-admission/seams — M6's published §4.7 reader seams (M6-T05). M6
// publishes SIX leaf-typed read-only DTO surfaces every downstream clinical/billing module consumes
// instead of importing M6's schema (architecture §11 blocks the schema import): ElectionPeriodReader
// (M23), CertificationReader + FaceToFaceReader (recert gating), LevelOfCareReader (M26 cap),
// AdmissionStatusReader (M14 queues) + AdmissionCensusReader (M30 dashboards). `registerAdmissionSeams`
// registers all six real readers over their boot deny-stubs (before validateSeams()), driven from the
// composition root's wireModuleSeams(). The readers are pure orchestration over an injected
// AdmissionReaderStore (in-memory slice here; Drizzle in prod, reads under the consumer's RLS).
import type {
  AdmissionCensusReader,
  AdmissionStatusReader,
  CertificationReader,
  ElectionPeriodReader,
  FaceToFaceReader,
  LevelOfCareReader,
} from "@wardenx/types";
import { getSeam, registerSeam } from "../../../bootstrap/index";
import {
  createAdmissionCensusReader,
  createAdmissionStatusReader,
  createCertificationReader,
  createElectionPeriodReader,
  createFaceToFaceReader,
  createLevelOfCareReader,
} from "./readers";
import { type AdmissionReaderStore, createInMemoryAdmissionReaderStore } from "./store";

export {
  type AdmissionReaderStore,
  type AdmissionReaderSeed,
  type ElectionPeriodRecord,
  createInMemoryAdmissionReaderStore,
  toActiveElectionPeriod,
  toCensusEntry,
  toElectionPeriodSummary,
} from "./store";
export {
  AdmissionNotFoundError,
  createAdmissionCensusReader,
  createAdmissionStatusReader,
  createCertificationReader,
  createElectionPeriodReader,
  createFaceToFaceReader,
  createLevelOfCareReader,
} from "./readers";

/** Deps for M6's reader-seam registration (slice defaults to the in-memory store). */
export interface AdmissionSeamDeps {
  /** The §4.7 data port (Drizzle over M6's tables in prod; in-memory slice in tests). */
  store?: AdmissionReaderStore;
}

/**
 * Register every M6 §4.7 reader seam into the M1 registry over its boot deny-stub (M6-T05; before
 * validateSeams()). All six share one {@link AdmissionReaderStore} so a single Drizzle adapter backs
 * the whole admission read surface. Called by the composition root's wireModuleSeams().
 */
export function registerAdmissionSeams(deps: AdmissionSeamDeps = {}): void {
  const store = deps.store ?? createInMemoryAdmissionReaderStore().store;
  registerSeam("ElectionPeriodReader", createElectionPeriodReader(store));
  registerSeam("CertificationReader", createCertificationReader(store));
  registerSeam("FaceToFaceReader", createFaceToFaceReader(store));
  registerSeam("LevelOfCareReader", createLevelOfCareReader(store));
  registerSeam("AdmissionStatusReader", createAdmissionStatusReader(store));
  registerSeam("AdmissionCensusReader", createAdmissionCensusReader(store));
}

/** Typed resolver for M6's ElectionPeriodReader (sound: registered real impl; validateSeams guards it). */
export function getElectionPeriodReader(): ElectionPeriodReader {
  return getSeam("ElectionPeriodReader");
}

/** Typed resolver for M6's CertificationReader. */
export function getCertificationReader(): CertificationReader {
  return getSeam("CertificationReader");
}

/** Typed resolver for M6's FaceToFaceReader. */
export function getFaceToFaceReader(): FaceToFaceReader {
  return getSeam("FaceToFaceReader");
}

/** Typed resolver for M6's LevelOfCareReader. */
export function getLevelOfCareReader(): LevelOfCareReader {
  return getSeam("LevelOfCareReader");
}

/** Typed resolver for M6's AdmissionStatusReader. */
export function getAdmissionStatusReader(): AdmissionStatusReader {
  return getSeam("AdmissionStatusReader");
}

/** Typed resolver for M6's AdmissionCensusReader. */
export function getAdmissionCensusReader(): AdmissionCensusReader {
  return getSeam("AdmissionCensusReader");
}
