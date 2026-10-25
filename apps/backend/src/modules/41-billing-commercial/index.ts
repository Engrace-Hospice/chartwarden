// apps/backend/src/modules/41-billing-commercial — Module 41 "Billing — Commercial" (ADR-0100). The public surface other code
// (the composition root in apps/backend/src/index.ts) imports. Built so far: payer plan model (#721) and claim assembly,
// validation, pre-authorization, coordination of benefits and audited overrides (#722). Submission, eligibility and
// remittance matching land with their own issues.
export { M41_OUTBOX_EVENTS } from "./events-by-m41";
export { buildCommercialAuthorizationService } from "./services/authorization-service";
export type {
  AuthorizationView,
  CommercialAuthorizationService,
  RecordAuthorizationInput,
} from "./services/authorization-service";
export { buildCommercialClaimAssemblyService, resolveCoverages } from "./services/claim-assembly";
export type {
  AssembledCommercialClaim,
  CommercialClaimAssemblyService,
} from "./services/claim-assembly";
export { buildCommercialClaimLifecycleService } from "./services/claim-lifecycle";
export type { CommercialClaimLifecycleService, ReadyResult } from "./services/claim-lifecycle";
export { buildCommercial837iRenderer } from "./services/render-837i";
export type {
  CommercialRenderParties,
  CommercialRenderPorts,
  CommercialSubscriberIdentity,
  Render837iResult,
} from "./services/render-837i";
export type {
  AssembleCommercialClaimInput,
  CommercialActor,
  CommercialAuditPort,
  CommercialClaimSeams,
  CommercialOutboxPort,
} from "./services/types";
export {
  M41_REGISTERED_ABAC_PREDICATES,
  buildCommercialAbacPredicates,
  registerM41AbacPredicates,
} from "./abac-predicates";
export { registerCommercialBillingRoutes } from "./routes/commercial-billing.routes";
export type { CommercialBillingRouteDeps } from "./routes/commercial-billing.routes";
export { buildCommercialClaimReadService } from "./services/claim-read-service";
export type { CommercialClaimReadService } from "./services/claim-read-service";
export { M41_CONTRIBUTED_PERMISSIONS, type M41ContributedPermissionKey } from "@chartwarden/auth";
