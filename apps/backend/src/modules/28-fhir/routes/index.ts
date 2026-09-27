// apps/backend/src/modules/28-fhir/routes/index.ts — M28 route surface barrel.
export {
  mountM28Routes,
  registerAdminClientRoutes,
  registerAdminConfigRoutes,
  registerAdminExportRoutes,
  registerAdminInboundRoutes,
  registerFhirR4Routes,
  type AdminClientsRouteDeps,
  type AdminConfigRouteDeps,
  type AdminExportRouteDeps,
  type AdminInboundRouteDeps,
  type FhirR4RouteDeps,
  type FhirDisclosureAuditPort,
  type M28RouteServices,
  type FhirAssertionReplayGuard,
  type FhirJwksFetcher,
  type FhirReplayRedis,
  type FhirServedResource,
  SERVED_RESOURCES,
  createHttpFhirJwksFetcher,
  createInMemoryFhirReplayGuard,
  createRedisFhirReplayGuard,
  mintFhirToken,
  projectResourceById,
  projectSearch,
} from "./mount";
export {
  type M28ReadActor,
  type M28WriteActor,
  type PreHandler,
  actorOf,
  writeActorOf,
} from "./actor";
export {
  ABAC_BULK_EXPORT_CANCEL,
  ABAC_CLIENT_ORG,
  ABAC_INBOUND_OWNER_MATCH,
  ABAC_IN_ORG,
  P,
  STEP_UP,
} from "./guards";
export {
  FHIR_JSON_CONTENT_TYPE,
  operationOutcome,
  sendOutcome,
  type FhirOperationOutcome,
} from "./operation-outcome";
export {
  cascadeClientRevocation,
  type FhirRevocationCascadePort,
  type FhirRevocationCascadeResult,
} from "./revocation-cascade";
export {
  FhirStoreError,
  NOOP_FHIR_OUTBOX,
  createInMemoryFhirGatewayStore,
  type CreateClientArgs,
  type FhirBearerContext,
  type FhirBulkExportJobView,
  type FhirClientCreateResult,
  type FhirCredentialRotationResult,
  type FhirGatewayStore,
  type FhirInboundProposalView,
  type FhirSessionSummary,
  type FhirTenantConfigView,
  type FhirWriteOutboxPort,
  type InMemoryFhirGatewaySeed,
} from "./store";
export {
  createDrizzleFhirGatewayStore,
  mintFhirJti,
  type FhirGatewayStoreDeps,
} from "./store-drizzle";
export { parse, parseQuery } from "./m28-typebox";
