// apps/backend/src/modules/09-assessments/wounds — M9 longitudinal wounds: a patient has wounds, each visit adds dated
// observations, the visit note (M8) states the ones recorded at its encounter through the `WoundProvider` seam.
export { type WoundRouteDeps, registerWoundRoutes } from "./routes";
export * from "./service";
export { createDbWoundService, type DbWoundServiceOptions } from "./service-db";
export {
  createInMemoryWoundService,
  type InMemoryWoundBackend,
  type InMemoryWoundOptions,
} from "./service-memory";
export {
  type WoundProviderStore,
  type WoundSeamRegistrar,
  createDrizzleWoundProviderStore,
  createInMemoryWoundProviderStore,
  createWoundProvider,
  registerWoundSeam,
  toWoundObservationView,
} from "./seam";
export { type WoundEraseCounts, eraseWoundSubtree } from "./erase";
export {
  type WoundPatientReader,
  seamWoundPatientReader,
  woundPatientReaderOver,
} from "./patient-exists";
export type { WoundObservationRecord, WoundRecord } from "./projection";
