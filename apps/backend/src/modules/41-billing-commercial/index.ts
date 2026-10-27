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
export {
  type CommercialClaimReader,
  buildCommercialClaimReader,
  registerM41PublishedSeams,
} from "./services/remittance-match-seam";
export { buildCommercialClaimAssemblyService, resolveCoverages } from "./services/claim-assembly";
export type {
  AssembledCommercialClaim,
  CommercialClaimAssemblyService,
} from "./services/claim-assembly";
export { buildCommercialClaimLifecycleService } from "./services/claim-lifecycle";
export type { CommercialClaimLifecycleService, ReadyResult } from "./services/claim-lifecycle";
export {
  type ClaimSendGateInput,
  type ClaimSendGateResult,
  type SendGateReason,
  evaluateClaimSendGate,
} from "./services/claim-send-gate";
export {
  type CommercialClearinghouseBinding,
  type CommercialSubmissionService,
  type SendGateView,
  type SubmissionView,
  type TimelineView,
  buildCommercialSubmissionService,
} from "./services/submission-service";
export {
  type SubmissionWorkerDeps,
  registerM41SubmissionWorker,
  runSubmissionDrain,
  scheduleM41Jobs,
} from "./jobs/submission-worker";
export {
  type AckWorkerDeps,
  createDrizzleAckCursorStore,
  registerM41AckWorker,
  runAckPull,
  scheduleM41AckJobs,
} from "./jobs/ack-worker";
export {
  type QuarantinePruneDeps,
  registerM41QuarantinePruneWorker,
  runQuarantinePrune,
  scheduleM41QuarantinePrune,
} from "./jobs/quarantine-prune";
export { transitionForAck } from "./domain/ack-transition";
export { transitionForRemittance } from "./domain/remittance-transition";
export {
  type M41RemittanceConsumerDeps,
  type M41RemittanceOutboxPort,
  type M41RemittanceSkipReason,
  buildM41RemittanceConsumer,
} from "./outbox-consumers/m25-remittance";
export {
  abandonForeignHeldEvents,
  applyAckEvent,
  heldQuarantineReport,
  listHeldRows,
  resolveHeldRowByOperator,
  outstanding as outstandingAckWork,
  replayHeldEvents,
} from "./jobs/ack-worker";
export type { HeldQuarantineReport } from "./jobs/ack-held-replay";
export {
  ALWAYS_READY,
  type DrainReadiness,
  createDrainReadiness,
  createSharedDrainReadiness,
  scheduleWithRetry,
} from "./jobs/readiness";
export { type ScheduleProbe, createScheduleProbe } from "./jobs/schedule-probe";
export { M41_CRON_QUEUES, M41_PLATFORM_JOB_ID, wireM41Tenancy } from "./jobs/queues";
export { buildCommercialRenderPorts } from "./services/render-ports";
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
export { registerCommercialAckQuarantineRoutes } from "./routes/ack-quarantine.routes";
export type { AckApplyDeps } from "./jobs/ack-apply";
export type { CommercialBillingRouteDeps } from "./routes/commercial-billing.routes";
export { buildCommercialClaimReadService } from "./services/claim-read-service";
export type { CommercialClaimReadService } from "./services/claim-read-service";
export { M41_CONTRIBUTED_PERMISSIONS, type M41ContributedPermissionKey } from "@chartwarden/auth";
// apps/backend/src/modules/41-billing-commercial - Billing - Commercial (ADR-0100). #724 lands eligibility (270/271) and enrollment.
export {
  createCommercialAdminService,
  type CommercialAdminService,
} from "./eligibility/admin-service";
export { buildCommercialContextPort } from "./eligibility/context";
export {
  type EligibilityFreshnessFinding,
  type EligibilityFreshnessInput,
  type EligibilityFreshnessSeverity,
  type EligibilityFreshnessStatus,
  type LatestEligibilityCheck,
  evaluateEligibilityFreshness,
} from "./eligibility/freshness";
export {
  type SendGateInput,
  type SendGateResult,
  evaluateSendGate,
} from "./eligibility/send-gate";
export {
  type CheckEligibilityArgs,
  type EligibilityCheckView,
  type EligibilityService,
  createEligibilityService,
} from "./eligibility/service";
export { buildDrizzleEligibilityStore } from "./eligibility/store-drizzle";
export type { EligibilityStore } from "./eligibility/store";
export { CommercialRefusalError } from "./errors";
export { type M41RouteServices, mountM41Routes } from "./routes/mount";
