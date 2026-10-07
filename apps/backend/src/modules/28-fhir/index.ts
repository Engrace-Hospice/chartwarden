// apps/backend/src/modules/28-fhir — the FHIR Gateway backend module (M28).
//
// M28-T06 landed the seam boundary (published/consumed). M28-T08 adds the HTTP surface: the thirty-nine
// §4.1 routes (the FHIR-spec bearer surface + the admin console), the twelve §4.6 permission keys, the six
// §4.7 ABAC predicates + their Drizzle resolver, the W-FHIR-12 revocation cascade, the route-facing Drizzle
// store (+ in-memory for tests), the Drizzle published-seam store, and the §3.7 `fhir_gateway` eraser.
// `fhir.write` stays OFF: the gateway is read-only US Core R4.
export * from "./seams/index";
export { createDrizzleFhirPublishedSeamStore } from "./seams/published-store-drizzle";
export { M28_OUTBOX_EVENTS } from "./events-by-m28";
export {
  type M28ContributedPermissionKey,
  type M28PermissionKey,
  M28_CONTRIBUTED_PERMISSIONS,
  M28_PERMISSION_KEY_LIST,
  M28_STEP_UP_PERMISSION_KEYS,
} from "./permission-keys";
export {
  type FhirBulkExportJobAbacFacts,
  type FhirClientActiveFacts,
  type FhirGatewayAbacDeps,
  type FhirGatewayAbacResolver,
  type M28RegisteredAbacPredicate,
  FHIR_BULK_EXPORT_CANCEL_PERMISSION,
  FHIR_OWNER_MODULE_WRITE_PERMISSION,
  M28_FHIR_ABAC_PREDICATES,
  buildFhirGatewayAbacPredicates,
  denyStubFhirGatewayAbacResolver,
  registerFhirGatewayAbacPredicates,
} from "./abac-predicates";
export {
  type FhirBaaStatusPort,
  type FhirConsentDisclosurePort,
  type FhirEffectivePermissionReader,
  type FhirGatewayAbacDrizzleDeps,
  buildDrizzleFhirGatewayAbacResolver,
} from "./abac-resolver-drizzle";
export {
  type FhirGatewayEraseStore,
  type FhirGatewayEraserDeps,
  createDrizzleFhirGatewayEraseStore,
  createFhirGatewayEraser,
  createInMemoryFhirGatewayEraseStore,
  registerFhirGatewayEraser,
} from "./erasers/fhir-eraser";
export {
  mountM28Routes,
  createDrizzleFhirGatewayStore,
  createInMemoryFhirGatewayStore,
  cascadeClientRevocation,
  FhirStoreError,
  NOOP_FHIR_OUTBOX,
  mintFhirJti,
  type FhirDisclosureAuditPort,
  type FhirGatewayStore,
  type FhirGatewayStoreDeps,
  type FhirRevocationCascadePort,
  type FhirRevocationCascadeResult,
  type FhirWriteOutboxPort,
  type M28RouteServices,
  type FhirAssertionReplayGuard,
  type FhirJwksFetcher,
  type FhirReplayRedis,
  createHttpFhirJwksFetcher,
  createInMemoryFhirClientRateLimiter,
  createInMemoryFhirReplayGuard,
  createRedisFhirClientRateLimiter,
  createRedisFhirReplayGuard,
  sampleFhirBaaCoverage,
  warnOnFhirBaaGap,
} from "./routes/index";
// GAP-084 — the §4.8 BullMQ workers (bulk export + sweeper, inbound SLA watch + payload destruction, client
// session sweeper), their ports and queue catalog.
export {
  type ActiveOrgListPort as FhirActiveOrgListPort,
  type BulkExportEnqueuePort,
  type BulkExportOutcome,
  type BulkExportWorkerDeps,
  type ExportPatientEnumeratorPort,
  type FhirAlertPort,
  type FhirDisclosureSink,
  type FhirExportObjectStore,
  type FhirJobBaaPort,
  type FhirJobOutboxPort,
  type M28WorkerDeps,
  M28_JOB_SCHEDULES,
  M28_PLATFORM_JOB_ID,
  M28_QUEUES,
  type CapabilitySnapshotDeps,
  buildBulkExportEnqueuePort,
  buildFhirExportObjectStore,
  registerM28Workers,
  runBulkExportJob,
  runCapabilitySnapshotValidator,
  runBulkExportSweeper,
  runClientSessionSweeper,
  runInboundPayloadDestruction,
  runInboundSlaWatch,
  scheduleM28Jobs,
  wireM28Tenancy,
} from "./jobs/index";
export {
  CAPABILITY_RELEASE_TAG,
  buildGatewayCapabilityStatement,
} from "./routes/capability-statement";
