import { createHash, randomUUID } from "node:crypto";
import { auditPlatformEvent } from "@wardenx/audit";
// @wardenx/backend — Fastify host entry + COMPOSITION ROOT (not in any module codePath, so
// exempt from the module-boundary import rules — it may import every module's init). It builds
// the server, runs the seam/eraser boot gate, and registers each Phase-1 module's real seams
// via `wireModuleSeams` (M1's bootstrap cannot import a downstream module; the composition
// root does, then hands the registration into the boot gate before validateSeams()).
import {
  createCredentialThrottle,
  createDbActorEnrichmentReader,
  createDbAdminMembershipReader,
  createDbEffectivePermissionStore,
  createDbSessionContextStore,
  createIdentityAuth,
  createInMemoryFailedLoginStore,
  getIdentitySession,
  registerAbacRegistry,
  registerDbEffectivePermissionResolver,
  registerIdentityAuth,
} from "@wardenx/auth";
import type { RbacEngineHandle, SessionContextStore } from "@wardenx/auth";
import { type DbClient, createDbClient, schema } from "@wardenx/db";
import { createUnboundIqiesAdapter } from "@wardenx/iqies-client";
import type { AlertEmitter } from "@wardenx/messaging";
import type { PlatformBypassAuditor } from "@wardenx/tenancy";
import {
  registerPlatformJob,
  withOrgContext,
  withPlatformContext,
} from "@wardenx/tenancy";
import { DegradedError, WardenXError } from "@wardenx/types";
import type { AdmissionStatusReader } from "@wardenx/types";
import { createX12835Client } from "@wardenx/x12-835-client";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import Redis, { type RedisOptions } from "ioredis";
import { buildActiveOrgEnumerator } from "./bootstrap/active-org-enumerator";
import {
  attachDlqPromotionAlert,
  buildDlqPromotionSink,
} from "./bootstrap/dlq-alerts";
import {
  createDrizzleFeatureFlagAdmin,
  createDrizzleFeatureFlagReader,
} from "./bootstrap/feature-flag-store";
import {
  DEFAULT_RATE_LIMIT_TIERS,
  assertNoInMemoryBindingsOnDbBoot,
  assertProductionEnv,
  buildServer,
  createSessionAuthenticate,
  getSeam,
  noteInMemoryBinding,
  registerEraser,
  registerSeam,
} from "./bootstrap/index";
import {
  PARTITION_ROTATION_CRON,
  PARTITION_ROTATION_QUEUE,
  classifyPartitionCoverage,
  readPartitionCoverage,
  runPartitionRotation,
  summarizeRotation,
  wirePartitionRotationTenancy,
} from "./bootstrap/jobs/partition-rotation";
import {
  m34ActiveMembershipUserId,
  m34SoleTenantUserIds,
} from "./bootstrap/m34-identity-shred-subjects";
import {
  buildMetricsRegistry,
  mountMetricsRoute,
  registerBullMQQueueMetrics,
  registerHttpMetrics,
  registerOutboxMetrics,
  registerPartitionMetrics,
} from "./bootstrap/metrics";
import { wireOrganizationSettingsRegistry } from "./bootstrap/organization-settings-persister";
import {
  M1_OUTBOX_DISPATCHER_JOB_ID,
  type OutboxDispatcher,
  createOutboxDispatcher,
} from "./bootstrap/outbox-dispatcher";
import {
  type OutboxPublishPort,
  type OutboxTx,
  buildBootOutboxCatalog,
  buildTxOutboxPublisher,
  wireOutboxCatalog,
} from "./bootstrap/outbox-persister";
import { createDbIdempotencyStore } from "./bootstrap/plugins/idempotency-store-db";
import {
  createBudgetedRateLimiter,
  createInMemoryRateLimitStore,
  createRedisFailedLoginStore,
  createRedisRateLimitStore,
} from "./bootstrap/plugins/rate-limit-store";
import {
  buildOrgProviderEntityLister,
  buildPrimaryProviderEntityResolver,
  buildProviderEntityCcnResolver,
  buildProviderEntityLocationLister,
  buildProviderEntityOrgCheck,
} from "./bootstrap/provider-entity-resolver";
import { buildReadinessProbe } from "./bootstrap/readiness-probe";
import { registerLocationLookupRoutes } from "./bootstrap/routes/locations";
import { registerProviderEntityLookupRoutes } from "./bootstrap/routes/provider-entities";
import { buildSoleTenantUserResolver } from "./bootstrap/sole-tenant-user-resolver";
import { createPlatformKekAdapter, loadPlatformKekRing } from "./bootstrap/tenant-kek";

/** The @wardenx/tenancy platform-job id M36's D9 sole-tenant membership read runs under. */
const M36_SOLE_TENANT_JOB_ID = "m36-sole-tenant-resolver";
const M8_PLATFORM_JOB_ID = "m8-encounter-automation";
const M17_PLATFORM_JOB_ID = "m17-scheduling-automation";
// AC-04 — the sentinel the `/ready` object-store check HEADs. Neither the bucket nor the key is
// expected to exist: a 404 is the healthy answer, and the point is that the request COMPLETED
// (endpoint reachable, SigV4 accepted, credentials valid). Names are PHI-free and tenant-free by
// construction, so the probe can never touch a real tenant bucket (`tenant-<orgId>`).
const READINESS_PROBE_BUCKET = "wardenx-readiness";
const READINESS_PROBE_KEY = ".probe";
/** AC-05 — SECURITY_HARDENING §22.1: 5 signup intents per IP per hour on the public surface. */
const PUBLIC_SIGNUP_HOURLY_LIMIT = 5;
// M24 (WX-PR-011) — the per-state adapter registry + the Oregon launch-gateway (real+fake transport). Lives
// in @wardenx/medicaid-adapters (M24's `dependsOn` PURE-domain leaf), not the backend module barrel — mirrors
// how the M23 X12/MAC gateway lives inside the backend module instead (the one placement difference is that
// dependency-cruiser §25.14 requires Oregon's wire format/URL to stay INSIDE @wardenx/medicaid-adapters).
import {
  MedicaidAdapterRegistry,
  type PlaceOfServiceFacilityKind,
  type PlaceOfServiceResidenceKind,
  createM24OregonGateway,
  m24LaunchGatewayConfigFromEnv,
} from "@wardenx/medicaid-adapters";
// The §4.4 / M10-real HOPE consumer interface the M30 worker deps bind (composed from the three live M10
// §D10 readers via `getSeam` in the worker-runner block below).
import type { QualityHopeConsumer } from "@wardenx/quality";
import type { DsarDocumentUploadRequest } from "@wardenx/saas-tenant-platform";
import {
  M2_OUTBOX_EVENTS,
  createDrizzleIdentityEraserStore,
  mountDeviceAttestationRoutes,
  mountIdentityRoutes,
  mountOrganizationLifecycleRoutes,
  mountSessionStepUpRoutes,
  registerIdentityErasers,
  registerIdentitySeams,
} from "./modules/02-identity/index";
import {
  createDbProposedRoleAttacher,
  mountAuthorizationRoutes,
  registerAuthorizationAbacPredicates,
} from "./modules/03-authorization/index";
import {
  M4_OUTBOX_EVENTS,
  assertAuditActionCatalog,
  createDrizzleAuditEraserPorts,
  createDrizzleAuditEraserStore,
  mountAuditRoutes,
  registerAuditErasers,
} from "./modules/04-audit/index";
import { createM34DestructionWorkflow } from "./modules/04-audit/m34-destruction-workflow";
import {
  M5_OUTBOX_EVENTS,
  buildM5DeathCascadeConsumer,
  buildM29ProposalApplierConsumer,
  createDrizzleCareTeamStore,
  createDrizzleCaseloadStore,
  createDrizzlePatientEraseStore,
  createDrizzlePatientMutatorStore,
  createDrizzlePatientReaderStore,
  getPatientCoverageReader,
  getPatientReader,
  mountPatientRoutes,
  registerPatientErasers,
  registerPatientSeams,
} from "./modules/05-patient/index";
import { m34TenantPatientIds } from "./modules/05-patient/m34-shred-subjects";
import {
  M6_OUTBOX_EVENTS,
  M6_PLATFORM_JOB_ID,
  activeAdmissionDraftContextForPatient,
  admissionIsActiveForOrg,
  admissionSchedulingContextForOrg,
  buildM6DocumentBackrefConsumer,
  buildM6ProposalAcceptedConsumer,
  buildM6WorkerDeps,
  createDrizzleAdmissionEraseStore,
  createDrizzleAdmissionReaderStore,
  electionPeriodContextForOrg,
  mountAdmissionRoutes,
  registerAdmissionAbacPredicates,
  registerAdmissionErasers,
  registerAdmissionRoutes,
  registerAdmissionSeams,
  registerM6CronWorkers,
  scheduleM6Jobs,
  wireM6Tenancy,
} from "./modules/06-admission/index";
import {
  M7_OUTBOX_EVENTS,
  M7_PLATFORM_JOB_ID,
  buildM7AdmissionActivatedConsumer,
  buildM7AdmissionDischargedConsumer,
  buildM7IdgDecisionConsumer,
  buildM7WorkerDeps,
  createDbCarePlanAbacResolver,
  createDrizzleCarePlanEraseStore,
  createDrizzleCarePlanReaderStore,
  mountCarePlanRoutes,
  registerCarePlanAbacPredicates,
  registerCarePlanErasers,
  registerCarePlanRoutes,
  registerCarePlanSeams,
  registerM7CronWorkers,
  scheduleM7Jobs,
  wireM7Tenancy,
} from "./modules/07-care-plan/index";
import {
  M8_OUTBOX_EVENTS,
  buildM8VisitClosedConsumer,
  buildM8VisitPublishedConsumer,
  buildM8WorkerDeps,
  createDrizzleEncounterEraseStore,
  createDrizzleEncounterReaderStore,
  createHearthnoteCiphers,
  mountEncounterRoutes,
  registerEncounterAbacPredicates,
  registerEncounterErasers,
  registerEncounterRoutes,
  registerEncounterSeams,
  registerM8CronWorkers,
  scheduleM8Jobs,
} from "./modules/08-encounters/index";
import {
  M9_OUTBOX_EVENTS,
  M9_PLATFORM_JOB_ID,
  buildM9WorkerDeps,
  createDrizzleAssessmentEraseStore,
  createDrizzleAssessmentReaderStore,
  mountAssessmentRoutes,
  registerAssessmentAbacPredicates,
  registerAssessmentErasers,
  registerAssessmentRoutes,
  registerAssessmentSeams,
  registerM9CronWorkers,
  scheduleM9Jobs,
  wireM9Tenancy,
} from "./modules/09-assessments/index";
import {
  M10_OUTBOX_EVENTS,
  M10_PLATFORM_JOB_ID,
  buildM10AdmissionWorkflowConsumer,
  buildM10WorkerDeps,
  createDrizzleHopeEraseStore,
  mountHopeRoutes,
  registerHopeAbacPredicates,
  registerHopeErasers,
  registerHopeRoutes,
  registerHopeSeams,
  registerM10CronWorkers,
  scheduleM10Jobs,
  wireM10Tenancy,
} from "./modules/10-hope/index";
import {
  M11_OUTBOX_EVENTS,
  M11_PLATFORM_JOB_ID,
  buildM11DischargeCascadeConsumer,
  buildM11DocumentBackrefConsumer,
  buildM11IdgDecisionConsumer,
  createDbOrderBackend,
  createDrizzleOrderEraseStore,
  createDrizzleOrderSeamStore,
  createMedicationOrderSignatureCascade,
  mountOrderRoutes,
  registerM11StandingSpawnWorker,
  registerOrderAbacPredicates,
  registerOrderErasers,
  registerOrderRoutes,
  registerOrderSeams,
  scheduleM11StandingSpawn,
} from "./modules/11-orders/index";
import {
  M12_OUTBOX_EVENTS,
  buildM12DischargeCascadeConsumer,
  buildM12DocumentBackrefConsumer,
  buildM12IdgDecisionConsumer,
  createDrizzleDoseSpotSeamStore,
  createDrizzleMedicationOrderEraseStore,
  mountDoseSpotRoutes,
  registerDoseSpotAbacPredicates,
  registerDoseSpotErasers,
  registerDoseSpotRoutes,
  registerDoseSpotSeams,
} from "./modules/12-dosespot/index";
import {
  M13_OUTBOX_EVENTS,
  buildM13DocumentBackrefConsumer,
  createDrizzleEmarEraseStore,
  createDrizzleEmarSeamStore,
  mountEmarRoutes,
  registerEmarAbacPredicates,
  registerEmarErasers,
  registerEmarRoutes,
  registerEmarSeams,
} from "./modules/13-emar/index";
import {
  M14_OUTBOX_EVENTS,
  M14_PLATFORM_JOB_ID,
  buildM14ActionItemAutoCloseConsumer,
  buildM14WorkerDeps,
  createDrizzleIdgEraseStore,
  createDrizzleIdgSeamStore,
  mountIdgRoutes,
  registerIdgAbacPredicates,
  registerIdgErasers,
  registerIdgRoutes,
  registerIdgSeams,
  registerM14CronWorkers,
  scheduleM14Jobs,
  wireM14Tenancy,
} from "./modules/14-idg/index";
import {
  M15_OUTBOX_EVENTS,
  buildDrizzleDisciplinePlanAbacResolver,
  buildDrizzleM15ReadService,
  buildDrizzleM15WriteService,
  buildM15PlanBootstrapConsumer,
  createDrizzleDisciplinePlanEraseStore,
  createDrizzleDisciplinePlanSeamStore,
  denyStubDisciplinePlanAbacResolver,
  mountM15Routes,
  registerDisciplinePlanAbacPredicates,
  registerDisciplinePlanErasers,
  registerDisciplinePlanSeams,
} from "./modules/15-discipline-care-plans/index";
import {
  M16_OUTBOX_EVENTS,
  buildDrizzleBereavementAbacResolver,
  buildDrizzleM16ReadService,
  buildDrizzleM16WriteService,
  buildM16BereavementIntakeConsumer,
  buildM16IdgDecisionConsumer,
  createDrizzleBereavementEraseStore,
  createDrizzleBereavementSeamStore,
  denyStubBereavementAbacResolver,
  mountM16Routes,
  registerBereavementAbacPredicates,
  registerBereavementErasers,
  registerBereavementSeams,
} from "./modules/16-bereavement/index";
import {
  M17_OUTBOX_EVENTS,
  buildM17AdmissionLifecycleConsumer,
  buildM17CarePlanProposalConsumer,
  buildM17EncounterSignedConsumer,
  buildM17WorkerDeps,
  createDrizzleCredentialStore,
  createDrizzleSchedulingSeamStore,
  mountSchedulingRoutes,
  registerM17CronWorkers,
  registerSchedulingAbacPredicates,
  registerSchedulingRoutes,
  registerSchedulingSeams,
  scheduleM17Jobs,
} from "./modules/17-scheduling/index";
import {
  M18_OUTBOX_EVENTS,
  buildM18VisitPublishedConsumer,
  createDrizzleEvvSeamStore,
  mountEvvRoutes,
  registerEvvAbacPredicates,
  registerEvvRoutes,
  registerEvvSeams,
} from "./modules/18-evv/index";
import {
  M19_OUTBOX_EVENTS,
  buildDrizzleM19ReadService,
  buildDrizzleM19WriteService,
  buildDrizzleOncallAbacResolver,
  buildDrizzleOncallSeamStore,
  buildDrizzleVendorSessionBindReader,
  buildOncallTriggerConsumers,
  createDrizzleInboundTriggerPorts,
  createDrizzleTriageEraseStore,
  denyStubOncallAbacResolver,
  mountM19Routes,
  registerOncallAbacPredicates,
  registerOncallSeams,
  registerTriageErasers,
} from "./modules/19-oncall/index";
import {
  M20_OUTBOX_EVENTS,
  M20_PLATFORM_JOB_ID,
  buildDrizzleM20ReadService,
  buildDrizzleM20WriteService,
  buildDrizzleSafetyAbacResolver,
  buildDrizzleSafetySeamStore,
  buildFieldSafetyConsumers,
  buildM20WorkerDeps,
  createDrizzleSafetyEraseStore,
  createSafetyPolicyProvider,
  denyStubSafetyAbacResolver,
  mountM20Routes,
  registerFieldSafetyAbacPredicates,
  registerFieldSafetySeams,
  registerM20CronWorkers,
  registerSafetyErasers,
  safetyClinicianSignalCache,
  scheduleM20Jobs,
  wireM20Tenancy,
} from "./modules/20-field-safety/index";
import {
  M21_OUTBOX_EVENTS,
  bindSupplyRequestCreator,
  buildDrizzleM21ReadService,
  buildDrizzleM21WriteService,
  buildDrizzleSuppliesAbacResolver,
  buildDrizzleSuppliesSeamStore,
  buildM21DocumentBackrefConsumer,
  decideDispatcherEligible,
  denyStubSuppliesAbacResolver,
  mountM21Routes,
  registerSuppliesAbacPredicates,
  registerSuppliesSeams,
  registerSupplyEraser,
} from "./modules/21-supplies/index";
import {
  M22_DOCUMENT_RENDERED_EVENT,
  M22_OUTBOX_EVENTS,
  buildM22DocumentRequestConsumer,
  createDrizzleDocumentEraseStore,
  createDrizzleDocumentReaderStore,
  createDrizzleDocumentSeamStore,
  createRefusingObjectStore,
  createS3ObjectStore,
  createS3TenantStorageProvisioner,
  createSignedUrlService,
  deriveTenantBucket,
  getDocumentRenderer,
  mountDocumentRoutes,
  registerDocumentAbacPredicates,
  registerDocumentErasers,
  registerDocumentRoutes,
  registerDocumentSeams,
  s3ObjectStoreConfigFromEnv,
} from "./modules/22-documents/index";
// M23 (Billing — Medicare) boot surface — the §4.10 outbox catalog, the §4.7 ABAC resolvers, the §4.1 route
// mount over the Drizzle read/write services + the boot-time claim-assembly service, the §3.7 `billing_record`
// eraser (registerEraser INJECTED — M23 cannot import the M1 bootstrap registry), and the §4.8 BullMQ workers
// (claim/NOE/NOTR submit[.retry], 999/277CA ack pulls, eligibility refresh, NOE/NOTR window-watch, eligibility
// stale-watch, MAC-portal health, the revalidate consumer). Every worker infra/seam/x12/portal port stays
// fail-closed-unbound at boot (RULE 4), so Phase-0 containment disables their construction; the assembly
// reader seams + the live MAC/X12 binds are follow-ups.
import {
  M23_OUTBOX_EVENTS,
  buildDrizzleM23ReadService,
  buildDrizzleM23WriteService,
  buildM23BootAssemblyService,
  buildM23NoeDraftConsumer,
  buildM23NotrDraftConsumer,
  buildM23OutboxBackedSubmissionGate,
  buildM23RemittanceConsumer,
  buildM23SubmissionQueuePort,
  buildM23SubmissionRequestConsumer,
  buildM23WorkerDeps,
  createDrizzleBillingEraseStore,
  createM23LaunchGateway,
  m23LaunchGatewayConfigFromEnv,
  mountM23Routes,
  registerBillingErasers,
  registerM23AbacPredicates,
  registerM23LaunchWorkers,
  registerM23PublishedSeams,
  scheduleM23LaunchJobs,
} from "./modules/23-billing-medicare/index";
// M24 (Billing — Medicaid) boot surface — the §4.11 outbox catalog, the §4.8 ABAC resolvers
// (provider_entity_medicaid_billing_scope / medicaid_claim_in_billing_manager_caseload /
// medicaid_override_role_eligible / regulatory_required_rule_protected_medicaid / rb_arrangement_visible_in_scope
// / state_trading_partner_credential_admin), the §4.1 route mount over the Drizzle read/write services, and the
// §3.7 `medicaid_billing_record` eraser. The write service's `m24.*` transactional outbox publisher binds at
// boot; the §4.3 published-seam registration + the §4.9 per-state-adapter workers + the consumed-reader binds
// are deferred follow-ups (the M26 posture — the adapter wire I/O lands later).
import {
  M24_OUTBOX_EVENTS,
  M24_SUBMISSION_REQUEST_EVENTS,
  buildCredentialCipherPort,
  buildDrizzleCredentialResolver,
  buildDrizzleM24ReadService,
  buildDrizzleM24WriteService,
  buildM24SubmissionQueuePort,
  buildM24SubmissionRequestConsumer,
  buildM24SubmissionWorkerDeps,
  createDrizzleMedicaidRedactStore,
  mountM24Routes,
  registerM24AbacPredicates,
  registerM24LaunchWorkers,
  registerM24PublishedSeams,
  registerMedicaidErasers,
} from "./modules/24-billing-medicaid/index";
// M25 (Remittance & Denials) boot surface — the §4.5 outbox catalog, the §4.7 ABAC resolvers
// (`claim_assigned_to_actor`, `appeal_within_deadline`), and the §4.1 route mount over the Drizzle
// read/write services. The write service's transactional outbox publisher + the read service's M38
// terminology lookup stay on their fail-closed defaults at boot (no-op emit / deny-stub lookup) until those
// binds land — a documented follow-up (the M23/M27 deferred-bind posture); routes are fully live otherwise.
import {
  type WorkerAlertPort as M25WorkerAlertPort,
  M25_OUTBOX_EVENTS,
  M25_PLATFORM_JOB_ID,
  type TerminologyLookupPort,
  buildDrizzleM25IngestService,
  buildDrizzleM25ReadService,
  buildDrizzleM25WriteService,
  buildM23BackedClaimMatchCandidateProvider,
  buildM25EdiReceivedConsumer,
  buildM25WorkerDeps,
  createDrizzleRemittanceEraseStore,
  m25X12WorkerPortFromEnv,
  mountM25Routes,
  registerM25AbacPredicates,
  registerM25CronWorkers,
  registerM25PublishedSeams,
  registerRemittanceErasers,
  scheduleM25Jobs,
  wireM25Tenancy,
} from "./modules/25-remittance/index";
// M26 (Cap Management) boot surface — the §4.10 outbox catalog, the §4.7 ABAC resolvers (cap_period_open /
// _in_settlement / _settled / _methodology_unlocked / cap_platform_admin), and the §4.1 route mount over the
// Drizzle read/write services. The write service's transactional outbox publisher binds at boot; the §4.3
// published-seam impls + the §4.8 BullMQ workers + the §3.7 eraser land in P4 (the M27 deferred posture).
import {
  M26_OUTBOX_EVENTS,
  buildDrizzleM26ReadService,
  buildDrizzleM26WriteService,
  createDrizzleCapRedactStore,
  mountM26Routes,
  registerCapErasers,
  registerM26AbacPredicates,
  registerM26CronWorkers,
  registerM26PublishedSeams,
  scheduleM26Jobs,
} from "./modules/26-cap/index";
// M27 (Cost Report) boot surface — the §4.10 outbox catalog, the §4.7 ABAC resolvers, the §4.1 route mount
// over the Drizzle read/write services, the §3.7 `cost_report_class` eraser, and the §4.8 BullMQ workers
// (the M30 precedent). WX-PR-013 bound the recompute-enqueue producer + the outbox/alerts/active-org worker
// ports for real; the live Xero/Gusto pull + the M6/M8 statistics aggregate seams remain explicit deny-stub
// forward work (see the wiring.ts / jobs/m27-jobs.ts TODO comments for why).
import {
  type ClaimSettlementSeam as M27ClaimSettlementSeam,
  type DrugCostSeam as M27DrugCostSeam,
  type PatientDaysSeam as M27PatientDaysSeam,
  type ProviderEntityResolver as M27ProviderEntityResolver,
  M27_OUTBOX_EVENTS,
  M27_PLATFORM_JOB_ID,
  buildDrizzleM27ReadService,
  buildDrizzleM27WriteService,
  buildM27AllocationInputs,
  buildM27DocumentBackrefConsumer,
  buildM27RecomputeEnqueue,
  buildM27ValidationContext,
  buildM27WorkerDeps,
  createDrizzleCostReportEraseStore,
  m27CapSeamResolver,
  mountM27Routes,
  registerCostReportErasers,
  registerM27AbacPredicates,
  registerM27CronWorkers,
  registerM27PublishedSeams,
  registerM27Workers,
  scheduleM27Jobs,
  wireM27Tenancy,
} from "./modules/27-cost-report/index";
// M28 (FHIR Gateway) boot surface — the §4.3 published read seams (M28-T06). The three impls register over
// their M1 deny-stubs ONLY when a Drizzle store is supplied; M28's routes/repos (the store's home) land in
// T08, so the store is unbound this wave and the fail-closed deny-stubs stand (the M19/M20 posture).
import {
  M28_OUTBOX_EVENTS,
  buildDrizzleFhirGatewayAbacResolver,
  createDrizzleFhirGatewayEraseStore,
  createDrizzleFhirGatewayStore,
  createDrizzleFhirPublishedSeamStore,
  createHttpFhirJwksFetcher,
  createInMemoryFhirReplayGuard,
  createRedisFhirReplayGuard,
  denyStubFhirGatewayAbacResolver,
  mountM28Routes,
  registerFhirGatewayAbacPredicates,
  registerFhirGatewayEraser,
  registerFhirPublishedSeams,
} from "./modules/28-fhir/index";
// M29 (External Interfaces) boot surface (M29-T08) — the §4.1/§4.2 route store, the §4.4 published seams,
// and the §4.8 ABAC predicate resolver. Seams register over their M1 deny-stubs ONLY when a Drizzle store is
// supplied (db-less boot keeps the fail-closed deny-stubs); the ABAC resolver binds the M3 permission store +
// a lazy M5 CaseloadProvider adapter.
import {
  M29_OUTBOX_EVENTS,
  NPPES_SYNC_SCHEDULE,
  buildDrizzleM29AbacResolver,
  buildNppesManualSyncTrigger,
  createDrizzleM29PublishedSeamStore,
  createDrizzleM29Store,
  denyStubM29AbacResolver,
  mountM29Routes,
  registerM29AbacPredicates,
  registerM29PublishedSeams,
  registerNppesSyncWorker,
  scheduleNppesSyncJob,
} from "./modules/29-external-interfaces/index";
import {
  M30_OUTBOX_EVENTS,
  M30_PLATFORM_JOB_ID,
  buildDrizzleM30ReadService,
  buildDrizzleM30WriteService,
  buildM30RecomputeEnqueue,
  buildM30WorkerDeps,
  createDrizzleQualityEraseStore,
  mountM30Routes,
  registerM30AbacPredicates,
  registerM30CronWorkers,
  registerM30PublishedSeams,
  registerM30Workers,
  registerQualityErasers,
  scheduleM30Jobs,
  wireM30Tenancy,
} from "./modules/30-quality/index";
import {
  buildDrizzlePortalStore,
  buildPortalAbacResolverFromStore,
  createM31PublishedSeamImpls,
  createPortalReasonCipher,
  denyStubPortalAbacResolver,
  mountM31Routes,
  registerM31PublishedSeams,
  registerPortalAbacPredicates,
  registerPortalErasers,
} from "./modules/31-portal/index";
// M32 (AI Platform) boot surface — M32-T02's §3.7 destruction contract, M32-T06's §4.4 seam registration
// and M32-T07's HTTP surface: the §4.11 `m32.*` outbox catalog, the six §4.7 ABAC predicate resolvers and
// the §4.1 route mount over the T03/T04/T05 command services + T07's read port. `ai.full` stays OFF.
import {
  M32_OUTBOX_EVENTS,
  M32_PLATFORM_JOB_ID,
  buildDrizzleAiPlatformAbacResolver,
  buildDrizzleM32ReadService,
  createAiPromptRegistry,
  createDenyingAiOptInEvidenceResolver,
  createDrizzleAiCapabilityRegistryStore,
  createDrizzleAiEvaluationRunStore,
  createDrizzleAiHallucinationReportStore,
  createDrizzleAiKillSwitchStore,
  createDrizzleAiPromptTemplateStore,
  createDrizzleAiProvenanceEraseStore,
  createDrizzleAiRoutingOverrideStore,
  createDrizzleAiTenantConsentStore,
  createUnconfiguredAiTokenBudgetResolver,
  createUnresolvableAiPromptArtifactReader,
  denyStubAiPlatformAbacResolver,
  mountM32Routes,
  registerAiPlatformAbacPredicates,
  registerAiPlatformSeams,
  registerAiProvenanceErasers,
  wireM32Tenancy,
} from "./modules/32-ai-platform/index";
import {
  M33_OUTBOX_EVENTS,
  buildDrizzleM33ExportDrilldownService,
  buildDrizzleM33ReadService,
  buildDrizzleM33WriteService,
  buildDrizzleReportingAbacResolver,
  buildM33DocumentBackrefConsumer,
  buildM33MvRefreshEnqueue,
  buildM33ReadEnqueue,
  buildM33WorkerDeps,
  createDbSystemDashboardSeeder,
  createDrizzleReportingEraseStore,
  mountM33ExportDrilldownRoutes,
  mountM33ReadRoutes,
  mountM33WriteRoutes,
  registerM33AbacPredicates,
  registerM33Workers,
  registerReportingErasers,
  registerReportingMetricsSeam,
  scheduleM33Jobs,
  wireM33Tenancy,
} from "./modules/33-reporting/index";
import {
  type BootstrapModule34Deps,
  M34_OUTBOX_EVENTS,
  type SignupIntentRouteService,
  type TenantPlatformAbacResolver,
  bootstrapModule34,
  buildDrizzlePlatformService,
  buildDrizzleTenantService,
  buildM34ProvisionQueue,
  buildM34ProvisionStartedConsumer,
  buildM34WorkerDeps,
  buildPlatformEnqueue,
  buildTenantEnqueue,
  createDrizzleSaasTenantPlatformEraseStore,
  createM34ProvisionGateway,
  enableM34JobCapability,
  getTenantKeyProvider,
  m34ProvisionGatewayConfigFromEnv,
  mountTenantPlatformRoutes,
  registerLiveM34Seams,
  registerM34DekRotateWorker,
  registerM34DsarExportWorker,
  registerM34ProvisionWorker,
  registerM34ShredWorker,
  registerM34TenantExportWorker,
  registerSaasTenantPlatformErasers,
  registerTenantPlatformAbacPredicates,
  validateModule34Seams,
  wireM34AlertRuleSeed,
  wireM34Tenancy,
} from "./modules/34-saas-tenant-platform/index";
// M35 (Subscription Billing) boot surface — the §4.11 outbox catalog, the §4.8 ABAC predicates, and the
// §4.1–4.3 route mount over the single Drizzle route service. The write path emits `m35.*` events through
// the bound transactional-outbox publisher; the platform-ops cross-tenant reads/writes run through the
// injected platform runner (fail-closed until a platform credential binds — the M34 posture), and the §4.3
// webhook ingest stays fail-closed (503) until the live Stripe transport binds. The §4.5/§4.6 seams were
// bound as deny-stubs in T05 and stay so (M35's first consumer, M33, builds last in this wave).
import {
  M35_OUTBOX_EVENTS,
  buildDrizzleM35RouteService,
  mountM35Routes,
  registerM35AbacPredicates,
} from "./modules/35-subscription/index";
import {
  M36_OUTBOX_EVENTS,
  buildM36ClinicalAlertConsumer,
  createDbMessagingProvider,
  createDrizzleAlertEmitter,
  createDrizzleMessagingEraseStore,
  mountMessagingRoutes,
  registerMessagingErasers,
  registerMessagingSeams,
  selectTransactionalEmailTransport,
  wireAlertRuleSeed,
} from "./modules/36-messaging/index";
// M37 (Inpatient Unit / IPU Management) boot surface — the §4.7 ABAC predicates, the §4.4 outbox catalog,
// and the §4.1 core route mount over the Drizzle route service. The write path emits `m37.*` through the
// bound transactional-outbox publisher. (The remaining §4.1 routes + §7.7 eraser + SeamRegistry extend this.)
import {
  type IpuAiPromptRegistryPort,
  M37_OUTBOX_EVENTS,
  M37_PLATFORM_JOB_ID,
  buildDrizzleIpuRouteService,
  buildM37WorkerDeps,
  getIpuAdmissionStatusReader,
  getIpuOrderReader,
  getIpuRoomingFactsReader,
  getIpuVisitorConsentGate,
  mountM37Routes,
  registerIpuErasers,
  registerIpuSeams,
  registerM37AbacPredicates,
  registerM37CronWorkers,
  scheduleM37Jobs,
  validateIpuAIBlock,
  wireM37Tenancy,
} from "./modules/37-ipu/index";
import {
  createDbTerminologyStore,
  createDrizzleTerminologyEraseStore,
  mountTerminologyRoutes,
  registerTerminologyAbacPredicates,
  registerTerminologyErasers,
  registerTerminologySeams,
} from "./modules/38-terminology/index";
import {
  M39_OUTBOX_EVENTS,
  buildM39ConsentRenderConsumer,
  createConsentInternalNotesCipher,
  createDbConsentStore,
  createDrizzleConsentEraseStore,
  getConsentPatientReader,
  mountConsentRoutes,
  registerConsentAbacPredicates,
  registerConsentErasers,
  registerConsentSeams,
} from "./modules/39-consent/index";
import {
  M40_OUTBOX_EVENTS,
  buildM29NppesPlatformConsumers,
  createDbBaaStore,
  createDbMdmStore,
  createDbNppesNpiSource,
  createDrizzleMdmEraseStore,
  getMdmEntityProvider,
  mountMdmRoutes,
  registerMdmErasers,
  registerMdmSeams,
} from "./modules/40-mdm/index";

export { buildServer };
export * from "./bootstrap/index";

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// M6–M14 / M17 / M18 / M22 — THE CLINICAL CORE IS LIVE OVER DRIZZLE.
//
// Every one of these twelve modules now mounts a PRODUCTION Drizzle route service under `withOrgContext`
// (see the `mount*Routes(app, dbHandle.db, …)` calls in registerModuleRoutes): reads AND the full write
// lifecycle run as real Postgres statements, so RLS scopes every row by `app.org_id` and the M4 write-audit
// triggers fire on every mutation. The former in-memory `createInMemory*Backend` route scaffold (a per-process
// `Map` with no RLS and no audit) has been removed — the in-memory backends survive only as the behavioral
// reference in each module's `routes/service.ts` (used by the pure route/acceptance suites), never mounted here.
// ════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Register every Phase-1 producer module's real seams into the M1 registry. Passed to
 * buildServer() as `registerModuleSeams`, it runs inside bootSeams() after M1's wireSeams()
 * and before validateSeams(), so the real seams stand over the deny-stubs (§3.18).
 */
/**
 * TASK-004 — the boot-registered RBAC engine handle. Set by wireModuleSeams (db boots) and read by
 * registerModuleRoutes when mounting M3, so the route surface and `requirePermission` share ONE
 * resolver + ONE §2.5 invalidation cache (a second instance would split them). Module-scope because
 * both closures live in this file; bootSeams runs before registerModuleRoutes inside buildServer.
 */
let liveRbacHandle: RbacEngineHandle | undefined;

export function wireModuleSeams(
  deps: {
    sessionContextStore?: SessionContextStore;
    db?: DbClient;
    organizationDb?: DbClient;
    /**
     * The PLATFORM-pooled client (`DATABASE_PLATFORM_URL`). Distinct from `organizationDb` even though
     * the composition root happens to pass the same handle to both: this one is here because M34's D5
     * key provider needs a credential that may SELECT `tenant_key_ring`, which migration 0052 §5 revokes
     * from `wardenx_app` (#105). Absent ⇒ the key provider refuses with a stated reason.
     */
    platformDb?: DbClient;
    /** The catalog-validating tx outbox publisher (TASK-002) — the M5 PatientMutator's §4.6
     * `m5.patient.updated` emit rides it. Absent on slice/test boots (mutator stays in-memory). */
    outboxPublisher?: OutboxPublishPort;
  } = {},
): void {
  // AUTH-T05b: pass the DB-backed SessionContextStore in production (composition root supplies it when
  // a DB client is present); the slice/tests fall back to M2's in-memory store.
  registerIdentitySeams({
    sessions: deps.sessionContextStore,
    db: deps.db,
    organizationDb: deps.organizationDb,
  }); // M2 — SessionContextResolver + AuditorSessionMinter + TenantOrgCreationProvider (§4.7 / M34 §7.1)
  // M3 — register the live RBAC resolver (DB-backed effective permissions) when a DB client is present,
  // turning `requirePermission` from fail-closed to real resolution. Slice/tests keep the default.
  // TASK-004 — the handle is CAPTURED so the M3 route mount binds the SAME resolver + §2.5
  // invalidation cache for /me/permissions, anti-escalation, and grant/revoke cache drops.
  if (deps.db) liveRbacHandle = registerDbEffectivePermissionResolver(deps.db);
  // M3 — register M3's own `step_up_recent` ABAC predicate (§4.2.1 — the step-up freshness gate every
  // `requireStepUp` route resolves through). It reads M2's SessionContextResolver seam (registered just
  // above) lazily at request time, so registration order only requires the seam present by first request.
  registerAuthorizationAbacPredicates();
  // M38 — TerminologyProvider (§4.5). Production backs it with the Drizzle store over the real M38
  // tables (FB-T01); slice/tests keep the in-memory default.
  registerTerminologySeams(
    deps.db ? { store: createDbTerminologyStore(deps.db) } : {},
  );
  // M36 — AlertEmitter (§4.6): GAP-096 — the real Drizzle-backed T04 resolution/fan-out engine binds
  // over a DB client; slice/tests keep the in-memory default (createInMemoryAlertEmitter). The
  // DB-backed MessagingProvider (§4.6 channel/message CRUD with per-tenant DEK encryption) registers
  // over the deny-stub when a DB client is present too (FB-T05).
  registerMessagingSeams(
    deps.db
      ? {
          emitter: createDrizzleAlertEmitter(deps.db),
          provider: createDbMessagingProvider(deps.db),
        }
      : {},
  );
  // M40 — MdmEntityProvider (§4.5) + BaaStatusProvider (§4.6 §7.7 as-of gate). Production backs both
  // seams with Drizzle stores over the real M40 tables (FB-T02); slice/tests keep the in-memory default.
  registerMdmSeams(
    deps.db
      ? {
          store: createDbMdmStore(deps.db),
          baaStore: createDbBaaStore(deps.db),
        }
      : {},
  );
  // M5 — CaseloadProvider (§4.1, + caseload_membership predicate); PatientReader/Mutator land T08. The
  // §3.4 PatientCoverageReader registers over the real `patient_payer` rows when a db is present — the
  // read M23/M24 resolve a claim's billed payer from (without it, billing degrades fail-closed).
  // TASK-002 — PatientReader/PatientMutator bind their Drizzle stores on a db boot (the reader over
  // patient + patient_identifier; the mutator's §4.6 emit rides the catalog publisher when supplied).
  registerPatientSeams(
    deps.db
      ? {
          db: deps.db,
          caseload: { store: createDrizzleCaseloadStore(deps.db) },
          careTeam: { store: createDrizzleCareTeamStore(deps.db) },
          readerStore: createDrizzlePatientReaderStore(deps.db),
          ...(deps.outboxPublisher
            ? {
                mutatorStore: createDrizzlePatientMutatorStore(deps.db, {
                  outbox: deps.outboxPublisher,
                }),
              }
            : {}),
        }
      : {},
  );
  // M6 — the six §4.7 admission reader seams (election/CTI/F2F/LOC/status/census). Slice/tests keep the
  // in-memory store; the Drizzle-backed store lands with M6's routes/repos (M6-T06+). PLUS the §4.11
  // DeathDischargeReader the M30 measure-recompute worker consumes for the HVLDL denominator, and the
  // LevelOfCarePeriodReader / DischargeReader the same worker consumes for HCI indicators 1/3/4 —
  // registered over DEDICATED Drizzle readers when a db is present (each self-scopes its own call, HARD
  // RULE 3); slice/tests without a db keep them all on their fail-closed deny-stubs.
  // TASK-002 — the six §4.7 admission readers bind the Drizzle store on a db boot (deps.db also
  // keeps the §4.11 DeathDischargeReader + the HCI aggregate readers live, as before).
  registerAdmissionSeams(
    deps.db
      ? { db: deps.db, store: createDrizzleAdmissionReaderStore(deps.db) }
      : {},
  );
  // M7 — the §7.8 CarePlanReader (encounter-relevance picker + the 5-/15-day overdue sign-gate M8
  // consumes). Slice/tests keep the in-memory store + real clock; the Drizzle-backed store lands with
  // M7's routes/repos (M7-T05+).
  // TASK-002 — CarePlanReader binds the full Drizzle store on a db boot (SUD/D7 redaction resolves
  // the M39 ConsentEvaluator lazily, fail-closed).
  registerCarePlanSeams(
    deps.db ? { store: createDrizzleCarePlanReaderStore(deps.db) } : {},
  );
  // M8 — the four §4.7 owned seams (billable/signed/mileage/creator). M8 also CONSUMES M7's CarePlanReader
  // (registered just above) for the encounter authoring picker + the overdue sign-gate. Slice/tests keep
  // the in-memory store; the Drizzle-backed store lands with M8's routes/repos (M8-T09+).
  // M8 — back the §4.7 reader seams with the Drizzle store when a db is present (#107): the live
  // SignedEncountersReader.signedEncountersForPatientSince over the real encounter table (the prior in-memory
  // default returned empty, zeroing M30's HVLDL numerator). Slice/tests keep the in-memory store.
  registerEncounterSeams(
    deps.db ? { store: createDrizzleEncounterReaderStore(deps.db) } : {},
  );
  // M9 — the two §4.7 / D7 owned seams (LatestAssessmentProvider + ScaleSeriesProvider) M7/M10/M14/M28/M32
  // consume for latest-scale reads + trend series/deltas. Slice/tests keep the in-memory store; the
  // Drizzle-backed store lands with M9's routes/repos (M9-T05+).
  // TASK-002 — LatestAssessmentProvider + ScaleSeriesProvider bind the Drizzle store on a db boot.
  // KNOWN GAP (agent finding): the M9 route write path never populates provider_entity_id/location_id,
  // so a route-recorded row's latest-read throws AssessmentSeamDataGapError until the write path sites
  // captures — loud, never a fabricated context.
  registerAssessmentSeams(
    deps.db ? { store: createDrizzleAssessmentReaderStore(deps.db) } : {},
  );
  // M10 — the three PER-ENTITY §2 / D10 owned seams (HopeTimepointProvider + HopeJ2051Provider +
  // HopeSubmissionProvider) M14/M22/M30/M32 consume for open HOPE windows, J2051 trigger/SFV obligations,
  // and per-PE submission status (in-memory store). PLUS the ORG-LEVEL HopeOrgRollupProvider (#107) the M30
  // measure-recompute worker consumes — registered over a DEDICATED Drizzle aggregate reader when a db is
  // present (org-scoped COUNTS only, D6); slice/tests without a db keep it on the fail-closed deny-stub.
  registerHopeSeams(deps.db ? { db: deps.db } : {});
  // M33 — register the PUBLISHED MetricsProvider seam (#107 item 2) so M30/M34/M37 can embed dashboard
  // metrics via getSeam. Returns forward-seam-empty (value:null) until M33's MVs materialize; the M1
  // fail-closed deny-stub stands when no db is present.
  registerReportingMetricsSeam(deps.db);
  // M26 — register the PUBLISHED CapAccrualReader seam so M27's cost-report Worksheet-E cap calc resolves the
  // live cap-period aggregate via getSeam (D13). The M1 fail-closed deny-stub stands when no db is present.
  registerM26PublishedSeams(deps.db);
  // M24 — build the eight §4.3 published reader-seam impls (registration deferred — no live getSeam consumer
  // yet; M24 stays reachable cross-module via its §4.11 outbox events, the M26 unconsumed-seam posture).
  registerM24PublishedSeams(deps.db);
  // M23 — register the PUBLISHED PatientDaysProvider seam so M27's cost-report Worksheet-D census reconciliation
  // resolves the live billed-and-accepted patient-day aggregate via getSeam (M23's first M1 publish). The M1
  // fail-closed deny-stub stands when no db is present.
  registerM23PublishedSeams(deps.db);
  // M25 — register the PUBLISHED ClaimSettlementProvider seam so M27's cost-report E-1 settlement tie resolves
  // the live actual interim-payment aggregate (835 CLP04) via getSeam. The M1 fail-closed deny-stub stands when
  // no db is present.
  registerM25PublishedSeams(deps.db);
  // M30 — register the FIVE §4.3 published seams (QualityMeasureProvider / IncidentRegisterProvider /
  // QapiProjectProvider / ComplianceStatusProvider / SecurityRiskAssessmentReader). The per-PE aggregation
  // grain binds to the same M40 provider-entity resolver the M30 workers use; UNBOUND ⇒ empty, never a
  // fabricated cross-provider rollup. The M1 fail-closed deny-stubs stand when no db is present.
  //
  // CONSUMPTION (GAP-066 — this comment used to say these seams let "M22's quality report, M28's FHIR
  // MeasureReport/AdverseEvent, M33's dashboards and M34's FY-rollover tenant gate" reach M30 via getSeam;
  // an audit checked and found the only `getSeam("QualityMeasureProvider")` in the repo is M30's own seam
  // test): NOTHING consumes these five today. That is not a wiring gap — all four named consumers are
  // UNBUILT surfaces, not unwired ones. M28 has no MeasureReport/AdverseEvent resource at all, M34 has no
  // FY-rollover tenant gate, M33 has no quality dataset, and M22 has no quality-report route; each would be
  // a feature, not a binding. The registration stands because it is the read path those features will use
  // and it costs nothing dormant (contrast M24, whose seams are built but deliberately left UNregistered
  // until a consumer exists — the two postures differ, and this is the one M30 shipped with).
  registerM30PublishedSeams(deps.db, {
    providerEntities: deps.db
      ? buildOrgProviderEntityLister(deps.db)
      : undefined,
  });
  // M27 — register the PUBLISHED CostReportFilingStatusReader (M27's FIRST M1 publish) so M30's CoP
  // 418.310 failure-to-file indicator resolves the live filing posture. GAP-065: that indicator now EXISTS
  // (the `cost_report_filing_compliance` measure, registry.ts + jobs/m30-jobs.ts
  // `resolveCostReportFilingInput`) and reads this seam through `buildM30CostReportConsumer`. Until then
  // this registration fed nothing — the adapter was built and unit-tested but no calculator consumed it,
  // and no CoP measure code existed at all, so the claim on this line was aspirational. The other six
  // declared M27 seams stay unregistered until they have a consumer (the M24 posture).
  registerM27PublishedSeams(deps.db);
  // M11 — the two §2.8 D14 / §4.3 owned seams (OrderSignatureProvider — the polymorphic clinical-signature
  // WRITE primitive M12 routes medication-order signatures through, D4 — + OrderProvider — the read-side
  // counterpart M14/M23/M30/M7 consume). Slice/tests keep the in-memory store; the Drizzle-backed store lands
  // with M11's routes/repos (M11-T06+).
  // TASK-002 — OrderProvider + the OrderSignatureProvider WRITE primitive bind the Drizzle store on
  // a db boot (guard-checked writes in the caller's request scope). Migration 0156 added the
  // `order_discontinuation.target_kind` discriminator (task-11), and `SignOrderTargetInput` now
  // carries the REQUIRED signerDiscipline (task-15) — the seam sentinel is gone.
  registerOrderSeams(
    deps.db ? { store: createDrizzleOrderSeamStore(deps.db) } : {},
  );
  // M12 — the two §2.10 D17 owned READ seams (MedicationOrderProvider — the medication-order read path M13
  // (eMAR administration context) / M14 / M19 / M28 (FHIR) / M30 / M31 (portal) / M33 consume — + RefillInboxProvider
  // — the refill-inbox read path the prescriber UI + M19/M33 consume). Slice/tests keep the in-memory store;
  // the Drizzle-backed store lands with M12's routes/repos (M12-T08+).
  // TASK-002 — MedicationOrderProvider + RefillInboxProvider bind the Drizzle store on a db boot
  // (D14 allowlist sig projection; the cost-basis + comfort-kit rollups REFUSE with
  // M12_SEAM_SCHEMA_GAP — no cost column / not M12's table — never a fabricated $0 or "no kit").
  registerDoseSpotSeams(
    deps.db ? { store: createDrizzleDoseSpotSeamStore(deps.db) } : {},
  );
  // M13 — the two §2.12 D16 owned READ seams (MedicationAdministrationProvider — the administration read path M14
  // (IDG "administrations since last meeting") / M28 (FHIR) / M30 (PRN-effectiveness / missed-dose /
  // comfort-kit-timeliness measures) / M31 (portal summary) / M33 (dashboards) / M37 (IPU IV-pump overlay)
  // consume — + ReconciliationProvider — the reconciliation-worksheet read path M14/M30 consume). Slice/tests
  // keep the in-memory store; the Drizzle-backed store lands with M13's routes/repos (M13-T08+).
  // TASK-002 — MedicationAdministrationProvider + ReconciliationProvider bind the full Drizzle
  // store on a db boot (12/12 methods; §3.6 free-text denylist keys scrubbed from `data`).
  registerEmarSeams(
    deps.db ? { store: createDrizzleEmarSeamStore(deps.db) } : {},
  );
  // M14 — the three §4.8 owned READ seams (IdgPacketProvider — the packet-snapshot + M22 render handshake M22
  // (minutes / packet PDF) + M33 consume — + IdgDecisionProvider — the decision read path M30
  // (decision-to-careplan-update latency) + M33 consume — + IdgScheduleProvider — the meeting-schedule +
  // 15-day-cadence read path M28 (FHIR) + M30 (cadence-adherence) + M33 consume). Slice/tests keep the
  // in-memory store; the Drizzle-backed store lands with M14's routes/repos (M14-T05+).
  // TASK-002 — the three IDG providers bind the full Drizzle store on a db boot.
  // `decisionsForCarePlan` reads the migration-0155 `idg_decision.care_plan_id` link (populated at
  // record time via M7's CarePlanReader; a NULL link honestly never matches — task-11 closed the gap).
  registerIdgSeams(
    deps.db ? { store: createDrizzleIdgSeamStore(deps.db) } : {},
  );
  // M15 — the seven §4.3 owned READ seams. Two of them are the LOCKED contracts M17 shipped first and has been
  // consuming as fail-closed deny-stubs since Wave F (M17-F06/ADR-0009): registering `VolunteerComplianceProvider`
  // CLOSES the D8 pre-schedule gate predicate 6 (a `volunteer_visit` now resolves the REAL 42 CFR §418.78 gate
  // instead of denying loudly), and `SupervisoryCadenceReader` CLOSES the day-view / propose-from-frequency
  // supervisory advisory. The other five are M15's own §4.3 surface: `DisciplinePlanReader` (M14 IDG one-pager /
  // M22 plan PDF / M28 / M31 / M33), `MswRiskFactorReader` (the psychosocial factors M16's bereavement rubric
  // scores — M15 exposes, never scores, §1.2), `VolunteerGateExpiryReader` (the 418.78 expiry sweep),
  // `SupervisoryCadencePlanReader` (the per-plan cadence + overdue worklist) and `DisciplineComplianceProvider`
  // (the M30/M33 rollups + the 418.78(e) ratio). Slice/tests keep the in-memory store; the Drizzle-backed store
  // lands with M15's routes/repos (M15-T06+), so today's reads answer empty/null — never a fabricated pass:
  // the volunteer gate still denies fail-CLOSED on an unreadable store and the ratio still badges `unavailable`.
  // TASK-002 — the seven M15 discipline-plan seams bind the Drizzle store on a db boot (volunteer
  // 418.78 gate stays fail-CLOSED: absent rows fail each blocking kind; the 418.78(e) ratio badges
  // `unavailable` until the M27 staffPatientCareMinutes dep binds — never a fabricated 0% breach).
  registerDisciplinePlanSeams(
    deps.db ? { store: createDrizzleDisciplinePlanSeamStore(deps.db) } : {},
  );
  // M15-T06 — the four §4.5 ABAC predicates M15 OWNS (aide_supervisor_eligible /
  // volunteer_compliance_active / family_violence_disclosure_allowed / volunteer_coordinator_role) into
  // M3's named-predicate registry. Their subject facts load through the Drizzle resolver when a DB client
  // is present; WITHOUT one the deny-stub resolver stands, so every predicate denies rather than silently
  // passing (§8.7 fail-CLOSED — an unreadable subject is never an authorized one).
  registerDisciplinePlanAbacPredicates({
    resolver: deps.db
      ? buildDrizzleDisciplinePlanAbacResolver(deps.db)
      : denyStubDisciplinePlanAbacResolver,
  });
  // M16 — the seven §4.6 / D13 owned seams: `BereavementPlanProvider` (the plan header + roster + closeout
  // rollup M28 (FHIR `CarePlan`) / M30 (HQRP) / M31 (portal) / M33 (dashboards) / M36 (bereavement-channel
  // membership + `archives_at`) consume), `BereavementOutreachProvider` (touchpoints + the CoP 418.64(d)
  // counts), `BereavementRiskFactorsProvider` (the D3/D17 snapshot M32 narrates from, the deterministic score,
  // and the Layer-2 write-back — the ONE write, an APPEND to the immutable §3.3.3 ledger),
  // `BereavementAssignmentReader`, `BereavedPortalScopeProvider` (M31's bereaved-family session scope),
  // `BereavementComplianceProvider` and `BereavementRiskTierProvider` (the M30/M33 rollups, as COUNTS).
  // Slice/tests keep the in-memory store; the Drizzle-backed store lands with M16's routes/repos (M16-T06+),
  // so today's reads answer empty/null — never a fabricated pass: `isInBereavementWindow` still denies
  // fail-CLOSED on an unreadable plan, which is what M36 and M3's `bereavement_window` predicate read.
  // TASK-002 — the seven M16 bereavement seams bind the Drizzle store on a db boot (all 15 port
  // methods incl. the ONE write: the append to the immutable risk-score ledger; contact channel
  // ciphers never cross the seam).
  registerBereavementSeams(
    deps.db ? { store: createDrizzleBereavementSeamStore(deps.db) } : {},
  );
  // M16-T06 — the four §4.8 ABAC predicates M16 OWNS (bereavement_window / discipline_can_provide_bereavement
  // / org_scope_bereavement_oversight / portal_self_service) into M3's named-predicate registry. §4.8 calls
  // the last two "reused / M3 §4.2 family", but nothing on the platform registers either name, and an
  // UNREGISTERED predicate denies exactly like a typo does — so M16 owns them. Their subject facts load
  // through the Drizzle resolver when a DB client is present; WITHOUT one the deny-stub resolver stands, so
  // every predicate denies rather than silently passing (§8.7 fail-CLOSED). `roleGrants` is M3's own
  // effective-permission store, which is the platform's ONE discipline-derivation input (`RoleGrant.roleKey`)
  // — M16 reads it through that port rather than importing M3's `role` / `membership_role` schema.
  registerBereavementAbacPredicates({
    resolver: deps.db
      ? buildDrizzleBereavementAbacResolver(deps.db, {
          roleGrants: createDbEffectivePermissionStore(deps.db),
        })
      : denyStubBereavementAbacResolver,
    // §4.8's volunteer clause resolves through M15's published `VolunteerComplianceProvider` — the ONE
    // 42 CFR §418.78 gate implementation on the platform. Resolved lazily per call, fail-CLOSED on throw.
    volunteerGatesSatisfied: async ({
      organizationId,
      volunteerMembershipId,
    }) => {
      try {
        const status = await getSeam(
          "VolunteerComplianceProvider",
        ).effectiveStatusFor(
          organizationId as never,
          volunteerMembershipId as never,
        );
        return status.isActive === true;
      } catch {
        return false;
      }
    },
  });
  // M21 — the three §4.8 / D14 owned seams: `SupplyFulfillmentProvider` (direct request creation plus the
  // status / terminality read M11's §7.7 cancellation cascade branches on), `ComfortKitDispatchProvider`
  // (M13's bedside controlled-substance inventory, the D17 / M37 IPU-room stock kit, and the DEA §1304
  // perpetual-log APPEND M13's drawdown writes) and `SupplyCostProvider` (M23 cap-spend / M27 cost report,
  // in integer CENTS, as totals and counts — never a rate). All three share the Drizzle store, which reads
  // under the CONSUMER's ambient request context (`withOrgContextFromRequest`), so a seam call is RLS-scoped
  // to the caller's org without M21 comparing anything. Without a DB client the in-memory slice stands, and
  // a slice `listActiveDispatchesForPatient` answers `[]` — which a consumer must read as "this slice has no
  // kits", never as "the ward has none".
  //
  // `creator` binds the M21 WRITE service so `createDirectSupplyRequest` goes through the SAME path as a
  // route and an M11 cascade (D4 routing freeze + per-kind validation + the §4.5.2 emit). It is wired below,
  // where the Drizzle services are constructed; unbound, the create method raises rather than writing a
  // routing-less row.
  registerSuppliesSeams(
    deps.db ? { store: buildDrizzleSuppliesSeamStore(deps.db) } : {},
  );
  // M19 — the five §4.3 owned READ seams: `OnCallProvider` (who is on call NOW for a ProviderEntity + the
  // active shifts M36's `on_call` channel synchronizer re-syncs membership from, §4.5 — the same read M20's
  // after-hours SOS parallel recipient resolves through, M20 §7.5 D14), `TriageCallReader` (M32's PHI-free
  // feature read + M14's since-last-IDG digest), `TriageCallProvider` (M14's packet slice + M11's
  // verbal-order → triage-context reverse lookup), `PortalTriageReader` (the ONLY M19 surface M31's portal
  // may reach — lay-language, D11/D13 scrubbed) and `TriageCallMetricsProvider` (M30/M33 measures, as rates
  // AND the counts behind them). All five share the Drizzle store, which reads under the CONSUMER's ambient
  // request context (`withOrgContextFromRequest`), so a seam call is RLS-scoped to the caller's org without
  // M19 comparing anything — the `orgId` seam argument is ASSERTED against that scope, never used to select.
  //
  // WITHOUT a DB client this registers NOTHING and the fail-closed deny-stubs stand — deliberately unlike
  // M15/M16/M21 above. An in-memory slice would answer `currentOnCallActors` with `[]`, and `[]` from that
  // seam is a REAL answer meaning "nobody is covering" — the fact M36's escalation routing and the §4.8
  // watchdog act on. A DB-less boot must not manufacture a coverage gap; a throwing stub says "M19 cannot
  // answer", which is the truth.
  if (deps.db)
    registerOncallSeams({ store: buildDrizzleOncallSeamStore(deps.db) });
  // M20-T05 — the SEVEN §4.3 seams M20 publishes: `SafetyDashboardProvider` (the supervisor
  // live-awareness board, also embedded by M17's visit-day view), `SafetyContextReader` (M8's "was there
  // an incident during the visit I am documenting?"), `SafetyIncidentReader` (M32's §8.6
  // minimum-necessary projection), `SafetyMetricsProvider` (M30/M33 aggregates, every rate WITH its
  // denominator), `SafetyCheckInProvider` (M17's per-visit badge trio), `SafetyPolicyProvider` (the ONLY
  // read path to the effective policy, §2.2.4) and `SafetySupervisorProvider` (who gets paged + the §7.8
  // coverage gaps). All seven share the Drizzle store, which reads under the CONSUMER's ambient request
  // context, so a seam call is RLS-scoped to the caller's org without M20 comparing anything.
  //
  // WITHOUT a DB client this registers NOTHING, for the same reason as M19 above and with a sharper edge:
  // an in-memory slice answers the board with an empty `clinicians` array and `coverageGapsForOrg` with
  // `[]`, which read as "nobody is in the field" and "everybody is covered". A DB-less boot must not
  // manufacture "everyone is fine" on a safety surface; a throwing stub says "M20 cannot answer".
  //
  // THREE OPTIONAL DEPS ARE DELIBERATELY UNBOUND HERE. The §8.6 tenant-DEK coordinate decipher lands with
  // M20's write path (T06) — until then `SafetyIncidentReader` refuses with
  // `SAFETY_COORDINATE_DECIPHER_UNBOUND` rather than reporting every incident as having no geography. The
  // org IANA time zone lands with the same task — until then `getAfterHoursSosCount` refuses rather than
  // counting a Pacific agency's 22:30 presses as business hours. The §7.7 GPS-spoof signal cache is
  // process-local, and F-043/#103 bound the consumer that fills it — `m20.gps-spoof-badge`, which shares
  // THIS instance through `safetyClinicianSignalCache()`. The two ends are wired in different scopes (the
  // seam registration here, the binding beside the outbox dispatcher), and separate instances would record
  // every suspicion and show none.
  if (deps.db)
    registerFieldSafetySeams({
      store: buildDrizzleSafetySeamStore(deps.db),
      signals: safetyClinicianSignalCache(),
    });
  // M21-T05 — the two §4.4 ABAC predicates M21 OWNS (controlled_substance_dispatcher_eligible /
  // comfort_kit_return_reconciler_eligible) into M3's named-predicate registry. Both guard a
  // controlled-substance movement, so unlike M15's and M16's per-seam split the fail direction here is
  // UNIFORM: an unreadable resolver, an unknown target, an absent row and a thrown error all DENY. There is
  // no fact about a CII solution whose unavailability should be read as permission to move it. Their subject
  // facts load through the Drizzle resolver when a DB client is present; without one the deny-stub resolver
  // stands. `roleGrants` is M3's own effective-permission store — the platform's ONE authority-derivation
  // input — read through that port rather than by importing M3's `role` / `membership_role` schema.
  registerSuppliesAbacPredicates({
    resolver: deps.db
      ? buildDrizzleSuppliesAbacResolver(deps.db, {
          roleGrants: createDbEffectivePermissionStore(deps.db),
        })
      : denyStubSuppliesAbacResolver,
  });
  // M19-T07 — the six §4.7 ABAC predicates M19 OWNS (`oncall_eligible`,
  // `triage_call_owner_or_supervisor`, `external_triage_actor`, `escalation_recipient_scope`,
  // `escalation_recipient`, `portal_session_consent_active`) into M3's named-predicate registry.
  //
  // Every one is an AUTHORIZATION read, so unlike M15/M16 the fail direction here is UNIFORM: unreadable
  // resolver, unknown target, absent row, cross-tenant id and thrown error all DENY. §2.4's "a coverage gap
  // must ALERT rather than block" governs the watchdog and boot, not who may answer the after-hours line.
  //
  // ONE method deliberately does NOT collapse its error into a boolean: `activeShiftForMembership` answers
  // `true` / `false` / `null`, so "this nurse is not on call" stays distinct from "we could not read the
  // roster" (the M19-T04 finding). `decideOnCallEligible` treats `null` as no-answer and lets the ROLE path
  // still speak — a supervisor is not locked out of the board by a slow query, while an ordinary RN, who
  // has no other path, is still refused.
  registerOncallAbacPredicates({
    resolver: deps.db
      ? buildDrizzleOncallAbacResolver(deps.db, {
          roleGrants: createDbEffectivePermissionStore(deps.db),
        })
      : denyStubOncallAbacResolver,
  });
  // M20-T06 — the six §4.7 ABAC predicates M20 OWNS (`clinician_self`, `supervises_clinician`,
  // `safety_supervisor_or_above`, `incident_subject_or_supervisor`, `active_sos_responder`,
  // `field_eligible_for_sos`) into M3's named-predicate registry.
  //
  // §4.7 ALSO NAMES `org_scope` AND `caseload_or_scope`, AND M20 REGISTERS NEITHER, deliberately.
  // `caseload_or_scope` is M7's and M20 binds it by name on the dashboard row; `org_scope` is M3's
  // intrinsic `inOrg` VERBATIM ("session.organization_id === target.organization_id"), and registering a
  // second name for the same rule would create two predicates that must never disagree while satisfying
  // `arch:abac-predicates` either way. See the module's abac-predicates.ts header.
  //
  // Every one of the six is an AUTHORIZATION read, so the fail direction is UNIFORM: unreadable resolver,
  // unknown target, absent row, cross-tenant id and thrown error all DENY. §2.4's "a coverage gap must
  // ALERT rather than block" governs the WATCHDOG, not who may acknowledge a life-safety alert.
  //
  // ONE cross-module read deliberately does NOT collapse its error into a boolean: the M19 `OnCallProvider`
  // arm of `active_sos_responder` answers `memberships` / `[]` / `null`, so "nobody is on call" stays
  // distinct from "M19 did not answer" (the M20-T04 rule). A `null` lets the SUBSCRIPTION arm still speak —
  // a subscribed supervisor can acknowledge a 3 a.m. SOS while M19 is down — while an on-call nurse with no
  // subscription is still refused, because guessing in her favour would let any session that reached the
  // route acknowledge any alert.
  registerFieldSafetyAbacPredicates({
    resolver: deps.db
      ? buildDrizzleSafetyAbacResolver(deps.db, {
          roleGrants: createDbEffectivePermissionStore(deps.db),
        })
      : denyStubSafetyAbacResolver,
  });
  // M31-T07 — publish the SEVEN §4.3 portal/telehealth reader seams (PortalAccountReader,
  // PortalAccessGrantReader, PortalEngagementProvider, TelehealthMetricsProvider, TelehealthVisitReader,
  // PortalSessionMinter, PortalDisclosureAccountingProvider) into the M1 registry — the deny-stub closers
  // for M28 SMART-launch, M30 engagement/telehealth measures, M33 dashboards, M34 onboarding, M35 metering —
  // and register the SIX §4.7 ABAC predicates (`portal_account_active`, `portal_grant_active_for_patient`,
  // `portal_caregiver_is_primary_or_dpoa`, `bereaved_portal_window_open`, `telehealth_consent_active`,
  // `state_two_party_recording_consent_present`). Every predicate is an AUTHORIZATION read whose fail
  // direction is UNIFORM: a non-portal session class, an unreadable resolver, an unknown target, an absent
  // row, an unbound/erroring M39 and a thrown error all DENY (§8.2 — a portal surface that cannot prove
  // consent must refuse). The subject facts load through the Drizzle store over M31's three owned tables when
  // a DB client is present; without one the deny-stub resolver stands.
  if (deps.db) {
    const portalStore = buildDrizzlePortalStore(deps.db);
    registerM31PublishedSeams(
      { registerSeam },
      createM31PublishedSeamImpls(portalStore),
    );
    registerPortalAbacPredicates({
      resolver: buildPortalAbacResolverFromStore(portalStore),
    });
  } else {
    registerPortalAbacPredicates({ resolver: denyStubPortalAbacResolver });
  }
  // M37 §4.11 — register the eight REAL Drizzle-backed IPU reader seams over their deny-stubs (db-present
  // boot); consumers (M23/M26/M27/M13/M30/M31/M34) resolve them via getSeam. Without a db the deny-stubs stand.
  if (deps.db) registerIpuSeams({ registerSeam }, deps.db);
  // M17 — the four §4.3 owned READ seams (VisitReader — the visit read path M8 (encounter-authoring context,
  // which CLOSES M8's visit-seeding inert consumer M8 D9) / M18 (EVV geofence target) / M14 (IDG since-meeting)
  // consume — + VisitAssignmentReader — the assignment read path M5 (the §4.5 D11 caseload-contribution
  // projection) / M19 (on-call triage) / M20 (field-safety live-awareness) consume — + PortalVisitReader — the
  // M31 portal upcoming-visit read path (lay-language, scrubbed) — + VisitMetricsProvider — the M30/M33
  // productivity + quality measures read path). Slice/tests keep the in-memory store; the Drizzle-backed store
  // lands with M17's routes/repos (M17-T07+).
  // TASK-002 — the four M17 visit seams bind the Drizzle store on a db boot. BEHAVIOR CHANGE the
  // agent flagged: `tonightsOnCallRoster` now THROWS SchedulingOnCallRosterUnavailableError (M17
  // owns no rotation table) instead of the in-memory `[]` — which is the answer M19's shift-sync
  // degraded path is built for ("unreadable" keeps the last committed shifts; `[]` would cancel them).
  registerSchedulingSeams(
    deps.db
      ? {
          store: createDrizzleSchedulingSeamStore(deps.db),
          credentials: { store: createDrizzleCredentialStore(deps.db) },
        }
      : {},
  );
  // M18 — the six §4.3 owned reader seams. `EvvBracketResolver` is published over M8's EXISTING `resolveBracket`
  // contract — this registration CLOSES M8's `encounter.period` forward seam (M8 D9), replacing its fail-closed
  // deny-stub with the real resolver. The other five (EvvComplianceReader — M23/M24 billing gate + M30 HQRP —
  // EvvAggregatorReferenceReader — M24 claim / M25 denial — EvvLocationProvider — M20 field-safety live-awareness,
  // the only coordinate-bearing seam, D10 — EvvMetricsProvider — M30/M33 dashboards — EvvVerificationProvider — M31
  // portal arrival surface) stand over their deny-stubs. Slice/tests keep the in-memory store; the Drizzle-backed
  // store lands with M18's routes/repos (M18-T06+).
  // TASK-002 — the six M18 EVV seams bind the Drizzle store on a db boot (real classified
  // compliance breakdowns — the route service's UI-003 hardcode was NOT copied; coordinate-bearing
  // reads keep the route surface's zeroed-coords D10 posture pending the decrypt pipeline).
  registerEvvSeams(
    deps.db ? { store: createDrizzleEvvSeamStore(deps.db) } : {},
  );
  // M22 — the two §4.3 published seams: `DocumentRenderer` (the §7.2 W2 render-from-typed-payload handshake
  // M5/M6/M8/M11/M12/M13/M14/M16/M17/M18/M23/M39 consume to materialize their PDFs) + `DocumentStorageProvider`
  // (the §11 D1 per-tenant object store: presign-download + version-aware destroy). Registering the renderer
  // CLOSES the forward-seam deny-stub M39 consent's Wave-C render path + every source module's m22-document-
  // backref consumer awaited. Slice/tests keep the in-memory store + in-memory object store; the Drizzle +
  // MinIO adapters land with M22's routes/worker (a later M22 task).
  // TASK-002 — the five §4.3 reader seams bind the Drizzle reader store on a db boot, and the object
  // store binds the REFUSING port (DegradedError naming the missing MinIO adapter — the audit's
  // TASK-002 risk note: never a Map wearing durable storage) when the MINIO_* env contract is absent.
  // task-15 — the zero-dep SigV4 S3/MinIO adapter binds when the MINIO_* env contract IS present
  // (official-vector-tested).
  // GAP-095 — `store:` (the renderer's document-ROW write port, distinct from `objects` above) now binds
  // the real Drizzle store over `document`/`document_version` — the SAME tables `readers` queries. Before
  // this, `store:` was never passed here, so `registerDocumentSeams` fell back to its in-memory default:
  // even when the S3 object write succeeded for real (MINIO_* present), the catalog row landed in a
  // private per-process Map no reader seam could ever see — not a restart-loses-data bug, a permanently
  // disconnected write path.
  const s3Config = deps.db ? s3ObjectStoreConfigFromEnv(process.env) : null;
  registerDocumentSeams(
    deps.db
      ? {
          store: createDrizzleDocumentSeamStore(deps.db),
          readers: createDrizzleDocumentReaderStore(deps.db),
          objects: s3Config
            ? createS3ObjectStore(s3Config)
            : createRefusingObjectStore(),
        }
      : {},
  );
  // M39 — ConsentEvaluator (§4.3, the disclosure/redaction gate). Production backs it with the Drizzle
  // store over the real M39 consent tables (FB-T03); slice/tests keep the in-memory default.
  registerConsentSeams(deps.db ? { store: createDbConsentStore(deps.db) } : {});
  registerConsentAbacPredicates(); // M39 — the 11 §4.8 ABAC predicate resolvers (resolve via the seam)
  // M7 — the five §6 predicate resolvers. `caseload_or_scope` is the SHARED patient-scope predicate that
  // M9-M15/M19-M26/M34 bind BY NAME — M3's registry denies on an unregistered name, so it must be registered
  // here (after the M5 `CaseloadProvider` / M39 `ConsentEvaluator` seams above, as the registrar's contract
  // requires), or every consumer's guard is a permanent 403. It MUST be registered at boot rather than beside
  // M7's route mount: bootSeams() runs before registerModuleRoutes(), and every registrar skips a name the
  // registry already holds, so a later re-registration is silently ignored.
  //
  // The `patientId`/collection arms resolve through the live M5 CaseloadProvider. The `planId`-keyed arms
  // resolve real M7 rows through the Drizzle `CarePlanAbacResolver` (loadPlan/loadProblem/loadVersion under
  // withOrgContext, RLS-scoped, fail-closed on absent/cross-tenant) when a DB is present; without one (the
  // DB-less dev/degraded path) they fall back to the deny-stub.
  registerCarePlanAbacPredicates({
    resolver: deps.db
      ? createDbCarePlanAbacResolver(deps.db)
      : {
          loadPlan: async () => null,
          loadProblem: async () => null,
          loadVersion: async () => null,
        },
  });
  // M33 — the two §4.7 ABAC predicate resolvers (`reportable_scope` D8 cross-cutting read scope +
  // `dashboard_visibility` §4.7.2 saved-view ladder), over the PRODUCTION Drizzle resolver when a db is
  // present (F-044). This used to be called with no argument at all, so `dashboard_visibility` ran against
  // the deny-stub in production: `loadReportView` returned null for every view, the predicate read that as
  // "absent / cross-tenant" and denied, and `GET /reporting/dashboards/:id` — which mounts it with
  // `notFoundOnDeny: true` — answered 404 for every caller including a dashboard's own owner.
  //
  // The team/location reach behind `reportable_scope` STAYS fail-closed and that is a declared absence:
  // M2 publishes no `SupervisorReader` seam in this build. Without it every actor lacking org-wide
  // authority resolves to `self`, the narrowest scope, which is the right answer to a question the
  // platform cannot yet ask.
  registerM33AbacPredicates(
    deps.db ? { resolver: buildDrizzleReportingAbacResolver(deps.db) } : undefined,
  );
  // M30 — the eleven §4.7 / §6.7 ABAC predicate resolvers (`incidentVisibility`, `ownsIncident`,
  // `assignedToIncident`, `abuseAllegationAccess`, `capVerifyAuthority`, `ownsQapiProject`,
  // `qapiCloseAuthority`, `ownsSraCycle`, `sraCloseAuthority`, `assignedToMortality`, `part2Redisclosure`).
  // Defaults to the deny-stub resolver until P2C binds the real Drizzle owner-fact loads + the M5 PrivacyFlag /
  // M39 consent reach — with the deny-stub every owner/role/visibility predicate denies and the Part-2 row
  // redaction redacts every promoted row (fail-closed, never fails open). Idempotent (the M33 precedent).
  // P2c — pass the DB handle so the real Drizzle owner-fact resolver (`buildDrizzleM30AbacResolver`) binds
  // under RLS; without a db client it stays the deny-stub (slice/tests). The M5 PrivacyFlag / M39 Part-2
  // reach behind `part2Redisclosure` stays fail-closed (not in the M1 SeamContracts).
  registerM30AbacPredicates({ db: deps.db });
  // M27 — the three §4.7 ABAC resolvers (`cost_report_editor_for_provider`,
  // `cost_report_approver_for_provider`, `cost_report_period_active`). Pass the DB handle so the real
  // Drizzle owner-fact resolver binds under RLS; with no db it defaults to the deny-stub (default-deny).
  registerM27AbacPredicates({ db: deps.db });
  // M35 — the five §4.8 ABAC resolvers (`billing_scope_matches_org`, `platform_billing_scope`,
  // `refund_requires_step_up_approval`, `plan_change_within_period_grace`, `promo_applicable_to_subscription`).
  // Pure over (context, target) — no DB handle needed; the resource-fact clauses the guard can't supply
  // (a promo's redemption count, a refund's requester) are re-asserted server-side by the route service.
  registerM35AbacPredicates();
  // M37 — the five §4.7 ABAC resolvers (`m37.ipu.rn_coverage_active`, `m37.irc_episode.within_cap`,
  // `m37.equipment.inspection_current`, `m37.gip_criteria.attester_eligible`, `m37.ipu.staff_member`). Pure
  // over (context, target) — the route write service resolves the DB fact onto the target and the §2
  // machines re-assert the invariant inside the tx (defense in depth). Default-deny.
  registerM37AbacPredicates();
  // M23 — the four §4.7 ABAC resolvers (`provider_entity_billing_scope`, `claim_in_billing_manager_caseload`,
  // `override_role_eligible`, `regulatory_required_rule_protected`). Pass the DB handle so the Drizzle
  // owner-fact resolver binds under RLS; with no db it defaults to the deny-stub (default-deny). The M5
  // CaseloadProvider axis behind `claim_in_billing_manager_caseload` stays fail-closed until that seam binds.
  registerM23AbacPredicates({ db: deps.db });
  // M25 — the two §4.7 ABAC resolvers (`claim_assigned_to_actor` denial worklist-ownership;
  // `appeal_within_deadline` the hard T-0 block on submit). Pass the DB handle so the Drizzle fact resolver
  // binds under RLS; with no db it defaults to the deny-stub (default-deny).
  registerM25AbacPredicates({ db: deps.db });
  // M26 — the five §4.7 ABAC resolvers (cap_period_open / _in_settlement / _settled /
  // _methodology_unlocked / cap_platform_admin). Pass the DB handle so the Drizzle period/settlement fact
  // resolver binds under RLS; with no db it defaults to the deny-stub (default-deny).
  registerM26AbacPredicates({ db: deps.db });
  // M24 — the six §4.8 ABAC resolvers (provider_entity_medicaid_billing_scope /
  // medicaid_claim_in_billing_manager_caseload / medicaid_override_role_eligible /
  // regulatory_required_rule_protected_medicaid / rb_arrangement_visible_in_scope /
  // state_trading_partner_credential_admin). Pass the DB handle so the Drizzle fact resolver binds under RLS;
  // with no db it defaults to the deny-stub (default-deny).
  registerM24AbacPredicates({ db: deps.db });
  // M38 — the one §4.4 ABAC resolver (`terminology_admin_platform_ops`), the platform-only conjunct on
  // the `/api/v1/admin/terminology/*` surface. Role-only (the `platform_ops` M3 RBAC role on a staff
  // session), so no DB handle: there is no owner row to load — a canonical terminology load has no
  // tenant. Registered under M38's OWN name rather than borrowing M34's identical-today
  // `tenant_lifecycle_platform_ops`, because the registry is single-owner per name (GAP-063).
  registerTerminologyAbacPredicates();
  // M33 — register the platform job id on the @wardenx/tenancy allowlist so the §4.8 platform-scoped
  // workers (the on-PRIMARY MV refresh, the lag probe, the tenant eraser) may enter withPlatformContext
  // (the allowlist starts empty → fail-closed). The M34 `wireM34Tenancy` precedent.
  wireM33Tenancy();
  // M30 — register M30's platform job id on the @wardenx/tenancy allowlist so the §4.8 cron fan-outs
  // (nightly recompute / monthly CAHPS sample / daily risk-register refresh / SRA reminders) may enter
  // withPlatformContext to enumerate active orgs (the allowlist starts empty → fail-closed). Prerequisite
  // for the cron fan-out; inert until the M2 active-org enumerator binds (issue #107, item 5). The
  // wireM33Tenancy / wireM34Tenancy precedent.
  wireM30Tenancy();
  wireM25Tenancy(); // M25 — allowlist the cron job id so the denial-aging/appeal-deadline fan-outs may enter withPlatformContext
  wireM27Tenancy(); // M27 (WX-PR-013) — allowlist the cron job id so filing-deadline-scan may enter withPlatformContext
  // TASK-040D — allowlist M7/M9/M10's cron platform job ids (same fail-closed posture as M25/M30/M33/M34).
  wireM6Tenancy();
  wireM7Tenancy();
  wireM9Tenancy();
  wireM10Tenancy();
  wireM14Tenancy(); // GAP-092 — allowlist the cron job id so idg.review-clock-sweep may enter withPlatformContext
  wireM20Tenancy(); // F-111 (#249) — allowlist the cron job id so the SOS SLA watchdog may enter withPlatformContext
  registerPlatformJob(M11_PLATFORM_JOB_ID);
  // F-071/#174 — allowlist M37's cron job id so ipu.rn-coverage-watchdog may enter withPlatformContext.
  // Without the watchdog nothing ever wrote `ipu_rn_coverage_window`, and the four write paths that read
  // it treat an absent row as uncovered — so every GIP and respite admission was refused at open.
  wireM37Tenancy();
  // F-033/#93 — allowlist the platform partition-rotation job. Unlike the module crons above this one
  // belongs to no module: the 43 time-RANGE tables it keeps ahead are spread across ~20 modules and no
  // module can see the others', so it is registered here with them rather than from a module wiring file.
  wirePartitionRotationTenancy();
  // M34 — the 8 §4.6 ABAC predicate resolvers (the platform-ops tenant surface gates on
  // `tenant_lifecycle_platform_ops`, role-only; `dsar_export_*` composes the M5 CaseloadProvider seam,
  // registered above). The grant/flag/onboarding-task resolver methods are exercised by the tenant-scoped
  // routes (Phase 2D Drizzle-backed); the platform-ops route surface mounted here uses only the role-only
  // predicate, so a fail-closed slice resolver is sufficient until the Drizzle resolver lands.
  registerTenantPlatformAbacPredicates({ resolver: SLICE_M34_ABAC_RESOLVER });
  // M34 (Phase 2D) — register M34's platform job id on the @wardenx/tenancy allowlist (the allowlist starts
  // empty; without this the platform-ops seam reads + the platform-scoped workers are REFUSED entry to
  // withPlatformContext — fail-closed). Must run before any registerLiveM34Seams read or worker run.
  wireM34Tenancy();
  // M32-T06 (§4.4 steps 4–5) — publish M32's seams over their boot deny-stubs.
  //
  // ONLY THE `AIPromptRegistry` BINDS LIVE HERE, and the asymmetry is deliberate. It is not an inference
  // surface: it is the D18/§8.5 query M12, M13, M18, M21, M27 and M28 each run at their own boot to prove
  // no active prompt template targets their AI-prohibited zone. Its deny-stub THROWS — an unwired registry
  // answering `[]` would hand six boot validators a clean bill of health minted from nothing — so leaving
  // it unregistered is not a neutral default. The artifact reader stays UNRESOLVABLE (there is no
  // `/srv/prompts` mount and no authored template this wave), which is fail-closed in the right direction:
  // the D18 prefix queries answer from the TABLE alone and need no reader, while any attempt to resolve a
  // template BODY refuses rather than serving an unpinned prompt.
  //
  // The ten §4.2 INFERENCE seams stay on their refusing deny-stubs, which is the Wave-H posture ("M32 —
  // capability shell only, `ai.full` OFF"). Standing them up needs an `AiInvocationPipeline`, and that
  // needs a per-tenant DEK envelope cipher that no module on this platform has yet (M20's write path
  // refuses for the same reason). A pipeline built without one could write plaintext PHI into a column
  // named `prompt_payload_cipher`; a deny-stub that answers `{ available: false }` costs M8 nothing,
  // because M8's Layer-1 path is what runs today either way.
  wireM32Tenancy();
  registerAiPlatformSeams(
    deps.db
      ? {
          promptRegistry: createAiPromptRegistry({
            store: createDrizzleAiPromptTemplateStore({
              db: deps.db,
              platformDb: deps.db,
              auditBypass: m34PlatformBypassAuditor,
              jobId: M32_PLATFORM_JOB_ID,
            }),
            artifacts: createUnresolvableAiPromptArtifactReader(),
          }),
        }
      : {},
  );
  // M32-T07 (§4.7) — the six named ABAC predicate resolvers. Registered here, beside the seam wiring,
  // because `ai_prohibited_zone_respected` resolves through the SAME `AIPromptRegistry` instance the
  // seam publishes: two registries would be two answers to D18's contraband question.
  //
  // WITHOUT A DB CLIENT THE DENY-STUB RESOLVER BINDS, and that is the fail-closed direction rather than a
  // convenience. M3's registry denies an UNREGISTERED name, so leaving the six unregistered would also
  // refuse — but indistinguishably from a typo, which is exactly the confusion `arch:abac-predicates`
  // exists to remove. A registered resolver that answers "no" to every question refuses for a stated
  // reason a boot log can carry.
  registerAiPlatformAbacPredicates({
    resolver: deps.db
      ? buildDrizzleAiPlatformAbacResolver({
          db: deps.db,
          promptRegistry: createAiPromptRegistry({
            store: createDrizzleAiPromptTemplateStore({
              db: deps.db,
              platformDb: deps.db,
              auditBypass: m34PlatformBypassAuditor,
              jobId: M32_PLATFORM_JOB_ID,
            }),
            artifacts: createUnresolvableAiPromptArtifactReader(),
          }),
        })
      : denyStubAiPlatformAbacResolver,
  });
  // M28-T06 (§4.3) — publish M28's three read seams (FhirGatewayMetricsProvider / FhirClientReader /
  // FhirInboundProposalReader) over their M1 deny-stubs so M33 (utilization) / M30 (§164.528 disclosure
  // scorecard) / M34 (SaaS console) / M5 + M12 (inbound-proposal review queues) can resolve them via
  // getSeam. Registration is STORE-GATED: with a db the Drizzle store binds all three; a db-less boot
  // passes none and the fail-closed deny-stubs stand, exactly like M19/M20. A consumer reaching an
  // unbound M28 seam denies LOUDLY rather than reading a fabricated empty projection.
  //
  // (The comment here used to say this wave passed NO store and the call was a no-op. It has passed the
  // store on every db boot for as long as the store has existed; an external audit read the comment,
  // not the argument, and filed "registers none of its three published seams" — F-035/#95.)
  registerFhirPublishedSeams(
    deps.db ? { store: createDrizzleFhirPublishedSeamStore(deps.db) } : {},
  );
  // M28-T08 (§4.7) — the six named ABAC predicate resolvers. Registered beside the seam wiring; the
  // db-less path binds the deny-stub resolver, which refuses for a STATED reason a boot log can carry
  // (M3 denies an unregistered name too, but indistinguishably from a typo — the confusion
  // `arch:abac-predicates` exists to remove). The consent/BAA ports stay unbound this wave, so
  // `fhir_export_recipient_authorized` and `fhir_client_active` deny fail-closed — both are route-unbound
  // in Phase 1 (the FHIR-spec bearer surface enforces them in the handler).
  registerFhirGatewayAbacPredicates({
    resolver: deps.db
      ? buildDrizzleFhirGatewayAbacResolver({
          db: deps.db,
          permissions: createDbEffectivePermissionStore(deps.db),
        })
      : denyStubFhirGatewayAbacResolver,
  });
  // M29-T08 (§4.4) — publish M29's five read seams (LabObservationReader / Hl7InboundProposalReader /
  // ExternalFeedReader / NppesProviderReader / ExternalInterfaceMetricsProvider) over their M1 deny-stubs.
  // STORE-GATED (the M28/M19/M20 posture): a db-less boot passes no store and the fail-closed deny-stubs
  // stand, so M28's DiagnosticReport egress / M5+M6 review badges / M33+M34 feed status deny LOUDLY rather
  // than reading a projection minted from an unwired store.
  registerM29PublishedSeams(
    deps.db ? { store: createDrizzleM29PublishedSeamStore(deps.db) } : {},
  );
  // M29-T08 (§4.8) — the six named ABAC predicate resolvers. The resolver binds the M3 effective-permission
  // store + a LAZY M5 CaseloadProvider adapter (resolved via getSeam at call time, so a not-yet-registered
  // M5 provider fails closed via the registry deny-stub, never at boot). The db-less path binds the deny-stub
  // resolver, which refuses for a STATED reason (`arch:abac-predicates` distinguishes it from a typo).
  registerM29AbacPredicates({
    resolver: deps.db
      ? buildDrizzleM29AbacResolver({
          db: deps.db,
          permissions: createDbEffectivePermissionStore(deps.db),
          caseload: {
            isInCaseload: (input) =>
              getSeam("CaseloadProvider").isInCaseload(input),
          },
        })
      : denyStubM29AbacResolver,
  });
  // M34 — register the PACKAGE-OWNED seams (the D5 `TenantKeyProvider` + the lifecycle/onboarding/support/
  // export-shard publishes). These live in `@wardenx/saas-tenant-platform`'s own registry (M1 imports the
  // `TenantKeyProvider` interface, so the live-impl home is the package, not the M1 registry).
  // `validateModule34Seams()` HARD-FAILS boot if the mandatory `TenantKeyProvider` is absent (D5) — so the
  // platform never serves a request whose PHI ciphertext it cannot key. Phase 2D: when a DB client is
  // present, `registerLiveM34Seams` binds the REAL Drizzle-backed providers (lifecycle/onboarding/support
  // reads over the §3 repos under withOrgContext/withPlatformContext + the D5 key provider over the real
  // key-ring repo + the injected KEK-unwrap port — the KEK adapter itself is the one typed-TODO, fail-closed
  // on call). Without a DB client (tests / no-db boot) the fail-closed slice key provider keeps boot green.
  if (deps.db) {
    const gatewayConfig = m34ProvisionGatewayConfigFromEnv(process.env);
    const gateway = gatewayConfig ? createM34ProvisionGateway(gatewayConfig) : null;
    // #105 — the platform KEK. Preferred over the gateway's `/dek/unwrap` because a KEK held by this
    // process is a key this deployment actually has, where the provision gateway is an HTTP service that
    // is unspecified and undeployed (#115): the whole per-tenant DEK chain hung off a call to nothing.
    // A KMS/HSM deployment replaces this one binding and nothing else (ADR-0045; the port is unchanged).
    const platformKek = loadPlatformKekRing(process.env);
    const kek = platformKek ? createPlatformKekAdapter(platformKek) : null;
    registerLiveM34Seams({
      db: deps.db,
      auditBypass: m34PlatformBypassAuditor,
      kekUnwrap: kek ?? gateway?.kekUnwrap,
      // NOT `deps.db`: migration 0052 §5 revokes wardenx_app's SELECT on tenant_key_ring, so the request
      // path's credential cannot read a wrapped DEK at all. The platform login holds the grant.
      keyRingDb: deps.platformDb,
    });
  } else {
    bootstrapModule34(SLICE_MODULE_34_SEAM_DEPS);
  }
  validateModule34Seams();
  // ── TASK-001 ledger (production-readiness audit 2026-08-03, ARCH-003) ───────────────────────────
  // Every registrar above that STILL stands an in-memory store behind a published seam on a
  // db-present boot is recorded here, beside the wiring that chose it. A per-process Map wearing a
  // seam contract answers "no rows" about a database it never read — a silent clinical lie, not a
  // neutral default. assertNoInMemoryBindingsOnDbBoot (before listen()) lists these loudly in dev
  // and refuses to boot in production until TASK-002 binds the Drizzle stores; each fix deletes its
  // note in the same diff.
  if (deps.db) {
    const t2 = "TASK-002 (bind Drizzle seam stores)";
    // M22's note is GONE (GAP-023/024/038 removes it): GAP-095 bound `store:` to the real Drizzle
    // document-row write store — twenty lines above, at the registerDocumentSeams call — but left this
    // note behind, so a stale line kept claiming a Map stood behind the renderer and, since this ledger
    // REFUSES a production boot, kept refusing one. The remaining M22 gap is the object store, and that
    // one binds `createRefusingObjectStore()` (a loud DegradedError naming the missing MINIO_* contract)
    // rather than a Map: refusing is the correct posture, not a fake-success this ledger exists to catch.
    if (!deps.outboxPublisher) {
      // Slice boots that pass a db but no catalog publisher keep the in-memory PatientMutator.
      noteInMemoryBinding({
        kind: "seam",
        label:
          "M5 registerPatientSeams — PatientMutator on an in-memory store (no outbox publisher supplied)",
        task: t2,
      });
    }
  }
  // M3 — flip the Authorization Contract's ABAC evaluator from its fail-closed DENY_ALL default to the
  // named-predicate registry, NOW that every module above has registered its predicates. Without this
  // single call, every `requireAbac`/`requireStepUp` route denies in production: the predicates exist
  // but the evaluator was never pointed at the registry that holds them. Idempotent (sets the evaluator
  // seam), so test re-boots that call wireModuleSeams() repeatedly stay safe.
  registerAbacRegistry();
  // Phase-1 producers append here as they land.
}

/**
 * M34 `platform.bypass_invoked` auditor (audit #9). M1's @wardenx/tenancy requires a `PlatformBypassAuditor`
 * for EVERY `withPlatformContext` entry, so "every cross-tenant read is audited" is a type-level guarantee.
 * This binds M4's PLATFORM-SCOPED audit helper over the platform tx the bypass runs on: it writes one
 * `platform.bypass_invoked` row (organizationId null — a cross-tenant action has no single org; actorKind
 * `system`; the caller's jobId + reason in context) at the event's own severity, atomically with the platform
 * work. If the write fails it propagates, so the cross-tenant read fails rather than serving an UNAUDITED
 * bypass (the fail-closed posture).
 *
 * Uses `auditPlatformEvent` (NOT the plain `audit()` helper, WX-PR-024): `audit()`'s `tx.insert(...)` runs as
 * the caller's own role — `wardenx_app` in production — which holds no INSERT policy admitting a null-org
 * `audit_event` row (ADR-0010 bans a policy shaped to allow it). `auditPlatformEvent` instead calls the
 * SECURITY DEFINER `audit_writer_insert_platform_event` function (migration 0187), so this write actually
 * succeeds under real RLS instead of throwing on every `withPlatformContext` entry codebase-wide.
 */
export const m34PlatformBypassAuditor: PlatformBypassAuditor<DbClient> = async (
  tx,
  event,
) => {
  await auditPlatformEvent(tx, {
    eventType: "platform.bypass_invoked",
    resourceKind: "tenant",
    outcome: "success",
    severity: event.severity,
    correlationId: `platform-bypass:${event.jobId}:${randomUUID()}`,
    context: { jobId: event.jobId, reason: event.reason },
  });
};

/**
 * Fail-closed slice `TenantKeyProvider` (D5) so `validateModule34Seams()` passes at boot before the real
 * KMS-backed key provider lands. Every method THROWS — the platform has no live PHI ciphertext to key in the
 * slice/local boot, so a resolve is a programming error, not a silent fail-open. This satisfies the mandatory
 * D5 registration without handing out a real key.
 *
 * This is the DB-LESS boot only. The db-present path binds the real key-ring provider over the platform KEK
 * (`registerLiveM34Seams` above, #105 / ADR-0045); a comment in M27 spent a while citing THIS stub as the
 * reason the per-tenant DEK was unavailable in production, which sent readers to the wrong branch entirely.
 */
const SLICE_MODULE_34_SEAM_DEPS: BootstrapModule34Deps = {
  tenantKeyProvider: {
    async dekForOrg() {
      throw new Error(
        "M34 TenantKeyProvider: slice deny-stub — the KMS-backed provider lands Phase 2D",
      );
    },
    async dekForOrgVersion() {
      throw new Error(
        "M34 TenantKeyProvider: slice deny-stub — the KMS-backed provider lands Phase 2D",
      );
    },
    async keyRingState() {
      return "absent";
    },
  },
};

/**
 * Fail-closed slice resolver for M34's §4.6 ABAC predicates registered at boot. Every owner-fact load
 * denies (returns null/false) — the platform-ops tenant-lifecycle routes only exercise the role-only
 * `tenant_lifecycle_platform_ops` predicate, so these methods are never reached for that surface. The
 * Phase-2D Drizzle-backed resolver (loading grant/flag/onboarding-task facts under RLS) replaces this.
 */
const SLICE_M34_ABAC_RESOLVER: TenantPlatformAbacResolver = {
  hasActiveConsentedSupportSession: async () => false,
  loadConsentGrant: async () => null,
  loadFeatureFlag: async () => null,
  loadOnboardingTask: async () => null,
};

/**
 * Register every module's REAL data eraser over the Phase-0 deny-stubs. Passed to
 * buildServer() as `registerModuleErasers`, it runs inside bootSeams() AFTER wireErasers()
 * (which deny-stubs every REQUIRED_ERASERS class) and before validateErasers(), so a real
 * eraser stands over its stub. A right-to-erasure request then hits a working eraser, not a
 * silent no-op (M2-T10).
 */
export function wireModuleErasers(
  deps: {
    db?: DbClient;
    platformDb?: DbClient;
    /**
     * The destruction-granted credential (DATABASE_DESTRUCTION_URL → a login role IN ROLE
     * wardenx_destruction, migration 0157). The append-only clinical/billing tables grant
     * wardenx_app no DELETE, so per-patient erase stores bind THIS pool when present; absent, they
     * bind the tenant pool and the first privileged statement fails loudly (permission denied) —
     * never a certificate for undone work. M4's audit-row executor binds ONLY this (typed UNBOUND
     * otherwise — audit_event is append-only for every app role).
     */
    destructionDb?: DbClient;
  } = {},
): void {
  // TASK-003 (ARCH-007) — every registrar below binds its Drizzle erase store on a db boot, so a
  // right-to-erasure request touches REAL rows and its certificate counts what was actually
  // destroyed. Grant caveats (each fails LOUDLY, never a fake certificate): the append-only
  // clinical/billing tables (M7–M13, M23, M25) grant wardenx_app no DELETE — the erase path needs
  // the destruction-granted credential at deployment; M4's performErasure throws typed-UNBOUND
  // (audit_event is HELPER_ONLY + append-only — the crypto-erase adapter lands in packages/audit);
  // M36's sole-tenant-user leg refuses without a platform membership enumerator (D9 is an
  // inherently cross-tenant read); M40's provisional DELETE awaits its grant.
  const db = deps.db;
  // Privileged erase pool: the destruction credential when provisioned, else the tenant pool
  // (whose missing DELETE grants make the erase fail loudly — the honest interim).
  const eraseDb = deps.destructionDb ?? db;
  registerIdentityErasers(
    db ? { store: createDrizzleIdentityEraserStore(db) } : {},
  ); // M2 — `identity`
  registerAuditErasers(
    db
      ? {
          store: createDrizzleAuditEraserStore(db),
          // performErasure binds the packages/audit executor ONLY over the destruction credential;
          // without it the typed UNBOUND throw stands (never the tenant pool — no DELETE grant).
          ports: createDrizzleAuditEraserPorts(
            db,
            deps.destructionDb ? { destructionDb: deps.destructionDb } : {},
          ),
        }
      : {},
  ); // M4 — `audit_event`
  registerTerminologyErasers(
    eraseDb ? { store: createDrizzleTerminologyEraseStore(eraseDb) } : {},
  ); // M38
  // M36 — the D9 sole-tenant-user leg resolves through the audited platform-context membership
  // read when the platform credential is present; without it that ONE leg keeps its typed refusal.
  registerMessagingErasers(
    db
      ? {
          store: createDrizzleMessagingEraseStore(
            eraseDb ?? db,
            deps.platformDb
              ? {
                  soleTenantUserIds: buildSoleTenantUserResolver({
                    platformDb: deps.platformDb,
                    auditBypass: m34PlatformBypassAuditor,
                    jobId: M36_SOLE_TENANT_JOB_ID,
                  }),
                }
              : {},
          ),
        }
      : {},
  );
  registerMdmErasers(
    eraseDb ? { store: createDrizzleMdmEraseStore(eraseDb) } : {},
  ); // M40 — `mdm_tenant_overlays`
  registerPatientErasers(
    eraseDb ? { store: createDrizzlePatientEraseStore(eraseDb) } : {},
  ); // M5 — `clinical_record`
  registerConsentErasers(
    eraseDb ? { store: createDrizzleConsentEraseStore(eraseDb) } : {},
  ); // M39 — `consent`
  registerAdmissionErasers(
    eraseDb ? { store: createDrizzleAdmissionEraseStore(eraseDb) } : {},
  ); // M6 — `admission_record`
  registerCarePlanErasers(
    eraseDb ? { store: createDrizzleCarePlanEraseStore(eraseDb) } : {},
  ); // M7 — `care_plan_record`
  registerEncounterErasers(
    eraseDb ? { store: createDrizzleEncounterEraseStore(eraseDb) } : {},
  ); // M8 — `encounter_record`
  registerAssessmentErasers(
    eraseDb ? { store: createDrizzleAssessmentEraseStore(eraseDb) } : {},
  ); // M9 — `clinical_assessment`
  registerHopeErasers(
    eraseDb ? { store: createDrizzleHopeEraseStore(eraseDb) } : {},
  ); // M10 — `hope_record` (CMS 10-year block in the orchestrator)
  registerOrderErasers(
    eraseDb ? { store: createDrizzleOrderEraseStore(eraseDb) } : {},
  ); // M11 — `order_record`
  // M12 — `medication_order_record`; the injected M11 cascade removes the med-order-targeted
  // signature/verbal rows at erase time (task-15 — the cross-eraser ownership decision).
  registerDoseSpotErasers(
    eraseDb
      ? {
          store: createDrizzleMedicationOrderEraseStore(eraseDb, {
            orderSignatureCascade:
              createMedicationOrderSignatureCascade(eraseDb),
          }),
        }
      : {},
  );
  registerEmarErasers(
    eraseDb ? { store: createDrizzleEmarEraseStore(eraseDb) } : {},
  ); // M13 — `emar_record`
  // M15-T06 — `discipline_plan_record` (per-PATIENT destruction-cert callback; scrubs the version
  // `state_snapshot` + assessment `data` jsonb FIRST, deletes the discipline subtree, tombstones the plan
  // roots for FK integrity; the workforce-scoped volunteer gate/ledger/hour rows survive, §8.5). The
  // Drizzle store binds when a DB client is present; without one the slice's in-memory store stands.
  registerDisciplinePlanErasers(
    deps.db ? { store: createDrizzleDisciplinePlanEraseStore(deps.db) } : {},
  );
  // M16-T06 — `bereavement_record` (per-DECEDENT destruction-cert callback; shreds the contact channel
  // ciphers + the contact-log notes + the risk `risk_factors_jsonb` FIRST, deletes the survivor subtree,
  // tombstones the plan root for FK integrity. The `bereavement_plan_closure` row SURVIVES with its
  // narrative shredded — §7.15 survey reconstruction — and the org-scoped external-source gate override is
  // tenant config that is never touched, §8.5). The Drizzle store binds when a DB client is present;
  // without one the slice's in-memory store stands.
  registerBereavementErasers(
    deps.db ? { store: createDrizzleBereavementEraseStore(deps.db) } : {},
  );
  registerIdgErasers(
    eraseDb ? { store: createDrizzleIdgEraseStore(eraseDb) } : {},
  ); // M14 — `idg_record` (patient-scoped rows; meetings/minutes survive, minutes hash-redacted)
  // M22 — `documents`. With the MINIO_* env contract the erase destroys real object versions via
  // the SigV4 adapter (task-15); without it, object destruction refuses via DegradedError BEFORE
  // any row delete (retryable, never orphaned keys).
  {
    const s3EraseConfig = eraseDb
      ? s3ObjectStoreConfigFromEnv(process.env)
      : null;
    registerDocumentErasers(
      eraseDb
        ? {
            store: createDrizzleDocumentEraseStore(
              eraseDb,
              s3EraseConfig
                ? { objects: createS3ObjectStore(s3EraseConfig) }
                : {},
            ),
          }
        : {},
    );
  }
  // M34 — `saas_tenant_platform_class` runs entirely under withPlatformContext (subjectId = ORG), so
  // it binds the PLATFORM credential, not the tenant pool; without one the in-memory slice stands
  // and the ledger records it (the M35 platform-runner posture).
  registerSaasTenantPlatformErasers(
    deps.platformDb
      ? {
          store: createDrizzleSaasTenantPlatformEraseStore({
            platformDb: deps.platformDb,
            auditBypass: m34PlatformBypassAuditor,
          }),
        }
      : {},
  );
  registerReportingErasers(
    eraseDb ? { store: createDrizzleReportingEraseStore(eraseDb) } : {},
  ); // M33 — `reporting_class` (drilldown audit count-only, destruction-blocked)
  registerQualityErasers(
    eraseDb ? { store: createDrizzleQualityEraseStore(eraseDb) } : {},
  ); // M30 — `quality_class` (compliance/survey evidence count-only, destruction-blocked)
  registerCostReportErasers(
    eraseDb ? { store: createDrizzleCostReportEraseStore(eraseDb) } : {},
  ); // M27 — `cost_report_class` (evidence delete refuses until the M4 elevated destruction-cert binding lands)
  registerBillingErasers({
    registerEraser,
    ...(db ? { store: createDrizzleBillingEraseStore(eraseDb ?? db) } : {}),
  }); // M23 — `billing_record` (in-flight guards refuse; MAC-secret shred is the org-destruction path). registerEraser INJECTED (M23 may not import the M1 registry).
  registerRemittanceErasers({
    registerEraser,
    ...(db ? { store: createDrizzleRemittanceEraseStore(eraseDb ?? db) } : {}),
  }); // M25 — `remittance` (PR-ledger only; line/adjustment history rolls off via the M4 partition manager).
  registerMedicaidErasers({
    registerEraser,
    ...(db ? { store: createDrizzleMedicaidRedactStore(eraseDb ?? db) } : {}),
  }); // M24 — `medicaid_billing_record` (redact-to-shred; FK chain survives). Distinct from M23's class.
  registerCapErasers({
    registerEraser,
    ...(db ? { store: createDrizzleCapRedactStore(eraseDb ?? db) } : {}),
  }); // M26 — `cap` (redact-to-sentinel, D14 — aggregates survive for CMS reconciliation).
  // M21-T05 — `supply_record` (per-PATIENT destruction-cert callback). UNLIKE every eraser above it does
  // not delete the controlled-substance rows: DEA 21 CFR §1304.04 requires the perpetual inventory record
  // to survive, so the `supply_request` rows are shredded-then-deleted while the `comfort_kit_dispatch` /
  // `comfort_kit_return` headers are DE-IDENTIFIED IN PLACE and their `*_content` lot lines (which carry
  // no patient column at all) are left untouched. Org-scoped catalog / template / routing / par-stock
  // config is never touched. Registers only with a DB client — the shred is a privileged write, and a
  // slice boot must keep the deny-stub rather than report a destruction it did not perform.
  if (deps.db) registerSupplyEraser(deps.db);
  // M19-T02 — `triage_record` (per-PATIENT destruction-cert callback; nulls the caller identity, chief
  // complaint and the two DEK ciphers on the patient's `triage_call` rows FIRST, deletes the escalation /
  // answer / state-history subtree, then leaves each call as a de-identified closed TOMBSTONE because M8's
  // signed `triage_telephonic_contact` encounter back-references it. The org-scoped policy / vendor binding
  // / protocol catalog and the CoP 418.100(c)(2) `on_call_shift` roster evidence are never touched, §3.7).
  // The Drizzle store binds when a DB client is present; without one the slice's in-memory store stands.
  registerTriageErasers(
    deps.db ? { store: createDrizzleTriageEraseStore(deps.db) } : {},
  );
  // M20-T02 — `safety_record` (per-PATIENT destruction-cert callback that DELETES NOTHING: §3.7 files ten
  // of M20's thirteen tables as "structural row retained with redacted markers". It redacts the free text
  // §3.5 says may describe the patient on the incidents and SOS alerts linked to them, redacts `action_taken`
  // on the attached acknowledgments, and LAST severs the patient/visit linkage. The clinician's own SOS
  // coordinates and location stream, both check-in tables, the policy-version replay rows, the supervisor
  // subscriptions, the advisory polygons and the clinician's emergency-contact consent are never touched —
  // that is a different data subject's workers-comp evidence.) The Drizzle store binds when a DB client is
  // present; without one the slice's in-memory store stands.
  registerSafetyErasers(
    deps.db ? { store: createDrizzleSafetyEraseStore(deps.db) } : {},
  );
  // M32-T02 — `clinical_record_ai_provenance` + `intake_ai_provenance` (per-PATIENT destruction-cert
  // callbacks that DELETE NOTHING: `ai_invocation` is the §164.528 disclosure ledger, so the rows survive
  // with their token counts, model pin, ZDR flag and timestamps — the evidence that a disclosure to a
  // model vendor happened, or that it did not — while the CIPHERTEXT on that patient's rows is destroyed
  // in place. The per-tenant DEK shred §3.7 describes is the whole-org offboarding path and belongs to
  // M34; a per-patient certificate cannot shred a key that protects every other patient. Split by
  // capability: `doclens_*` = the patient's intake documents, everything else = the chart. The token
  // ledger, the hallucination reports and the platform-shared governance surface are never touched.)
  // The Drizzle store binds when a DB client is present; without one the slice's in-memory store stands.
  registerAiProvenanceErasers(
    deps.db ? { store: createDrizzleAiProvenanceEraseStore(deps.db) } : {},
  );
  // M28-T08 — the §3.7 `fhir_gateway` eraser (org-offboarding destruction: subjectId=org). NOT a delete of
  // the §164.528 disclosure record — a targeted shred of the cursor-signing key, the credential ciphers,
  // the export/session rows and the inbound payloads, while every accounting row survives. The Drizzle
  // store binds when a DB client is present; without one the in-memory slice store stands.
  registerFhirGatewayEraser(
    deps.db ? { store: createDrizzleFhirGatewayEraseStore(deps.db) } : {},
  );
  // M31-T06 — `portal_record` (per-PATIENT destruction-cert callback, §3.7/D15): aborts the patient's active
  // telehealth visits and shreds their vendor-room recording refs, revokes the patient's grants with
  // `revoke_cascade_source='destruction'`, and flips any account the revocation left with no active grant to
  // ANY patient to `revoked` (contact ciphers shredded). The recording BYTES in MinIO are M22's to
  // crypto-erase — M31 owns only the refs. Registers only with a DB client (the shred is a privileged write);
  // a slice boot keeps the deny-stub rather than report a destruction it did not perform.
  if (deps.db) registerPortalErasers(deps.db);
  // M37-T11 — `ipu_record` (per-PATIENT destruction-cert callback, §7.7 / D8): deletes the patient's
  // ipu_admission subtree in FK order + the per-patient visitor restrictions under RLS (DELETE grants,
  // migration 0153); aggregate census snapshots survive (no patient_id, D14). Registers only with a DB
  // client (the delete is a privileged tenant-pool write); a slice boot keeps the deny-stub.
  if (deps.db) registerIpuErasers(deps.db);
  // ── TASK-001 ledger (production-readiness audit 2026-08-03, ARCH-007) ───────────────────────────
  // Every registrar above called WITHOUT a Drizzle erase store on a db-present boot binds an
  // in-memory slice store: a right-to-erasure request "succeeds" against rows that exist nowhere and
  // mints a destruction certificate from nothing — the exact fake-success Phase 0 exists to stop.
  // assertNoInMemoryBindingsOnDbBoot (before listen()) lists these loudly in dev and refuses to boot
  // in production until TASK-003 binds the Drizzle stores (the M15/M16/M28 `deps.db ? {store} : {}`
  // pattern); each fix deletes its line here in the same diff.
  if (deps.db && !deps.platformDb) {
    // The one remaining conditional: M34's org-offboarding eraser needs the platform credential.
    noteInMemoryBinding({
      kind: "eraser",
      label:
        "M34 registerSaasTenantPlatformErasers — 'saas_tenant_platform_class' erase store (no DATABASE_PLATFORM_URL; the cross-tenant deletes need the platform credential)",
      task: "deployment config (provision the platform login role + set DATABASE_PLATFORM_URL)",
    });
  }
  // Phase-1 data-class owners append here as they land.
}

/**
 * TASK-040A (OPS-002/003) — which slice of the composition root this process runs:
 *   · "all"    — routes + BullMQ workers/cron + outbox dispatcher, all in one process. The
 *                historical (and still default) shape — unchanged for `bun src/index.ts` / `dev`.
 *   · "api"    — routes only. SKIPS constructing BullMQ Workers/repeatable-cron Queues and the
 *                outbox dispatcher, so horizontally-scaled API replicas stop each independently
 *                re-registering the same repeatable cron schedules / competing for the same jobs.
 *   · "worker" — the background half: BullMQ workers/cron + the outbox dispatcher, on its own
 *                port (`WORKER_PORT`, default 3001) serving only /health + /ready for its own
 *                liveness/readiness probes. Routes stay mounted too (cheap — pure registration,
 *                no connections opened) rather than forking `registerModuleRoutes`'s ~1000-line
 *                closure; trimming that surface for a pure-worker deploy is a follow-up, not a
 *                correctness requirement here (no job processor calls back through HTTP).
 */
type ProcessRole = "all" | "api" | "worker";

/**
 * The composition root. Exported (not just run inline behind `import.meta.main`) so a SEPARATE
 * entrypoint (`worker.ts`, TASK-040A) can invoke the exact same boot sequence with `role: "worker"`
 * — `import.meta.main` is per-entry-file (Bun runtime semantics), so a file that merely imports
 * this module can never trip that guard itself; calling the exported function directly sidesteps
 * that instead of duplicating ~1200 lines of composition-root wiring into a second file.
 */
function buildFirstAdminAcceptanceService(deps: {
  db: DbClient;
  platformDb: DbClient;
  auditBypass: PlatformBypassAuditor<DbClient>;
}): SignupIntentRouteService {
  const disabled = (): never => {
    throw new WardenXError(
      "SIGNUP_DISABLED",
      "self-serve signup is not enabled",
      503,
    );
  };
  return {
    async createIntent() {
      return disabled();
    },
    async verifyEmail() {
      return disabled();
    },
    async acceptInvitation(rawToken, args) {
      const tokenHash = createHash("sha256").update(rawToken).digest("hex");
      await withPlatformContext(
        deps.platformDb,
        {
          jobId: "m34.platform_ops",
          reason: "resolve first-admin invitation",
          crossTenant: true,
        },
        deps.auditBypass,
        async (platformTx) => {
          const [invitation] = await platformTx
            .select()
            .from(schema.tenantInvitation)
            .where(eq(schema.tenantInvitation.tokenHash, tokenHash))
            .limit(1)
            .for("update");
          if (!invitation) {
            throw new WardenXError(
              "INVITATION_INVALID",
              "invitation is invalid",
              404,
            );
          }
          if (
            invitation.status !== "pending" ||
            invitation.expiresAt <= new Date()
          ) {
            throw new WardenXError(
              "INVITATION_INVALID",
              "invitation is expired or already used",
              409,
            );
          }

          const userId = await withOrgContext(
            deps.db,
            { organizationId: invitation.organizationId, userId: "" },
            async (tx) => {
              const email = invitation.inviteeEmail.trim().toLowerCase();
              await tx
                .insert(schema.users)
                .values({
                  email,
                  emailVerified: true,
                  name: args.displayName ?? invitation.inviteeFullName,
                })
                .onConflictDoNothing({ target: schema.users.email });
              const [user] = await tx
                .select()
                .from(schema.users)
                .where(eq(schema.users.email, email))
                .limit(1);
              if (!user) throw new Error("first-admin user resolution failed");

              let [membership] = await tx
                .select()
                .from(schema.memberships)
                .where(
                  and(
                    eq(schema.memberships.userId, user.id),
                    eq(
                      schema.memberships.organizationId,
                      invitation.organizationId,
                    ),
                    ne(schema.memberships.status, "revoked"),
                  ),
                )
                .limit(1);
              if (!membership) {
                [membership] = await tx
                  .insert(schema.memberships)
                  .values({
                    userId: user.id,
                    organizationId: invitation.organizationId,
                    status: "active",
                    acceptedAt: new Date(),
                  })
                  .returning();
              } else if (membership.status !== "active") {
                [membership] = await tx
                  .update(schema.memberships)
                  .set({ status: "active", acceptedAt: new Date() })
                  .where(eq(schema.memberships.id, membership.id))
                  .returning();
              }
              if (!membership)
                throw new Error("first-admin membership creation failed");

              const [orgAdmin] = await tx
                .select()
                .from(schema.roles)
                .where(
                  and(
                    isNull(schema.roles.organizationId),
                    eq(schema.roles.key, "org_admin"),
                  ),
                )
                .limit(1);
              if (!orgAdmin)
                throw new Error("org_admin role template is unavailable");
              await tx
                .insert(schema.membershipRoles)
                .values({
                  organizationId: invitation.organizationId,
                  membershipId: membership.id,
                  roleId: orgAdmin.id,
                  grantedBy: user.id,
                })
                .onConflictDoNothing({
                  target: [
                    schema.membershipRoles.membershipId,
                    schema.membershipRoles.roleId,
                  ],
                });
              return user.id;
            },
          );

          const consumed = await platformTx
            .update(schema.tenantInvitation)
            .set({
              status: "consumed",
              consumedAt: new Date(),
              consumedByUserId: userId,
            })
            .where(
              and(
                eq(schema.tenantInvitation.id, invitation.id),
                eq(schema.tenantInvitation.status, "pending"),
              ),
            )
            .returning({ id: schema.tenantInvitation.id });
          if (consumed.length !== 1) {
            throw new WardenXError(
              "INVITATION_INVALID",
              "invitation was already used",
              409,
            );
          }
        },
      );
      return { accepted: true };
    },
  };
}

export async function bootWardenX(role: ProcessRole = "all"): Promise<void> {
  // audit #M2 — fail closed if a production secret is missing/weak (BETTER_AUTH_SECRET, TRUSTED_ORIGINS,
  // TWO_FACTOR_ENCRYPTION_KEY, DATABASE_URL, BETTER_AUTH_URL). No-op in dev/test. Runs first so a
  // misconfigured production deploy refuses to boot rather than serving with a weak/absent secret.
  assertProductionEnv();
  // M4-T10 — fail closed if the consolidated audit action catalog has a D9 namespace/uniqueness
  // violation (§4.6.7) before the server serves a single request.
  assertAuditActionCatalog();
  // AUTH-T01 (ADR-0033): build the production DB client when configured, and inject it. Consumed by
  // the Better Auth mount (AUTH-T02) + repositories. Absent DATABASE_URL → the host still boots
  // (the auth handler is mounted only when a DB client is present).
  const dbHandle = process.env.DATABASE_URL
    ? createDbClient({ connectionString: process.env.DATABASE_URL })
    : undefined;
  // M35 §5.2 platform-ops admin surface runs its cross-tenant reads/writes through a SEPARATE platform
  // credential — NOT the tenant `wardenx_app` pool. The six PLATFORM-ONLY M35 tables
  // (revenue_recognition_snapshot, stripe_webhook_event, patient_pseudonym_key, stripe_api_call_audit,
  // platform_retained_invoice[_line]; migration 0143) have RLS enabled with NO wardenx_app grant, so a
  // tenant-pool read fails closed with `permission denied`. DATABASE_PLATFORM_URL points at a least-privilege
  // platform login role (SELECT/write on those tables + the org-scoped M35 tables it reads cross-tenant +
  // audit_event INSERT + BYPASSRLS). Absent → the M35 platformRunner below stays undefined and the admin
  // surface is fail-closed (503) — the prod-safe default (never the superuser, never the tenant pool).
  const platformDbHandle = process.env.DATABASE_PLATFORM_URL
    ? createDbClient({ connectionString: process.env.DATABASE_PLATFORM_URL })
    : undefined;
  // TASK-003 follow-up — the DESTRUCTION credential (a login role IN ROLE wardenx_destruction,
  // migration 0157: DELETE/UPDATE grants scoped to exactly what the erase stores execute, org-pinned
  // RLS policies — never BYPASSRLS). The append-only clinical/billing tables grant wardenx_app no
  // DELETE, so without this the per-patient erase paths fail loudly at the first privileged
  // statement and M4's audit-row executor stays typed-UNBOUND.
  const destructionDbHandle = process.env.DATABASE_DESTRUCTION_URL
    ? createDbClient({ connectionString: process.env.DATABASE_DESTRUCTION_URL })
    : undefined;
  if (!destructionDbHandle) {
    console.warn(
      "⚠️  DATABASE_DESTRUCTION_URL is not configured: right-to-erasure paths over append-only tables (clinical core, billing, audit_event) will fail loudly rather than certify undone work.",
    );
  }
  if (platformDbHandle) registerPlatformJob("m35-subscription-admin");
  if (platformDbHandle) registerPlatformJob(M8_PLATFORM_JOB_ID);
  if (platformDbHandle) registerPlatformJob(M17_PLATFORM_JOB_ID);
  // M36 D9 — the sole-tenant membership read the offboarding eraser runs (audited platform entry).
  if (platformDbHandle) registerPlatformJob(M36_SOLE_TENANT_JOB_ID);
  // audit C1 — RLS is the tenancy control, and a role with BYPASSRLS makes every policy decorative.
  // The migrator now gates that grant on WARDENX_DEV_BYPASSRLS + non-production, but a grant applied
  // by hand (or by an older migrate run against this cluster) would leave no trace at boot. Ask the
  // cluster directly and refuse to serve. Dev/test only warn — the local single-org demo needs the
  // bypass for pre-org reads until the platform pool lands.
  if (dbHandle) {
    const bypassing = await dbHandle.db.execute(
      sql`SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    const row = (
      bypassing as unknown as { rows?: Array<{ rolbypassrls?: boolean }> }
    ).rows?.[0];
    if (row?.rolbypassrls === true) {
      const message =
        "the database role this process connects as (current_user) has BYPASSRLS: " +
        "row-level security is NOT enforced for any query, on any table.";
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          `Refusing to boot — ${message} Revoke it (ALTER ROLE … NOBYPASSRLS).`,
        );
      }
      console.warn(`⚠️  ${message} (permitted outside production)`);
    }
  }
  // Phase 2D — the Valkey/Redis connection the M34 §4.3 BullMQ Queue producers + Workers open over. Parsed
  // from REDIS_URL (the same env M1 infra wires the rate-limit store from). Absent → the M34 command routes'
  // enqueue ports + the worker construction stay fail-closed (a typed throw), never a silent drop. The M4-T11
  // audit workers use the SAME connection shape; both are constructed in the worker-runner section below.
  const queueConnection: ConnectionOptions | undefined = parseRedisConnection(
    process.env.REDIS_URL,
  );
  const m23LaunchConfig = m23LaunchGatewayConfigFromEnv(process.env);
  const m23LaunchGateway = m23LaunchConfig
    ? createM23LaunchGateway(m23LaunchConfig)
    : null;
  // WX-PR-012 — the M25 x12-worker sidecar transport, gated the same way (unset in dev/test/CI so
  // nothing calls out by accident; `undefined` falls through to `createX12835Client()`'s fail-closed
  // default). No sidecar is deployed anywhere yet, so this stays undefined in every environment today.
  const m25X12Port = m25X12WorkerPortFromEnv(process.env);
  const m23SubmissionQueues =
    queueConnection && m23LaunchGateway
      ? buildM23SubmissionQueuePort(queueConnection)
      : null;
  // M24 (WX-PR-011) — the Oregon launch-gateway, gated the same way as M23's (unset in dev/test/CI so
  // nothing calls out by accident). The adapter registry always constructs (WA/ID/CA/NV deny-stubs register
  // regardless); only Oregon's wire I/O gets a real gateway when one resolves.
  const m24LaunchConfig = m24LaunchGatewayConfigFromEnv(process.env);
  const m24OregonGateway = m24LaunchConfig
    ? createM24OregonGateway(m24LaunchConfig)
    : null;
  const m24AdapterRegistry = new MedicaidAdapterRegistry([], m24OregonGateway);
  const m24SubmissionQueues =
    queueConnection && m24OregonGateway
      ? buildM24SubmissionQueuePort(queueConnection)
      : null;
  // M29 D11 (GAP-045) — the §4.1.4 manual NPPES-sync enqueue. Built here (not in the worker-runner
  // section) because the ROUTE needs it and the route mount runs first; the nightly repeatable + the
  // Worker that drains this same queue are registered further below. Absent REDIS_URL → the trigger route
  // 503s and the nightly run simply does not exist on this deployment — both honest, neither silent.
  const m29NppesSync = queueConnection
    ? buildNppesManualSyncTrigger(queueConnection)
    : null;
  const m34ProvisionConfig = m34ProvisionGatewayConfigFromEnv(process.env);
  const m34ProvisionGateway = m34ProvisionConfig
    ? createM34ProvisionGateway(m34ProvisionConfig)
    : null;
  const m34TenantStorageConfig = s3ObjectStoreConfigFromEnv(process.env);
  const m34TenantStorage = m34TenantStorageConfig
    ? createS3TenantStorageProvisioner(m34TenantStorageConfig)
    : null;
  // #105 — the same platform KEK the D5 seam resolves DEKs through (bound in wireModuleSeams above),
  // rebuilt here for the WRAP half: `tenant.provision` mints a tenant's first DEK and `tenant.dek_rotate`
  // mints its successors. Wrap and unwrap MUST come from the same adapter — a DEK wrapped by the gateway
  // and unwrapped by this process (or the reverse) is a key nobody can open. Falls back to the gateway
  // when no KEK is configured, so a KMS-fronted deployment keeps working unchanged.
  const m34PlatformKekRing = loadPlatformKekRing(process.env);
  const m34KeyMaterial = m34PlatformKekRing
    ? createPlatformKekAdapter(m34PlatformKekRing)
    : m34ProvisionGateway?.keyMaterial;
  const m34ProvisionQueue =
    queueConnection &&
    platformDbHandle &&
    m34ProvisionGateway &&
    m34TenantStorage
      ? buildM34ProvisionQueue(queueConnection)
      : null;
  if (m34ProvisionQueue) {
    enableM34JobCapability("tenant.provision");
  }
  if (queueConnection && platformDbHandle && m34ProvisionGateway) {
    enableM34JobCapability("tenant.dek_rotate");
    if (destructionDbHandle) enableM34JobCapability("tenant.shred");
  }
  // TASK-040B (OPS-004) — a dedicated long-lived Redis connection the `/ready` probe PINGs (never
  // one of the per-queue BullMQ connections constructed below — those come and go with their
  // Worker/Queue lifecycle, and a health check should not race that). `lazyConnect` defers the
  // socket until the first PING; the bounded `retryStrategy` keeps it retrying in the background
  // (so a later ping succeeds once Redis recovers) without hammering a dead endpoint. The `error`
  // listener is a required no-op, NOT a log: ioredis EMITS `error` on every failed reconnect
  // attempt while disconnected, and an EventEmitter `error` with no listener throws and crashes the
  // process — failures already surface per-request via the probe's own timeout/rejection handling.
  const redisHealthClient = queueConnection
    ? new Redis({
        // `queueConnection`'s declared type is bullmq's broad `ConnectionOptions` union (which also
        // covers an already-live ioredis/Cluster instance passed straight through); the value
        // `parseRedisConnection` actually returns below is always the plain host/port options shape.
        ...(queueConnection as RedisOptions),
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 2_000,
        retryStrategy: (times) => Math.min(times * 200, 2_000),
      })
    : undefined;
  const stepUpRedisClient = queueConnection
    ? new Redis({
        ...(queueConnection as RedisOptions),
        maxRetriesPerRequest: null,
      })
    : null;

  stepUpRedisClient?.on("error", () => {});
  redisHealthClient?.on("error", () => {});
  // WX-PR-017 — the SD-055 rate limiter's cluster-wide counter store. A DEDICATED connection, not a
  // reuse of `redisHealthClient` above: that one is tuned for a periodic /ready ping (lazyConnect,
  // 1 retry) and this one sits on the hot path of every single request — mixing the two would make
  // the limiter's first real request pay the health client's lazy-connect cost, and a change tuned
  // for one concern would silently retune the other.
  const rateLimitRedisClient = queueConnection
    ? new Redis({
        ...(queueConnection as RedisOptions),
        maxRetriesPerRequest: 1,
        connectTimeout: 2_000,
        retryStrategy: (times) => Math.min(times * 200, 2_000),
      })
    : undefined;
  rateLimitRedisClient?.on("error", () => {});
  const rateLimitStore = rateLimitRedisClient
    ? createRedisRateLimitStore(rateLimitRedisClient)
    : undefined;
  // TASK-040B — the outbox dispatcher (below, ~worker-runner section) is constructed AFTER
  // buildServer() returns `app` (it needs `app.addHook`/`app.log`), but the readinessProbe is
  // built and passed INTO buildServer() before that. This ref lets the probe's outbox-depth check
  // close over the eventual dispatcher instance rather than needing it to exist yet; undefined
  // (no DATABASE_PLATFORM_URL / dispatcher disabled) reports "ok" — nothing to be unready about.
  let outboxDispatcherRef: OutboxDispatcher | undefined;
  // TASK-040C (OPS-005/006) — shared by BOTH the readiness probe (below) and the metrics registry's
  // `wardenx_outbox_pending_depth` gauge, so the "no dispatcher running yet/at all → 0" fallback is
  // defined exactly once instead of duplicated at each call site.
  const outboxPendingDepth = () =>
    outboxDispatcherRef?.pendingDepth() ?? Promise.resolve(0);
  // M1-T10 — assemble the FULL transactional-outbox catalog (M1 folded in by the helper + the passed
  // M30/M33/M34 contributions) and build the catalog-validating tx publisher. The publisher is threaded
  // into the M30 + M33 write services below so their §4.10 `m30.*`/`m33.*` emits persist into
  // `outbox_event` on the mutation's own tx (transactional outbox). M34 is registered in the catalog for
  // completeness but is intentionally NOT bound (its emit payloads are non-conformant — zero regression).
  // A duplicate `eventName` across contributions fails boot here (OutboxEventCollisionError — fail-closed).
  const bootOutboxCatalog = buildBootOutboxCatalog([
    // TASK-031 — the `m6.*` referral/admission catalog. `m6OutboxPublisher` (below) has always been
    // bound to the M6 Drizzle route service, but the catalog itself was never registered here, so
    // every M6 mutation that emits an outbox event (referral received/triaged/accepted/declined,
    // admission created/activated/held/…) threw `OutboxEventValidationError: unknown_event` and rolled
    // back — M6 could not complete a single write in a DATABASE_URL boot. Discovered running the
    // referral-accept ceremony end-to-end (running the app finds what gates miss — check-fitness-gaps's
    // event-catalog check validates events-by-m6.ts's own shape, not whether it's wired into the boot
    // catalog, so this had no test coverage anywhere in the gate suite).
    M6_OUTBOX_EVENTS,
    // TASK-002 — the `m5.*` patient catalog. REQUIRED for the Drizzle PatientMutator's §4.6
    // `m5.patient.updated` emit to validate against the shared publisher.
    M5_OUTBOX_EVENTS,
    // M7L-T02 — the `m7.*` care-plan catalog. REQUIRED for the write lifecycle's outbox emits to
    // validate: the bound `m7OutboxPublisher` (below) runs every emit through this catalog, and an
    // unlisted event name throws `unknown_event` and rolls back the caller's write.
    M7_OUTBOX_EVENTS,
    // M8L-T02 — the `m8.*` encounter catalog. REQUIRED for the write lifecycle's outbox emits to
    // validate (the bound `m8OutboxPublisher` below runs every emit through it); an unlisted event name
    // throws `unknown_event` and rolls back the caller's write. `m8.encounter.signed` is the locked
    // clinical-record trigger — its payload is validated against the §4.4 schema here.
    M8_OUTBOX_EVENTS,
    // M9L — the `m9.*` assessment catalog. REQUIRED for the write pipeline's `m9.assessment.recorded` /
    // `m9.assessment.amended` emits to validate against the bound `m9OutboxPublisher`.
    M9_OUTBOX_EVENTS,
    // M10L — the `m10.hope.*` catalog. REQUIRED for the HOPE write lifecycle's sign/correct/SFV/submission
    // emits to validate against the bound `m10OutboxPublisher`.
    M10_OUTBOX_EVENTS,
    // M11L — the `m11.order.*` catalog. REQUIRED for the order write lifecycle's draft/sign/verbal/cosign/
    // discontinue/correct/complete + standing-order emits to validate against the bound `m11OutboxPublisher`.
    M11_OUTBOX_EVENTS,
    // M12L — the `m12.*` catalog. REQUIRED for the DoseSpot write lifecycle's draft/sign/verbal/discontinue/
    // complete + refill approve-deny + prescriber enroll/revoke emits to validate against `m12OutboxPublisher`.
    M12_OUTBOX_EVENTS,
    // M13L — the `m13.*` catalog. REQUIRED for the eMAR write lifecycle's record/correct/void/refuse +
    // caregiver ack/dispute + missed-dose ack + reconciliation decision/finalize/void + comfort-kit return +
    // policy emits to validate against `m13OutboxPublisher`.
    M13_OUTBOX_EVENTS,
    // M14L — the `m14.*` catalog + the canonical `idg.decision_recorded` seam. REQUIRED for the IDG write
    // lifecycle's meeting/attendance/decision/action-item/minutes emits to validate against `m14OutboxPublisher`
    // — and it is `idg.decision_recorded` at ADJOURN that wires LIVE the M7/M11/M12 decision consumers.
    M14_OUTBOX_EVENTS,
    // M17L — the `m17.*` catalog. REQUIRED for the scheduling write lifecycle's visit proposed/assigned/
    // published/started/cancelled/rescheduled/no-show + recurring discontinue + time-off requested/approved/
    // denied + route-degraded emits to validate against `m17OutboxPublisher`.
    M17_OUTBOX_EVENTS,
    // M18L — the `m18.evv.*` catalog. REQUIRED for the EVV write lifecycle's capture (check-in/out) + device
    // pending/approved/suspended + geofence-policy-changed + late-check-resolved + aggregator-cancelled emits to
    // validate against `m18OutboxPublisher`.
    M18_OUTBOX_EVENTS,
    // M4L — the `m4.*` catalog (GAP-003). REQUIRED for the legal-hold apply/release emits to
    // validate against `m4OutboxPublisher`; `declaredConsumers` is `[]` for both — no M04-F03
    // `HoldApplier` seam has registered yet (see events-by-m4.ts).
    M4_OUTBOX_EVENTS,
    M15_OUTBOX_EVENTS,
    M16_OUTBOX_EVENTS,
    // M19 — the `m19.oncall_shift.*` pair `openShift`/`closeShift` publish (genuine pre-existing gap: this
    // module shipped with no catalog file and no boot-catalog entry, so both routes always 500'd — see
    // `events-by-m19.ts`'s header).
    M19_OUTBOX_EVENTS,
    // M21-T04 — the §4.5.2 `m21.*` catalog. Registered for the dispatcher's payload validation; the
    // per-module publisher binds with the §4.6 workers + the M21-T05 service layer (the M34 precedent —
    // catalogued now, bound when there is a mutation to bind it to).
    M21_OUTBOX_EVENTS,
    // M22 — the §7.2 W2 handshake's DOWNSTREAM half (`m22.document.rendered`). M22 had no event catalog
    // at all until this, so every source module's declared `m*.document-backref` consumer subscribed to
    // a name the dispatcher had never heard of and every `document_id` back-ref column stayed NULL.
    M22_OUTBOX_EVENTS,
    M23_OUTBOX_EVENTS,
    M24_OUTBOX_EVENTS,
    M25_OUTBOX_EVENTS,
    M26_OUTBOX_EVENTS,
    M27_OUTBOX_EVENTS,
    M30_OUTBOX_EVENTS,
    M33_OUTBOX_EVENTS,
    M34_OUTBOX_EVENTS,
    // M20-T06 — the §4.10 `m20.safety.*` catalog. REQUIRED for the routes to work at all, not
    // documentation: `publishOutboxEvent` throws `unknown_event` for a name the catalog does not carry,
    // and the throw rolls back the caller's transaction. Without this entry every §4.1 mutation that
    // declares an outbox effect — which is nearly all of them — would fail at the moment of the write.
    M20_OUTBOX_EVENTS,
    // M32-T07 — the §4.11 `m32.*` catalog (twenty-one events). Registered for the dispatcher's payload
    // validation and for `outbox_event_catalog`; the per-mutation PUBLISHER is deliberately NOT bound
    // (the M21/M34 posture, and for a sharper reason here): M32's §4.1 writes go through the M32-T03/T04/
    // T05 command services, each of which owns its OWN transaction inside its store. A route-layer emit
    // would fire AFTER that transaction committed, which is precisely the guarantee the transactional
    // outbox exists to provide — an event that can outlive a rolled-back write. Binding it means
    // threading a `WriteOutboxPort` through those stores' transaction boundaries, which is a change to
    // T03-T05's shape rather than an addition to T07's. Catalogued now, bound when the emit can join the
    // write's own tx.
    M32_OUTBOX_EVENTS,
    M35_OUTBOX_EVENTS,
    M37_OUTBOX_EVENTS,
    M39_OUTBOX_EVENTS,
    // task-11 — the m29.* decision events (accept/reject). REQUIRED for the store's §4.10 emit to
    // validate; the M5/M6 appliers consume `accepted` via the boot dispatcher.
    M29_OUTBOX_EVENTS,
    // GAP-099 — the `m40.canonical.*` catalog. REQUIRED for the NPPES appliers' own emits to validate:
    // `m40OutboxPublisher` runs every publish through this catalog and an unlisted name throws
    // `unknown_event`, which would fail the delivery and retry the canonical write forever.
    M40_OUTBOX_EVENTS,
    // M28 (FHIR Gateway) had NO catalog contribution at all — alongside M2 and M36 (#205). T07's lifecycle
    // cores (packages/fhir/src/lifecycle/*.ts) have built and typed every one of these event envelopes
    // since M28-T07 and nothing could ever publish one: the route store had no outbox dependency at all.
    // REQUIRED for `m28OutboxPublisher` (below) to validate the client/bulk-export/inbound emits now bound
    // in `store-drizzle.ts`.
    M28_OUTBOX_EVENTS,
    // M2 (Identity) had NO catalog contribution at all either (#205) — the second of the three. Fourteen
    // membership/invitation/device-attestation/step-up facts were already recorded as AUDIT events at
    // their real call sites; only the outbox publish was missing. §11 D19's four org-lifecycle/session
    // events M35's per-seat billing needs (m2.organization.*, m2.session.created) are here too now — the
    // real org activate/suspend/close capability (organization-lifecycle.ts) and the select-organization
    // producer closed that gap in the same pass.
    M2_OUTBOX_EVENTS,
    // M36 (Messaging) had NO catalog contribution at all either — the third of the three (#205). The spec
    // declares exactly one cross-module event, `m36.notification.delivery_failed`; see events-by-m36.ts's
    // header for why it has no producer yet (the out-of-band dispatch pipeline is unbuilt) and why the
    // catalog + the two real consumer bindings (M19, M20) are worth landing anyway.
    M36_OUTBOX_EVENTS,
  ]);
  const txOutboxPublisher = buildTxOutboxPublisher(bootOutboxCatalog);
  // Per-module adapters that pin `callerModule` (the module-scoped `WriteOutboxPort` omits it; the
  // dispatcher's namespace check requires it). Each forwards the caller's open tx + envelope to the shared
  // publisher. M30/M33/M34 — M34's lifecycle outbox now binds too (#107; its emit is gated to the conformant
  // `m34.tenant.provisioned` event, so no mutation rolls back).
  // GAP-003 — the M4 legal-hold apply/release notification; `bindCallerModule`'s returned shape
  // requires `organizationId` on every publish (`OutboxPublishInput`), which `registerLegalHoldsRoutes`
  // supplies explicitly (see legal-holds.ts's `M4OutboxPort`).
  const m4OutboxPublisher = bindCallerModule(txOutboxPublisher, "m4");
  // GAP-004 — the M5 §7.8 death-cascade `m5.patient.deceased` emit (deceased-db.ts).
  const m5OutboxPublisher = bindCallerModule(txOutboxPublisher, "m5");
  const m6OutboxPublisher = bindCallerModule(txOutboxPublisher, "m6");
  // M6 → M37 (confirm-handshake fix, 2026-08-05) — the LIVE `IpuBedAssignmentProvider` seam (registered
  // by M37 at boot), resolved lazily per call (the `m24SignedEncounters`/`m24CoverageResolver` precedent)
  // so registration order at boot never matters. This is the real "bedId verified with M37" check the
  // §2.3.5 `ipuConfirmBedAssignment` guard has always declared but nothing implemented.
  const m6IpuBedAssignmentReader = {
    async activeBedAssignmentForLevelOfCarePeriod(
      organizationId: string,
      levelOfCarePeriodId: string,
    ) {
      const reader = getSeam("IpuBedAssignmentProvider") as {
        activeBedAssignmentForLevelOfCarePeriod(
          organizationId: string,
          levelOfCarePeriodId: string,
        ): Promise<{
          ipuAdmissionId: string;
          bedAssignmentId: string;
          bedId: string;
        } | null>;
      };
      return reader.activeBedAssignmentForLevelOfCarePeriod(
        organizationId,
        levelOfCarePeriodId,
      );
    },
  };
  const m7OutboxPublisher = bindCallerModule(txOutboxPublisher, "m7");
  const m8OutboxPublisher = bindCallerModule(txOutboxPublisher, "m8");
  const m9OutboxPublisher = bindCallerModule(txOutboxPublisher, "m9");
  const m10OutboxPublisher = bindCallerModule(txOutboxPublisher, "m10");
  const m11OutboxPublisher = bindCallerModule(txOutboxPublisher, "m11");
  const m12OutboxPublisher = bindCallerModule(txOutboxPublisher, "m12");
  const m13OutboxPublisher = bindCallerModule(txOutboxPublisher, "m13");
  const m14OutboxPublisher = bindCallerModule(txOutboxPublisher, "m14");
  // task-11 — the m29 decision events (accept/reject) ride the deciding tx via the store's port.
  const m29OutboxPublisher = bindCallerModule(txOutboxPublisher, "m29");
  const m17OutboxPublisher = bindCallerModule(txOutboxPublisher, "m17");
  const m18OutboxPublisher = bindCallerModule(txOutboxPublisher, "m18");
  const m15OutboxPublisher = bindCallerModule(txOutboxPublisher, "m15");
  const m16OutboxPublisher = bindCallerModule(txOutboxPublisher, "m16");
  const m19OutboxPublisher = bindCallerModule(txOutboxPublisher, "m19");
  const m20OutboxPublisher = bindCallerModule(txOutboxPublisher, "m20");
  const m21OutboxPublisher = bindCallerModule(txOutboxPublisher, "m21");
  const m22OutboxPublisher = bindCallerModule(txOutboxPublisher, "m22");
  const m23OutboxPublisher = bindCallerModule(txOutboxPublisher, "m23");
  const m24OutboxPublisher = bindCallerModule(txOutboxPublisher, "m24");
  const m25OutboxPublisher = bindCallerModule(txOutboxPublisher, "m25");
  const m26OutboxPublisher = bindCallerModule(txOutboxPublisher, "m26");
  const m27OutboxPublisher = bindCallerModule(txOutboxPublisher, "m27");
  // WX-PR-013 — the real §4.8 BullMQ producer the M27 write-service's mutating routes call (refresh-inputs /
  // allocate / compute-worksheet / validate / submit's ecr-generation trigger). Fails closed (never a silent
  // no-op) when no Valkey connection is configured. `m27Recompute.queues` is closed on shutdown alongside the
  // worker/cron-schedule queues (see the §4.8 worker-registration block below, where `app` is in scope).
  const m27Recompute = buildM27RecomputeEnqueue(queueConnection);
  const m35OutboxPublisher = bindCallerModule(txOutboxPublisher, "m35");
  const m37OutboxPublisher = bindCallerModule(txOutboxPublisher, "m37");
  const m39OutboxPublisher = bindCallerModule(txOutboxPublisher, "m39");
  // GAP-099 — M40's first publisher. It had none until now because nothing could WRITE a canonical
  // (migration 0019 created `mdm_canonical_writer` and never a function owning it), so there was no
  // canonical change for M40 to announce; migration 0202 built the write path and events-by-m40.ts the
  // catalog. Publishes platform-wide (`organizationId: null`) — a canonical belongs to no tenant.
  const m40OutboxPublisher = bindCallerModule(txOutboxPublisher, "m40");
  const m28OutboxPublisher = bindCallerModule(txOutboxPublisher, "m28");
  const m2OutboxPublisher = bindCallerModule(txOutboxPublisher, "m2");
  // M24 §8.7 — the trading-partner secret cipher port. Built once at boot so a missing/short KEK surfaces
  // here, not on the first tenant write; left undefined when no key is configured, which makes credential
  // WRITES fail closed while every other M24 route keeps working (production requires the key via env.ts).
  const m24CredentialCipher = process.env.M24_CREDENTIAL_ENCRYPTION_KEY
    ? buildCredentialCipherPort()
    : undefined;
  // M24 (WX-PR-011) — the per-PE trading-partner credential resolver the submit/poll workers decrypt
  // through. Requires BOTH a db handle and the cipher port; absent either, the worker construction below
  // stays gated off (RULE 4 — never fabricate a credential, never submit without one).
  const m24CredentialResolver =
    dbHandle && m24CredentialCipher
      ? buildDrizzleCredentialResolver(dbHandle.db, m24CredentialCipher)
      : null;
  // M24 → M5 §3.4 — the coverage read claim assembly + eligibility resolve a billed payer from. Resolved
  // through getSeam at CALL time (not boot), so registration order does not matter and an unregistered
  // reader denies loudly at the deny-stub rather than silently reporting "no coverage".
  const m24CoverageResolver = {
    async activeMedicaidCoverage(q: {
      organizationId: string;
      patientId: string;
      onDate: string;
    }) {
      const found = await getPatientCoverageReader().activeCoverageOfKind({
        organizationId: q.organizationId,
        patientId: q.patientId,
        coverageKind: "medicaid",
        onDate: q.onDate,
      });
      return found
        ? {
            id: found.id,
            payerId: found.payerId,
            subscriberId: found.subscriberId,
          }
        : null;
    },
  };
  // M24 → M1 (WX-PR-011) — `provider_entity` is M1-owned, so this read lives HERE (the composition root
  // sits outside every module's codePaths, unlike write-service-drizzle.ts, which the table-ownership gate
  // scans) rather than inside the M24 module itself.
  const m24CcnReader = dbHandle
    ? {
        async ccnForProviderEntity(
          organizationId: string,
          providerEntityId: string,
        ) {
          const rows = await dbHandle.db
            .select({ ccn: schema.providerEntities.ccn })
            .from(schema.providerEntities)
            .where(
              and(
                eq(schema.providerEntities.id, providerEntityId),
                eq(schema.providerEntities.organizationId, organizationId),
              ),
            )
            .limit(1);
          return rows[0]?.ccn ?? null;
        },
      }
    : undefined;
  // M24 → M6 (WX-PR-011 line-assembly follow-up) — `level_of_care_period` is M6-owned; same escape-valve
  // posture as `m24CcnReader` immediately above. Excludes `status='assigning'` (confirm-handshake fix,
  // 2026-08-05): an IRC/GIP period awaiting M37 bed confirmation is not yet a real period of care and
  // must never generate a billable claim line.
  const m24LocPeriodReader = dbHandle
    ? {
        async periodsForAdmission(organizationId: string, admissionId: string) {
          return dbHandle.db
            .select({
              id: schema.levelOfCarePeriods.id,
              levelOfCare: schema.levelOfCarePeriods.levelOfCare,
              effectiveAt: schema.levelOfCarePeriods.effectiveAt,
              endedAt: schema.levelOfCarePeriods.endedAt,
              facilityId: schema.levelOfCarePeriods.facilityId,
              ipuBedAssignmentId: schema.levelOfCarePeriods.ipuBedAssignmentId,
            })
            .from(schema.levelOfCarePeriods)
            .where(
              and(
                eq(schema.levelOfCarePeriods.organizationId, organizationId),
                eq(schema.levelOfCarePeriods.admissionId, admissionId),
                ne(schema.levelOfCarePeriods.status, "assigning"),
              ),
            )
            .orderBy(schema.levelOfCarePeriods.effectiveAt);
        },
      }
    : undefined;
  // M24 → M40 (place-of-service follow-up) — `facility` is M40-owned/NON_ORG_SCOPED; same escape-valve
  // posture as `m24LocPeriodReader`. Batched by id so one claim assembly issues at most one query here.
  const m24FacilityKindReader = dbHandle
    ? {
        async kindsFor(facilityIds: readonly string[]) {
          const map = new Map<string, PlaceOfServiceFacilityKind>();
          if (facilityIds.length === 0) return map;
          const rows = await dbHandle.db
            .select({ id: schema.facilities.id, kind: schema.facilities.kind })
            .from(schema.facilities)
            .where(inArray(schema.facilities.id, [...facilityIds]));
          for (const r of rows) map.set(r.id, r.kind);
          return map;
        },
      }
    : undefined;
  // M24 → M40 (GAP-040) — the LIVE `MdmEntityProvider` seam for the R&B arrangement's NF-name snapshot.
  // Resolved LAZILY per call (the `m24ResidenceReader` precedent) so seam-registration order at boot
  // never matters, and through the SEAM rather than `m24FacilityKindReader`'s direct `facility` read
  // because the seam chases `merged_into_id`: a facility merged after the tenant picked it must
  // snapshot the survivor's name.
  const m24FacilityNameResolver = {
    async resolveFacility(orgId: string, id: string) {
      return getMdmEntityProvider().resolveFacility(orgId, id);
    },
  };
  // M24 → M5 (place-of-service follow-up) — the LIVE `PatientAddressReader` seam (registered by M5 at
  // boot), resolved lazily per call (the `m24SignedEncounters`/`m24CoverageResolver` precedent) so
  // registration order at boot never matters.
  const m24ResidenceReader = {
    async residenceAt(
      organizationId: string,
      patientId: string,
      asOfDate: string,
    ) {
      const reader = getSeam("PatientAddressReader") as {
        residenceAt(
          organizationId: string,
          patientId: string,
          asOfDate: string,
        ): Promise<{
          kind: PlaceOfServiceResidenceKind;
          facilityId: string | null;
          postalCode: string | null;
        } | null>;
      };
      return reader.residenceAt(organizationId, patientId, asOfDate);
    },
  };
  // M24 → M8 (WX-PR-011 line-assembly follow-up) — the LIVE `SignedEncountersReader` seam (registered by
  // M8 at boot), narrowed to the encounter-window shape claim assembly needs. Resolved lazily per call
  // (the M24 coverage-resolver precedent) so registration order at boot never matters.
  const m24SignedEncounters = {
    async encountersInWindow(
      organizationId: string,
      patientId: string,
      from: string,
      to: string,
    ) {
      const reader = getSeam("SignedEncountersReader") as {
        signedEncountersForPatientSince(
          organizationId: string,
          patientId: string,
          since: string,
        ): Promise<ReadonlyArray<{ encounterId: string; serviceDate: string }>>;
      };
      const digests = await reader.signedEncountersForPatientSince(
        organizationId,
        patientId,
        new Date(from).toISOString(),
      );
      return digests
        .filter((d) => d.serviceDate <= to)
        .map((d) => ({
          encounterId: d.encounterId,
          serviceDate: d.serviceDate,
        }));
    },
  };
  const m30OutboxPublisher = bindCallerModule(txOutboxPublisher, "m30");
  const m33OutboxPublisher = bindCallerModule(txOutboxPublisher, "m33");
  const m34OutboxPublisher = bindCallerModule(txOutboxPublisher, "m34");
  // AUTH-T02/T03: when a DB client is present, build the Better Auth instance + the authenticate hook
  // (getIdentitySession → SessionContextResolver seam → request.context). The seam is resolved lazily
  // at request time, after bootSeams() has registered it.
  // Transactional email transport for reset + magic-link links (FB-T14). M36 OWNS outbound email
  // (manifest VENDOR_ADAPTERS["postmark"] = packages/messaging; DR/INT #14), so auth's `EmailTransport`
  // seam binds to M36's transport here — the bridge lives in the composition root, so neither M2 imports
  // a vendor SDK nor takes a `dependsOn` edge on M36. A real Postmark/SES adapter plugs into M36's
  // `provider` slot when M1 infra wires credentials; until then dev logs the link (console) and
  // production drops it (no-op — a link in prod logs is a credential in logs).
  const emailTransport = selectTransactionalEmailTransport({
    isProduction: process.env.NODE_ENV === "production",
  });
  // TASK-030 — the web app's origin, for building the M2 invite-accept link (`${origin}/invite/:token`).
  // `WEB_APP_URL` is an explicit override; `BETTER_AUTH_URL` (already production-required, §bootstrap/
  // env.ts) is reused as the same-origin-SPA default per its own baseURL comment above; dev falls back
  // to the Vite origin, matching every other dev fallback in this file. Undefined only if production
  // sets neither — the invite route then omits `inviteUrl` rather than guess a wrong origin.
  const webAppBaseUrl =
    process.env.WEB_APP_URL ??
    process.env.BETTER_AUTH_URL ??
    (process.env.NODE_ENV === "production"
      ? undefined
      : "http://localhost:5173");
  const auth = dbHandle
    ? createIdentityAuth(
        dbHandle.db as Parameters<typeof createIdentityAuth>[0],
        {
          emailTransport,
        },
      )
    : undefined;
  const authenticate = auth
    ? createSessionAuthenticate({
        getSnapshot: (request) => getIdentitySession(auth, request.raw.headers),
        getResolver: () => getSeam("SessionContextResolver"),
        // TASK-013 — the M23 #39/#40 / M15 `/internal/...` system-principal routes' only path to
        // reachability. Unset (dev/no secret configured) → `systemCredential` is undefined and the
        // machine-credential branch never runs, exactly today's fail-closed posture.
        systemCredential: process.env.INTERNAL_SERVICE_TOKEN
          ? { token: process.env.INTERNAL_SERVICE_TOKEN }
          : undefined,
      })
    : undefined;
  // WX-PR-018 — an OPTIONAL override for the SD-055 tiers, off by default (undefined → the M1
  // baseline's own DEFAULT_RATE_LIMIT_TIERS, unchanged production behavior). Local dev / the E2E
  // suite is the reason this exists: 18 Playwright specs signing in serially from one machine share
  // ONE `ip:<loopback>` bucket for the pre-org/unauthenticated tier — a realistic shared-NAT login
  // burst, exactly what SD-055 is supposed to allow the AUTHENTICATED tier to handle, but the
  // sign-in call itself is inherently pre-auth and has nowhere else to bucket. Raising the ceiling
  // via env, rather than hand-editing DEFAULT_RATE_LIMIT_TIERS, keeps the shipped default intact for
  // every other boot.
  const rateLimitTiers = process.env.RATE_LIMIT_UNAUTHENTICATED_PER_MINUTE
    ? {
        unauthenticatedPerMinute: Number(
          process.env.RATE_LIMIT_UNAUTHENTICATED_PER_MINUTE,
        ),
        authenticatedPerMinute: process.env.RATE_LIMIT_AUTHENTICATED_PER_MINUTE
          ? Number(process.env.RATE_LIMIT_AUTHENTICATED_PER_MINUTE)
          : DEFAULT_RATE_LIMIT_TIERS.authenticatedPerMinute,
      }
    : undefined;
  // AC-04 — the object-store client the `/ready` probe reaches through. Built off the SAME MINIO_*
  // env contract M22 uses; absent when object storage is not configured, in which case the probe
  // omits the check entirely (reporting "ok") rather than failing a deployment that has no MinIO.
  const readinessS3Config = s3ObjectStoreConfigFromEnv(process.env);
  const readinessObjectStore = readinessS3Config ? createS3ObjectStore(readinessS3Config) : null;
  // F-091 — the M1 `feature_flag` reader. Nothing had ever bound one, so `createDefaultFeatureFlagReader()`
  // stood in every deployment and answered `{}` for every org: `GET /api/v1/system/feature-flags` served an
  // empty map, and every capability gate reading the same fact through a structurally identical port (M22's
  // `documents.doclens`, M38's §7.7 `ai.full`) resolved permanently off. Built once here and passed to the
  // three surfaces that consume it, so the tenant read route and the module gates cannot disagree about
  // what a tenant's flags are. Undefined on a no-db boot, where the empty default remains correct.
  const featureFlagReader = dbHandle ? createDrizzleFeatureFlagReader(dbHandle.db) : undefined;
  const app = buildServer({
    db: dbHandle?.db,
    authenticate,
    ...(featureFlagReader ? { featureFlagReader } : {}),
    // WX-PR-017 — SD-055 rate-limit tiers enforced cluster-wide over the dedicated Valkey connection
    // above when REDIS_URL is set; falls back to the M1 baseline's own per-process default otherwise
    // (a slice/test/no-Redis boot, where a single process IS the whole "cluster").
    ...(rateLimitStore || rateLimitTiers
      ? {
          security: {
            ...(rateLimitStore ? { rateLimitStore } : {}),
            ...(rateLimitTiers ? { rateLimitTiers } : {}),
          },
        }
      : {}),
    // TASK-040B (OPS-004) — the real `/ready` probe: DB `SELECT 1`, Redis PING, outbox pending-row
    // depth. Every check is OMITTED (reports "ok") when its dependency isn't configured, matching
    // today's boot posture — a slice/test/no-Redis boot still serves. `outboxDepthThreshold` reads
    // OUTBOX_READY_DEPTH_THRESHOLD so an operator can tune it without a redeploy.
    readinessProbe: buildReadinessProbe({
      pingDb: dbHandle
        ? async () => {
            await dbHandle.db.execute(sql`SELECT 1`);
          }
        : undefined,
      pingRedis: redisHealthClient
        ? async () => {
            await redisHealthClient.ping();
          }
        : undefined,
      // AC-04 — a real object-store reach. A HEAD on a sentinel key exercises the endpoint, the
      // SigV4 signature and the credentials in one round trip: an unreachable endpoint rejects, bad
      // credentials come back 403 and throw, and the expected 404 (`inspectObject` → null) is the
      // healthy answer. It deliberately does NOT assert any bucket exists — buckets are per tenant
      // (`tenant-<orgId>`), so there is no single bucket to probe, and a missing one is a config
      // error surfaced at first use rather than an outage.
      ...(readinessObjectStore
        ? {
            pingObjectStore: async () => {
              await readinessObjectStore.inspectObject({
                bucket: READINESS_PROBE_BUCKET,
                objectKey: READINESS_PROBE_KEY,
              });
            },
          }
        : {}),
      outboxPendingDepth,
      outboxDepthThreshold: Number(
        process.env.OUTBOX_READY_DEPTH_THRESHOLD ?? 500,
      ),
      capabilities: {
        m22DocumentUpload: s3ObjectStoreConfigFromEnv(process.env)
          ? "ready"
          : "disabled",
        m23AsyncWorkers: m23SubmissionQueues ? "ready" : "disabled",
        m24AsyncWorkers: m24SubmissionQueues ? "ready" : "disabled",
        m34AsyncWorkers: m34ProvisionQueue ? "ready" : "disabled",
      },
    }),
    // Postgres-backed idempotency. The bootstrap default is an in-memory Map, and nothing ever
    // replaced it — so on the production mount an Idempotency-Key was process-local: a retry landing
    // on another replica re-ran the mutation, which for the M23/M26/M30 write surfaces that REQUIRE
    // the header means a duplicated claim submission or settlement. Absent a DB the in-memory default
    // still applies (slice/tests), which is correct: there is nowhere durable to put it.
    ...(dbHandle
      ? { idempotencyStore: createDbIdempotencyStore(dbHandle.db) }
      : {}),
    // Mount module REST routes when a DB client is present (progressive backend wiring). M3 first:
    // the role catalog runs on the real Drizzle RoleStore; other module routes append here as their
    // stores land. The slice/tests boot without this (foundation routes only).
    registerModuleRoutes: dbHandle
      ? (app) => {
          // M3 — role catalog + grants on real stores; TASK-004 threads the boot-registered RBAC
          // handle so /me/permissions + anti-escalation read the live engine and grant/revoke/edit
          // drop the §2.5 cache immediately.
          mountAuthorizationRoutes(app, dbHandle.db, liveRbacHandle);
          // TASK-001 ledger (ARCH-005) — three M3 route deps are still in-memory.
          noteInMemoryBinding({
            kind: "route-dep",
            label:
              "M3 mountAuthorizationRoutes — engagements/auditorSessions/notifier in-memory (auditor-engagement console + compliance notifier are process-local)",
            task: "M3 follow-up wiring (Drizzle engagement/auditor-session/notifier stores)",
          });
          if (!liveRbacHandle) {
            // Should be unreachable on a db boot (wireModuleSeams runs first inside buildServer) —
            // recorded rather than assumed, so a future boot-order change cannot silently revert
            // /me/permissions to a fixed empty set.
            noteInMemoryBinding({
              kind: "route-dep",
              label:
                "M3 mountAuthorizationRoutes — effectivePermissions is a fixed EMPTY resolver (no RBAC engine handle at mount time)",
              task: "TASK-004 (live effective-permission resolver)",
            });
          }
          // M2 — member roster on the real MembershipRepository; isAdmin via the M3 admin reader.
          // TASK-030 — invite delivery: the SAME M36 transport bound to Better Auth's reset/magic-link
          // above, reused here so the invite-create/resend routes can email the accept link too.
          // F-097 — the §D3 M2→M3 handshake. M2's spec records it as Decided and nothing performed it:
          // the accept route consumed the invitation, created the membership, dropped `proposedRoleKeys`
          // and returned, so every invitation the platform has ever issued produced a membership with no
          // role grants. M3 owns the grant, so M3's attacher is bound here rather than imported inside
          // M2 (which is `dependsOn: [1]`).
          mountIdentityRoutes(app, dbHandle.db, createDbAdminMembershipReader(dbHandle.db), {
            emailTransport,
            webAppBaseUrl,
            roleAttacher: createDbProposedRoleAttacher(dbHandle.db),
            // #138/F-060/F-116 — the day-one dashboard seed, bound the same way as roleAttacher just
            // above and for the identical import-boundary reason (M33's implementation; M2 cannot
            // import it).
            dashboardSeeder: createDbSystemDashboardSeeder(dbHandle.db),
            outbox: m2OutboxPublisher,
          });
          // TASK-001 ledger — the external-collaborator magic-link store is process-local: there is
          // no M2 table for pending tokens (see mountIdentityRoutes' header), so a minted link exists
          // on one replica only and dies with the process.
          noteInMemoryBinding({
            kind: "route-dep",
            label:
              "M2 mountIdentityRoutes — external-collaborator magic-link store is a per-process Map (no M2-owned pending-token table exists)",
            task: "new M2-owned token table + RLS + audit trigger (audit report 07 §M2)",
          });
          // M2 (ADR-0023 D2 / SecHardening §12.2/§12.4) — the device-attestation write path. This is what
          // puts rows in `device_attestation`, which is what lets the authenticate hook stamp
          // `attributes.deviceAttestation`, which is what M3's `device_attestation_valid` predicate has
          // been denying on for want of a producer since it was written (F-030).
          // M2 §4.4 — the step-up routes (initiate + verify). This is the ONLY production path that
          // writes `session.last_step_up_at`: the routes existed with slice adapters and one caller
          // (their own test), and `onLoginMfaCompleted` — the other writer — is exported and called by
          // nobody, so the column was populated by nothing and every step-up gate on the platform
          // answered "not fresh" for every caller, forever. Fail-closed, and therefore invisible.
          // The challenge + lockout store is Valkey-backed via `stepUpRedisClient` when the queue
          // connection is configured, so a challenge minted on one replica is spendable on another;
          // without it, it falls back to a per-process Map (lockout threshold per-replica).
          mountSessionStepUpRoutes(app, dbHandle.db, stepUpRedisClient, m2OutboxPublisher);
          if (!stepUpRedisClient) {
            noteInMemoryBinding({
              kind: "route-dep",
              label:
                "M2 mountSessionStepUpRoutes — no queue connection configured, so the step-up challenge AND consecutive-failure store is a per-process Map, so the lockout threshold is per-replica rather than per-session",
              task: "configure a queue connection (REDIS_URL) so the Valkey-backed challenge store is used",
            });
          }
          mountDeviceAttestationRoutes(app, dbHandle.db, m2OutboxPublisher);
          noteInMemoryBinding({
            kind: "route-dep",
            label:
              "M2 mountDeviceAttestationRoutes — the attestation CHALLENGE store is a per-process Map, so a challenge minted on one replica cannot be spent on another",
            task: "move the challenge store to Valkey behind DeviceAttestationChallengeStore",
          });
          // §11 D19 (#205 hard half) — the real org activate/suspend/close capability. This is what
          // makes M35's `m2.organization.*` subscriptions have a producer at all; `organization.status`
          // had no UPDATE anywhere in the codebase before this.
          mountOrganizationLifecycleRoutes(app, dbHandle.db, m2OutboxPublisher);
          mountAuditRoutes(app, dbHandle.db, { outbox: m4OutboxPublisher }); // M4 — audit-log search + GAP-003 compliance surface
          mountPatientRoutes(app, dbHandle.db); // M5 — patient census/chart READS on the real patient table
          registerProviderEntityLookupRoutes(app, dbHandle.db); // M1 — provider-entity selector lookup for UX surfaces
          registerLocationLookupRoutes(app, dbHandle.db); // M1 (#50) — location selector for the admission activation ceremony
          mountAdmissionRoutes(
            app,
            dbHandle.db,
            m6OutboxPublisher,
            m6IpuBedAssignmentReader,
            // #44 — lets the election-statement draft verify the elected hospice is THIS org's before
            // it persists the id onto two tables whose FKs carry no organization.
            buildProviderEntityOrgCheck(dbHandle.db),
            // #50 — lets activation SITE the admission at a service location. `admission.location_id`
            // was never written by any code path, so every admission was unsited at the location level
            // and M10 refused to create its NOT NULL-sited HOPE timepoint windows.
            { activeLocationsFor: buildProviderEntityLocationLister(dbHandle.db) },
          ); // M6 — reads + the T02 referral/admission write lifecycle over Drizzle+RLS, m6.* transactional outbox
          // Clinical core (M7–M14, M17, M18, M22) — reads mounted over the real Drizzle route services under
          // RLS, replacing the retired in-memory scaffold. Writes fail-closed 501 until each module's write
          // lifecycle lands. See each module's `*-route-service-db.ts`.
          mountCarePlanRoutes(app, dbHandle.db, m7OutboxPublisher); // M7 — reads + the T02 write lifecycle over Drizzle+RLS, m7.* transactional outbox
          // M8 — reads + the T02 write lifecycle over Drizzle+RLS, m8.* transactional outbox. Two DEK
          // envelopes over the SAME M34 key ring M39's consent notes and M31's status reasons use:
          // `hearthnote_selection.free_text_cipher` (§3.6, #114) and
          // `hearthnote_assembled_output.layer1_cipher` / `final_cipher` (§2.6, #122). The key ring is a
          // deny-stub until the Phase-2D KMS-backed provider binds (#105), so both refuse with
          // 503 HEARTHNOTE_CIPHER_UNBOUND rather than storing PHI in the clear. That means: a selection
          // tree carrying clinician prose refuses, and — since an assembled narrative is prose by
          // construction and its columns are NOT NULL — FINALIZE refuses for every encounter. A tree with
          // no prose still writes, so authoring a structured draft does not depend on the key ring.
          mountEncounterRoutes(
            app,
            dbHandle.db,
            m8OutboxPublisher,
            createHearthnoteCiphers(getTenantKeyProvider()),
          );
          mountAssessmentRoutes(app, dbHandle.db, m9OutboxPublisher); // M9 — reads + the §10 write pipeline over Drizzle+RLS, m9.* transactional outbox
          mountHopeRoutes(app, dbHandle.db, m10OutboxPublisher); // M10 — reads + the write lifecycle over Drizzle+RLS, m10.hope.* transactional outbox
          mountOrderRoutes(app, dbHandle.db, m11OutboxPublisher); // M11 — reads + the write lifecycle over Drizzle+RLS, m11.order.* transactional outbox
          mountDoseSpotRoutes(app, dbHandle.db, m12OutboxPublisher); // M12 — reads + the write lifecycle over Drizzle+RLS, m12.* transactional outbox
          mountEmarRoutes(app, dbHandle.db, m13OutboxPublisher); // M13 — reads + the write lifecycle over Drizzle+RLS, m13.* transactional outbox
          mountIdgRoutes(app, dbHandle.db, m14OutboxPublisher); // M14 — reads + the write lifecycle over Drizzle+RLS, m14.*/idg.decision_recorded transactional outbox
          mountSchedulingRoutes(app, dbHandle.db, m17OutboxPublisher); // M17 — reads + the write lifecycle over Drizzle+RLS, m17.* transactional outbox
          mountEvvRoutes(app, dbHandle.db, m18OutboxPublisher); // M18 — reads + the write lifecycle over Drizzle+RLS, m18.evv.* transactional outbox
          mountDocumentRoutes(app, dbHandle.db, featureFlagReader); // M22 — reads + the write lifecycle over Drizzle+RLS (no producer outbox: M22's outbox is the consumer-side render handshake); the reader is the `documents.doclens` DocLens gate (F-091)
          mountTerminologyRoutes(app, dbHandle.db, featureFlagReader); // M38 — terminology read surface + tenant value-set extensions (FB-T01), the §4.1 value-set catalog + §7.3 remediation report + the platform-ops admin surface (GAP-063); the reader is the §7.7 `ai.full` semantic-search gate (F-091)
          mountMdmRoutes(app, dbHandle.db); // M40 — MDM entity directory + overlay/BAA + platform-ops (FB-T02)
          mountConsentRoutes(app, dbHandle.db, {
            outbox: m39OutboxPublisher,
            cipher: createConsentInternalNotesCipher(getTenantKeyProvider()),
            patientReader: getConsentPatientReader(),
          }); // M39 — immutable consent lifecycle + transactional outbox/render
          mountMessagingRoutes(app, dbHandle.db); // M36 — channel/thread/alert-inbox/prefs reads (FB-T04; writes → FB-T05)
          // M34 (Phase 2D) — mount the platform-ops + tenant-scoped surfaces over the DRIZZLE route services
          // (RLS-scoped reads under withPlatformContext/withOrgContext; commands enqueue the §4.3 queue job
          // through the BullMQ producer). The platform queue producer + the tenant queue producer are the
          // SAME Valkey connection the workers run on. The platform service's cross-tenant reads require the
          // M4 bypass auditor (currently fail-closed typed-TODO), so the platform surface 5xxs until that
          // lands; tenant reads are live, while async commands refuse until the worker capability set is
          // complete. Both fall back to the in-memory slice when no DB client is present (tests).
          const m34PlatformEnqueue = buildPlatformEnqueue(queueConnection);
          const m34TenantEnqueue = buildTenantEnqueue(queueConnection);
          mountTenantPlatformRoutes(app, dbHandle.db, {
            platform: buildDrizzlePlatformService({
              platformDb: platformDbHandle?.db ?? dbHandle.db,
              enqueue: m34PlatformEnqueue.enqueue,
              auditBypass: m34PlatformBypassAuditor,
              outbox: m34OutboxPublisher,
              // F-091 — M1 owns the `feature_flag` schema, so the §4.7 admin seam is built here and
              // injected rather than constructed inside M34 (which would create a schema import edge the
              // route file's own header says must not exist). On the PLATFORM pool: migration 0001's write
              // policies never admit a NULL org, so a platform-global flag is uncreatable from a tenant
              // connection by design.
              featureFlags: createDrizzleFeatureFlagAdmin(platformDbHandle?.db ?? dbHandle.db),
            }),
            tenant: buildDrizzleTenantService({
              db: dbHandle.db,
              enqueue: m34TenantEnqueue.enqueue,
            }),
            // AC-05 — SECURITY_HARDENING §22.1's 5/IP/hour on the public signup surface. The route
            // has always composed the preHandler; the composition root never injected a limiter, so
            // `createAllowAllRateLimiter()` stood and the budget was unlimited. Note this is
            // deliberately OUTSIDE the `platformDbHandle` branch: the limiter must bind whether or
            // not the first-admin acceptance service does, or the surface that IS mounted stays
            // unlimited. Cluster-wide over Valkey when REDIS_URL is set; per-replica otherwise —
            // which still bounds a single-instance deployment, where one replica IS the cluster.
            public: {
              rateLimiter: createBudgetedRateLimiter(
                rateLimitStore ?? createInMemoryRateLimitStore(),
                {
                  limit: PUBLIC_SIGNUP_HOURLY_LIMIT,
                  windowMs: 3_600_000,
                  keyPrefix: "m34:signup:ip",
                  onStoreError: (err) =>
                    app.log.warn(
                      { err },
                      "signup rate-limit store unavailable — failing open",
                    ),
                },
              ),
              ...(platformDbHandle
                ? {
                    service: buildFirstAdminAcceptanceService({
                      db: dbHandle.db,
                      platformDb: platformDbHandle.db,
                      auditBypass: m34PlatformBypassAuditor,
                    }),
                  }
                : {}),
            },
          });
          // M33 (Phase 2C) — mount the Reporting READ + WRITE + EXPORT/DRILLDOWN surfaces over the DRIZZLE
          // route services. Reads run under withReportSession (replica-over-primary, RLS-scoped, read-only,
          // tiered statement_timeout); writes run under withOrgContext on the primary. The MV-admin command
          // routes enqueue the on-PRIMARY `report.mv_refresh` job through the SAME Valkey connection the
          // workers run on. WX-PR-014 bound the tile/export SQL executor (real translateSpec results now
          // execute for real — no more forward-seam-empty tiles/CSVs) and the M39 ConsentEvaluator seam for
          // drilldown narrowing. Still deny-stub-safe (genuine infra gaps, not this pass's to invent): the
          // M22 render outbox (a package-level payload/schema mismatch), the per-tenant DEK encrypt (no M1
          // envelope-DEK/KMS provider exists yet), and the cron-parser adapter (a separate library
          // integration, out of the §4.8 background-job charter).
          const m33ReadEnqueue = buildM33ReadEnqueue(queueConnection);
          mountM33ReadRoutes(
            app,
            buildDrizzleM33ReadService({
              db: dbHandle.db,
              enqueue: m33ReadEnqueue.enqueue,
            }).service,
          );
          // M33 — bind the catalog-validating tx outbox publisher (callerModule `m33`) so the §4.10
          // `m33.report_definition.published` / `report_view.shared_org` / `report_schedule.created`
          // emits persist into `outbox_event` on the mutation's own withOrgContext tx (was unbound = no-op).
          mountM33WriteRoutes(
            app,
            buildDrizzleM33WriteService({
              db: dbHandle.db,
              outbox: m33OutboxPublisher,
            }).service,
          );
          mountM33ExportDrilldownRoutes(
            app,
            buildDrizzleM33ExportDrilldownService({
              db: dbHandle.db,
              outbox: m33OutboxPublisher,
            }).service,
          );
          // M30 (HQRP & Quality) — mount the nine §4.1 route plugins (measures / CAHPS / risk-register /
          // QAPI / SRA / CoP / incidents / mortality / infection) over the DRIZZLE READ + WRITE services.
          // Every method opens its own withOrgContext on the primary (RLS scopes each statement to
          // app.org_id); the R-04 / R-96 command routes enqueue the §4.8 recompute / risk-refresh jobs
          // through the SAME Valkey connection the other producers use (fail-closed without one). The §4.10
          // m30.* outbox emit is NOW bound (catalog-validating tx publisher, callerModule `m30`) so every
          // `m30.*` event persists into `outbox_event` on the mutation's own withOrgContext tx; the M40
          // provider-entity resolver stays unbound (a 503 on a provider-scoped insert until it binds —
          // fail-closed, never a silent no-op).
          const m30Recompute = buildM30RecomputeEnqueue(queueConnection);
          mountM30Routes(app, {
            readService: buildDrizzleM30ReadService(dbHandle.db),
            writeService: buildDrizzleM30WriteService(dbHandle.db, {
              recompute: m30Recompute.enqueue,
              outbox: m30OutboxPublisher,
              // #107 item 3 — resolve provider_entity_id server-side for the NOT-NULL provider-scoped
              // compliance inserts (incident / infection / QAPI program / CAHPS ingest), inside the
              // mutation's own org-context tx. Removes the prior fail-closed 503.
              providerEntity: buildPrimaryProviderEntityResolver(),
            }),
          });
          // M27 (Cost Report) — mount the §4.1 route plugins over the Drizzle READ + WRITE services. Each
          // mutation opens its own withOrgContext (RLS scopes every statement to app.org_id) and emits its
          // §4.10 m27.* event through the catalog-validating tx publisher (callerModule `m27`) in the same
          // unit of work. WX-PR-013 — the §4.8 recompute enqueue is now the REAL BullMQ producer
          // (`buildM27RecomputeEnqueue`, `wiring.ts`): refresh-inputs/allocate/compute-worksheet/validate/
          // submit's ecr-generation trigger now enqueue for real onto the queue names `registerM27Workers`
          // constructs `Worker`s against, instead of the prior fail-open synthetic-jobId no-op default.
          mountM27Routes(app, {
            readService: buildDrizzleM27ReadService(dbHandle.db),
            writeService: buildDrizzleM27WriteService(dbHandle.db, {
              outbox: m27OutboxPublisher,
              recompute: m27Recompute.enqueue,
            }),
          });
          // M35 (Subscription Billing) — mount the §4.1 tenant + §4.2 platform-ops + §4.3 webhook route
          // plugins over the single Drizzle route service. Tenant mutations open their own withOrgContext
          // (RLS scopes every statement to app.org_id) and emit their §4.11 m35.* event through the
          // catalog-validating tx publisher (callerModule `m35`) in the same unit of work (§4.13 outbox-only
          // Stripe path). The platform-ops (§5.2) cross-tenant reads/writes run through the injected platform
          // runner, bound below to the separate platform credential (DATABASE_PLATFORM_URL) via M1's gated +
          // audited `withPlatformContext`. When no platform credential is configured the runner is undefined
          // and the admin surface fails closed (503) — never reading under tenant RLS. The §4.3 webhook stays
          // fail-closed (503) until the live Stripe secret + DEK transport binds.
          mountM35Routes(app, {
            service: buildDrizzleM35RouteService(dbHandle.db, {
              outbox: m35OutboxPublisher,
              // M35A-T03 — resolve the M2 `OrganizationReader` seam LAZILY (per call, after validateSeams has
              // applied its graceful deny-stub / M2 has registered the real reader), so the platform-ops admin
              // lists label cross-tenant rows with an org display name instead of a raw UUID.
              organizationReader: {
                readByIds: (ids) =>
                  getSeam("OrganizationReader").readByIds(ids),
              },
              // Platform-ops cross-tenant runner: each call is ONE allowlisted ("m35-subscription-admin"),
              // audited (`platform.bypass_invoked` via the shared M34 auditor) `withPlatformContext` tx against
              // the platform credential. Undefined → fail-closed (503), never a tenant-pool read.
              platformRunner: platformDbHandle
                ? (fn) =>
                    withPlatformContext(
                      platformDbHandle.db,
                      {
                        jobId: "m35-subscription-admin",
                        reason: "M35 §5.2 platform-ops admin surface",
                        crossTenant: true,
                      },
                      m34PlatformBypassAuditor,
                      fn,
                    )
                : undefined,
            }),
          });
          // M37 (Inpatient Unit / IPU Management) — mount the §4.1 core route spine over the Drizzle route
          // service. Each mutation opens its own withOrgContext (RLS scopes every statement to app.org_id),
          // drives the pure @wardenx/inpatient §2 machines, and emits its §4.4 m37.* event through the
          // catalog-validating tx publisher (callerModule `m37`) in the same unit of work (D17 outbox-only).
          mountM37Routes(app, {
            service: buildDrizzleIpuRouteService(dbHandle.db, {
              outbox: m37OutboxPublisher,
              // GAP-061 — the §2.2 shared-room occupancy gate's M5 read. A THUNK: the seam registry is
              // populated by wireModuleSeams(), and resolving eagerly here would capture whatever was
              // registered at mount time (the deny-stub, on an unlucky ordering).
              rooming: getIpuRoomingFactsReader,
              // GAP-062 — the §2.7 non-immediate-family visitor consent gate's M39 read (same thunk reason).
              consent: getIpuVisitorConsentGate,
              // F-069 — the §2.10 restraint gate's M11 order read (same thunk reason). Without it the
              // CoP 418.110 physician-order requirement was satisfied by any non-empty string.
              orders: getIpuOrderReader,
              // F-070 — the §2.2 discharge gate's M6 admission-state read (same thunk reason). Without
              // it the "the M6 discharge has happened" precondition was a boolean the client sent.
              admissions: getIpuAdmissionStatusReader,
            }),
          });
          // M23 (Billing — Medicare) — mount the §4.1 route plugins over the Drizzle READ + WRITE services +
          // the boot-time claim-assembly service. Each mutation opens its own withOrgContext (RLS scopes every
          // statement to app.org_id), runs the pure @wardenx/billing lifecycle reducer, and emits its §4.10
          // m23.* event through the catalog-validating tx publisher (callerModule `m23`) in the same unit of
          // work (D2 outbox-only). The assembly service's cross-module reader seams (M5/M6/M8/M18/M38/M40) are
          // fail-closed deny-stubs at boot (RULE 4) until they register in the M1 SeamRegistry — POST
          // /claims/assemble returns 503 SEAM_UNBOUND, never a fabricated claim. The §4.8 BullMQ submit/
          // eligibility producer + the M40 CCN / M1 secret-cipher / M4 override-audit ports stay on their
          // fail-closed defaults until those binds land (the submit routes enqueue once the producer binds).
          mountM23Routes(app, {
            readService: buildDrizzleM23ReadService(dbHandle.db),
            writeService: buildDrizzleM23WriteService(dbHandle.db, {
              outbox: m23OutboxPublisher,
              jobs: buildM23OutboxBackedSubmissionGate(
                m23SubmissionQueues !== null,
              ),
              providerCcn: {
                async ccnForProviderEntity(
                  tx,
                  organizationId,
                  providerEntityId,
                ) {
                  const [provider] = await (tx as DbClient)
                    .select({ ccn: schema.providerEntities.ccn })
                    .from(schema.providerEntities)
                    .where(
                      and(
                        eq(schema.providerEntities.id, providerEntityId),
                        eq(
                          schema.providerEntities.organizationId,
                          organizationId,
                        ),
                      ),
                    )
                    .limit(1);
                  if (!provider)
                    throw new DegradedError(
                      "provider-entity",
                      "provider CCN unavailable",
                    );
                  return provider.ccn;
                },
              },
            }),
            assemblyService: buildM23BootAssemblyService(dbHandle.db, {
              outbox: m23OutboxPublisher,
            }),
          });
          // M25 (Remittance & Denials) — mount the §4.1 route plugins over the Drizzle READ + WRITE
          // services. Each mutation opens its own withOrgContext (RLS scopes every statement to app.org_id),
          // validates the §2.2 transition via the pure domain machines, and version-checks the PATCH surfaces
          // (§2.5). The §4.5 m25.* transactional outbox publisher + the M38 terminology lookup stay on their
          // fail-closed defaults (no-op emit / deny-stub) until those binds land — the routes (reads, manual-
          // match, the denial/appeal state ladders, the overlay edit) are fully live; only the cross-module
          // event fan-out + the M38 plain-language merge are deferred (the M23/M27 deferred-bind posture).
          // Bind the M38 CARC/RARC catalog floor (the taxonomy view's category + default plain-language)
          // over the registered TerminologyProvider seam (resolved lazily per lookup, so registration order
          // is irrelevant). The per-tenant overlay still layers on top; an unknown code degrades to 'unmapped'.
          // getSeam returns `unknown` for seams outside the typed SeamContracts — cast to the minimal lookup
          // shape M25 needs (the M38 ResolvedConcept's display + loosely-typed properties).
          const terminologyProvider = getSeam("TerminologyProvider") as {
            lookup(
              system: string,
              code: string,
            ): Promise<{
              display: string;
              properties?: Record<string, unknown>;
            } | null>;
          };
          const m25Terminology: TerminologyLookupPort = {
            async lookup(carcCode) {
              const concept = await terminologyProvider.lookup(
                "carc",
                carcCode,
              );
              if (!concept) return null;
              const props = concept.properties;
              return {
                category:
                  typeof props?.category === "string"
                    ? props.category
                    : "unmapped",
                plainLanguage: concept.display,
              };
            },
          };
          // WX-PR-012 — the 835 receive/post pipeline. `m25X12Port` is undefined (fail-closed
          // `NO_X12_835_PORT`) unless M25_X12_WORKER_URL is configured — no Python x12-worker sidecar is
          // deployed anywhere yet, so this stays unreachable in every environment today, same as M23's own
          // `x12-837-client` transport; the CODE is real and will call out for real once ops points it at a
          // live sidecar. `claims` binds M23's real ClaimSubmissionReader seam (degrades to "no
          // candidates"/"no patient id" — never fabricates a match — until M23 registers it, which now
          // happens automatically at this same boot via `registerM23PublishedSeams`).
          const m25IngestService = buildDrizzleM25IngestService(dbHandle.db, {
            client: createX12835Client(m25X12Port),
            outbox: m25OutboxPublisher,
            terminology: m25Terminology,
            claims: buildM23BackedClaimMatchCandidateProvider(),
          });
          mountM25Routes(app, {
            readService: buildDrizzleM25ReadService(
              dbHandle.db,
              m25Terminology,
            ),
            writeService: buildDrizzleM25WriteService(
              dbHandle.db,
              m25OutboxPublisher,
            ),
            ingestService: m25IngestService,
          });
          // M26 (Cap Management) — mount the §4.1 route plugins over the Drizzle READ + WRITE services; the
          // §4.10 `m26.cap.*` transactional outbox publisher binds here (events persist on the mutation's tx).
          mountM26Routes(app, {
            readService: buildDrizzleM26ReadService(dbHandle.db),
            writeService: buildDrizzleM26WriteService(
              dbHandle.db,
              m26OutboxPublisher,
            ),
          });
          // M24 (Billing — Medicaid) — mount the §4.1 route plugins over the Drizzle READ + WRITE services;
          // the §4.11 `m24.*` transactional outbox publisher binds here (events persist on the mutation's tx).
          mountM24Routes(app, {
            readService: buildDrizzleM24ReadService(dbHandle.db),
            // The §8.7 credential cipher port binds here. Absent M24_CREDENTIAL_ENCRYPTION_KEY the port is
            // left unbound and a credential WRITE fails closed (503 CREDENTIAL_CRYPTO_UNBOUND) — every other
            // M24 route is unaffected. Boot never fails on a missing key outside production, where env.ts
            // requires it; and a secret is never accepted-then-dropped, which is what the sentinel did.
            writeService: buildDrizzleM24WriteService(
              dbHandle.db,
              m24OutboxPublisher,
              m24CredentialCipher,
              m24CoverageResolver,
              m24CcnReader,
              m24LocPeriodReader,
              m24SignedEncounters,
              m24FacilityKindReader,
              m24ResidenceReader,
              m24FacilityNameResolver,
            ),
          });
          // M15 (Discipline Care Plans) — mount the §4.1 route plugins over the Drizzle READ + WRITE
          // services. Every read opens its own withOrgContext (RLS scopes each statement to app.org_id)
          // and resolves the §7.8/§7.9 SUD + family-violence gates through M39's ConsentEvaluator seam
          // BEFORE it queries, so a caller who is not cleared never has the row in the result set. Every
          // mutation runs the pure §2.2/§2.3 machines and emits its §2.4 `m15.*` event through the
          // catalog-validating tx publisher (callerModule `m15`) on the mutation's own transaction — which
          // is how the D12 M22 plan-PDF render handshake (`m15.plan.version_signed`) reaches M22. The M27
          // patient-care-HOURS denominator for the 418.78(e) ratio stays unbound (M15-F04): the ratio
          // answers the honest `unavailable` badge, never a fabricated 0%.
          mountM15Routes(app, {
            readService: buildDrizzleM15ReadService(dbHandle.db),
            writeService: buildDrizzleM15WriteService(dbHandle.db, {
              outbox: m15OutboxPublisher,
            }),
          });
          // M16 (Bereavement) — mount the §4.1 route plugins over the Drizzle READ + WRITE services. Every
          // read opens its own withOrgContext (RLS scopes each statement to app.org_id) and resolves the
          // §7.13 42 CFR Part 2 gate through M39's ConsentEvaluator seam; every mutation runs the pure
          // §2.2–§2.4 machines and emits its §4.4 `m16.*` event through the catalog-validating tx publisher
          // (callerModule `m16`) on the mutation's own transaction — which is how the D14 M22
          // sympathy-letter render handshake (`m16.bereavement.outreach_artifact_requested`) reaches M22.
          // The write service takes the READ service so every plan-shaped mutation answers with the SAME
          // projection route 2 serves (one DTO, one disclosure gate, no drift).
          const m16ReadService = buildDrizzleM16ReadService(dbHandle.db);
          mountM16Routes(app, {
            readService: m16ReadService,
            writeService: buildDrizzleM16WriteService(
              dbHandle.db,
              m16ReadService,
              {
                outbox: m16OutboxPublisher,
              },
            ),
          });
          // M21 (Supplies, DME & Comfort Kits) — mount the §4.1 route plugins over the Drizzle READ +
          // WRITE services. Every read opens its own withOrgContext (RLS scopes each statement to
          // app.org_id); every mutation runs the pure §2.2–§2.7 machines and emits its §4.5.2 `m21.*` event
          // through the catalog-validating tx publisher (callerModule `m21`) on the mutation's own
          // transaction — which is how the outbox-only M22 handoffs reach M22 (the bill of lading at
          // dispatch, the DEA-1304-format receipt at reconciliation) and how M13 learns a kit reached the
          // bedside.
          //
          // TWO fail-CLOSED probes bind here and both refuse rather than assume:
          //   • `dispatcherEligible` re-checks the §4.4 authority INSIDE the dispatch transaction, over the
          //     SAME Drizzle resolver the ABAC predicate uses — so a grant revoked between preHandler and
          //     commit still stops the kit, and there is one implementation of the rule rather than two.
          //   • `vendorActive` is the M40 `DmeVendor` check §2.2's assignVendor guard reads. It resolves
          //     `MdmEntityProvider` lazily through the M1 seam registry and answers `false` on an unbound
          //     or throwing seam: sending a hospital bed to a vendor whose contract lapsed is a bill the
          //     agency cannot collect and a delivery the patient may never get.
          const m21ReadService = buildDrizzleM21ReadService(dbHandle.db);
          const m21AbacResolver = buildDrizzleSuppliesAbacResolver(
            dbHandle.db,
            {
              roleGrants: createDbEffectivePermissionStore(dbHandle.db),
            },
          );
          const m21WriteService = buildDrizzleM21WriteService(
            dbHandle.db,
            m21ReadService,
            {
              outbox: m21OutboxPublisher,
              dispatcherEligible: async ({
                organizationId,
                membershipId,
                locationId,
              }) => {
                const roleKeys = await m21AbacResolver.roleKeysOf(
                  organizationId,
                  membershipId,
                );
                const locationIds = await m21AbacResolver.locationIdsOf(
                  organizationId,
                  membershipId,
                );
                return decideDispatcherEligible(
                  {
                    organizationId,
                    targetId: "",
                    locationId,
                    involvesControlledSubstance: true,
                  },
                  { organizationId, membershipId, roleKeys, locationIds },
                );
              },
              vendorActive: async ({ organizationId, vendorId }) => {
                try {
                  const provider = getSeam("MdmEntityProvider") as {
                    isActiveEntity?: (
                      orgId: string,
                      kind: string,
                      entityId: string,
                    ) => Promise<boolean>;
                  };
                  if (typeof provider.isActiveEntity !== "function")
                    return false;
                  return await provider.isActiveEntity(
                    organizationId,
                    "dme_vendor",
                    vendorId,
                  );
                } catch {
                  return false;
                }
              },
            },
          );
          mountM21Routes(app, {
            readService: m21ReadService,
            writeService: m21WriteService,
          });
          // §4.8 — bind the WRITE service as the seam's creation path, so a coordinator's direct entry
          // through `SupplyFulfillmentProvider.createDirectSupplyRequest` takes the SAME route as an HTTP
          // create and an M11 cascade (D4 routing freeze + per-kind validation + the §4.5.2 emit). Until
          // this runs the seam's create method refuses loudly rather than writing a routing-less row.
          bindSupplyRequestCreator(m21WriteService);
          // M19 (On-Call Triage) — mount the §4.1 route plugins over the Drizzle READ + WRITE services.
          // Every read opens its own withOrgContext (RLS scopes each statement to app.org_id) and resolves
          // the 42 CFR Part 2 gate through M39's ConsentEvaluator BEFORE it queries, so an uncleared caller
          // never has the SUD medication in the result set. Every mutation runs the pure §2.2-§2.7 machines
          // and emits its §4.10 `m19.*` event through the catalog-validating tx publisher (callerModule
          // `m19`) on the mutation's own transaction — which is how M17 learns a visit was dispatched, M16's
          // bereavement timeline starts from a `pronouncement_scheduled` disposition, and M36's channel
          // synchronizer follows a shift open/close.
          //
          // TWO fail-directions bind here and they point OPPOSITE ways, deliberately:
          //   • the M8 `EncounterCreator` call runs AFTER the disposition commits and a failure is a
          //     §2.7 class D-B DEFERRAL — the call parks in `documented_pending_encounter`, the clinician
          //     is not blocked, and the §4.8 worker retries. A seam probe inside our own transaction would
          //     also self-deadlock the pool (the M21-T05 finding).
          //   • the D3 vendor deployment models stay OFF (`vendorModelsEnabled` unset), so a policy PATCH
          //     selecting `hybrid`/`centralized` is REFUSED rather than accepted-and-ignored. Phase 1 has
          //     no signed BAA and the §8.5 adapter registry is empty; a tenant must never believe a vendor
          //     is answering their nights when none is.
          //
          // The two cipher ports (D14's per-tenant DEK envelope) are left UNBOUND: no key-management
          // binding exists for M19 yet, so the caller quote is dropped rather than written plaintext into a
          // column named `_cipher`, and the transcript decrypt refuses rather than returning the stored
          // bytes as though they were readable.
          const m19ReadService = buildDrizzleM19ReadService(dbHandle.db);
          mountM19Routes(app, {
            readService: m19ReadService,
            writeService: buildDrizzleM19WriteService(dbHandle.db, m19ReadService, {
              outbox: m19OutboxPublisher,
            }),
            // F-030 — the vendor-session bind gate's read. Mounting this is what makes
            // `attributes.externalActorId` producible: without a bound session, M19's
            // `external_triage_actor` compares the shift's vendor against nothing, which is how that
            // predicate came to refuse every caller.
            vendorSessionBindReader: buildDrizzleVendorSessionBindReader(dbHandle.db),
          });
          // M20 (Field Safety) — mount the §4.1 route plugins over the Drizzle READ + WRITE services.
          // Every read opens its own withOrgContext (RLS scopes each statement to app.org_id); every
          // mutation runs the pure §2.2 machines and emits its §4.10 `m20.safety.*` event through the
          // catalog-validating tx publisher (callerModule `m20`) on the mutation's own transaction — which
          // is how M36 learns an SOS was raised, M17 learns a visit needs cancelling, and M22 learns an
          // incident report needs rendering.
          //
          // THE DEK CIPHER PORT IS DELIBERATELY UNBOUND, and the two halves of M20 answer that DIFFERENTLY:
          //   • the SOS PRESS never refuses for it. M20-F16 / S13: the coordinate is replaced by the
          //     recognisable `routes/coordinates.ts` sentinel, a warning rides the response, and the alert
          //     fans out. Refusing a call for help because a key is missing is the one failure this module
          //     must not have.
          //   • the INCIDENT CREATE refuses with 503 `SAFETY_CIPHER_UNBOUND`. `narrative_cipher` is NOT
          //     NULL and holds the substance of a workers-comp record; writing it in the clear into a
          //     column named `_cipher` would make the §3.7 erasure report a destruction that never
          //     happened. Every other incident route — submit, transition, the D9 OSHA sign-off — works
          //     without a cipher, because none of them writes prose.
          //
          // `recipientCountFor` is likewise unbound, so `RaiseSosResponse.acknowledgersDispatched` answers
          // `null` rather than `0`: "we could not ask the §4.5 composed resolver" is what the mobile client
          // renders as the D15 `tel:` direct-dial fallback, and "0 recipients" would instead read as a
          // genuine coverage gap the tenant caused.
          const m20ReadService = buildDrizzleM20ReadService(dbHandle.db);
          mountM20Routes(app, {
            readService: m20ReadService,
            writeService: buildDrizzleM20WriteService(
              dbHandle.db,
              m20ReadService,
              {
                outbox: m20OutboxPublisher,
              },
            ),
          });
          // M31 (Patient/Family Portal & Telehealth) — mount the forty-seven §4.1 routes over the Drizzle
          // store (the three owned tables) + the injected video adapter. The telehealth adapter is left
          // UNBOUND here (a fail-closed NOOP): no per-tenant Daily.co API-key vault is wired yet, so the
          // Record button denies and join mints an empty token rather than reaching a vendor with an
          // unconfigured key. Every lay READ route composes the upstream portal-summary seams and fails
          // CLOSED; the owned-table reads/writes (accounts, grants, telehealth lifecycle) are live over RLS.
          // The reason cipher seals the operator's suspend/reinstate reason (#117); it composes over the
          // SAME M34 key ring M39's consent notes use, which is a slice deny-stub until the Phase-2D
          // KMS-backed provider lands — so those two routes refuse with 503 until then rather than
          // recording an account status change with no reason. Every other admin route is unaffected.
          mountM31Routes(app, {
            store: buildDrizzlePortalStore(dbHandle.db),
            reasonCipher: createPortalReasonCipher(getTenantKeyProvider()),
          });
          // M32 (AI Platform) — mount the thirty-two §4.1 routes over the T03/T04/T05 command services
          // plus T07's read port. `ai.full` stays OFF: these routes GOVERN a platform that is not yet
          // serving inference, which is the order §2.2 requires (a capability reaches APPROVED only
          // after the governance surface that approved it exists).
          //
          // THREE PORTS ARE DELIBERATELY UNBOUND HERE, and each refusal is a different shape:
          //   • `cipher` — no module on this platform binds a per-tenant DEK envelope yet, so R18's
          //     hallucination report refuses with 503 `AI_REPORT_CIPHER_UNBOUND`. `reporter_narrative_
          //     cipher` is NOT NULL and holds prose; writing it in the clear into a column named
          //     `_cipher` would make the §3.7 erasure report a destruction that never happened. Every
          //     OTHER hallucination route — the triage queue, the triage decision — works without one.
          //   • `budgets` — M2 states no token budget (`createUnconfiguredAiTokenBudgetResolver`), so
          //     R22's forecast reports `softCap`/`hardCap`/`projectedBreach` as `null` rather than as a
          //     green "no breach projected" tile minted from a missing configuration.
          //   • the prompt ARTIFACT reader stays unresolvable (there is no `/srv/prompts` mount this
          //     wave), so R30's activation refuses: a template pinned to a file nothing can read is a
          //     governance record of a prompt nobody can reproduce. R29 still answers from the TABLE.
          //
          // `capabilityShellMode: true` is what keeps R32's health endpoint GREEN while `ai.full` is
          // OFF — "no healthy backend" is the expected Phase-1 state, and reporting `degraded` for the
          // platform's intended posture is the fastest way to teach an operator to ignore the endpoint.
          const m32SafetyStoreDeps = {
            db: dbHandle.db,
            platformDb: dbHandle.db,
            auditBypass: m34PlatformBypassAuditor,
            jobId: M32_PLATFORM_JOB_ID,
            userId: "",
          };
          const m32PromptStore = createDrizzleAiPromptTemplateStore({
            db: dbHandle.db,
            platformDb: dbHandle.db,
            auditBypass: m34PlatformBypassAuditor,
            jobId: M32_PLATFORM_JOB_ID,
          });
          const m32PromptArtifacts = createUnresolvableAiPromptArtifactReader();
          const m32PromptRegistry = createAiPromptRegistry({
            store: m32PromptStore,
            artifacts: m32PromptArtifacts,
          });
          const m32Registry = createDrizzleAiCapabilityRegistryStore({
            db: dbHandle.db,
            platformDb: dbHandle.db,
            auditBypass: m34PlatformBypassAuditor,
            jobId: M32_PLATFORM_JOB_ID,
          });
          mountM32Routes(app, {
            governance: {
              registry: m32Registry,
              consent: createDrizzleAiTenantConsentStore({
                db: dbHandle.db,
                userId: "",
              }),
              // W4.1's evidence resolver stays DENYING: the BAA / ZDR / clinical-reviewer checks are
              // three upstream seams nothing binds yet, and a default that answered "resolved" would
              // make the wave's most consequential consent gate a no-op indistinguishable from a
              // working one (governance/service.ts's header).
              evidence: createDenyingAiOptInEvidenceResolver(),
              evaluations:
                createDrizzleAiEvaluationRunStore(m32SafetyStoreDeps),
            },
            safety: {
              killSwitches: createDrizzleAiKillSwitchStore(m32SafetyStoreDeps),
              reports: createDrizzleAiHallucinationReportStore({
                db: dbHandle.db,
                userId: "",
              }),
              evaluations:
                createDrizzleAiEvaluationRunStore(m32SafetyStoreDeps),
              registry: m32Registry,
            },
            prompts: {
              store: m32PromptStore,
              artifacts: m32PromptArtifacts,
              registry: m32PromptRegistry,
            },
            read: buildDrizzleM32ReadService({
              db: dbHandle.db,
              budgets: createUnconfiguredAiTokenBudgetResolver(),
              capabilityShellMode: true,
            }),
            routing: createDrizzleAiRoutingOverrideStore({
              db: dbHandle.db,
              userId: "",
            }),
            cipher: null,
            promptRegistry: m32PromptRegistry,
          });
          // M28 (FHIR Gateway) — mount the thirty-nine §4.1 routes over the Drizzle route store. The
          // FHIR-spec bearer surface (R1-R22) resolves its own SMART token; the admin console (R23-R39)
          // composes the §4.6 permission + §4.7 ABAC preHandlers. `fhir.write` stays OFF: read-only US
          // Core R4.
          //
          // F-035 (#95) — the read path is BOUND. The three things this call used to leave unwired were
          // each load-bearing: the JWKS fetcher (without it the SMART assertion path cannot verify a
          // signature), the token-endpoint URL (the `aud` an assertion must carry — without it the mint
          // refuses the assertion path outright rather than accepting an unbound audience), and the
          // replay guard. The disclosure sink is deliberately NOT passed: absent, the routes default to
          // `store.recordDisclosure`, which is the §164.528 ledger. It used to default to a no-op.
          //
          // The replay guard goes cluster-wide over Valkey when REDIS_URL is set and per-process
          // otherwise — the same posture as the credential throttle and the signup limiter above, and
          // for the same reason: on a single-replica deployment one replica IS the cluster.
          mountM28Routes(app, {
            store: createDrizzleFhirGatewayStore(dbHandle.db, { outbox: m28OutboxPublisher }),
            jwks: createHttpFhirJwksFetcher(),
            replay: rateLimitRedisClient
              ? createRedisFhirReplayGuard(rateLimitRedisClient)
              : createInMemoryFhirReplayGuard(),
            tokenEndpointUrl: process.env.FHIR_TOKEN_ENDPOINT_URL,
          });

          // M29 (External Interfaces) — mount the §4.1 operator + §4.2 clinician routes over the Drizzle
          // route store. Feed lifecycle (dual-approval + BAA gate), ADT proposal review (propose-then-review),
          // HL7 message search/replay/retry, NPPES administration, and the caseload-scoped lab surface.
          // The compliance decrypt of a stored HL7 payload still fails closed (Phase-1 501 — no module
          // binds a per-tenant DEK), walking the full guard chain first.
          // task-11 — the accept/reject decision events now RIDE the deciding tx (the M5/M6
          // appliers consume `m29.hl7_inbound_proposal.accepted` via the boot dispatcher).
          // GAP-045 — the §4.1.4 NPPES sync trigger is REAL: it enqueues onto the same
          // `nppes-sync-platform` queue the D11 nightly repeatable fires (503 when this deployment has no
          // queue connection, never a blanket 501).
          // GAP-044 — the §4.2 unmatched-lab review queue's exit. `patients` is a THUNK: the manual bind
          // resolves its target (and that patient's agency, ARCH-011) through M5's PatientReader seam,
          // which is registered by `wireModuleSeams()` AFTER this mount runs.
          mountM29Routes(app, {
            store: createDrizzleM29Store(dbHandle.db, {
              outbox: m29OutboxPublisher,
              patients: () => getPatientReader(),
            }),
            ...(m29NppesSync ? { nppesSyncTrigger: m29NppesSync.trigger } : {}),
          });
        }
      : undefined,
    registerModuleSeams: () =>
      wireModuleSeams({
        sessionContextStore: dbHandle
          ? createDbSessionContextStore(
              dbHandle.db,
              createDbActorEnrichmentReader(dbHandle.db),
            )
          : undefined,
        db: dbHandle?.db,
        organizationDb: platformDbHandle?.db,
        platformDb: platformDbHandle?.db,
        outboxPublisher: txOutboxPublisher,
      }),
    registerModuleErasers: () =>
      wireModuleErasers({
        db: dbHandle?.db,
        platformDb: platformDbHandle?.db,
        destructionDb: destructionDbHandle?.db,
      }),
  });
  if (m23SubmissionQueues) {
    app.addHook("onClose", async () => {
      await Promise.all(
        m23SubmissionQueues.queues.map((queue) => queue.close()),
      );
    });
  }
  if (m24SubmissionQueues) {
    app.addHook("onClose", async () => {
      await Promise.all(
        m24SubmissionQueues.queues.map((queue) => queue.close()),
      );
    });
  }
  if (m34ProvisionQueue)
    app.addHook("onClose", () => m34ProvisionQueue.close());
  // TASK-040B — close the readiness-probe's dedicated Redis connection on shutdown (the per-queue
  // BullMQ connections below close via their own onClose hooks; this one is health-check-only).
  if (redisHealthClient) app.addHook("onClose", () => redisHealthClient.quit());
  if (rateLimitRedisClient)
    app.addHook("onClose", () => rateLimitRedisClient.quit());
  // TASK-040C (OPS-005/006) — Prometheus metrics. HTTP + outbox counters/gauges register for EVERY
  // role (they're cheap and role-agnostic — an API-only replica's `wardenx_outbox_pending_depth`
  // correctly reads 0 since no dispatcher runs there); the BullMQ per-queue gauge only registers where
  // queues are actually constructed, further below, inside the worker-runner block.
  const metricsRegistry = buildMetricsRegistry();
  registerHttpMetrics(app, metricsRegistry);
  const outboxMetrics = registerOutboxMetrics(metricsRegistry, {
    pendingDepth: outboxPendingDepth,
  });
  // F-033/#93 — partition-coverage gauges. Registered for EVERY role, like the outbox ones: the read is
  // a catalog scan of ~43 relations, and an API-only replica answering it is exactly as correct as the
  // worker answering it. Deliberately NOT folded into `/ready`: a table running low on partition
  // headroom is a maintenance signal, and taking an otherwise-healthy replica out of the load balancer
  // for it would turn a scheduling problem into an outage.
  registerPartitionMetrics(metricsRegistry, {
    coverage: dbHandle ? () => readPartitionCoverage(dbHandle.db) : undefined,
  });
  mountMetricsRoute(app, metricsRegistry);
  // TASK-040D (OPS-012) — DLQ-promotion alerting, shared by BOTH the BullMQ worker-runner block and the
  // outbox-dispatcher block below (two SEPARATE top-level `if`s — declared here, outside either, so it's
  // in scope for both rather than duplicated). Log-based always-on (the task's own explicit "log-based
  // alert" allowance) plus an optional webhook when OPS_ALERT_WEBHOOK_URL is configured. Cheap to
  // construct unconditionally — it does nothing until something calls it.
  const dlqPromotionSink = buildDlqPromotionSink({
    webhookUrl: process.env.OPS_ALERT_WEBHOOK_URL,
    log: (m) => app.log.error(m),
  });
  // TASK-001 (production-readiness audit 2026-08-03) — ALL wiring is done (bootSeams + every route
  // mount ran inside buildServer above): refuse to boot in production, and loudly list in dev, every
  // in-memory binding still standing behind a production contract on a DATABASE_URL boot. The ledger
  // notes live beside the bindings that chose them (wireModuleSeams / wireModuleErasers / the mount
  // notes in registerModuleRoutes). WARDENX_INMEM_ASSERT=warn is the audit's one-iteration rollback.
  assertNoInMemoryBindingsOnDbBoot({ dbPresent: dbHandle !== undefined });
  if (dbHandle && auth) {
    // AC-05 — SECURITY_HARDENING §5.3.1's per-username + per-IP FAILED-attempt budgets. The global
    // SD-055 tier does cover /api/auth/* (it exempts no path, unlike the CSRF plugin), but it counts
    // ALL requests by IP at 30/min and so does nothing about a slow distributed run against one
    // named account — the credential-stuffing shape §5.3.1 actually names. Cluster-wide over Valkey
    // when REDIS_URL is set; per-replica otherwise. Usernames are hashed before they become keys.
    registerIdentityAuth(app, auth, {
      credentialThrottle: createCredentialThrottle(
        rateLimitRedisClient
          ? createRedisFailedLoginStore(rateLimitRedisClient)
          : createInMemoryFailedLoginStore(),
        {
          onStoreError: (err) =>
            app.log.warn(
              { err },
              "credential-throttle store unavailable — failing open",
            ),
        },
      ),
    }); // AUTH-T02: mount /api/auth/* (needs BETTER_AUTH_SECRET/URL in prod)
    app.addHook("onClose", () => dbHandle.close());
  }
  // Close the separate M35 platform-ops credential pool on shutdown (when configured).
  if (platformDbHandle) app.addHook("onClose", () => platformDbHandle.close());
  if (destructionDbHandle)
    app.addHook("onClose", () => destructionDbHandle.close());

  // M37 D16 — the AI-prohibited-zone boot validator (§8.6). With a db, M32's real AIPromptRegistry is
  // registered (bootSeams ran inside buildServer), so this asks the D18 table-only query whether any active
  // prompt targets an M37 mutation zone (GIP criteria / IRC cap-override / restraint / body-release) and
  // REFUSES to listen if so — the deny-stub throws on a no-db slice boot, so it is gated on a real db. This
  // is belt-and-suspenders with the central AI_PROHIBITED_ZONES table (the R30 registration-time guard).
  if (dbHandle) {
    app.addHook("onReady", async () => {
      await validateIpuAIBlock(
        getSeam("AIPromptRegistry") as unknown as IpuAiPromptRegistryPort,
      );
    });
  }

  // M1-T10 — boot-populate `outbox_event_catalog` from the FULL catalog (idempotent UPSERT on event_name;
  // platform reference data, NON_ORG_SCOPED). Fail-soft: a failure here logs but never blocks boot (the
  // dispatcher validates against the in-memory `bootOutboxCatalog`, not this table). Fire-and-forget — there
  // is nothing to close, so no onClose hook is needed.
  if (dbHandle) {
    wireOutboxCatalog(dbHandle.db, bootOutboxCatalog).catch((err) => {
      app.log.error(err, "outbox_event_catalog population failed");
    });
  }

  // ARCH-023 / TASK-066 — boot-populate `organization_settings_registry` from the in-code registry
  // (idempotent UPSERT on settings_key; platform reference data, NON_ORG_SCOPED). The row was never
  // written before this: migration 0003's collision-guard trigger reads it to decide whether a
  // settings key is `uniqueAcrossTenants`, and treats an absent row as "no opinion" rather than
  // failing closed — so leaving this unwired never blocked a settings write, it just left the W-M1-08
  // uniqueness guard permanently inert for every module that declared one. Fail-soft, fire-and-forget,
  // same posture as the outbox-catalog boot above.
  if (dbHandle) {
    wireOrganizationSettingsRegistry(dbHandle.db).catch((err) => {
      app.log.error(err, "organization_settings_registry population failed");
    });
  }

  // GAP-096 — boot-populate alert_rule's platform-default rows (organization_id IS NULL) from
  // PLATFORM_DEFAULT_ALERT_RULES, via the migration-0193 SECURITY DEFINER function (see
  // alert-rule-seed-persister.ts) — runs over the ordinary tenant pool (dbHandle), no platform
  // credential required. Fail-soft, fire-and-forget, same posture as the two boot-populates above.
  if (dbHandle) {
    wireAlertRuleSeed(dbHandle.db).catch((err) => {
      app.log.error(err, "alert_rule platform-default seed population failed");
    });
  }

  // GAP-098 — the same boot-populate for M34's own platform-default rules, whose header has called this
  // "the Phase 2D boot UPSERT" since the file was written while nothing performed it. PARTIAL by design:
  // only rules naming an M36 BUILT-IN resolver are seeded, because M36's registry THROWS on an unknown
  // resolver name and M34's own two resolvers are implemented but never registered at boot — seeding
  // those would turn a dormant rule into a failing emit. The skipped count is logged rather than
  // swallowed so the remaining gap stays visible.
  if (dbHandle) {
    wireM34AlertRuleSeed(dbHandle.db)
      .then((result) => {
        if (result.skipped > 0) {
          app.log.warn(
            {
              seeded: result.seeded,
              skipped: result.skipped,
              resolvers: result.skippedResolvers,
            },
            "M34 alert_rule seed is PARTIAL — rules naming an unregistered recipient resolver were " +
              "skipped; they stay dormant until registerM34AlertResolvers is bound at boot",
          );
        }
      })
      .catch((err) => {
        app.log.error(
          err,
          "M34 alert_rule platform-default seed population failed",
        );
      });
  }

  // ── worker-runner section (the M4-T11 BullMQ worker-construction precedent) ──────────────────────────
  // Construct the §4.3 M34 BullMQ Workers + the four cron-schedule Queue producers, and tear them down on
  // app close. Guarded by a Valkey connection (constructing a Worker opens the connection — never at import,
  // never in tests). When REDIS_URL is unset the workers are NOT constructed (the host still boots; the
  // command routes' enqueue ports already fail closed without a connection). The M4 audit workers
  // (registerAuditWorkers/scheduleAuditJobs) stay deferred here until their production AuditJobAdapters have
  // a boot accessor — they are the SAME construction shape and slot in beside the M34 block when bound.
  // TASK-040A — also gated on `role !== "api"`: an API-only replica must not construct these (it would
  // re-register the same repeatable cron schedules on every replica and compete for the same jobs);
  // the "worker" role (or the default "all") does.
  if (role !== "api" && dbHandle && queueConnection) {
    // TASK-040D (OPS-012) — apply the shared `dlqPromotionSink` (declared above, before this block) to
    // EVERY module's constructed Worker set below (existing modules + TASK-040D's new M7/M9/M10 ones),
    // using BullMQ's own `Worker.name` (the queue name) as the source label — one call site, not one
    // bespoke wiring per module.
    const attachDlqAlertsToAll = (
      workers: readonly Worker[],
      modulePrefix: string,
    ): void => {
      for (const w of workers)
        attachDlqPromotionAlert(
          w,
          `${modulePrefix}:${w.name}`,
          dlqPromotionSink,
        );
    };
    const m34Workers: Worker[] = [];
    // GAP-048 — the DSAR-export worker's object-store PUT + M22 DocumentRenderer capability. A fresh
    // SigV4 client off the SAME MINIO_* env contract M22 uses (not M22's own instance — createS3ObjectStore
    // is a pure stateless signer, nothing to share); `deriveTenantBucket`/`getDocumentRenderer` are M22's
    // real implementations, reachable here (the composition root) but not from M34's own module folder
    // (module-boundary discipline, ADR-0005 D1).
    const m34DsarS3Config = s3ObjectStoreConfigFromEnv(process.env);
    const m34DsarObjectStore = m34DsarS3Config
      ? createS3ObjectStore(m34DsarS3Config)
      : null;
    const m34DsarExportDeps = m34DsarObjectStore
      ? {
          objectStore: {
            putObject: (args: {
              organizationId: string;
              objectKey: string;
              bytes: Uint8Array;
            }) =>
              m34DsarObjectStore.putObject({
                bucket: deriveTenantBucket(args.organizationId),
                objectKey: args.objectKey,
                bytes: args.bytes,
              }),
          },
          render: {
            render: (args: DsarDocumentUploadRequest) =>
              getDocumentRenderer().render(
                { orgId: args.organizationId },
                "dsar_bundle",
                args,
              ),
          },
          outbox: m34OutboxPublisher,
        }
      : undefined;
    // GAP-094 — the tenant-export worker's object-store PUT + M22 DocumentRenderer capability, the
    // `tenant.export` sibling of the DSAR dep bag above. Reuses the SAME `m34DsarObjectStore` client (one
    // stateless SigV4 signer off the one MINIO_* env contract — no reason to construct a second instance)
    // and a new `tenant_export_cover_letter` render template (renderer.ts).
    const m34TenantExportDeps = m34DsarObjectStore
      ? {
          objectStore: {
            putObject: (args: {
              organizationId: string;
              objectKey: string;
              bytes: Uint8Array;
            }) =>
              m34DsarObjectStore.putObject({
                bucket: deriveTenantBucket(args.organizationId),
                objectKey: args.objectKey,
                bytes: args.bytes,
              }),
          },
          render: {
            render: (args: {
              organizationId: string;
              aggregateId: string;
              bundleSha256: string;
            }) =>
              getDocumentRenderer().render(
                { orgId: args.organizationId },
                "tenant_export_cover_letter",
                args,
              ),
          },
        }
      : undefined;
    if (m34ProvisionGateway && m34TenantStorage && platformDbHandle) {
      const workerDeps = buildM34WorkerDeps({
        connection: queueConnection,
        db: dbHandle.db,
        platformDb: platformDbHandle.db,
        dsarExport: m34DsarExportDeps,
        tenantExport: m34TenantExportDeps,
        provision: {
          auditBypass: m34PlatformBypassAuditor,
          ...m34ProvisionGateway,
          storage: m34TenantStorage,
          // AFTER the spread: the platform KEK wins over the gateway's `/dek/wrap` (see m34KeyMaterial).
          ...(m34KeyMaterial ? { keyMaterial: m34KeyMaterial } : {}),
          outbox: m34OutboxPublisher,
        },
        keyLifecycle: {
          auditBypass: m34PlatformBypassAuditor,
          keyMaterial: m34KeyMaterial ?? m34ProvisionGateway.keyMaterial,
          storage: m34ProvisionGateway.destructionStorage,
          outbox: m34OutboxPublisher,
          async destroyTenantKeyRing(input) {
            await platformDbHandle.db.transaction(async (tx) => {
              await tx.execute(
                sql`SELECT set_config('app.destroyed_by_membership_id', ${input.actorMembershipId}, true)`,
              );
              await tx.execute(
                sql`SELECT m34_destroy_tenant_key_ring(${input.tenantAccountId}, ${input.destructionCertId})`,
              );
            });
          },
          destructionWorkflow: (() => {
            const workflow = createM34DestructionWorkflow();
            return {
              ...workflow,
              async authorizationFacts(
                tx: DbClient,
                input: {
                  readonly orgId: string;
                  readonly destructionCertId: string;
                  readonly actorMembershipId: string;
                },
              ) {
                return {
                  ...(await workflow.authorizationFacts(tx, input)),
                  actorUserId: await m34ActiveMembershipUserId(
                    tx,
                    input.actorMembershipId,
                  ),
                };
              },
            };
          })(),
          shredSubjects: {
            patientIds: m34TenantPatientIds,
            soleTenantUserIds: m34SoleTenantUserIds,
          },
        },
      });
      const provisionWorker = registerM34ProvisionWorker(workerDeps);
      const dekRotateWorker = registerM34DekRotateWorker(workerDeps);
      m34Workers.push(provisionWorker);
      m34Workers.push(dekRotateWorker);
      app.addHook("onClose", () =>
        Promise.all([provisionWorker.close(), dekRotateWorker.close()]),
      );
      if (destructionDbHandle) {
        const shredWorker = registerM34ShredWorker(workerDeps);
        m34Workers.push(shredWorker);
        app.addHook("onClose", () => shredWorker.close());
      }
      // GAP-048 — the DSAR-export worker is org-scoped (F09), so it doesn't strictly need platformDb/the
      // provision gateway; it's constructed alongside them here purely because `workerDeps` is already
      // built in this block. Only registered when the MINIO_* env contract is present (m34DsarExportDeps),
      // matching the shred worker's "constructed only when its capability is present" posture.
      if (m34DsarExportDeps) {
        const dsarExportWorker = registerM34DsarExportWorker(workerDeps);
        m34Workers.push(dsarExportWorker);
        app.addHook("onClose", () => dsarExportWorker.close());
        enableM34JobCapability("tenant.dsar_export");
      }
      // GAP-094 — the tenant-export worker, the same "org-scoped, constructed alongside the platform-scoped
      // ones purely because workerDeps is already built here" posture as the DSAR worker just above.
      if (m34TenantExportDeps) {
        const tenantExportWorker = registerM34TenantExportWorker(workerDeps);
        m34Workers.push(tenantExportWorker);
        app.addHook("onClose", () => tenantExportWorker.close());
        enableM34JobCapability("tenant.export");
      }
      attachDlqAlertsToAll(m34Workers, "m34");
      app.log.info(
        `M34 key lifecycle workers constructed: provision, dek_rotate${destructionDbHandle ? ", shred" : ""}${m34DsarExportDeps ? ", dsar_export" : ""}${m34TenantExportDeps ? ", tenant_export" : ""}`,
      );
    } else {
      app.log.warn(
        "M34 tenant provisioning disabled: platform DB, provision gateway, and MINIO_* configuration are required",
      );
    }

    // ── M33 §4.8 reporting workers + cron schedules (the same worker-runner shape) ──────────────────────
    // Construct the §4.8 BullMQ Workers (mv_refresh / scheduled_run / export_render / drilldown_audit_flush /
    // lag_probe) + the two repeatable cron schedules (the 30s lag probe + the nightly MV-refresh tick).
    // WX-PR-014 bound: the per-job tenancy envelope (withOrgContext/withPlatformContext, previously absent —
    // every M33 worker ran on the un-scoped base client), the §4.10 outbox emits that satisfy their catalog
    // schema, the Valkey-backed lag-probe state (a DEDICATED connection — separate from `queueConnection`'s
    // BullMQ-broad `ConnectionOptions` union, the same `rateLimitRedisClient` precedent above), and the
    // nightly MV-refresh orchestrator's real per-MV fan-out producer (`m33MvRefreshEnqueue`, a SEPARATE
    // `Queue` handle from the one the worker below consumes — a producer needs its own `Queue.add`).
    const m33LagProbeRedis = queueConnection
      ? new Redis({
          ...(queueConnection as RedisOptions),
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          connectTimeout: 2_000,
          retryStrategy: (times) => Math.min(times * 200, 2_000),
        })
      : undefined;
    m33LagProbeRedis?.on("error", () => {});
    const m33MvRefreshEnqueue = buildM33MvRefreshEnqueue(queueConnection);
    // WX-PR-025: `platformDb` prefers the separate `platformDbHandle` (DATABASE_PLATFORM_URL) over the
    // tenant `wardenx_app` pool when configured — `mvRefresh`'s nightly cross-tenant REFRESH needs the
    // `wardenx_platform` credential's ownership + BYPASSRLS over the report_mv.* views (provisioned by
    // `scripts/db/provision-runtime-roles.ts`) to genuinely span every tenant; `wardenx_app` has no
    // privilege to REFRESH those views at all. Falls back to `dbHandle.db` when the platform credential
    // isn't configured (dev/CI without DATABASE_PLATFORM_URL) — `lagProbe`'s own `platform.bypass_invoked`
    // audit write and `scheduledRun`'s ordinary org-scoped work are unaffected either way.
    const m33Workers = registerM33Workers(
      buildM33WorkerDeps({
        connection: queueConnection,
        db: dbHandle.db,
        platformDb: platformDbHandle?.db ?? dbHandle.db,
        auditBypass: m34PlatformBypassAuditor,
        outboxPublisher: m33OutboxPublisher,
        lagProbeRedis: m33LagProbeRedis,
        mvRefreshEnqueue: m33MvRefreshEnqueue.enqueue,
      }),
    );
    attachDlqAlertsToAll(m33Workers, "m33");
    app.addHook("onClose", async () => {
      await Promise.all(m33Workers.map((w) => w.close()));
      await Promise.all([
        m33LagProbeRedis?.quit(),
        m33MvRefreshEnqueue.queue?.close(),
      ]);
    });
    // Register the repeatable cron schedules + their close hook BEFORE app.listen() (the M34
    // FST_ERR_INSTANCE_ALREADY_LISTENING gotcha — await here so the hook is added while pre-listen).
    try {
      const m33ScheduleQueues = await scheduleM33Jobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m33ScheduleQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M33 cron-schedule registration failed");
    }
    app.log.info(
      { queues: m33Workers.length },
      "M33 §4.8 BullMQ reporting workers constructed",
    );

    // ── platform.partition_rotate — the time-partition rotation cron (F-033 / #93) ─────────────────────
    //
    // Keeps the current + 3 following months of partitions created for every time-RANGE partitioned
    // table, discovered from `pg_catalog` (migration 0224). Runs on the 1st, 8th and 15th: the work is a
    // no-op once the window is covered, so three cheap chances beat one tick that a restart can eat.
    //
    // It uses the PLATFORM credential, not the tenant pool. Partition DDL needs ownership of the parent
    // table and `wardenx_app` has none — the definer-rights `rotate_time_partitions` bridges that, and
    // `scripts/db/provision-runtime-roles.ts` grants EXECUTE on it to `wardenx_platform`. Falling back to
    // `dbHandle.db` keeps dev/CI (no DATABASE_PLATFORM_URL) working, where the connected role is usually
    // the owner anyway.
    const partitionRotateWorker = new Worker(
      PARTITION_ROTATION_QUEUE,
      async () => {
        const rows = await runPartitionRotation({
          platformDb: platformDbHandle?.db ?? dbHandle.db,
          auditBypass: m34PlatformBypassAuditor,
        });
        const summary = summarizeRotation(rows);
        // A blocked table is not a job failure to retry — retrying cannot help, because the partition is
        // refused for as long as DEFAULT holds those rows. It is an operator task, so it is logged at
        // error level with the table names and the job still completes.
        if (!summary.healthy) {
          app.log.error(
            { blocked: summary.blocked, noCreator: summary.noCreator },
            "partition rotation completed with tables that need manual repair",
          );
        } else {
          app.log.info(
            { created: summary.created, alreadyCovered: summary.ok },
            "partition rotation complete",
          );
        }
        return summary;
      },
      { connection: queueConnection, concurrency: 1 },
    );
    attachDlqAlertsToAll([partitionRotateWorker], "platform");
    app.addHook("onClose", async () => {
      await partitionRotateWorker.close();
    });
    try {
      const partitionRotateQueue = new Queue(PARTITION_ROTATION_QUEUE, {
        connection: queueConnection,
      });
      await partitionRotateQueue.add(
        "scheduled",
        {},
        { repeat: { pattern: PARTITION_ROTATION_CRON }, removeOnComplete: true },
      );
      app.addHook("onClose", async () => {
        await partitionRotateQueue.close();
      });
    } catch (err) {
      app.log.error(err, "partition-rotation cron registration failed");
    }

    // ── M30 §4.8 HQRP/quality workers + cron schedules (the same worker-runner shape) ───────────────────
    // Construct the four §4.8 WORK-queue Workers (measure_recompute / cahps_export / outbreak_detection /
    // risk_register_refresh) + the four STANDALONE cron consumers + their four repeatable cron-schedule
    // Queues. The worker ports bind their bindable adapters (the M30 repos + the on-PRIMARY MV refresh) and
    // the ONE live consumed seam — the M10 HOPE consumer, composed below from the three §D10 M10 readers
    // resolved via `getSeam` (RULE 4). Everything still-unlanded (the transactional-outbox dispatcher, the
    // envelope-DEK helper for CAHPS PHI, the M36 alert router, the per-family measure-input provider, the
    // platform active-org / decedent / open-SRA-cycle readers, the per-org enqueue producers, the M1
    // `processing_log` accessor) stays a LAZY fail-closed thunk inside the package wiring — those job paths
    // throw `M30WorkerPortUnbound` only when a JOB RUNS; boot stays green (the M34 eager-bind gotcha).
    //
    // The §4.4 / M10-real HOPE consumer: M30 needs ORG-WIDE rollups (timepoint completion / submission
    // posture / SFV timeliness / J2051 timely-follow-up / open-SFV count). M10 now publishes a dedicated
    // org-scoped aggregate seam for exactly this — `HopeOrgRollupProvider` (#107) — alongside its per-entity
    // readers. Each method delegates LAZILY to `getSeam("HopeOrgRollupProvider")` at call time (RULE 4 — so a
    // not-yet-registered M10 surface fails closed via the registry deny-stub at run time, never at boot), and
    // the recompute worker never reaches `hope` until `registrations` + `resolveInput` are bound anyway.
    const m30HopeConsumer: QualityHopeConsumer = {
      timepointCompletionRollup(organizationId, period) {
        return getSeam("HopeOrgRollupProvider").timepointCompletionRollup(
          organizationId,
          period,
        );
      },
      submissionPostureRollup(organizationId, period) {
        return getSeam("HopeOrgRollupProvider").submissionPostureRollup(
          organizationId,
          period,
        );
      },
      sfvTimelinessRollup(organizationId, period) {
        return getSeam("HopeOrgRollupProvider").sfvTimelinessRollup(
          organizationId,
          period,
        );
      },
      j2051FollowUpRollup(organizationId, period) {
        return getSeam("HopeOrgRollupProvider").j2051FollowUpRollup(
          organizationId,
          period,
        );
      },
      openSfvObligationCount(organizationId) {
        return getSeam("HopeOrgRollupProvider").openSfvObligationCount(
          organizationId,
        );
      },
    };
    // #107 item 2 — bind the active-org enumerator so the §4.8 cron fan-outs enumerate every active tenant
    // under withPlatformContext (allowlisted via wireM30Tenancy above; audited by the shared platform-bypass
    // auditor — its event records the M30 jobId, so the "M34" name is incidental, the auditor is module-agnostic).
    const m30ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: dbHandle.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M30_PLATFORM_JOB_ID,
      reason: "M30 §4.8 cron fan-out (active-org enumeration)",
    });
    // The two §4.11 HVLDL consumed seams — the M6 death-discharge census (denominator) + the M8
    // signed-encounter reader (the EVV-verified qualifying-visit numerator source). Both are M-owned,
    // leaf-typed, and already registered by wireModuleSeams above (DeathDischargeReader over its dedicated
    // Drizzle reader when a db is present, else its fail-closed deny-stub; SignedEncountersReader over M8's
    // in-memory store). Resolved here via `getSeam` (RULE 4) and handed to the worker deps the same way the
    // M10 HOPE consumer is — each self-scopes on its own connection, so an HVLDL recompute reads its census
    // without M30 touching M6/M8 schema directly.
    const m30DeathDischargeReader = getSeam("DeathDischargeReader");
    const m30SignedEncounters = getSeam("SignedEncountersReader");
    // HCI indicators 1 / 3 / 4's consumed seams — same M6-owned, leaf-typed, dedicated-Drizzle-reader
    // posture as DeathDischargeReader above (registered by wireModuleSeams; self-scoping; resolved here
    // via getSeam, RULE 4).
    const m30LevelOfCarePeriodReader = getSeam("LevelOfCarePeriodReader");
    const m30DischargeReader = getSeam("DischargeReader");
    // opioid_on_admission_rate's two consumed seams — M6's admission-onset census (same self-scoping
    // posture as above) + M12's ALREADY-published MedicationOrderProvider (no new M12 seam surface).
    const m30AdmissionOnsetReader = getSeam("AdmissionOnsetReader");
    const m30MedicationOrders = getSeam("MedicationOrderProvider");
    // WX-PR-014 — a second `buildM30RecomputeEnqueue` instance for the CRON fan-out (the route-scoped
    // `m30Recompute` built for `mountM30Routes` above is a different block's `const`, not reachable here).
    // Same producer, same queue names — BullMQ allows multiple `Queue` client handles per named queue, so
    // this is a second independent connection, not a duplicate queue; its `.queues` close on shutdown below
    // alongside the worker set.
    const m30CronRecompute = buildM30RecomputeEnqueue(queueConnection);
    const m30WorkerDeps = buildM30WorkerDeps({
      connection: queueConnection,
      db: dbHandle.db,
      hopeProvider: m30HopeConsumer,
      activeOrgs: m30ActiveOrgs,
      deathDischargeReader: m30DeathDischargeReader,
      signedEncounters: m30SignedEncounters,
      levelOfCarePeriodReader: m30LevelOfCarePeriodReader,
      dischargeReader: m30DischargeReader,
      admissionOnsetReader: m30AdmissionOnsetReader,
      medicationOrders: m30MedicationOrders,
      // WX-PR-014 — the nightly-recompute + risk-register-refresh cron fan-outs: the per-org provider-entity
      // lister (already used for M30's published seams) + the real BullMQ producer + the SAME tx-scoped
      // outbox publisher the M30 routes already use (`m30.measure.value_emitted` / `m30.risk_register
      // .refreshed` are called UNCONDITIONALLY by their workers — without this every recompute/refresh job
      // throws on its last line and rolls back, see M30WorkerDeps' doc comment).
      providerEntities: buildOrgProviderEntityLister(dbHandle.db),
      recomputeEnqueue: m30CronRecompute.enqueue,
      outboxPublisher: m30OutboxPublisher,
    });
    const m30Workers = [
      ...registerM30Workers(m30WorkerDeps),
      ...registerM30CronWorkers(m30WorkerDeps),
    ];
    attachDlqAlertsToAll(m30Workers, "m30");
    app.addHook("onClose", async () => {
      await Promise.all([
        ...m30Workers.map((w) => w.close()),
        ...m30CronRecompute.queues.map((q) => q.close()),
      ]);
    });
    // Register the four §4.8 repeatable cron schedules + their close hook BEFORE app.listen() (the M34
    // FST_ERR_INSTANCE_ALREADY_LISTENING gotcha — await here so the hook is added while pre-listen).
    try {
      const m30ScheduleQueues = await scheduleM30Jobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m30ScheduleQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M30 cron-schedule registration failed");
    }
    app.log.info(
      { queues: m30Workers.length },
      "M30 §4.8 BullMQ HQRP/quality workers constructed",
    );
    // ── M27 §4.8 Cost-Report workers + the filing-deadline cron (same worker-runner shape) ──────────────
    // WX-PR-013 bound the outbox/alerts/active-org ports for real (the M25 alert/active-org-enumerator
    // pattern); the M1 DEK + Xero/Gusto pull seams + M6/M8 statistics seams remain explicit deny-stub
    // forward work (see wiring.ts / jobs/m27-jobs.ts for why — RULE 4 still applies: those typed thunks
    // throw only when a JOB RUNS, so boot stays green).
    const m27ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: dbHandle.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M27_PLATFORM_JOB_ID,
      reason: "M27 §4.8 cron fan-out (active-org enumeration)",
    });
    const m27AlertEmitter = getSeam("AlertEmitter") as {
      emit(
        orgId: string,
        input: {
          eventType: string;
          payload: Record<string, unknown>;
          severity: string;
          correlationId: string;
        },
      ): Promise<unknown>;
    };
    const m27WorkerDeps = buildM27WorkerDeps({
      connection: queueConnection,
      db: dbHandle.db,
      // WX-PR-013 — the pre-existing catalog-validating tx publisher (callerModule `m27`), now bound so every
      // §4.10 m27.* emit from a §4.8 processor (allocation-recompute / validation-run / ecr-generation / …)
      // actually lights up instead of throwing `M27WorkerPortUnbound` when the job runs.
      outbox: m27OutboxPublisher,
      // WX-PR-013 — the §4.9 filing-deadline tier alerts, routed through the live M36 AlertEmitter seam.
      alerts: {
        dispatch: async ({ alertCode, severity, organizationId, payload }) => {
          await m27AlertEmitter.emit(organizationId, {
            eventType: alertCode,
            payload,
            severity,
            correlationId: `m27-cron:${alertCode}`,
          });
        },
      },
      // WX-PR-013 — the filing-deadline-scan cron fan-out source (under withPlatformContext, allowlisted by
      // wireM27Tenancy() at boot).
      activeOrgs: m27ActiveOrgs,
      // M26's CapAccrualReader is registered live above (registerM26PublishedSeams) — flag the cap provider
      // bound so the cost-report cap rules evaluate against the live aggregate (per-org availability still
      // comes from the cap-context resolver, which fail-closes when an org has no cap period). D13.
      capProviderBound: true,
      // The §11.B ValidationContext shaper — reads M27's materialized state + the live M26 cap / M40 MAC
      // jurisdiction and assembles the typed context every validation rule evaluates against (the M30
      // buildM30WorkerDeps({ deathDischargeReader: getSeam(...) }) precedent). M23-gated rules SKIP (unbound).
      validationContext: buildM27ValidationContext({
        capResolver: m27CapSeamResolver,
        providerEntity: () =>
          getSeam("MdmEntityProvider") as M27ProviderEntityResolver,
        // M23 billed-census + M25 actual interim payments + M12 drug-cost basis (opaque rich-seams; cast to
        // M27's consumer views). Each degrades to its deny-stub (rule SKIPS) until the producer binds live.
        patientDays: () => getSeam("PatientDaysProvider") as M27PatientDaysSeam,
        settlement: () =>
          getSeam("ClaimSettlementProvider") as M27ClaimSettlementSeam,
        drugCost: () => getSeam("DrugCostBillingReader") as M27DrugCostSeam,
      }),
      // The §4320/§4330 allocation-input shaper — reads M27's materialized Worksheet A/A-1…A-4/B-1 + the
      // statistics census and assembles the hospice chain inputs (Worksheet B step-down on the B-1 statistical
      // basis → Worksheet C per-diem cost by level of care). No cap/settlement worksheet on the form (M26).
      allocationInputs: buildM27AllocationInputs(),
    });
    const m27Workers = [
      ...registerM27Workers(m27WorkerDeps),
      ...registerM27CronWorkers(m27WorkerDeps),
    ];
    attachDlqAlertsToAll(m27Workers, "m27");
    app.addHook("onClose", async () => {
      await Promise.all(m27Workers.map((w) => w.close()));
    });
    app.addHook("onClose", async () => {
      await Promise.all(m27Recompute.queues.map((q) => q.close()));
    });
    try {
      const m27ScheduleQueues = await scheduleM27Jobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m27ScheduleQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M27 cron-schedule registration failed");
    }
    app.log.info(
      { queues: m27Workers.length },
      "M27 §4.8 BullMQ cost-report workers constructed",
    );
    // ── M23 §4.8 Billing workers (claim/NOE/NOTR submit[.retry], eligibility refresh, validation-run,
    // revalidate consumer) + the cron consumers (999/277CA ack pulls, NOE/NOTR window-watch, eligibility
    // stale-watch, MAC-portal health) — same worker-runner shape. buildM23WorkerDeps binds only the
    // connection + db; every infra/seam/x12/portal port stays fail-closed-unbound at boot (RULE 4 — the typed
    // thunks in m23-jobs.ts throw only when a JOB RUNS, so boot stays green). The live binds (transactional
    // outbox, x12-837-client generation, MAC-portal HTTP, HETS eligibility, the M2 active-org / MAC-jurisdiction
    // enumerators for the cron fan-out, the validation-runner → claim-validation-service, the M36 alert router)
    // are follow-ups.
    let m23Workers: Worker[] = [];
    if (m23LaunchGateway) {
      const m23WorkerDeps = buildM23WorkerDeps({
        connection: queueConnection,
        db: dbHandle.db,
        outbox: m23OutboxPublisher,
        x12: m23LaunchGateway.x12,
        macPortal: m23LaunchGateway.macPortal,
        jurisdictions: {
          listJurisdictions: async () => [{ macJurisdiction: "ngs_j6" }],
        },
      });
      m23Workers = registerM23LaunchWorkers(m23WorkerDeps);
      attachDlqAlertsToAll(m23Workers, "m23");
      app.addHook("onClose", async () => {
        await Promise.all(m23Workers.map((worker) => worker.close()));
      });
      try {
        const m23ScheduleQueues = await scheduleM23LaunchJobs(queueConnection);
        app.addHook("onClose", async () => {
          await Promise.all(m23ScheduleQueues.map((queue) => queue.close()));
        });
      } catch (err) {
        app.log.error(
          err,
          "M23 launch acknowledgment schedule registration failed",
        );
      }
      app.log.info(
        { queues: m23Workers.length },
        "M23 launch submission workers constructed",
      );
    } else {
      app.log.warn(
        "M23 launch workers disabled: configure X12 and MAC gateway URLs and bearer tokens",
      );
    }
    // ── M24 §4.9 Billing-Medicaid workers (WX-PR-011: claim submit + poll over the per-state adapter
    // registry) — same worker-runner shape as M23. Requires BOTH the Oregon launch-gateway (real HTTP,
    // env-gated) AND the credential resolver (the §8.7 cipher port) — RULE 4: either absent, no workers
    // construct, and `submitClaim`'s outbox event sits durably queued until an integrator binds both.
    let m24Workers: Worker[] = [];
    if (m24OregonGateway && m24CredentialResolver) {
      const m24WorkerDeps = buildM24SubmissionWorkerDeps({
        connection: queueConnection,
        db: dbHandle.db,
        outbox: m24OutboxPublisher,
        adapters: m24AdapterRegistry,
        credentials: m24CredentialResolver,
      });
      m24Workers = registerM24LaunchWorkers(m24WorkerDeps);
      attachDlqAlertsToAll(m24Workers, "m24");
      app.addHook("onClose", async () => {
        await Promise.all(m24Workers.map((worker) => worker.close()));
      });
      app.log.info(
        { queues: m24Workers.length },
        "M24 launch submission workers constructed",
      );
    } else {
      app.log.warn(
        "M24 launch workers disabled: configure M24_LAUNCH_GATEWAY_ENABLED and M24_CREDENTIAL_ENCRYPTION_KEY",
      );
    }
    // ── M25 §4.8 Remittance crons (denial-aging rebucket + appeal-deadline watch) — same worker-runner
    // shape. buildM25WorkerDeps binds only the connection + db; the M2 active-org enumerator (the per-org
    // cron fan-out source, under withPlatformContext) + the M36 alert router stay fail-closed-unbound at boot
    // (RULE 4 — the typed thunks in cron-workers.ts throw only when a CRON TICK RUNS, so boot stays green).
    // Bind the active-org enumerator (the cron fan-out source; allowlisted via wireM25Tenancy, audited by
    // the shared module-agnostic platform-bypass auditor) + the M36 AlertEmitter so the crons enumerate
    // every active tenant under withPlatformContext and fire the §4.9 typed alerts.
    const m25ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: dbHandle.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M25_PLATFORM_JOB_ID,
      reason: "M25 §4.8 cron fan-out (active-org enumeration)",
    });
    const m25AlertEmitter = getSeam("AlertEmitter") as {
      emit(
        orgId: string,
        input: {
          eventType: string;
          payload: Record<string, unknown>;
          severity: string;
          correlationId: string;
        },
      ): Promise<unknown>;
    };
    const m25Alerts: M25WorkerAlertPort = {
      dispatch: async ({ alertCode, severity, organizationId, payload }) => {
        await m25AlertEmitter.emit(organizationId, {
          eventType: alertCode,
          payload,
          severity,
          correlationId: `m25-cron:${alertCode}`,
        });
      },
    };
    const m25WorkerDeps = buildM25WorkerDeps({
      connection: queueConnection,
      db: dbHandle.db,
      activeOrgs: m25ActiveOrgs,
      alerts: m25Alerts,
    });
    const m25Workers = registerM25CronWorkers(m25WorkerDeps);
    attachDlqAlertsToAll(m25Workers, "m25");
    app.addHook("onClose", async () => {
      await Promise.all(m25Workers.map((w) => w.close()));
    });
    try {
      const m25ScheduleQueues = await scheduleM25Jobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m25ScheduleQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M25 cron-schedule registration failed");
    }
    app.log.info(
      { queues: m25Workers.length },
      "M25 §4.8 BullMQ remittance crons constructed",
    );

    // ── M26 §4.8 Cap-Management crons (nightly projection recompute · cap-year auto-close · stale-PS&R
    // watchdog). Constructed over the same Valkey connection + db; the M2 active-org enumerator + the M36
    // alert router stay on their fail-closed/no-op defaults until bound (a cron tick fails closed, never at
    // import — the M25 deferred-bind posture). Idempotent recompute/close via the §2.6 unique constraints.
    const m26Workers = registerM26CronWorkers({
      connection: queueConnection,
      db: dbHandle.db,
    });
    attachDlqAlertsToAll(m26Workers, "m26");
    app.addHook("onClose", async () => {
      await Promise.all(m26Workers.map((w) => w.close()));
    });
    try {
      const m26ScheduleQueues = await scheduleM26Jobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m26ScheduleQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M26 cron-schedule registration failed");
    }
    app.log.info(
      { queues: m26Workers.length },
      "M26 §4.8 BullMQ cap crons constructed",
    );

    // ── M7 §4.6 `care-plan.gates` cron (TASK-040D — the M25 worker-runner shape) ─────────────────────────
    // The CoP 418.56 5-/15-day gate scans. Absent this, they never ran in production — this is the fix.
    const m7ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: dbHandle.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M7_PLATFORM_JOB_ID,
      reason: "M7 §4.6 care-plan.gates cron fan-out (active-org enumeration)",
    });
    const m7WorkerDeps = buildM7WorkerDeps({
      connection: queueConnection,
      db: dbHandle.db,
      outbox: m7OutboxPublisher,
      activeOrgs: m7ActiveOrgs,
    });
    const m7Workers = registerM7CronWorkers(m7WorkerDeps);
    attachDlqAlertsToAll(m7Workers, "m7");
    app.addHook("onClose", async () => {
      await Promise.all(m7Workers.map((w) => w.close()));
    });
    try {
      const m7ScheduleQueues = await scheduleM7Jobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m7ScheduleQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M7 cron-schedule registration failed");
    }
    app.log.info(
      { queues: m7Workers.length },
      "M7 §4.6 BullMQ care-plan.gates cron constructed",
    );

    // ── M17 Phase-3 scheduling automation: recurring materialization + visit attention ───────────────
    const m17ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: dbHandle.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M17_PLATFORM_JOB_ID,
      reason:
        "M17 scheduling automation cron fan-out (recurrence materialization + attention)",
    });
    const m17WorkerDeps = buildM17WorkerDeps({
      connection: queueConnection,
      db: dbHandle.db,
      outbox: m17OutboxPublisher,
      activeOrgs: m17ActiveOrgs,
      alerts: getSeam("AlertEmitter") as AlertEmitter,
    });
    const m17Workers = registerM17CronWorkers(m17WorkerDeps);
    attachDlqAlertsToAll(m17Workers, "m17");
    app.addHook("onClose", async () => {
      await Promise.all(m17Workers.map((w) => w.close()));
    });
    try {
      const m17ScheduleQueues = await scheduleM17Jobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m17ScheduleQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M17 cron-schedule registration failed");
    }
    app.log.info(
      { queues: m17Workers.length },
      "M17 Phase-3 scheduling automation crons constructed",
    );

    // ── M8 Phase-3 encounter attention + cosignature SLA automation ─────────────────────────────────
    const m8ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: dbHandle.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M8_PLATFORM_JOB_ID,
      reason:
        "M8 encounter automation cron fan-out (attention + cosignature SLA)",
    });
    const m8WorkerDeps = buildM8WorkerDeps({
      connection: queueConnection,
      db: dbHandle.db,
      outbox: m8OutboxPublisher,
      activeOrgs: m8ActiveOrgs,
      alerts: getSeam("AlertEmitter") as AlertEmitter,
    });
    const m8Workers = registerM8CronWorkers(m8WorkerDeps);
    attachDlqAlertsToAll(m8Workers, "m8");
    app.addHook("onClose", async () => {
      await Promise.all(m8Workers.map((w) => w.close()));
    });
    try {
      const m8ScheduleQueues = await scheduleM8Jobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m8ScheduleQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M8 cron-schedule registration failed");
    }
    app.log.info(
      { queues: m8Workers.length },
      "M8 Phase-3 encounter automation crons constructed",
    );

    // ── M6 admission F2F due-reminder cron ───────────────────────────────────────────────────────────────
    const m6ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: dbHandle.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M6_PLATFORM_JOB_ID,
      reason:
        "M6 admission F2F due-reminder cron fan-out (active-org enumeration)",
    });

    const m6WorkerDeps = buildM6WorkerDeps({
      connection: queueConnection,
      db: dbHandle.db,
      outbox: m6OutboxPublisher,
      activeOrgs: m6ActiveOrgs,
    });

    const m6Workers = registerM6CronWorkers(m6WorkerDeps);

    attachDlqAlertsToAll(m6Workers, "m6");

    app.addHook("onClose", async () => {
      await Promise.all(m6Workers.map((w) => w.close()));
    });

    try {
      const m6ScheduleQueues = await scheduleM6Jobs(queueConnection);

      app.addHook("onClose", async () => {
        await Promise.all(m6ScheduleQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M6 cron-schedule registration failed");
    }

    app.log.info(
      { queues: m6Workers.length },
      "M6 admission due-reminder crons constructed",
    );

    // ── M9 §4.8 `license`/`changes`/`cadence` crons (TASK-040D — the M25 worker-runner shape) ────────────
    // `summary`/`eraser` (M9_QUEUES) stay out of scope — event-driven / M4-destruction-cert consumers.
    const m9ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: dbHandle.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M9_PLATFORM_JOB_ID,
      reason:
        "M9 §4.8 license/change-escalation/cadence cron fan-out (active-org enumeration)",
    });
    const m9WorkerDeps = buildM9WorkerDeps({
      connection: queueConnection,
      db: dbHandle.db,
      outbox: m9OutboxPublisher,
      activeOrgs: m9ActiveOrgs,
    });

    const m9Workers = registerM9CronWorkers(m9WorkerDeps);
    attachDlqAlertsToAll(m9Workers, "m9");
    app.addHook("onClose", async () => {
      await Promise.all(m9Workers.map((w) => w.close()));
    });
    try {
      const m9ScheduleQueues = await scheduleM9Jobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m9ScheduleQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M9 cron-schedule registration failed");
    }
    app.log.info(
      { queues: m9Workers.length },
      "M9 §4.8 BullMQ compliance-scan crons constructed",
    );

    // ── M20 §4.8 `m20.sos-sla-watchdog.cron` (F-111, #249 — the M9 worker-runner shape) ─────────────────
    // `decideSosWatchdog` (lifecycle/sos-escalator.ts) shipped with M20-T03 and had no production caller
    // anywhere: no file under 20-field-safety matched *cron*/*worker*/*job*, so an unacknowledged SOS
    // alert sat in `acknowledging` (or any later tier) forever. See jobs/cron-workers.ts's own header for
    // why the tier-3 -> emergency_terminus rung is deliberately refused rather than completed (the same
    // choice consumers/m36-delivery-failed.ts already made for the identical edge — no caller anywhere in
    // this codebase implements the terminus's dial/PSAP/page effects).
    const m20ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: dbHandle.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M20_PLATFORM_JOB_ID,
      reason: "M20 §4.8 SOS SLA watchdog cron fan-out (active-org enumeration)",
    });
    const m20WorkerDeps = buildM20WorkerDeps({
      connection: queueConnection,
      db: dbHandle.db,
      outbox: m20OutboxPublisher,
      policy: createSafetyPolicyProvider(buildDrizzleSafetySeamStore(dbHandle.db)),
      activeOrgs: m20ActiveOrgs,
    });

    const m20Workers = registerM20CronWorkers(m20WorkerDeps);
    attachDlqAlertsToAll(m20Workers, "m20");
    app.addHook("onClose", async () => {
      await Promise.all(m20Workers.map((w) => w.close()));
    });
    try {
      const m20ScheduleQueues = await scheduleM20Jobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m20ScheduleQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M20 cron-schedule registration failed");
    }
    app.log.info(
      { queues: m20Workers.length },
      "M20 §4.8 SOS SLA watchdog cron constructed",
    );

    // ── M10 §4.8 HOPE crons (TASK-040D — the M25 worker-runner shape) ────────────────────────────────────
    // `hope-window-watchdog` + `sfv-watchdog`, plus (F-058 / F-072) the three §4.10 submission stages on
    // the shared `hope.submission` queue: `assemble-hope-submission`, `iqies-submit-worker` and
    // `iqies-reconcile-worker`. `alerts`/`scheduling`/`validation`/`retention` are still out of scope —
    // see jobs/cron-workers.ts's own header.
    //
    // The iQIES adapter is bound to `createUnboundIqiesAdapter` because there is no live transport in
    // this codebase: the CMS endpoint, its auth flow and the HOPE submission XML schema are not here
    // (#177). That binding is DELIBERATE and is not the same as leaving the port unbound — the deny-stub
    // raises a typed `retryable: false` DegradedError, so the job DLQs immediately (no retry storm) and
    // `attachDlqAlertsToAll` surfaces it, while Tier-2 capture is untouched (§5.6 / §7.10).
    const m10ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: dbHandle.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M10_PLATFORM_JOB_ID,
      reason: "M10 §4.8 HOPE watchdog cron fan-out (active-org enumeration)",
    });
    const m10WorkerDeps = buildM10WorkerDeps({
      connection: queueConnection,
      db: dbHandle.db,
      outbox: m10OutboxPublisher,
      activeOrgs: m10ActiveOrgs,
      alerts: getSeam("AlertEmitter") as {
        emit(
          orgId: string,
          input: {
            eventType: string;
            payload: Record<string, unknown>;
            severity: "info" | "warn" | "critical";
            correlationId: string;
          },
        ): Promise<{ alertId: string; resolvedRecipientCount: number }>;
      },
      iqies: createUnboundIqiesAdapter(),
      providerEntityCcn: buildProviderEntityCcnResolver(dbHandle.db),
    });
    const m10Workers = registerM10CronWorkers(m10WorkerDeps);
    attachDlqAlertsToAll(m10Workers, "m10");
    app.addHook("onClose", async () => {
      await Promise.all(m10Workers.map((w) => w.close()));
    });
    try {
      const m10ScheduleQueues = await scheduleM10Jobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m10ScheduleQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M10 cron-schedule registration failed");
    }
    app.log.info(
      { queues: m10Workers.length },
      "M10 §4.8 BullMQ HOPE crons constructed (watchdogs; iQIES submission is the manual package flow)",
    );

    // ── M14 §4.8 `idg.review-clock-sweep` cron (GAP-092 — the M9/M10/M25 worker-runner shape) ────────────
    const m14ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: dbHandle.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M14_PLATFORM_JOB_ID,
      reason:
        "M14 §4.8 idg.review-clock-sweep cron fan-out (active-org enumeration)",
    });
    const m14WorkerDeps = buildM14WorkerDeps({
      connection: queueConnection,
      db: dbHandle.db,
      outbox: m14OutboxPublisher,
      activeOrgs: m14ActiveOrgs,
    });
    const m14Workers = registerM14CronWorkers(m14WorkerDeps);
    attachDlqAlertsToAll(m14Workers, "m14");
    app.addHook("onClose", async () => {
      await Promise.all(m14Workers.map((w) => w.close()));
    });
    try {
      const m14ScheduleQueues = await scheduleM14Jobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m14ScheduleQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M14 cron-schedule registration failed");
    }
    app.log.info(
      { queues: m14Workers.length },
      "M14 §4.8 BullMQ review-clock-sweep cron constructed",
    );

    // M11 D5 — one repeatable hourly trigger enumerates active org ids under the audited platform
    // context; each delegated service call opens its own tenant/RLS transaction before touching PHI.
    const m11StandingActiveOrgs = buildActiveOrgEnumerator({
      platformDb: dbHandle.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M11_PLATFORM_JOB_ID,
      reason: "M11 D5 standing-order hourly spawn fan-out",
    });
    const m11StandingWorker = registerM11StandingSpawnWorker({
      connection: queueConnection,
      activeOrgs: m11StandingActiveOrgs,
      service: createDbOrderBackend(dbHandle.db, m11OutboxPublisher),
    });
    attachDlqAlertsToAll([m11StandingWorker], "m11");
    app.addHook("onClose", async () => {
      await m11StandingWorker.close();
    });
    try {
      const m11StandingQueue = await scheduleM11StandingSpawn(queueConnection);
      app.addHook("onClose", async () => {
        await m11StandingQueue.close();
      });
    } catch (err) {
      app.log.error(err, "M11 standing-spawn schedule registration failed");
    }
    // ── M37 §4.8 `ipu.rn-coverage-watchdog` cron (F-071/#174 — the M14 worker-runner shape) ──────────────
    //
    // The producer that did not exist. `ipu_rn_coverage_window` is a MATERIALIZED invariant that
    // `openAdmission`, `requestBed`, `initiateTransfer` and `applyRestraint` all read, each treating an
    // absent row as uncovered (correctly, fail-closed). Nothing ever wrote a row, and
    // `planOpenAdmission` refuses every non-`arranged` admission on that flag — so no GIP and no
    // inpatient-respite admission could be opened on any deployment. The pure grid builder
    // (`@wardenx/inpatient` `buildCoverageWindows`) has existed and been unit-tested since M37-T07; this
    // is the worker its own header named and that was never built.
    const m37ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: dbHandle.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M37_PLATFORM_JOB_ID,
      reason: "M37 §4.8 ipu.rn-coverage-watchdog cron fan-out (active-org enumeration)",
    });
    const m37WorkerDeps = buildM37WorkerDeps({
      connection: queueConnection,
      db: dbHandle.db,
      outbox: m37OutboxPublisher,
      activeOrgs: m37ActiveOrgs,
    });
    const m37Workers = registerM37CronWorkers(m37WorkerDeps);
    attachDlqAlertsToAll(m37Workers, "m37");
    app.addHook("onClose", async () => {
      await Promise.all(m37Workers.map((w) => w.close()));
    });
    try {
      const m37ScheduleQueues = await scheduleM37Jobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m37ScheduleQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M37 cron-schedule registration failed");
    }
    app.log.info(
      { queues: m37Workers.length },
      "M37 §4.8 BullMQ rn-coverage-watchdog cron constructed",
    );

    // ── M29 D11 — the platform NPPES sync worker + its 02:30 UTC nightly repeatable (GAP-045) ────────────
    // `NPPES_SYNC_SCHEDULE` shipped as pure data whose own comment promised "the M29-T08 worker binds this
    // to the BullMQ scheduler"; that worker was never written, so the nightly run never happened and
    // `nppes_provider` / `nppes_sync_run` were empty in every deployment. This is that binding.
    //
    // UNLIKE EVERY OTHER CRON HERE, this one is NOT an active-org fan-out: NPPES is one public CMS
    // directory shared platform-wide (D11), so there is no per-org tick and no `buildActiveOrgEnumerator`.
    // Its writes go through migration 0199's `nppes_writer_*` SECURITY DEFINER functions (the two tables
    // are SELECT-only to `wardenx_app`), and its five §4.10 events publish platform-wide
    // (`organization_id IS NULL`) through the existing migration-0186 path.
    //
    // It is also the only cron that reaches the PUBLIC INTERNET on a tick (the CMS NPI Registry, no
    // credentials, no BAA). `NPPES_SYNC_DISABLED=1` opts a deployment out of the repeatable — the same
    // escape hatch `OUTBOX_DISPATCHER_DISABLED` gives the relay — while leaving the manual trigger and
    // the worker itself intact, so an operator can still run one on demand.
    // The NPI list comes from M40's canonical `external_physician` — read through M40's own exported
    // reader, never M29 reaching into another module's table (`arch:tables` refused exactly that draft).
    const m29NppesNpiSource = createDbNppesNpiSource(dbHandle.db);
    const m29NppesWorkerDeps = {
      connection: queueConnection,
      db: dbHandle.db,
      outbox: m29OutboxPublisher,
      npiSource: {
        collectDistinctNpis: () => m29NppesNpiSource.distinctReferencedNpis(),
      },
      log: (
        level: "info" | "warn" | "error",
        event: string,
        fields: Record<string, unknown>,
      ) => {
        app.log[level]({ ...fields, event }, "m29.nppes.sync");
      },
    };
    const m29NppesWorkers = registerNppesSyncWorker(m29NppesWorkerDeps);
    attachDlqAlertsToAll(m29NppesWorkers, "m29");
    app.addHook("onClose", async () => {
      await Promise.all([
        ...m29NppesWorkers.map((w) => w.close()),
        ...(m29NppesSync?.queues ?? []).map((q) => q.close()),
      ]);
    });
    if (process.env.NPPES_SYNC_DISABLED !== "1") {
      try {
        const m29ScheduleQueues = await scheduleNppesSyncJob(queueConnection);
        app.addHook("onClose", async () => {
          await Promise.all(m29ScheduleQueues.map((q) => q.close()));
        });
      } catch (err) {
        app.log.error(
          err,
          "M29 NPPES nightly-sync schedule registration failed",
        );
      }
    } else {
      app.log.warn(
        "NPPES_SYNC_DISABLED=1 — the D11 nightly NPPES sync repeatable is NOT registered on this deployment (the manual §4.1.4 trigger still works)",
      );
    }
    app.log.info(
      {
        queue: NPPES_SYNC_SCHEDULE.queueName,
        cron: NPPES_SYNC_SCHEDULE.cronPattern,
      },
      "M29 D11 BullMQ NPPES platform-sync worker constructed",
    );

    // TASK-040C (OPS-005/006) — the `wardenx_bullmq_queue_jobs` gauge, over one dedicated read-only
    // `Queue` handle per UNIQUE queue name actually constructed above (derived from the Workers'
    // `.name`, not a separately-maintained module-by-module catalog list — self-maintaining as new
    // modules add queues). Read-only: never `.add()`s a job, only `getJobCounts()` on scrape.
    const allWorkers = [
      ...m34Workers,
      ...m33Workers,
      ...m30Workers,
      ...m27Workers,
      ...m23Workers,
      ...m25Workers,
      ...m26Workers,
      ...m7Workers,
      ...m9Workers,
      ...m10Workers,
      ...m14Workers,
      ...m29NppesWorkers,
    ];
    const metricsQueueNames = [...new Set(allWorkers.map((w) => w.name))];
    const metricsQueues = metricsQueueNames.map(
      (name) => new Queue(name, { connection: queueConnection }),
    );
    registerBullMQQueueMetrics(metricsRegistry, metricsQueues);
    app.addHook("onClose", async () => {
      await Promise.all(metricsQueues.map((q) => q.close()));
    });
  }

  // ── TASK-006 (OPS-001) — the transactional-outbox DISPATCHER ────────────────────────────────────
  // Every module's catalog publisher writes `outbox_event` rows; until this relay NOTHING read them.
  // The relay polls per-org under withOrgContext (RLS-clean; the org list comes from the audited
  // platform-context enumerator), delivers to live consumers with retry/backoff/DLQ, keeps
  // declared-but-incomplete handshakes pending on a slow clock so their backlog survives, marks only
  // explicit zero-consumer catalog events dispatched (the row IS the durable record), and purges
  // dispatched rows past retention. Requires the platform credential for org enumeration — absent,
  // it does NOT run and says so loudly (the M35 platform-runner posture; fail-closed, never a
  // tenant-pool RLS bypass). OUTBOX_DISPATCHER_DISABLED=1 opts out (tests/one-off boots).
  // TASK-040A — gated on `role !== "api"` for the same reason as the worker-runner section above: an
  // API replica polling the SAME outbox rows as every other replica is wasted work, not a correctness
  // bug (FOR UPDATE SKIP LOCKED makes concurrent pollers safe), but it belongs on the worker role.
  if (
    role !== "api" &&
    dbHandle &&
    process.env.OUTBOX_DISPATCHER_DISABLED !== "1"
  ) {
    if (platformDbHandle) {
      registerPlatformJob(M1_OUTBOX_DISPATCHER_JOB_ID);
      const outboxRelayOrgs = buildActiveOrgEnumerator({
        platformDb: platformDbHandle.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M1_OUTBOX_DISPATCHER_JOB_ID,
        reason: "outbox relay: active-org poll list",
        statuses: ["created", "active", "suspended"],
      });
      // Shared by the M19 D10 triggers AND the §4.8 M36 delivery-failure binding below (#205 follow-up) —
      // one object, since createDrizzleInboundTriggerPorts's return type already satisfies both port
      // interfaces.
      const m19TriggerPorts = createDrizzleInboundTriggerPorts(dbHandle.db);
      const outboxDispatcher = createOutboxDispatcher({
        db: dbHandle.db,
        orgs: outboxRelayOrgs,
        consumers: [
          buildM7AdmissionActivatedConsumer({
            db: dbHandle.db,
            outbox: m7OutboxPublisher,
          }),
          buildM7AdmissionDischargedConsumer({
            db: dbHandle.db,
            outbox: m7OutboxPublisher,
          }),
          buildM7IdgDecisionConsumer({
            db: dbHandle.db,
            outbox: m7OutboxPublisher,
          }),
          buildM11IdgDecisionConsumer({
            db: dbHandle.db,
            outbox: m11OutboxPublisher,
            resolveAdmissionContext: (organizationId, patientId) =>
              activeAdmissionDraftContextForPatient(
                dbHandle.db,
                organizationId,
                patientId,
              ),
          }),
          buildM12IdgDecisionConsumer({
            db: dbHandle.db,
            outbox: m12OutboxPublisher,
            resolveAdmissionContext: (organizationId, patientId) =>
              activeAdmissionDraftContextForPatient(
                dbHandle.db,
                organizationId,
                patientId,
              ),
          }),
          buildM16IdgDecisionConsumer({ db: dbHandle.db }),
          // F-105 — the §4.3.1 bereavement intake. The ONLY path by which a `bereavement_plan` row can
          // exist: M16 publishes no create route (the collection path is a GET worklist; all fifteen plan
          // writes are `/plans/:planId/…`), so before this binding the CoP 418.64(d) 13-month program was
          // unreachable in every deployment. The admission siting comes from M6's ORG-EXPLICIT reader —
          // the §4.7 seam pins the tenant from the ambient request scope and a relay tick is not a request.
          buildM16BereavementIntakeConsumer({
            db: dbHandle.db,
            outbox: m16OutboxPublisher,
            resolveAdmission: async (organizationId, admissionId) =>
              admissionSchedulingContextForOrg(dbHandle.db, organizationId, admissionId),
          }),
          buildM8VisitPublishedConsumer({
            db: dbHandle.db,
            outbox: m8OutboxPublisher,
            isAdmissionActive: (organizationId, admissionId) =>
              admissionIsActiveForOrg(dbHandle.db, organizationId, admissionId),
          }),
          buildM8VisitClosedConsumer({
            db: dbHandle.db,
            outbox: m8OutboxPublisher,
          }),
          buildM17EncounterSignedConsumer({
            db: dbHandle.db,
            outbox: m17OutboxPublisher,
          }),
          buildM17AdmissionLifecycleConsumer({
            db: dbHandle.db,
            outbox: m17OutboxPublisher,
          }),
          buildM17CarePlanProposalConsumer({
            db: dbHandle.db,
            outbox: m17OutboxPublisher,
          }),
          buildM36ClinicalAlertConsumer(
            getSeam("AlertEmitter") as AlertEmitter,
          ),
          buildM10AdmissionWorkflowConsumer({
            db: dbHandle.db,
            outbox: m10OutboxPublisher,
            admissions: getSeam(
              "AdmissionStatusReader",
            ) as AdmissionStatusReader,
          }),
          buildM18VisitPublishedConsumer({ db: dbHandle.db }),
          // M20 §4.8 / §7.1 (F-043, #103) — the field-safety visit consumers. Six deciders and a badge
          // cache had been complete, exported and unit-tested since M20-T04 with NO factory yielding a
          // binding, so the relay deferred every m20 event and — one layer down — NOTHING in the whole
          // repository ever inserted a `safety_check_in_schedule` row. The §4.2 supervisor board, the §4.3
          // badge trio, the §4.8 overdue detector and the clinician's own `/me/today` were therefore all
          // reading an empty set: the board answered "nobody is overdue" because nobody had ever been
          // OBLIGED, which is indistinguishable from everyone being fine.
          //
          // Unlike M10's admission consumer above, these DO reach through a §4.3 seam: M17 publishes no
          // org-explicit visit reader, and `VisitReader.visitForEncounter(orgId, visitId)` already takes
          // the org — it just resolves the tenant from the ambient scope rather than from the argument.
          // So each handler opens `runWithRequestContext` first, which makes the argument and the scope
          // agree and lets `assertCallerOrg` verify it. Without that the read would not dead-letter, it
          // would silently answer null: `seam-context`'s `readVisitAnchors` collapses "no such visit" and
          // "the seam threw" so the §4.2 board cannot leak another tenant's visit, so the bindings read
          // the seam directly and let a failure fail the delivery.
          // M19 §4.8 / §7.6 / D10 (F-043, #103) — the two proactive-triage triggers. Both deciders and
          // their shared core have been complete since M19-T04 with NO factory yielding a binding, so the
          // relay deferred them forever and `triage_call.source` could only ever hold `manual` or
          // `paper_origin`: NO proactive welfare check had ever been opened, and `source_outbox_event_id`
          // — the column D10's redelivery guard `triage_call_source_dedupe_uq` is built on — had never
          // been written by anything. A clinician who never arrived at a dying patient's home, and one
          // who never checked out of it, each raised an event delivered to nobody.
          //
          // Also the first producer of `m19.oncall_shift.coverage_gap`, which `events-by-m19.ts` records
          // as declared and never published: when no shift covers the trigger instant the consumer emits
          // the gap rather than opening a call it cannot anchor (`on_call_shift_id` is NOT NULL) or
          // throwing, which would park a patient welfare check in a DLQ.
          //
          // §4.8 M36 delivery-failure trigger (#205 M36 follow-up) rides the same `ports` object —
          // `m19TriggerPorts` (below) satisfies `DeliveryFailureTriggerPorts` too
          // (createDrizzleInboundTriggerPorts's return type is the intersection). No producer publishes
          // `m36.notification.delivery_failed` yet (events-by-m36.ts's header), so this binding is wired
          // and ready, not yet exercised.
          ...buildOncallTriggerConsumers({
            db: dbHandle.db,
            ports: m19TriggerPorts,
            deliveryPorts: m19TriggerPorts,
            outbox: m19OutboxPublisher,
            // No `alerts` port, matching M19's own route path: the §4.9 pages ride the outbox events,
            // which M36 resolves through its seam. Binding one here and not there would give the same
            // alert two carriers with different retry semantics.
          }),
          ...buildFieldSafetyConsumers({
            db: dbHandle.db,
            policy: createSafetyPolicyProvider(buildDrizzleSafetySeamStore(dbHandle.db)),
            outbox: m20OutboxPublisher,
            // No `alerts` port: M36's emitter is not bound to M20's write path either, so the §4.9
            // warn-severity inquiry rides the `m20.safety.check_in_overdue` OUTBOX event, which M36
            // resolves through its own seam. Binding one here and not on the route path would give the
            // same alert two carriers with different retry semantics.
            signals: safetyClinicianSignalCache(),
          }),
          ...(m23SubmissionQueues
            ? [buildM23SubmissionRequestConsumer(m23SubmissionQueues.port)]
            : []),
          ...(m24SubmissionQueues
            ? [buildM24SubmissionRequestConsumer(m24SubmissionQueues.port)]
            : []),
          ...(m34ProvisionQueue
            ? [buildM34ProvisionStartedConsumer(m34ProvisionQueue.port)]
            : []),
          // M5 §4.10 — the proposal applier (LIVE end-to-end now that M29's accept path publishes
          // the event; skips everything not m5-owned).
          buildM29ProposalApplierConsumer(),
          // M5 §7.8 (GAP-004) — the death cascade: resolves the decedent through M6's
          // DeathDischargeReader seam and flips patient.status='deceased' + emits
          // m5.patient.deceased (seeds M16 bereavement / M23 final claim / M28 FHIR / M36 IDG alert).
          buildM5DeathCascadeConsumer({ db: dbHandle.db, outbox: m5OutboxPublisher }),
          // M10 §2.2.1 (#48): the HOPE timepoint-schedule write path is `buildM10AdmissionWorkflowConsumer`
          // above. The lost-history `buildM10AdmissionSchedulingConsumer` handled the same two events and
          // wrote the same rows; only one may be bound (restored 2026-09-25, see the force-push recovery audit).
          // M6 §4.8.3 — the LIVE admission-event applier (task-15): resolves facts + executes
          // through the Drizzle gateway (external death / HL7 withdrawal / compliance windows),
          // records refusals durably + emits m6.applier.refused. Second consumer on the event so
          // m6-owned acceptances can never complete off M5's skip.
          buildM6ProposalAcceptedConsumer({
            db: dbHandle.db,
            outbox: m6OutboxPublisher,
          }),
          buildM39ConsentRenderConsumer(dbHandle.db),
          // M22 §4.11 (GAP-023/024/038) — the LIVE render handshake. Every `*.document_requested` row was
          // written by a source module and drained by NOBODY: the decider, the two gates, the renderer and
          // (since GAP-095) the Drizzle document-row store all existed, but no binding ever joined them, so
          // M13's finalize-reconciliation request sat `pending` forever. `store:` is a SECOND
          // `createDrizzleDocumentSeamStore` instance over the same tables as the one behind the renderer
          // seam — each opens its own `withOrgContext` per call, so sharing an instance would buy nothing.
          buildM22DocumentRequestConsumer({
            store: createDrizzleDocumentSeamStore(dbHandle.db),
            // A gate refusal is a settled decision, not a delivery failure — the row completes, so without
            // this sink a refused SUD/BAA render would be silent. Not the DLQ path (that is a throw).
            onRefusal: (r) =>
              app.log.warn(
                {
                  event: r.eventType,
                  org: r.organizationId,
                  aggregate: r.aggregateId,
                  detail: r.detail,
                },
                `M22 render refused: ${r.kind}`,
              ),
            // The §7.2 DOWNSTREAM half. The render and this emit are two transactions (the renderer opens
            // its own), which is why the consumer re-announces on an idempotent re-delivery: a crash
            // between them is precisely what gets redelivered.
            emitRendered: ({ organizationId, ...payload }) =>
              withOrgContext(
                dbHandle.db,
                { organizationId, userId: "" },
                (tx) =>
                  m22OutboxPublisher.publish(tx as never, {
                    eventName: M22_DOCUMENT_RENDERED_EVENT,
                    payload,
                    organizationId,
                    aggregateKind: "document",
                    aggregateId: payload.documentId,
                  }),
              ),
          }),
          // The requesting modules' back-ref consumers — the columns each built for exactly this
          // (`order_record.document_id`, `medication_order.document_id`,
          // `medication_reconciliation_worksheet.document_id`, `comfort_kit_dispatch.bol_document_id` /
          // `comfort_kit_return.receipt_document_id`) and never had an event to fill. Each ignores every
          // document it did not request. They must ALL be bound: `m22.document.rendered` declares exactly
          // these consumers, and the dispatcher holds a row `pending` while any declared consumer
          // module has no live binding.
          // F-100 — M6's is the sixth, and the one with the most columns behind it: the CTI, the election
          // statement, the face-to-face, the notice of rights, the revocation and the discharge summary,
          // all six commented "M22 document" since M6's schema landed and all six NULL in every database.
          buildM6DocumentBackrefConsumer({ db: dbHandle.db }),
          buildM11DocumentBackrefConsumer({ db: dbHandle.db }),
          buildM12DocumentBackrefConsumer({ db: dbHandle.db }),
          // F-102 — the M6 discharge cascade, both halves. Each decider has been complete, exported and
          // unit-tested since M11-T07 / M12-T08 with no caller but its own test, and neither COULD be
          // bound: `m6.admission.discharged` did not declare m11 or m12, and
          // `assertBindableAgainstCatalog` refuses a binding whose module the catalog does not name. Every
          // order and every medication order in flight when a patient was discharged stayed in flight —
          // including `queued_for_transmission`, an order waiting to reach the e-prescribing vendor.
          buildM11DischargeCascadeConsumer({ db: dbHandle.db, outbox: m11OutboxPublisher }),
          buildM12DischargeCascadeConsumer({ db: dbHandle.db, outbox: m12OutboxPublisher }),
          // F-103 — the §1.1 D10 discipline-plan bootstrap, and the ONLY path by which a
          // `discipline_care_plan` row has ever been created: `bootstrapDisciplinePlan`'s own doc names
          // "the `m6.admission.activated` consumer" and there was none, m15 was not declared on the
          // event, and no INSERT into that table existed anywhere in the repository. Every M15 write
          // route is `/discipline-plans/:planId/…`, so the aide plan of care, the MSW plan and the
          // spiritual plan were unreachable in every deployment.
          // F-104 — M14's §4.5 D8 action-item auto-close. The pure decider, the transition graph, the
          // `auto_closed` status, the `close_reason` value and the outbox event all shipped with M14-T06
          // and NOTHING bound them — and `idg_action_item.linked_artifact_id`, the column the engine
          // matches on, was written by no code path at all, so binding alone would have matched nothing
          // forever. An action item saying "sign this care plan" stayed open after the plan was signed.
          buildM14ActionItemAutoCloseConsumer({ db: dbHandle.db, outbox: m14OutboxPublisher }),
          buildM15PlanBootstrapConsumer({
            db: dbHandle.db,
            outbox: m15OutboxPublisher,
            // Same reason as M10's scheduling consumer above: M6's §4.7 seam pins the tenant from the
            // ambient REQUEST scope, and a relay tick is not a request.
            resolveSiting: (organizationId, admissionId) =>
              admissionSchedulingContextForOrg(dbHandle.db, organizationId, admissionId),
          }),
          buildM13DocumentBackrefConsumer({ db: dbHandle.db }),
          buildM21DocumentBackrefConsumer({ db: dbHandle.db }),
          // F-108 — M27's. Unlike the five clinical ones it stamps THREE columns off one event, resolved
          // from `aggregateType`: M27 fans the ECR file, the Print Image and the supporting-doc bundle out
          // under ONE request event name, so the aggregate type is the only discriminator on the wire —
          // and the pure handler's declared payload named an `artifactKind` M22 does not publish, so a
          // binding written to its stated shape would have no-op'd on every delivery.
          buildM27DocumentBackrefConsumer({ db: dbHandle.db, outbox: m27OutboxPublisher }),
          // GAP-051 — M33's half. Unlike the four above it does more than stamp a column: a rendered
          // scheduled report settles its occurrence `delivered` and emits the §4.9 fan-out, which is why
          // it composes the package's own decider/applier rather than a one-line UPDATE. The ad-hoc
          // "export now" artifact has no table to stamp and is deliberately not handled — see the file.
          buildM33DocumentBackrefConsumer({
            db: dbHandle.db,
            emitDelivered: ({ organizationId, ...payload }) =>
              withOrgContext(
                dbHandle.db,
                { organizationId, userId: "" },
                (tx) =>
                  m33OutboxPublisher.publish(tx as never, {
                    eventName: "m33.scheduled_report.delivered",
                    payload: { ...payload, organizationId },
                    organizationId,
                    aggregateKind: "report_schedule_run",
                    aggregateId: payload.runId,
                  }),
              ),
            onDisposition: (action) =>
              app.log.info(
                { disposition: action.kind },
                "M33 scheduled-report delivery: nothing to settle",
              ),
          }),
          // WX-PR-012 — the LIVE `m25.parse-and-post` consumer: M25 self-pulls (no other module produces
          // `m25.edi.835_received`), so this drives the parse + transactional-post + denial-seed half of
          // the pipeline the `remittance.receive` route's `receiveAdvice` emits into. The same
          // env-gated `m25X12Port` posture as the routes-mount binding above; the terminology lookup and
          // the M23 claim-match adapter are both reconstructed here (each resolves its seam lazily per
          // call, so a duplicate binding across two composition-root scopes is harmless).
          buildM25EdiReceivedConsumer(
            buildDrizzleM25IngestService(dbHandle.db, {
              client: createX12835Client(m25X12Port),
              outbox: m25OutboxPublisher,
              claims: buildM23BackedClaimMatchCandidateProvider(),
              terminology: {
                async lookup(carcCode) {
                  const concept = await (
                    getSeam("TerminologyProvider") as {
                      lookup(
                        system: string,
                        code: string,
                      ): Promise<{
                        display: string;
                        properties?: Record<string, unknown>;
                      } | null>;
                    }
                  ).lookup("carc", carcCode);
                  if (!concept) return null;
                  const props = concept.properties;
                  return {
                    category:
                      typeof props?.category === "string"
                        ? props.category
                        : "unmapped",
                    plainLanguage: concept.display,
                  };
                },
              },
            }),
          ),
          // GAP-037 — the other half of that pipeline. M25's ingest consumer above posts the 835 and
          // publishes `m25.remittance.claim_paid` / `_partial_paid` / `_denied` / `_recouped`, all four
          // declaring `m23` as a consumer. M23 had none: every posting row sat `pending` and no claim
          // ever left ACK_ACCEPTED when the MAC paid it. This drives the real lifecycle transition,
          // appends `claim_state_history`, and emits M23's own §4.10 adjudication events.
          // F-106 — the NOE draft. `NoeRepository.create` had no caller anywhere in the repository and
          // `/api/v1/noe-records` is a GET, so no Notice of Election has ever been created: the CMS 5-day
          // filing window (42 CFR 418.24(b)) was never started for any election, and the watchdog cron
          // has always scanned an empty table. Subscribed to `period_started`, not `election.signed` —
          // the effective date the deadline is computed from is written at ACTIVATION and does not exist
          // at signing. Both M6 facts come from the org-explicit reader: the §4.7 seam pins the tenant
          // from the ambient request scope and a relay tick is not a request.
          buildM23NoeDraftConsumer({
            db: dbHandle.db,
            outbox: m23OutboxPublisher,
            resolveElectionPeriod: async (organizationId, electionPeriodId) =>
              electionPeriodContextForOrg(dbHandle.db, organizationId, electionPeriodId),
            resolveCcn: async (organizationId, providerEntityId) => {
              const [provider] = await dbHandle.db
                .select({ ccn: schema.providerEntities.ccn })
                .from(schema.providerEntities)
                .where(
                  and(
                    eq(schema.providerEntities.id, providerEntityId),
                    eq(schema.providerEntities.organizationId, organizationId),
                  ),
                )
                .limit(1);
              if (!provider) throw new DegradedError("provider-entity", "provider CCN unavailable");
              return provider.ccn;
            },
            onSkipped: (info) =>
              app.log.info(
                {
                  reason: info.reason,
                  org: info.organizationId,
                  electionPeriod: info.electionPeriodId,
                },
                "M23 NOE draft skipped",
              ),
          }),
          // F-107 — the NOTR draft, the NOE's sibling. `NotrRepository.create` had no caller either, so
          // no notice of a hospice election ENDING has ever been drafted and the 42 CFR 418.26 5-day
          // window was never started for any revocation, transfer-out or discharge.
          buildM23NotrDraftConsumer({
            db: dbHandle.db,
            outbox: m23OutboxPublisher,
            resolveAdmission: async (organizationId, admissionId) =>
              admissionSchedulingContextForOrg(dbHandle.db, organizationId, admissionId),
            resolveCcn: async (organizationId, providerEntityId) => {
              const [provider] = await dbHandle.db
                .select({ ccn: schema.providerEntities.ccn })
                .from(schema.providerEntities)
                .where(
                  and(
                    eq(schema.providerEntities.id, providerEntityId),
                    eq(schema.providerEntities.organizationId, organizationId),
                  ),
                )
                .limit(1);
              if (!provider) throw new DegradedError("provider-entity", "provider CCN unavailable");
              return provider.ccn;
            },
            onSkipped: (info) =>
              app.log.info(
                {
                  reason: info.reason,
                  event: info.eventType,
                  org: info.organizationId,
                  admission: info.admissionId,
                },
                "M23 NOTR draft skipped",
              ),
          }),
          buildM23RemittanceConsumer({
            db: dbHandle.db,
            outbox: m23OutboxPublisher,
            // A skip is a settled decision (re-delivery, unmatched claim, or an 835 against a claim the
            // transition is not legal from) — the row completes, so without this it would be silent.
            onSkipped: (info) =>
              app.log.warn(
                {
                  reason: info.reason,
                  event: info.eventType,
                  org: info.organizationId,
                  claim: info.claimId,
                  state: info.currentState,
                },
                "M23 remittance transition skipped",
              ),
          }),
        ],
        // GAP-099 — the PLATFORM (`organization_id IS NULL`) binding list. Until now this list did not
        // exist and `pollPlatform()` could only claim a row and defer it, so M29's NPPES sync published
        // `m29.nppes.provider_synced` into a queue with no reachable consumer: every row sat pending on
        // the 30-minute deferred clock forever while M40's canonical went stale. These two appliers were
        // written and unit-tested in M40-T09 and have been waiting on the delivery path ever since.
        platformConsumers: buildM29NppesPlatformConsumers({
          db: dbHandle.db,
          outbox: m40OutboxPublisher,
          // The live M36 seam — the §4.7.2 per-tenant "your preferred physician was deactivated" alert.
          alerts: getSeam("AlertEmitter") as {
            emit(
              organizationId: string,
              input: {
                eventType: string;
                payload: Record<string, unknown>;
                severity: string;
                correlationId: string;
              },
            ): Promise<unknown>;
          },
          // The same audited enumerator the relay polls with — the deactivation fan-out asks each active
          // org's overlay whether it marked this provider preferred (one RLS-scoped read per org; there
          // is no legitimate single statement that spans tenants).
          orgs: outboxRelayOrgs,
        }),
        eventCatalog: bootOutboxCatalog,
        options: {
          log: (m) => app.log.warn(m),
          // TASK-040D (OPS-012) — the same shared sink every BullMQ worker's DLQ promotion reports to.
          onDeadLetter: (e) =>
            dlqPromotionSink({
              source: "outbox",
              jobId: e.eventId,
              // GAP-099 — null for a platform-wide row; the sink renders the org clause only when set.
              organizationId: e.organizationId ?? undefined,
              attempts: e.attemptCount,
              error: `${e.eventType}: ${e.error}`,
              occurredAt: new Date().toISOString(),
            }),
          // TASK-040C — the shared outbox counters/histogram, registered unconditionally above.
          onTick: outboxMetrics.onTick,
        },
      });
      outboxDispatcher.start();
      // TASK-040B — the readiness probe's outbox-depth check closes over this ref (set now that the
      // real instance exists; the probe itself was built earlier, before buildServer()).
      outboxDispatcherRef = outboxDispatcher;
      app.addHook("onClose", () => outboxDispatcher.stop());
      app.log.info("TASK-006 outbox dispatcher polling (per-org, RLS-scoped)");
    } else {
      console.warn(
        "⚠️  outbox dispatcher NOT running: DATABASE_PLATFORM_URL is not configured (the relay needs the platform credential to enumerate active orgs). Outbox rows will accumulate as pending.",
      );
    }
  }

  // TASK-040A (OPS-003) — graceful shutdown. Every teardown this process needs already exists as an
  // `onClose` hook (every BullMQ Worker/Queue close, the outbox dispatcher's `.stop()`, every DB
  // pool's `.close()`, the TASK-040B Redis health client's `.quit()`) — NOTHING previously called
  // `app.close()` on a termination signal, so a container orchestrator's SIGTERM hard-killed the
  // process instead of draining it (repo-wide grep found no SIGTERM/SIGINT handler anywhere before
  // this). `once` (not `on`): a second signal during an already-in-flight shutdown must not
  // re-enter `app.close()`. Fastify's own default `closeGracefully`/timeout handling still applies
  // underneath — this is only the missing trigger.
  const shutdown = (signal: string) => {
    app.log.info(`${signal} received — draining`);
    app.close().then(
      () => process.exit(0),
      (err) => {
        app.log.error(err, "graceful shutdown failed");
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  // TASK-040A — the worker role serves no public traffic; it listens on its own port (WORKER_PORT,
  // default 3001) so /health + /ready are reachable for its OWN liveness/readiness probes without
  // colliding with an API process's PORT on the same host (local/dev single-host runs).
  const port =
    role === "worker"
      ? Number(process.env.WORKER_PORT ?? 3001)
      : Number(process.env.PORT ?? 3000);
  app.listen({ port, host: "0.0.0.0" }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}

if ((import.meta as { main?: boolean }).main) {
  // Start only when run directly (not when imported by tests/tooling/worker.ts) — see `bootWardenX`.
  await bootWardenX(
    (process.env.PROCESS_ROLE as ProcessRole | undefined) ?? "all",
  );
}

/**
 * Adapt the shared {@link OutboxPublishPort} into a module-scoped emitter that pins `callerModule` (which
 * the per-module `WriteOutboxPort` intentionally omits — the dispatcher's namespace check needs it). The
 * returned shape matches M30's + M33's `WriteOutboxPort` structurally, so it threads straight into their
 * write-service `outbox` slots. M34 is NEVER passed through this (its emit payloads are non-conformant).
 */
function bindCallerModule(
  publisher: OutboxPublishPort,
  callerModule: string,
): {
  publish(
    tx: OutboxTx,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      /** `null` only for a genuinely platform-wide event — see {@link OutboxPublishInput.organizationId}. */
      readonly organizationId: string | null;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
} {
  return {
    publish: (tx, input) => publisher.publish(tx, { ...input, callerModule }),
  };
}

/**
 * Parse `REDIS_URL` into a BullMQ `ConnectionOptions` (host/port/username/password/db). Returns undefined
 * when unset so the queue producers + the worker construction stay fail-closed (never a localhost-default
 * that silently connects to the wrong store). TLS (`rediss:`) sets the `tls` option.
 */
function parseRedisConnection(
  redisUrl: string | undefined,
): ConnectionOptions | undefined {
  if (!redisUrl) return undefined;
  const u = new URL(redisUrl);
  const db = u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined;
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    username: u.username || undefined,
    password: u.password || undefined,
    db: Number.isFinite(db) ? db : undefined,
    ...(u.protocol === "rediss:" ? { tls: {} } : {}),
  };
}
