// apps/backend/src/modules/38-terminology/jobs — the §4.3 worker layer (GAP-108). See ./workers.
export * from "./queues";
export { createDbLoaderStore } from "./loader-store-db";
export { createDbEmbeddingStore, createDbExpansionWriter } from "./support-db";
export {
  DEFAULT_PLATFORM_BUCKET,
  type PlatformS3Slice,
  createPlatformObjectPort,
  createPlatformUploadSigner,
} from "./platform-objects";
export { type TerminologyProducer, buildTerminologyProducer } from "./producer";
export {
  type ActiveOrgList,
  type ScanProgress,
  type TenantScanDeps,
  type TenantScanResult,
  TENANT_DEPRECATION_ALERT_EVENT,
  runTenantDeprecationScanJob,
} from "./tenant-scan";
export {
  type M38WorkerDeps,
  SCHEDULED_OTHER_SYSTEMS,
  registerM38Workers,
  scheduleM38Jobs,
} from "./workers";
