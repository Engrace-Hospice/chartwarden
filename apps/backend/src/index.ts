import { createHash, randomUUID } from "node:crypto";
import {
  AUDIT_HASH_CHAIN_FLAG,
  auditPlatformEvent,
  createDbAuditChainReader,
  createDbAuditQuery,
} from "@chartwarden/audit";
// @chartwarden/backend — Fastify host entry + COMPOSITION ROOT (not in any module codePath, so
// exempt from the module-boundary import rules — it may import every module's init). It builds
// the server, runs the seam/eraser boot gate, and registers each Phase-1 module's real seams
// via `wireModuleSeams` (M1's bootstrap cannot import a downstream module; the composition
// root does, then hands the registration into the boot gate before validateSeams()).
import {
  LAB_RECOVERY_KEYS,
  createAuditorSessionIssuer,
  createCredentialThrottle,
  createDbActorEnrichmentReader,
  createDbAdminMembershipReader,
  createDbEffectivePermissionStore,
  createDbSessionContextStore,
  createDbSessionTimeoutEnforcer,
  createIdentityAuth,
  createIdentityCredentialAdmin,
  createInMemoryFailedLoginStore,
  createLinkSessionMinter,
  createPasswordVerifier,
  createTenantOriginMatcher,
  getIdentitySession,
  registerAbacRegistry,
  registerDbEffectivePermissionResolver,
  registerIdentityAuth,
  resolveActorPermissions,
  resolveMfaEnforcement,
  resolveWebTrustedOrigins,
} from "@chartwarden/auth";
import type { RbacEngineHandle, SessionContextStore } from "@chartwarden/auth";
import { type DbClient, createDbClient, schema } from "@chartwarden/db";
// F-172 (#248) — the M35 `patient_pseudonym_key` platform-singleton KEK ring (distinct secret from
// M34_TENANT_KEK — see `packages/subscription-billing/src/pseudonym/key-envelope.ts`'s own header for why
// the two ciphers must never share a KEK even though both wrap 32 bytes under AES-256-GCM).
import {
  createEnvTenantConfigResolver,
  createHttpDoseSpotClient,
  unverifiedEndpoints,
} from "@chartwarden/dosespot";
import { createUnboundIqiesAdapter } from "@chartwarden/iqies-client";
import type { AlertEmitter, MessagingProvider } from "@chartwarden/messaging";
import {
  MESSAGING_QUEUES,
  REALTIME_HINT_EVENT,
  accountRoom,
  computeRoomSet,
  createAlertPayloadRegistry,
  setOutOfBandFallbackObserver,
  userRoom,
} from "@chartwarden/messaging";
import {
  type PseudonymKeyProvider,
  createStripePaymentMethodVerifier,
  loadPseudonymKekRing,
} from "@chartwarden/subscription-billing";
import type { PlatformBypassAuditor } from "@chartwarden/tenancy";
import {
  getRequestContext,
  registerPlatformJob,
  runWithRequestContext,
  withOrgContext,
  withPlatformContext,
} from "@chartwarden/tenancy";
import {
  ACK_ESCALATION_REQUIRED_ROLE,
  ChartWardenError,
  DegradedError,
  type Npi,
  REDACTION_SINGLE_OFFICER_FLAG_KEY,
  RETENTION_ATTACHMENT_DESTRUCTION_FLAG_KEY,
  RETENTION_DESTRUCTION_EXECUTE_ENV,
  RETENTION_DESTRUCTION_FLAG_KEY,
  retentionDestructionModeOf,
} from "@chartwarden/types";
import type {
  AdmissionStatusReader,
  ChartPromotionSourceReader,
  OrgId,
  PatientAddressReader,
  PatientId,
  ScaleType,
} from "@chartwarden/types";
import { createX12835Client } from "@chartwarden/x12-835-client";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import Redis, { type RedisOptions } from "ioredis";
import { parseTrustedProxies } from "./bootstrap";
import {
  createAckQueueNoticeEvaluator,
  registerAckQueueMetrics,
  sampleAckQueue,
} from "./bootstrap/ack-queue-metrics";
import { startAckQueueWatchdog } from "./bootstrap/ack-queue-watchdog";
import { buildActiveOrgEnumerator } from "./bootstrap/active-org-enumerator";
import {
  bindPlatformStaffToOrg,
  reconcilePlatformStaff,
  setPlatformStaffFailureSink,
} from "./bootstrap/bind-platform-staff";
import { attachDlqPromotionAlert, buildDlqPromotionSink } from "./bootstrap/dlq-alerts";
import { buildF2fClinicianRoleReader } from "./bootstrap/f2f-clinician-roles";
import {
  createDrizzleFeatureFlagAdmin,
  createDrizzleFeatureFlagReader,
  createDrizzleFeatureFlagScopeLoader,
} from "./bootstrap/feature-flag-store";
// F-166 (#248) — M13's `m12.medication_order.active` materializer needs the order's location timezone.
import { buildFoundationSiteReader } from "./bootstrap/foundation-site-reader";
import {
  type GeocodeCoverageSampler,
  registerGeocodeCoverageMetrics,
  sampleGeocodeCoverage,
  warnOnGeocodeCoverageGap,
} from "./bootstrap/geocode-coverage";
import {
  DEFAULT_RATE_LIMIT_TIERS,
  FHIR_TOKEN_ENDPOINT_ENABLED_ENV,
  M23_LAUNCH_GATEWAY_ENABLED_ENV,
  M34_PROVISION_GATEWAY_ENABLED_ENV,
  assertNoInMemoryBindingsOnDbBoot,
  assertProductionEnv,
  buildServer,
  classifyTenantHost,
  createCachingTenantHostResolver,
  createDbTenantAppOrigin,
  createDbTenantHostResolver,
  createSessionAuthenticate,
  createTenantHostGuard,
  escalationRouterDenyStub,
  getSeam,
  integrationEnabled,
  noteInMemoryBinding,
  parseTenantBaseDomain,
  registerEraser,
  registerSeam,
  webAppBaseUrlFromEnv,
  withM24LaunchGatewayDefault,
} from "./bootstrap/index";
import {
  AUDIT_ARCHIVE_CRON,
  AUDIT_ARCHIVE_QUEUE,
  auditArchiveConfigFromEnv,
  platformCatalogRunner,
  runAuditArchive,
  wireAuditArchiveTenancy,
} from "./bootstrap/jobs/audit-archive";
import {
  IDEMPOTENCY_CLEANUP_JOB_ID,
  registerIdempotencyCleanupWorker,
  scheduleIdempotencyCleanup,
  wireIdempotencyCleanupTenancy,
} from "./bootstrap/jobs/idempotency-cleanup";
import {
  PARTITION_ROTATION_CRON,
  PARTITION_ROTATION_QUEUE,
  classifyPartitionCoverage,
  readPartitionCoverage,
  runPartitionRotation,
  summarizeRotation,
  wirePartitionRotationTenancy,
} from "./bootstrap/jobs/partition-rotation";
import { buildM11CosignerCounter } from "./bootstrap/m11-cosigner-counter";
import { buildDdeAssigneeEligibility } from "./bootstrap/m23-dde-assignee";
import { buildMortalityReviewerResolver } from "./bootstrap/m30-mortality-reviewer-resolver";
import { m34ActiveMembershipUserId } from "./bootstrap/m34-identity-shred-subjects";
import {
  buildMetricsRegistry,
  mountMetricsRoute,
  registerBullMQQueueMetrics,
  registerHttpMetrics,
  registerOutboxMetrics,
  registerPartitionMetrics,
} from "./bootstrap/metrics";
import { createOpsNoticeClaims } from "./bootstrap/ops-notice-claims";
import {
  buildMembershipUserResolver,
  buildOrgAdminCountReader,
  buildOrgSeedFactsReader,
} from "./bootstrap/org-spine-facts";
import { wireOrganizationSettingsRegistry } from "./bootstrap/organization-settings-persister";
import { buildM1MacPortalHealthConsumer } from "./bootstrap/outbox-consumers/m23-mac-portal-health";
import { buildM1LagProbeStatusConsumer } from "./bootstrap/outbox-consumers/m33-lag-probe";
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
import { buildPlatformOpsNoticeSink } from "./bootstrap/platform-ops-notices";
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
  buildProviderEligibilityIdentityReader,
  buildProviderEntityCcnResolver,
  buildProviderEntityLocationLister,
  buildProviderEntityOrgCheck,
  buildRequiredProviderEntityCcnResolver,
} from "./bootstrap/provider-entity-resolver";
import { buildReadinessProbe } from "./bootstrap/readiness-probe";
import { registerLocationLookupRoutes } from "./bootstrap/routes/locations";
import { registerProviderEntityLookupRoutes } from "./bootstrap/routes/provider-entities";
import { siteDisplayForOrg } from "./bootstrap/site-display-for-org";
import { buildSoleTenantUserResolver } from "./bootstrap/sole-tenant-user-resolver";
import { createDrizzleSystemStatusReader } from "./bootstrap/system-status-store";
import { createPlatformKekAdapter, loadPlatformKekRing } from "./bootstrap/tenant-kek";
import { buildM23OverrideAuditPort } from "./m23-override-audit";
import { buildM36AttachmentBinding, buildM36AttachmentStorage } from "./m36-attachment-storage";
import {
  type AuthAuditDb,
  createAuthAuditSink,
} from "./modules/02-identity/audit/auth-event-audit";
import {
  createDbActiveMembershipLister,
  createMfaEnrolmentGate,
} from "./modules/02-identity/mfa-enrolment-gate";
import {
  createDbMfaEnrollmentReader,
  createDbSessionProofReader,
  createDbSessionStepUpWriter,
} from "./modules/02-identity/step-up-adapters-db";

/** The @chartwarden/tenancy platform-job id M36's D9 sole-tenant membership read runs under. */
const M36_SOLE_TENANT_JOB_ID = "m36-sole-tenant-resolver";
/** The platform-job id M34's tenant-shred identity-subject read runs under (same M36 D9 rule, own audit trail). */
const M34_SHRED_SOLE_TENANT_JOB_ID = "m34-shred-sole-tenant-resolver";
const M8_PLATFORM_JOB_ID = "m8-encounter-automation";
const M17_PLATFORM_JOB_ID = "m17-scheduling-automation";
const M18_PLATFORM_JOB_ID = "m18-evv-automation";

/**
 * GAP-133 — M18's §D10 GPS-coordinate envelope over M34's per-tenant key ring (the M20 `safety-crypto`
 * precedent). One factory so the capture (seal), the location reads and the spoof detector (open) all agree on
 * the format and the AAD. `getTenantKeyProvider()` is resolved per call, so this is safe to build before M34
 * registers; until a platform KEK is bound, M34's stub refuses `dekForOrg` and every capture fails closed.
 */
function m18CoordsCipher(): EvvCoordsCipher {
  return createEvvCoordsCipher(m18CoordsKeys());
}
/** The same lazily-resolved M34 key ring, for the §4.8 `m18.dek-rotation` re-seal (consumer + daily sweep). */
function m18CoordsKeys(): EvvCoordsKeyProvider {
  return lazyEvvCoordsKeys(getTenantKeyProvider);
}
// GAP-054 — the audited platform read behind the geocode-coverage gauge/boot warning (active-org list only).
const M5_GEOCODE_COVERAGE_JOB_ID = "m5-geocode-coverage";
// GAP-083 follow-up — the audited platform read behind the FHIR-client BAA boot warning (active-org list only).
const M28_BAA_COVERAGE_JOB_ID = "m28-baa-coverage";
// GAP-006 — boot-time backfill that materializes the tenant-assignable ROLE_TEMPLATES into every existing org.
const M3_ROLE_TEMPLATE_BACKFILL_JOB_ID = "m3-role-template-backfill";
// AC-04 — the sentinel the `/ready` object-store check HEADs. Neither the bucket nor the key is
// expected to exist: a 404 is the healthy answer, and the point is that the request COMPLETED
// (endpoint reachable, SigV4 accepted, credentials valid). Names are PHI-free and tenant-free by
// construction, so the probe can never touch a real tenant bucket (`tenant-<orgId>`).
const READINESS_PROBE_BUCKET = "chartwarden-readiness";
const READINESS_PROBE_KEY = ".probe";
/** AC-05 — SECURITY_HARDENING §22.1: 5 signup intents per IP per hour on the public surface. */
const PUBLIC_SIGNUP_HOURLY_LIMIT = 5;
// M24 (WX-PR-011) — the per-state adapter registry + the Oregon launch-gateway (real+fake transport). Lives
// in @chartwarden/medicaid-adapters (M24's `dependsOn` PURE-domain leaf), not the backend module barrel — mirrors
// how the M23 X12/MAC gateway lives inside the backend module instead (the one placement difference is that
// dependency-cruiser §25.14 requires Oregon's wire format/URL to stay INSIDE @chartwarden/medicaid-adapters).
import {
  MedicaidAdapterRegistry,
  type PlaceOfServiceFacilityKind,
  type PlaceOfServiceResidenceKind,
  createM24OregonGateway,
  m24LaunchGatewayConfigFromEnv,
} from "@chartwarden/medicaid-adapters";
// The §4.4 / M10-real HOPE consumer interface the M30 worker deps bind (composed from the three live M10
// §D10 readers via `getSeam` in the worker-runner block below).
import type { QualityHopeConsumer } from "@chartwarden/quality";
import type { DsarDocumentUploadRequest } from "@chartwarden/saas-tenant-platform";
import {
  PUBLIC_SOURCE_ADAPTERS,
  embedderUnavailable,
  licensedSourceDenyStub,
} from "@chartwarden/terminology-loader";
import { buildActivePermissionHolderCounter } from "./bootstrap/active-permission-holders";
import {
  ACK_PICKER_RATE_LIMIT_KEY_PREFIX,
  buildAckRateLimit,
} from "./bootstrap/plugins/ack-rate-limit";
import { buildGlobalSearchRateLimit } from "./bootstrap/plugins/global-search-rate-limit";
import {
  M14_PACKET_BUILD_ROUTE_RATE_LIMIT,
  createRouteRateLimit,
} from "./bootstrap/plugins/route-rate-limit";
import { buildUrgentRateLimit } from "./bootstrap/plugins/urgent-rate-limit";
import {
  type RealtimeHandle,
  createRealtimeEmitter,
  createRealtimeTelemetry,
  realtimeClientKey,
  sessionRoom,
  startRealtimeServer,
} from "./bootstrap/realtime";
import { buildM36ExportBinding } from "./m36-export-binding";
import { revokeAuditorMagicLinksForEngagement } from "./modules/02-identity/auditor-magic-link-store";
import {
  M2_OUTBOX_EVENTS,
  buildM2ConsentRevokedConsumer,
  createAuditorEnrolment,
  createAuditorLinkEmailDelivery,
  createDbPublicTenantLookups,
  createDrizzleIdentityEraserStore,
  createLinkDelivery,
  createOrgScopedAuditExecutor,
  createPortalInviteeUserPort,
  createPortalSignInStore,
  createTaxIdCipher,
  createUnlockGuard,
  createUserMayUseTenantHost,
  membershipDisplayForOrg,
  mountDeviceAttestationRoutes,
  mountIdentityRoutes,
  mountOrgAdminRoutes,
  mountOrganizationLifecycleRoutes,
  mountSessionStepUpRoutes,
  registerAuditorEnrolmentRoutes,
  registerAuditorRedeemRoutes,
  registerIdentityErasers,
  registerIdentitySeams,
  registerPublicTenantRoutes,
} from "./modules/02-identity/index";
import { readStaffNames } from "./modules/02-identity/staff-names";
import {
  type ActorPermissionResolver,
  type M3OutboxPublisher,
  M3_OUTBOX_EVENTS,
  M3_PLATFORM_JOB_ID,
  createDbAuditorAccessGrantor,
  createDbOrgRoleLookup,
  createDbProposedRoleAttacher,
  createDbProvisioningRoleResolver,
  createMembershipsHoldingPermissionReader,
  createMembershipsHoldingRoleKeyReader,
  createProposedRoleGuard,
  createTenantAuditExecutor,
  materializeRoleTemplatesForOrg,
  materializeRoleTemplatesInTx,
  membershipRoleKeysForOrg,
  mountAuthorizationRoutes,
  registerAuthorizationAbacPredicates,
  registerAuthorizationSeams,
  registerM3CronWorkers,
  scheduleM3Jobs,
  wireM3ReaperTenancy,
} from "./modules/03-authorization/index";
import { M3_CLOSE_ENGAGEMENTS_PLATFORM_JOB_ID } from "./modules/03-authorization/jobs/close-engagements";
import { registerCloseEngagementsWorker } from "./modules/03-authorization/jobs/close-engagements-worker";
import {
  M4_OUTBOX_EVENTS,
  assertAuditActionCatalog,
  createDrizzleAuditEraserPorts,
  createDrizzleAuditEraserStore,
  mountAuditRoutes,
  registerAuditErasers,
} from "./modules/04-audit/index";
import {
  M4_AUDIT_JOBS_PLATFORM_JOB_ID,
  registerAuditOpsWorkers,
  scheduleAuditOpsJobs,
} from "./modules/04-audit/jobs/audit-ops-workers";
import { activeLegalHoldScopeForOrg } from "./modules/04-audit/legal-hold-scope";
import { createM34DestructionWorkflow } from "./modules/04-audit/m34-destruction-workflow";
import {
  activeLegalHolds,
  approvedMessageCertificates,
  completeMessageCertificate,
  createMessagingGovernanceHoldPort,
  expiredMessageCertificateIds,
  lockMessageCertificate,
  messageCertificateIsLive,
  openMessageCertificate,
  reserveMessageCertificateCount,
  settleMessageCertificateCount,
} from "./modules/04-audit/messaging-hold-workflow";
import { linkCaregiverToUserInTx } from "./modules/05-patient/caregiver-user-link";
import {
  M5_ADMITTING_GRANT_EXPIRY_PLATFORM_JOB_ID,
  M5_AMENDMENT_SLA_PLATFORM_JOB_ID,
  M5_OUTBOX_EVENTS,
  M5_SNAPSHOT_REBUILD_PLATFORM_JOB_ID,
  buildM5AdmissionDischargedConsumer,
  buildM5AdmissionSitingConsumer,
  buildM5ConsentPrivacyConsumer,
  buildM5DeathCascadeConsumer,
  buildM5ExtractionAllergyConsumer,
  buildM5ExtractionWritebackConsumer,
  buildM5GeocodeAddressConsumer,
  buildM5IntakeSudPrivacyConsumer,
  buildM5ReferralClosedConsumer,
  buildM5VisitAssignedConsumer,
  buildM5VisitUnassignedConsumer,
  buildM29ProposalApplierConsumer,
  countActivePatientsWithoutGeocode,
  createCaseloadStoreWithShiftCache,
  createDbPortalAmendmentIntake,
  createDrizzleCareTeamStore,
  createDrizzleCaseloadStore,
  createDrizzlePatientEraseStore,
  createDrizzlePatientMutatorStore,
  createDrizzlePatientReaderStore,
  createPatientIdentifierCipher,
  dosespotSyncDemographicsForOrg,
  funeralCaseForOrg,
  getCaseloadProvider,
  getPatientCoverageReader,
  getPatientReader,
  hl7OrmDemographicsInTx,
  lazyIdentifierKeys,
  membershipUserIdForOrg,
  mountPatientRoutes,
  patientDisplayLabelsForOrg,
  patientIdsPageForOrg,
  patientIsDeceasedForOrg,
  patientNameFragmentsPageForOrg,
  rebuildPrivacySnapshotsForOrg,
  registerAdmittingGrantExpiryWorker,
  registerAmendmentSlaWorker,
  registerPatientErasers,
  registerPatientSeams,
  registerSnapshotRebuildWorker,
  resolveGeocoder,
  scheduleAdmittingGrantExpiry,
  scheduleAmendmentSla,
  scheduleSnapshotRebuild,
  wireAdmittingGrantExpiryTenancy,
  wireAmendmentSlaTenancy,
} from "./modules/05-patient/index";
import { m34TenantPatientIds } from "./modules/05-patient/m34-shred-subjects";
// F-160 (#248) — the CapConsumerStore build: a real Drizzle-backed store for M26's `handlers-unbound`
// group, fed by two new org-explicit seam reads (M5's MBI, M6's first-election-in-range) injected as
// ports since M26's manifest dependsOn is [1, 23, 36] — it cannot import M5 or M6 directly.
import { mbiNormalizedForPatient } from "./modules/05-patient/seams/mbi-reader";
import { payerProgramsForPatientsForOrg } from "./modules/05-patient/seams/payer-programs-for-patients";
import { primaryCaregiverContactForOrg } from "./modules/05-patient/seams/primary-caregiver-contact-for-org";
import {
  M6_OUTBOX_EVENTS,
  M6_PLATFORM_JOB_ID,
  activeAdmissionDraftContextForPatient,
  activeAdmissionSitingForPatientForOrg,
  admissionCensusSummaryForOrg,
  admissionIsActiveForOrg,
  admissionSchedulingContextForOrg,
  buildM6CarePlanAddendumConsumer,
  buildM6CoverageAddendumConsumer,
  buildM6DocumentBackrefConsumer,
  buildM6LevelOfCareChangeSignedConsumer,
  buildM6ProposalAcceptedConsumer,
  buildM6RecertificationSignedConsumer,
  buildM6WorkerDeps,
  claimAssemblyRangeContextForOrg,
  claimStayEndFactsForOrg,
  composeNonCoveredItemsReaders,
  createAdmissionLocPeriodsReader,
  createDocumentReaderEvidenceValidator,
  createDrizzleAdmissionEraseStore,
  createDrizzleAdmissionReaderStore,
  createElectionAddendumService,
  electionAddendumComplianceForOrg,
  electionPeriodContextForOrg,
  idgActiveAdmissionsForOrg,
  idgCurrentLevelOfCareForOrg,
  idgHospitalEventsForOrg,
  idgPacketInclusionForOrg,
  idgRecertWindowsForOrg,
  latestLiveEndedEpisode,
  mountAdmissionRoutes,
  portalDischargedPastGraceForOrg,
  priorEpisodesForOrg,
  registerAdmissionAbacPredicates,
  registerAdmissionErasers,
  registerAdmissionRoutes,
  registerAdmissionSeams,
  registerM6CronWorkers,
  rhcPriorStayFacts,
  scheduleM6Jobs,
  transferInNoticeContextForOrg,
  wireM6Tenancy,
} from "./modules/06-admission/index";
import { cahpsDeathCandidatesForOrg } from "./modules/06-admission/seams/cahps-death-candidates-for-org";
import { firstElectionEffectiveDateInRangeForOrg } from "./modules/06-admission/seams/cap-election-context";
import { deathDischargeFactsForOrg } from "./modules/06-admission/seams/death-discharge-facts-for-org";
import { levelOfCarePeriodsForPatientForOrg } from "./modules/06-admission/seams/loc-periods-for-patient";
import { orderTriggeredRecordsForOrg } from "./modules/06-admission/seams/order-triggered-records-for-org";
import { patientSiteForOrg } from "./modules/06-admission/seams/patient-site-for-org";
// F-185 (#248) — M37's org-explicit restraint-admission-siting seam, injected as a port into M30's
// restraint-applied consumer (M30's manifest `dependsOn` excludes 37, the F-160 `CapConsumerStore` shape).
import { serviceCensusForOrg } from "./modules/06-admission/seams/service-census-for-org";
import {
  M7_OUTBOX_EVENTS,
  M7_PLATFORM_JOB_ID,
  activeProblemIdsForOrg,
  buildM7AdmissionActivatedConsumer,
  buildM7AdmissionDischargedConsumer,
  buildM7ExtractionDiagnosisWritebackConsumer,
  buildM7IdgDecisionConsumer,
  buildM7WorkerDeps,
  claimDiagnosesForOrg,
  createAddendumDiagnosesReader,
  createDbCarePlanAbacResolver,
  createDrizzleCarePlanEraseStore,
  createDrizzleCarePlanReaderStore,
  createUnrelatedProblemItemsReader,
  idgPacketCarePlanContextForOrg,
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
  billableEncountersInRangeForOrg,
  buildM8VisitClosedConsumer,
  buildM8VisitPublishedConsumer,
  buildM8WorkerDeps,
  createDrizzleEncounterEraseStore,
  createDrizzleEncounterReaderStore,
  createHearthnoteCiphers,
  encounterIdsForVisitsForOrg,
  encounterVisitIdsForOrg,
  mountEncounterRoutes,
  registerEncounterAbacPredicates,
  registerEncounterErasers,
  registerEncounterRoutes,
  registerEncounterSeams,
  registerM8CronWorkers,
  scheduleM8Jobs,
  signedEncounterNoteForOrg,
  signedEncounterSnapshotsInRangeForOrg,
} from "./modules/08-encounters/index";
import { visitCountsByDisciplineForOrg } from "./modules/08-encounters/seams/visit-counts-by-discipline-for-org";
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
  hopeAssessmentPatientIdForOrg,
  idgHopeContextForOrg,
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
  M11_ORDER_SWEEPS_PLATFORM_JOB_ID,
  M11_OUTBOX_EVENTS,
  M11_PLATFORM_JOB_ID,
  M11_STUCK_TRANSMISSION_PLATFORM_JOB_ID,
  M11_VERBAL_TIMER_PLATFORM_JOB_ID,
  RECOVERY_ESCALATION_THRESHOLD,
  RECOVERY_ORG_RATE_THRESHOLD,
  buildM11AssessmentSuggestionConsumer,
  buildM11DischargeCascadeConsumer,
  buildM11DocumentBackrefConsumer,
  buildM11FulfillmentStatusConsumer,
  buildM11IdgDecisionConsumer,
  buildM11LabCancellationConsumer,
  buildM11LabResultsApplierConsumer,
  buildM11LabTransmissionApplierConsumer,
  buildM11OrmRequestedPorts,
  buildM11RecoveryAlertConsumer,
  buildM11SupplyCancelledConsumer,
  createDbOrderBackend,
  createDrizzleOrderEraseStore,
  createDrizzleOrderSeamStore,
  createMedicationOrderSignatureCascade,
  createStuckTransmissionRecovery,
  heldThresholdsFromEnv,
  mountOrderRoutes,
  orderPatientAndKindForOrg,
  parseRecoveryBound,
  registerHeldTransmissionRoutes,
  registerM11OrderSweepWorkers,
  registerM11StandingSpawnWorker,
  registerM11StuckTransmissionWorker,
  registerM11VerbalOrderExpiryWorker,
  registerOrderAbacPredicates,
  registerOrderErasers,
  registerOrderRoutes,
  registerOrderSeams,
  scheduleM11OrderSweeps,
  scheduleM11StandingSpawn,
  scheduleM11StuckTransmission,
  scheduleM11VerbalOrderExpiry,
} from "./modules/11-orders/index";
import {
  M12_OUTBOX_EVENTS,
  M12_PLATFORM_JOB_ID,
  buildM12AdmissionActivatedMedHxConsumer,
  buildM12DischargeCascadeConsumer,
  buildM12DocumentBackrefConsumer,
  buildM12DraftOrderRequestedConsumer,
  buildM12ExtractionMedicationHistoryConsumer,
  buildM12IdgDecisionConsumer,
  buildM12PatientSyncAddressChangedConsumer,
  buildM12PatientSyncCreatedConsumer,
  buildM12PatientSyncPayerChangedConsumer,
  buildM12PatientSyncUpdatedConsumer,
  buildM12RecertificationMedHxConsumer,
  buildM12ReconciliationDiscontinueConsumer,
  buildM12VerbalExpiredConsumer,
  createBreakerEdgeRecorder,
  createDrizzleAdmissionIdForElectionPeriodPort,
  createDrizzleDoseSpotSeamStore,
  createDrizzleMedHxFetchEnqueuePort,
  createDrizzleMedicationOrderEraseStore,
  createDrizzlePatientSyncEnqueuePort,
  createEnvWebhookSecretResolver,
  createWebhookBodyCipher,
  describeM12AdapterPosture,
  idgMedicationHistoryForOrg,
  medicationOrderPatientAndDrugForOrg,
  medicationOrderScheduleContextForOrg,
  mountDoseSpotRoutes,
  registerDoseSpotAbacPredicates,
  registerDoseSpotErasers,
  registerDoseSpotRoutes,
  registerDoseSpotSeams,
  registerDoseSpotSyncQueueWorker,
  registerDoseSpotWebhookRoute,
  registerM12CronWorkers,
  scheduleDoseSpotSyncQueueDrain,
  scheduleM12Jobs,
  wireM12Tenancy,
} from "./modules/12-dosespot/index";
import { medicationOrdersForAdmissionForOrg } from "./modules/12-dosespot/seams/drizzle-store";
import {
  M13_OUTBOX_EVENTS,
  M13_PLATFORM_JOB_ID,
  buildM13AdmissionDischargedCascadeConsumer,
  buildM13CancelFutureScheduleConsumer,
  buildM13ComfortKitDeployedConsumer,
  buildM13ComfortKitReplenishedConsumer,
  buildM13ComfortKitReturnReconciliationConsumer,
  buildM13ComfortKitReturnedConsumer,
  buildM13DocumentBackrefConsumer,
  buildM13MaterializeScheduleConsumer,
  buildM13ReconciliationTriggerConsumer,
  buildPortalCaregiverAttestationPort,
  createDrizzleEmarEraseStore,
  createDrizzleEmarSeamStore,
  idgMissedDosesForOrg,
  ivSessionActivityForOrg,
  mountEmarRoutes,
  registerEmarAbacPredicates,
  registerEmarErasers,
  registerEmarRoutes,
  registerEmarSeams,
  registerM13CronWorkers,
  scheduleM13Jobs,
  wireM13Tenancy,
} from "./modules/13-emar/index";
import {
  M14_ALERT_PAYLOADS,
  M14_OUTBOX_EVENTS,
  M14_PLATFORM_JOB_ID,
  M14_QUEUES,
  buildM14ActionItemAutoCloseConsumer,
  buildM14AssessmentRecordedConsumer,
  buildM14AssessmentSignificantChangeConsumer,
  buildM14DecisionAppliedConsumer,
  buildM14DocumentBackrefConsumer,
  buildM14HopeJ2051TriggerConsumer,
  buildM14HopeSfvCreatedConsumer,
  buildM14MedicationOrderDiscontinuedConsumer,
  buildM14OrderDiscontinuedConsumer,
  buildM14WorkerDeps,
  createBullmqPacketBuildQueuePort,
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
  M15_PLATFORM_JOB_ID,
  buildDrizzleDisciplinePlanAbacResolver,
  buildDrizzleM15ReadService,
  buildDrizzleM15WriteService,
  buildM15IdgDecisionConsumer,
  buildM15PlanBootstrapConsumer,
  buildM15WorkerDeps,
  createDrizzleDisciplinePlanEraseStore,
  createDrizzleDisciplinePlanSeamStore,
  denyStubDisciplinePlanAbacResolver,
  mountM15Routes,
  registerDisciplinePlanAbacPredicates,
  registerDisciplinePlanErasers,
  registerDisciplinePlanSeams,
  registerM15CronWorkers,
  scheduleM15Jobs,
} from "./modules/15-discipline-care-plans/index";
import {
  M16_OUTBOX_EVENTS,
  M16_PLATFORM_JOB_ID,
  buildDrizzleBereavementAbacResolver,
  buildDrizzleM16ReadService,
  buildDrizzleM16WriteService,
  buildM16BereavementIntakeConsumer,
  buildM16ConsentRevokedConsumer,
  buildM16ConsentSignedConsumer,
  buildM16DischargeCosignedConsumer,
  buildM16DischargeDeathSecondaryConsumer,
  buildM16DocumentRenderedConsumer,
  buildM16EncounterSignedConsumer,
  buildM16IdgDecisionConsumer,
  buildM16PatientOptOutChangedConsumer,
  buildM16WorkerDeps,
  createBereavementCipher,
  createDrizzleBereavementEraseStore,
  createDrizzleBereavementSeamStore,
  denyStubBereavementAbacResolver,
  mountM16Routes,
  registerBereavementAbacPredicates,
  registerBereavementErasers,
  registerBereavementSeams,
  registerM16CronWorkers,
  scheduleM16Jobs,
  wireM16Tenancy,
} from "./modules/16-bereavement/index";
import { bereavementCensusForOrg } from "./modules/16-bereavement/seams/bereavement-census-for-org";
// F-161 (#248) — M16's org-explicit bereavement-plan-siting seam, injected as a port into M30's
// plan-closure consumer (M30's manifest `dependsOn` excludes 16, the F-160 `CapConsumerStore` shape).
import {
  bereavedContactFlipCandidateForOrg,
  bereavedContactFlipCandidatesForPlanForOrg,
  bereavementPlanSitingForOrg,
} from "./modules/16-bereavement/seams/plan-provider-entity-for-org";
import {
  M17_OUTBOX_EVENTS,
  buildM17AdmissionLifecycleConsumer,
  buildM17CarePlanProposalConsumer,
  buildM17EncounterSignedConsumer,
  buildM17EvvAtPatientAddressConsumer,
  buildM17EvvCheckInConsumer,
  buildM17EvvCheckOutConsumer,
  buildM17EvvEventCorrectedConsumer,
  buildM17EvvLateCheckResolvedConsumer,
  buildM17SosVisitCancellationConsumer,
  buildM17TriageVisitNeededConsumer,
  buildM17VolunteerAssignmentInactivatedConsumer,
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
import { onTimeVisitCountsForOrg } from "./modules/17-scheduling/seams/drizzle-store";
import {
  type EvvCoordsCipher,
  type EvvCoordsKeyProvider,
  M18_OUTBOX_EVENTS,
  buildEvvAggregatorDeps,
  buildM18DekRotationConsumer,
  buildM18EncounterSignedConsumer,
  buildM18SpoofDetectorConsumer,
  buildM18SubmissionPrepConsumer,
  buildM18VisitCancelledConsumer,
  buildM18VisitPublishedConsumer,
  complianceStatesForVisitsForOrg,
  createDrizzleCoordsResealStore,
  createDrizzleEvvSeamStore,
  createEvvCoordsCipher,
  isEvvDeviceAttestationEnforced,
  lazyEvvCoordsKeys,
  mountEvvRoutes,
  registerEvvAbacPredicates,
  registerEvvRoutes,
  registerEvvSeams,
  registerM18CronWorkers,
  scheduleM18Jobs,
} from "./modules/18-evv/index";
import { evvComplianceCountsForOrg } from "./modules/18-evv/seams/drizzle-store";
// F-194 (#248) — M18's org-explicit EVV-visit-provider-entity seam, injected as a port into M30's
// visit-verified consumer (M30's manifest `dependsOn` excludes 18, the F-160 `CapConsumerStore` shape).
import { evvVisitProviderEntityForOrg } from "./modules/18-evv/seams/evv-visit-provider-entity-for-org";
import {
  M19_OUTBOX_EVENTS,
  M19_PLATFORM_JOB_ID,
  buildAfterHoursRequestedConsumer,
  buildDrizzleEscalationRouterReads,
  buildDrizzleM19ReadService,
  buildDrizzleM19WriteService,
  buildDrizzleOncallAbacResolver,
  buildDrizzleOncallSeamStore,
  buildDrizzleVendorSessionBindReader,
  buildOncallEncounterSignedConsumer,
  buildOncallRosterSyncDebounceConsumer,
  buildOncallTriggerConsumers,
  createDrizzleInboundTriggerPorts,
  createDrizzleTriageEraseStore,
  denyStubOncallAbacResolver,
  gipProposalsForOrg,
  idgTriageCarePlanChangesForOrg,
  mountM19Routes,
  registerEscalationRouterForAllowlist,
  registerM19CronWorkers,
  registerM19Tier1CronWorkers,
  registerM19TriageCronWorkers,
  registerOncallAbacPredicates,
  registerOncallSeams,
  registerTriageErasers,
  scheduleM19Jobs,
  scheduleM19Tier1Jobs,
  scheduleM19TriageJobs,
  wireM19Tenancy,
} from "./modules/19-oncall/index";
import {
  M20_OUTBOX_EVENTS,
  M20_PLATFORM_JOB_ID,
  buildDrizzleM20ReadService,
  buildDrizzleM20WriteService,
  buildDrizzleSafetyAbacResolver,
  buildDrizzleSafetySeamStore,
  buildFieldSafetyConsumers,
  buildM20TerminusDeps,
  buildM20WorkerDeps,
  createCoordinateDecipher,
  createDrizzleSafetyEraseStore,
  createSafetyCiphers,
  createSafetyPolicyProvider,
  createSosRecipientCounter,
  denyStubSafetyAbacResolver,
  lazyTenantKeys,
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
  M21_PLATFORM_JOB_ID,
  bindSupplyRequestCreator,
  buildDrizzleM21ReadService,
  buildDrizzleM21WriteService,
  buildDrizzleSuppliesAbacResolver,
  buildDrizzleSuppliesSeamStore,
  buildM21ComfortKitControlledSubstanceReemitConsumer,
  buildM21ComfortKitDeploymentAckConsumer,
  buildM21ComfortKitReplenishmentIntakeConsumer,
  buildM21ComfortKitReturnRequiredConsumer,
  buildM21DocumentBackrefConsumer,
  buildM21OrderDiscontinuedConsumer,
  buildM21PharmacyDispenseConsumer,
  buildM21SupplyCancellationConsumer,
  buildM21SupplyFulfillmentIntakeConsumer,
  buildM21WorkerDeps,
  decideDispatcherEligible,
  denyStubSuppliesAbacResolver,
  mountM21Routes,
  registerM21CronWorkers,
  registerSuppliesAbacPredicates,
  registerSuppliesSeams,
  registerSupplyEraser,
  scheduleM21Jobs,
  validateSupplyAIBlock,
} from "./modules/21-supplies/index";
import { deliveredSourceOrderIdsForOrg } from "./modules/21-supplies/seams/delivered-source-orders-for-org";
import { buildIntakeSudBatchReader } from "./modules/22-documents/extraction/privacy-sud-batches";
import {
  type DocLensClassifierPort,
  type DocLensExtractorPort,
  type DocLensSudDetectorPort,
  type DocLensVisionVerifierPort,
  M22_DOCUMENT_RENDERED_EVENT,
  M22_FORM_RENDER_PLATFORM_JOB_ID,
  M22_OUTBOX_EVENTS,
  M22_RECORDS_REQUEST_EXPIRY_PLATFORM_JOB_ID,
  M22_RETENTION_ROTATION_PLATFORM_JOB_ID,
  buildAppealPacketRenderGuard,
  buildM22DocumentRequestConsumer,
  buildM22ExtractionBackrefConsumer,
  buildM22ExtractionClinicalBackrefConsumer,
  buildM22ExtractionDiagnosisBackrefConsumer,
  buildM22LabBackrefConsumer,
  buildM22MedicationListConsumer,
  buildPortalDisclosureReader,
  buildPortalUploadIntakePort,
  createCandidateValueCipher,
  createCodingTerminology,
  createDocLensIntakeEnqueue,
  createDrizzleDocumentEraseStore,
  createDrizzleDocumentReaderStore,
  createDrizzleDocumentSeamStore,
  createDrizzlePortalAccessLog,
  createHttpDoclingClient,
  createIdentityTargetPorts,
  createRefusingObjectStore,
  createS3ObjectStore,
  createS3TenantStorageProvisioner,
  createSignedUrlService,
  createSudConsentEvaluatorPortalConsentPort,
  createUnboundDoclingClient,
  deriveTenantBucket,
  doclingConfigFromEnv,
  expireRecordsRequestsForOrg,
  getDocumentRenderer,
  mountDocumentRoutes,
  registerAiBlockValidatorWorker,
  registerDocLensIntakeWorker,
  registerDocumentAbacPredicates,
  registerDocumentErasers,
  registerDocumentRoutes,
  registerDocumentSeams,
  registerFormRenderWorker,
  registerRecordsRequestExpiryWorker,
  registerRetentionRotationWorker,
  s3ObjectStoreConfigFromEnv,
  scheduleAiBlockValidator,
  scheduleFormRender,
  scheduleRecordsRequestExpiry,
  scheduleRetentionRotation,
  validateDocumentsAIBlock,
} from "./modules/22-documents/index";
import { buildM22ConsentRevokedConsumer } from "./modules/22-documents/outbox-consumers/m39-consent-revoked";
import { createDrizzleAttemptStore } from "./modules/23-billing-medicare/clearinghouse-attempt-store";
import {
  bindPlatformClearinghouse,
  describeClearinghouseBinding,
} from "./modules/23-billing-medicare/clearinghouse-binding";
// M23 (Billing — Medicare) boot surface — the §4.10 outbox catalog, the §4.7 ABAC resolvers, the §4.1 route
// mount over the Drizzle read/write services + the boot-time claim-assembly service, the §3.7 `billing_record`
// eraser (registerEraser INJECTED — M23 cannot import the M1 bootstrap registry), and the §4.8 BullMQ workers
// (claim/NOE/NOTR submit[.retry], 999/277CA ack pulls, eligibility refresh, NOE/NOTR window-watch, eligibility
// stale-watch, MAC-portal health, the revalidate consumer). The domain + watchdog workers construct on every
// db boot ("M23 domain + watchdog (+ launch) workers constructed"); the LAUNCH workers (claim/NOE/NOTR submit,
// 999/277CA pulls) additionally need the X12 + MAC gateways, which bind from `M23_X12_GATEWAY_*` /
// `M23_MAC_GATEWAY_*` (opt-out via `M23_LAUNCH_GATEWAY_ENABLED=false`; the production env validator
// requires them). A port whose gateway is not configured stays fail-closed-unbound (RULE 4) — it is never
// silently absent, and the other workers are unaffected.
import {
  type M23BootAssemblyPorts,
  type M23HetsConfig,
  M23_OUTBOX_EVENTS,
  M23_PLATFORM_JOB_ID,
  M23_QUEUES,
  ORG_WIDE_BILLING_SCOPE_ROLES,
  type ProviderCcnPort,
  buildClaimStateService,
  buildClaimValidationContextPort,
  buildClaimValidationRunner,
  buildClaimValidationService,
  buildDdeQueueService,
  buildDdeWatchdog,
  buildDrizzleM23ReadService,
  buildDrizzleM23WriteService,
  buildDrizzleOrgMacJurisdictionReader,
  buildDrizzlePlatformAdminService,
  buildDrizzleRateTableService,
  buildDrizzleRevalidationTargetResolver,
  buildDrizzleSequestrationPolicyService,
  buildDrizzleVisitChargeService,
  buildDrizzleWageIndexService,
  buildHetsEligibilityPort,
  buildM23BootAssemblySeams,
  buildM23BootAssemblyService,
  buildM23LateCheckResolvedConsumer,
  buildM23NoeDraftConsumer,
  buildM23NotrDraftConsumer,
  buildM23OutboxBackedSubmissionGate,
  buildM23RemittanceConsumer,
  buildM23RevalidateEnqueuePort,
  buildM23RevalidateTriggerConsumers,
  buildM23SubmissionQueuePort,
  buildM23SubmissionRequestConsumer,
  buildM23TaxonomyUnmappedCodeObservedConsumer,
  buildM23TransferNoticeDraftConsumer,
  buildM23ValidationRunner,
  buildM23WorkQueueEnqueuePort,
  buildM23WorkRequestConsumer,
  buildM23WorkerDeps,
  buildMacJurisdictionLister,
  buildMacSecretCipherFromEnv,
  buildNoticeWindowPort,
  buildTransferNoticeService,
  createDrizzleBillingEraseStore,
  createM23HetsTransport,
  createM23LaunchGateway,
  m23HetsConfigFromEnv,
  m23LaunchGatewayConfigFromEnv,
  mountM23Routes,
  priorElectionClosureForOrg,
  registerBillingErasers,
  registerM23AbacPredicates,
  registerM23DomainWorkers,
  registerM23LaunchWorkers,
  registerM23PortalHealthWorker,
  registerM23PublishedSeams,
  registerM23WatchCronWorkers,
  scheduleM23Jobs,
  scheduleM23WatchJobs,
  sweepLegacyValidationRunQueue,
  validateBillingAiBlockAtBoot,
  wireM23Tenancy,
} from "./modules/23-billing-medicare/index";
import {
  composeFacilitySpans,
  toFacilitySpans,
} from "./modules/23-billing-medicare/services/claim-cbsa";
import { buildClearinghouseAttemptResolutionService } from "./modules/23-billing-medicare/services/clearinghouse-attempt-resolution-service";
import { resolveInpatientCapDifferential } from "./modules/23-billing-medicare/services/inpatient-cap-differential";
// M24 (Billing — Medicaid) boot surface — the §4.11 outbox catalog, the §4.8 ABAC resolvers
// (provider_entity_medicaid_billing_scope / medicaid_claim_in_billing_manager_caseload /
// medicaid_override_role_eligible / regulatory_required_rule_protected_medicaid / rb_arrangement_visible_in_scope
// / state_trading_partner_credential_admin), the §4.1 route mount over the Drizzle read/write services, and the
// §3.7 `medicaid_billing_record` eraser. The write service's `m24.*` transactional outbox publisher binds at
// boot; the §4.3 published-seam registration + the §4.9 per-state-adapter workers + the consumed-reader binds
// are deferred follow-ups (the M26 posture — the adapter wire I/O lands later).
import {
  M24_OUTBOX_EVENTS,
  M24_PLATFORM_JOB_ID,
  M24_SUBMISSION_REQUEST_EVENTS,
  buildCredentialCipherPort,
  buildDrizzleActivePeStatesLister,
  buildDrizzleCredentialResolver,
  buildDrizzleEligibilityWatchdogStore,
  buildDrizzleM24ReadService,
  buildDrizzleM24WriteService,
  buildDrizzleRbDaySweepStore,
  buildDrizzleStateChannelCredentialResolver,
  buildM24MedicarePrimaryAckConsumer,
  buildM24RbDayConsumers,
  buildM24RemittanceConsumer,
  buildM24RevalidateEnqueuePort,
  buildM24RevalidateTriggerConsumers,
  buildM24SubmissionQueuePort,
  buildM24SubmissionRequestConsumer,
  buildM24SubmissionWorkerDeps,
  buildStateChannelHealthProbe,
  createDrizzleMedicaidRedactStore,
  mountM24Routes,
  registerM24AbacPredicates,
  registerM24CronWorkers,
  registerM24LaunchWorkers,
  registerM24PublishedSeams,
  registerM24RevalidateWorker,
  registerM24StateChannelHealthWorker,
  registerMedicaidErasers,
  scheduleM24Jobs,
  scheduleM24StateChannelHealthJob,
  wireM24Tenancy,
} from "./modules/24-billing-medicaid/index";
// M25 (Remittance & Denials) boot surface — the §4.5 outbox catalog, the §4.7 ABAC resolvers
// (`claim_assigned_to_actor`, `appeal_within_deadline`), and the §4.1 route mount over the Drizzle
// read/write services. The write service binds the catalog-validating transactional outbox publisher
// (`m25OutboxPublisher`) and the read service binds the M38 CARC/RARC catalog floor over the registered
// `TerminologyProvider` seam; both are live on a db boot (the no-op emit / deny-stub defaults apply only to a
// db-less slice).
import {
  type WorkerAlertPort as M25WorkerAlertPort,
  M25_OUTBOX_EVENTS,
  M25_PLATFORM_JOB_ID,
  type TerminologyLookupPort,
  buildDrizzleAdrService,
  buildDrizzleDenialRouteService,
  buildDrizzleDenialSeedStore,
  buildDrizzleM25IngestService,
  buildDrizzleM25ReadService,
  buildDrizzleM25WriteService,
  buildDrizzleQicService,
  buildDrizzleReopeningService,
  buildDrizzleSubmissionService,
  buildDrizzleTpeService,
  buildM18EvvAggregatorRejectedConsumer,
  buildM23BackedClaimMatchCandidateProvider,
  buildM23ClaimRejectedConsumer,
  buildM24BackedClaimMatchCandidateProvider,
  buildM25EdiReceivedConsumer,
  buildM25WorkerDeps,
  buildSeamAppealSourcePorts,
  createDrizzleRemittanceEraseStore,
  mountM25Routes,
  registerM25AbacPredicates,
  registerM25CronWorkers,
  registerM25PublishedSeams,
  registerRemittanceErasers,
  scheduleM25Jobs,
  wireM25Tenancy,
} from "./modules/25-remittance/index";
import { createDrizzleCapConsumerStore } from "./modules/26-cap/consumers/drizzle-store";
import { buildM26UpstreamConsumer } from "./modules/26-cap/consumers/outbox-binding";
// M26 (Cap Management) boot surface — the §4.10 outbox catalog, the §4.7 ABAC resolvers (cap_period_open /
// _in_settlement / _settled / _methodology_unlocked / cap_platform_admin), and the §4.1 route mount over the
// Drizzle read/write services. The write service's transactional outbox publisher binds at boot; the §4.3
// published-seam impls + the §4.8 BullMQ workers + the §3.7 eraser land in P4 (the M27 deferred posture).
import {
  type M26WorkerAlertPort,
  M26_OUTBOX_EVENTS,
  M26_PLATFORM_JOB_ID,
  buildDrizzleM26ReadService,
  buildDrizzleM26WriteService,
  buildPsrReconcileEnqueuer,
  createDrizzleCapRedactStore,
  createPsrFileStore,
  mountM26Routes,
  registerCapErasers,
  registerM26AbacPredicates,
  registerM26CronWorkers,
  registerM26PublishedSeams,
  scheduleM26Jobs,
  wireM26Tenancy,
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
  buildM27VendorInvoiceConsumer,
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
import { buildM27StatisticsSeams } from "./modules/27-cost-report/jobs/statistics-seams";
// M28 (FHIR Gateway) boot surface — the §4.3 published read seams (M28-T06). The three impls register over
// their M1 deny-stubs ONLY when a Drizzle store is supplied; M28's routes/repos (the store's home) land in
// T08, so the store is unbound this wave and the fail-closed deny-stubs stand (the M19/M20 posture).
import {
  CAPABILITY_RELEASE_TAG,
  M28_OUTBOX_EVENTS,
  M28_PLATFORM_JOB_ID,
  buildBulkExportEnqueuePort,
  buildDrizzleFhirGatewayAbacResolver,
  buildFhirExportObjectStore,
  buildGatewayCapabilityStatement,
  createDrizzleFhirGatewayEraseStore,
  createDrizzleFhirGatewayStore,
  createDrizzleFhirPublishedSeamStore,
  createHttpFhirJwksFetcher,
  createInMemoryFhirClientRateLimiter,
  createInMemoryFhirReplayGuard,
  createRedisFhirClientRateLimiter,
  createRedisFhirReplayGuard,
  denyStubFhirGatewayAbacResolver,
  getFhirBaaStatusProvider,
  mountM28Routes,
  registerFhirGatewayAbacPredicates,
  registerFhirGatewayEraser,
  registerFhirPublishedSeams,
  registerM28Workers,
  sampleFhirBaaCoverage,
  scheduleM28Jobs,
  warnOnFhirBaaGap,
  wireM28Tenancy,
} from "./modules/28-fhir/index";
import { buildM28ConsentRevokedConsumer } from "./modules/28-fhir/outbox-consumers/m39-consent-revoked";
// M29 (External Interfaces) boot surface (M29-T08) — the §4.1/§4.2 route store, the §4.4 published seams,
// and the §4.8 ABAC predicate resolver. Seams register over their M1 deny-stubs ONLY when a Drizzle store is
// supplied (db-less boot keeps the fail-closed deny-stubs); the ABAC resolver binds the M3 permission store +
// a lazy M5 CaseloadProvider adapter.
import {
  type ExternalInterfaceBaaGate,
  type ListenerAlertPort,
  M29_OUTBOX_EVENTS,
  M29_PLATFORM_JOB_ID,
  NPPES_SYNC_SCHEDULE,
  NppesClient,
  buildDrizzleM29AbacResolver,
  buildDrizzleOutboundFeedResolver,
  buildM29InboundSeamPorts,
  buildM29OutboundDispatchConsumer,
  buildM29PatientDeceasedConsumer,
  buildNppesManualSyncTrigger,
  createDrizzleFeedWatchStore,
  createDrizzleM29PublishedSeamStore,
  createDrizzleM29Store,
  createInboundCipher as createM29InboundCipher,
  createFeedRateLimiter as createM29OutboundRateLimiter,
  denyStubM29AbacResolver,
  lastCompletedNppesSyncAt,
  mountM29Routes,
  ormOutboundEvidenceForOrder,
  ormOutboundFeedsForOrders,
  outboundBaaCleared,
  primaryTaxonomyCode,
  probeTcpPort,
  registerM29AbacPredicates,
  registerM29FeedHealthWatchWorker,
  registerM29OutboundRetrySweepWorker,
  registerM29PublishedSeams,
  registerNppesSyncWorker,
  resolveFeedHealthWatchConfig,
  scheduleM29FeedHealthWatchJob,
  scheduleM29OutboundRetrySweepJob,
  scheduleNppesSyncJob,
  startListenerProcess as startM29ListenerProcess,
  startParseWorker as startM29ParseWorker,
  wireM29Tenancy,
} from "./modules/29-external-interfaces/index";
import { buildM30CahpsWiring } from "./modules/30-quality/cahps/wiring";
import {
  M30_OUTBOX_EVENTS,
  M30_PLATFORM_JOB_ID,
  buildDrizzleM30ReadService,
  buildDrizzleM30WriteService,
  buildM30BereavementPlanClosedConsumer,
  buildM30ClaimAdjudicatedConsumer,
  buildM30DischargeDeathConsumer,
  buildM30HopeSubmissionAcceptedConsumer,
  buildM30MedicationErrorReportedConsumer,
  buildM30RecomputeEnqueue,
  buildM30RestraintAppliedConsumer,
  buildM30VisitVerifiedConsumer,
  buildM30WorkerDeps,
  createDrizzleQualityEraseStore,
  idgQualityFlaggedEventsForOrg,
  mountM30Routes,
  registerM30AbacPredicates,
  registerM30AlertRepeatWorker,
  registerM30CapOverdueWorker,
  registerM30CronWorkers,
  registerM30PublishedSeams,
  registerM30ReviewOverdueWorker,
  registerM30Workers,
  registerQualityErasers,
  scheduleM30AlertRepeatJob,
  scheduleM30CapOverdueJob,
  scheduleM30Jobs,
  scheduleM30ReviewOverdueJob,
  wireM30Tenancy,
} from "./modules/30-quality/index";
import {
  M31_OUTBOX_EVENTS,
  bindM31EventEmitter,
  buildDailyTelehealthAdapter,
  buildDrizzlePortalStore,
  buildPortalAbacResolverFromStore,
  createM31EventEmitter,
  createM31PublishedSeamImpls,
  createPortalConsentPort,
  createPortalInvitationDelivery,
  createPortalPhiCipher,
  createPortalProvisioning,
  createPortalReasonCipher,
  createPortalRoomCipher,
  denyStubPortalAbacResolver,
  mountM31Routes,
  registerM31PublishedSeams,
  registerPortalAbacPredicates,
  registerPortalErasers,
} from "./modules/31-portal/index";
// F-222 (#248) — M31's first cron: the daily post-discharge-grace sweep (replaces the unbuilt `m6.admission.discharged` push).
import {
  M31_PLATFORM_JOB_ID,
  registerM31LateJoinWatchdogWorker,
  registerM31PostDischargeGraceWorker,
  scheduleM31LateJoinWatchdogJob,
  scheduleM31PostDischargeGraceJob,
  wireM31Tenancy,
} from "./modules/31-portal/jobs/index";
import { buildM31EncounterSignedTelehealthConsumer } from "./modules/31-portal/outbox-consumers/m8-encounter-signed-telehealth";
// F-167 (#248) — the per-contact-exact D6 lateral-flip trigger `plan_opened`'s own sibling names as "the
// real primary trigger." Fed by M16's new single-contact seam read (`bereavedContactFlipCandidateForOrg`).
import { buildM31BereavementContactActiveConsumer } from "./modules/31-portal/outbox-consumers/m16-bereavement-contact-active";
import { buildM31BereavementPlanClosedConsumer } from "./modules/31-portal/outbox-consumers/m16-bereavement-plan-closed";
import { buildM31BereavementPlanOpenedConsumer } from "./modules/31-portal/outbox-consumers/m16-bereavement-plan-opened";
// F-160 (#248) — M31's first outbox consumers: the telehealth force-end/re-mint/reconcile trio over
// `telehealth_visit`, M31's own owned table.
import { buildM31VisitCancelledTelehealthConsumer } from "./modules/31-portal/outbox-consumers/m17-visit-cancelled-telehealth";
import { buildM31VisitRescheduledTelehealthConsumer } from "./modules/31-portal/outbox-consumers/m17-visit-rescheduled-telehealth";
import { buildM31ConsentRevokedGrantCascadeConsumer } from "./modules/31-portal/outbox-consumers/m39-consent-revoked";
// M32 (AI Platform) boot surface — M32-T02's §3.7 destruction contract, M32-T06's §4.4 seam registration
// and M32-T07's HTTP surface: the §4.11 `m32.*` outbox catalog, the six §4.7 ABAC predicate resolvers and
// the §4.1 route mount over the T03/T04/T05 command services + T07's read port. `ai.full` stays OFF.
import {
  M32_OUTBOX_EVENTS,
  M32_PLATFORM_JOB_ID,
  aiBackendConfigFromEnv,
  buildConfiguredModelBackends,
  buildDrizzleAiPlatformAbacResolver,
  buildDrizzleM32ReadService,
  buildLiveAiInvocationPipeline,
  buildSpendReader,
  buildTriageFollowUpQueue,
  createAiPromptRegistry,
  createDenyingAiOptInEvidenceResolver,
  createDocLensOutputProjector,
  createDrizzleAiCapabilityRegistryStore,
  createDrizzleAiEvaluationRunStore,
  createDrizzleAiHallucinationReportStore,
  createDrizzleAiKillSwitchStore,
  createDrizzleAiPromptTemplateStore,
  createDrizzleAiProvenanceEraseStore,
  createDrizzleAiRoutingOverrideStore,
  createDrizzleAiSeamActorResolver,
  createDrizzleAiTenantConsentStore,
  createFilesystemAiPromptArtifactReader,
  createM32EventEmitter,
  createOrganizationSettingsAiTokenBudgetResolver,
  createUnconfiguredAiTokenBudgetResolver,
  denyStubAiPlatformAbacResolver,
  mountM32Routes,
  registerAiPlatformAbacPredicates,
  registerAiPlatformSeams,
  registerAiProvenanceErasers,
  registerM32TokenRollupWorker,
  registerM32TriageFollowUpWorker,
  scheduleM32TokenRollupJob,
  startAiBackendHealthSweep,
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
  M34_PLATFORM_JOB_ID,
  type SignupIntentRouteService,
  type TenantPlatformAbacResolver,
  bootstrapModule34,
  buildDrizzlePlatformService,
  buildDrizzleTenantPlatformAbacResolver,
  buildDrizzleTenantService,
  buildFeatureFlagKillSwitchPorts,
  buildM34ProvisionQueue,
  buildM34ProvisionStartedConsumer,
  buildM34WorkerDeps,
  buildPlatformEnqueue,
  buildTenantEnqueue,
  createDrizzleM34AlertResolverPorts,
  createDrizzlePlatformOpsService,
  createDrizzleSaasTenantPlatformEraseStore,
  createDrizzleTenantAccountFlagsService,
  createM34ProvisionGateway,
  describeM34SweepSchedules,
  enableM34JobCapability,
  getTenantKeyProvider,
  m34ProvisionGatewayConfigFromEnv,
  m34ResolverExtension,
  mountTenantPlatformRoutes,
  registerLiveM34Seams,
  registerM34BaaExpiryWorker,
  registerM34BundleExpiryWorker,
  registerM34DekRotateWorker,
  registerM34DsarExportWorker,
  registerM34OnboardingAdvanceWorker,
  registerM34ProvisionWorker,
  registerM34ShredWorker,
  registerM34SupportSessionCloseWorker,
  registerM34TenantExportWorker,
  registerSaasTenantPlatformErasers,
  registerTenantPlatformAbacPredicates,
  scheduleM34BundleExpiryJob,
  scheduleM34PlatformSweepJobs,
  validateModule34Seams,
  wireM34AlertRuleSeed,
  wireM34Tenancy,
} from "./modules/34-saas-tenant-platform/index";
import { canInviteFirstAdmin } from "./modules/34-saas-tenant-platform/invitation-token";
// M35 (Subscription Billing) boot surface — the §4.11 outbox catalog, the §4.8 ABAC predicates, and the
// §4.1–4.3 route mount over the single Drizzle route service. The write path emits `m35.*` events through
// the bound transactional-outbox publisher; the platform-ops cross-tenant reads/writes run through the
// injected platform runner (fail-closed until a platform credential binds — the M34 posture), and the §4.3
// webhook ingest stays fail-closed (503) until the live Stripe transport binds. The §4.5/§4.6 seams were
// bound as deny-stubs in T05 and are still dormant (GAP-208): nothing registers a live impl and no
// in-repo consumer resolves them via `getSeam`.
import {
  M35_JOBS_PLATFORM_JOB_ID,
  M35_OUTBOX_EVENTS,
  type PlatformRunner,
  buildDrizzleM35RouteService,
  buildM35OrgLifecycleConsumer,
  buildM35PatientActivePeriodConsumer,
  buildM35SessionCreatedConsumer,
  buildM35WebhookIngest,
  createDrizzlePseudonymKeyProvider,
  loadM35StripeConfig,
  mountM35Routes,
  registerM35AbacPredicates,
  registerM35Workers,
  scheduleM35Jobs,
} from "./modules/35-subscription/index";
import { createDeliveryRouteReader } from "./modules/36-messaging/ack-delivery-failure/delivery-route-reader-db";
import { emitWithRecipientFallback } from "./modules/36-messaging/alert-recipient-fallback";
import { createResponseAnalyticsReader } from "./modules/36-messaging/analytics/response-analytics-reader";
import {
  invalidateMessageBodyKeys,
  setMessageBodyKeyProvider,
  sharedRingDekCache,
} from "./modules/36-messaging/body-key-ring";
import {
  M36_BODY_LEGACY_COUNT_JOB_ID,
  assertM36BodyBootEnv,
  countLegacyBodiesAllTenants,
  runLegacyBodyBootCheck,
} from "./modules/36-messaging/body-legacy-key-check";
import { buildCareTeamReviewRouter } from "./modules/36-messaging/care-team-sync/binding";
import { cronAlertCorrelationId } from "./modules/36-messaging/cron-alert-correlation";
import {
  buildM36ExportBuildConsumer,
  createExportBuildEnqueuer,
  registerM36ExportBuildWorker,
  registerM36ExportExpiryWorker,
  scheduleM36ExportExpiryJobs,
} from "./modules/36-messaging/export/export-worker";
import { createNameExclusions } from "./modules/36-messaging/global-search/name-exclusion";
import { registerM36GlobalSearch } from "./modules/36-messaging/global-search/register";
import { createRingSearchKeyProvider } from "./modules/36-messaging/global-search/search-key-provider";
import {
  M36_ACK_QUEUE_METRICS_PLATFORM_JOB_ID,
  M36_DELIVERY_PLATFORM_JOB_ID,
  M36_INTEGRITY_PLATFORM_JOB_ID,
  M36_OUTBOX_EVENTS,
  bindOutOfBandTransports,
  buildAckDeps,
  buildClinicalLinkDeps,
  buildEscalationBinding,
  buildHandoffDeps,
  buildIdgAlertConsumers,
  buildIdgCarryForwardComplianceConsumer,
  buildIdgDiscussionDeps,
  buildM36BreakGlassAlertConsumer,
  buildM36ClinicalAlertConsumer,
  buildMedicationQuestionDeps,
  buildOnCallDirectoryDeps,
  buildPresenceDeps,
  buildPromotionDeps,
  buildReviewDeps,
  buildSbarDeps,
  buildSnoozeReminderBinding,
  buildTaskDeps,
  buildUrgentDeps,
  createAttachmentService,
  createBreakGlassReviewSweep,
  createBullmqTimerPort,
  createDbAckQueueStatsReader,
  createDbMessagingProvider,
  createDbMessagingRouteService,
  createDlqAuditRecorder,
  createDrizzleAlertEmitter,
  createDrizzleDeliveryDispatchStore,
  createDrizzleIdgAttendeeLookup,
  createDrizzleMembershipUserLookup,
  createDrizzleMessagingEraseStore,
  createDrizzleRoleSetMembersReader,
  createRealtimeAuditWriter,
  createScheduledSendDispatcher,
  createSosContactCaller,
  createUnreachableWatch,
  getEscalationRouter,
  mountMessagingRoutes,
  mountMessagingWebhookRoutes,
  registerM36AckEscalationWorkers,
  registerM36AttachmentScanWorker,
  registerM36BreakGlassReviewWorker,
  registerM36DeliveryWorkers,
  registerM36HandoffExpiryWorker,
  registerM36IntegrityWorkers,
  registerM36ReminderSweepWorker,
  registerM36ScheduledSendWorker,
  registerMessagingErasers,
  registerMessagingSeams,
  scheduleM36AckEscalationJobs,
  scheduleM36AttachmentScanJobs,
  scheduleM36BreakGlassReviewJobs,
  scheduleM36DeliveryJobs,
  scheduleM36HandoffExpiryJobs,
  scheduleM36IntegrityJobs,
  scheduleM36ReminderSweepJobs,
  scheduleM36ScheduledSendJobs,
  wireAlertRuleSeed,
  wireM36DeliveryTenancy,
} from "./modules/36-messaging/index";
import { countHoldOverlayMessages } from "./modules/36-messaging/jobs/retention-hold-sql";
import { createMentionActorNameResolver } from "./modules/36-messaging/mention-non-member-service-db";
import {
  channelHintAudience,
  endChannelMembershipsForUser,
  setCareTeamChannelArchived,
} from "./modules/36-messaging/messaging-provider-db";
import { createMessageBodyCipher } from "./modules/36-messaging/messaging-write-core";
import {
  buildM36AccessRevocationConsumer,
  buildM36AccessRevocationPlatformConsumer,
  combineReassignments,
} from "./modules/36-messaging/outbox-consumers/access-revocation";
import { buildM36AckDeliveryFailureConsumer } from "./modules/36-messaging/outbox-consumers/ack-delivery-failure";
import { buildM36AckEscalationNotificationsConsumer } from "./modules/36-messaging/outbox-consumers/ack-escalation-notifications";
import { buildM36AckNotificationsConsumer } from "./modules/36-messaging/outbox-consumers/ack-notifications";
import { buildM36AckTimerArmingConsumer } from "./modules/36-messaging/outbox-consumers/ack-timer-arming";
import { buildM36AckUnreachableNotificationsConsumer } from "./modules/36-messaging/outbox-consumers/ack-unreachable-notifications";
import { buildM36AdmissionComplianceAlertConsumer } from "./modules/36-messaging/outbox-consumers/admission-compliance-alerts";
import { buildM36AmendmentSlaAlertConsumer } from "./modules/36-messaging/outbox-consumers/amendment-sla-alerts";
import { buildM36BreakGlassNotificationsConsumer } from "./modules/36-messaging/outbox-consumers/break-glass-notifications";
import { buildM36CapThresholdAlertConsumer } from "./modules/36-messaging/outbox-consumers/cap-threshold-alerts";
import { buildM36ChannelMembershipSyncConsumer } from "./modules/36-messaging/outbox-consumers/channel-membership-sync";
import { buildM36EmarAlertConsumer } from "./modules/36-messaging/outbox-consumers/emar-alerts";
import { buildM36ExportNotificationsConsumer } from "./modules/36-messaging/outbox-consumers/export-notifications";
import { buildM36FeedHealthAlertConsumer } from "./modules/36-messaging/outbox-consumers/feed-health-alerts";
import { buildM36FieldSafetyAlertConsumer } from "./modules/36-messaging/outbox-consumers/field-safety-alerts";
import { buildM36HandoffNotificationsConsumer } from "./modules/36-messaging/outbox-consumers/handoff-notifications";
import { buildM36IpuAlertConsumer } from "./modules/36-messaging/outbox-consumers/ipu-alerts";
import { buildM36IpuIvAlertConsumer } from "./modules/36-messaging/outbox-consumers/ipu-iv-alerts";
import { buildM36ConsentRevokedConsumer } from "./modules/36-messaging/outbox-consumers/m39-consent-revoked";
import { buildM36MedicationQuestionNotificationsConsumer } from "./modules/36-messaging/outbox-consumers/medication-question-notifications";
import { buildM36MessageHintConsumer } from "./modules/36-messaging/outbox-consumers/message-hints";
import { buildM36MessageMentionConsumer } from "./modules/36-messaging/outbox-consumers/message-mentions";
import { buildM36OncallAlertConsumer } from "./modules/36-messaging/outbox-consumers/oncall-alerts";
import { buildM36PatientLifecycleReviewConsumer } from "./modules/36-messaging/outbox-consumers/patient-lifecycle-review";
import { buildM36PromotionNotificationsConsumer } from "./modules/36-messaging/outbox-consumers/promotion-notifications";
import { buildM36PromotionOutcomesConsumer } from "./modules/36-messaging/outbox-consumers/promotion-outcomes";
import { buildM36QualityAlertConsumer } from "./modules/36-messaging/outbox-consumers/quality-alerts";
import { buildM36ScheduleBlockedConsumer } from "./modules/36-messaging/outbox-consumers/schedule-blocked";
import { buildM36TaskNotificationsConsumer } from "./modules/36-messaging/outbox-consumers/task-notifications";
import { buildM36UrgentNotificationsConsumer } from "./modules/36-messaging/outbox-consumers/urgent-notifications";
import { bindTransactionalEmail } from "./modules/36-messaging/transactional-email-binding";
// M37 (Inpatient Unit / IPU Management) boot surface — the §4.7 ABAC predicates, the §4.4 outbox catalog,
// and the §4.1 core route mount over the Drizzle route service. The write path emits `m37.*` through the
// bound transactional-outbox publisher. (The remaining §4.1 routes + §7.7 eraser + SeamRegistry extend this.)
import {
  type IpuAiPromptRegistryPort,
  M37_OUTBOX_EVENTS,
  M37_PLATFORM_JOB_ID,
  buildDrizzleIpuRouteService,
  buildDrizzleLcpAdmissionLookup,
  buildM37AdmissionDischargedConsumer,
  buildM37DeathRecordedConsumer,
  buildM37IvOverlayOnOrderEndedConsumer,
  buildM37IvOverlayOnOrderSignedConsumer,
  buildM37LcpActivatedConsumer,
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
  registerM37IvBedsideWorker,
  scheduleM37IvBedsideWatchdog,
  scheduleM37Jobs,
  validateIpuAIBlock,
  wireM37Tenancy,
} from "./modules/37-ipu/index";
import { inpatientFacilityIdsForPeriodsForOrg } from "./modules/37-ipu/seams/inpatient-facilities-for-periods-for-org";
import { restraintAdmissionSitingForOrg } from "./modules/37-ipu/seams/restraint-admission-siting-for-org";
import {
  M38_PLATFORM_JOB_ID,
  type PlatformS3Slice,
  buildTerminologyProducer,
  carePlanCodeUsageProducer,
  createDbEmbeddingStore,
  createDbExpansionWriter,
  createDbLoaderStore,
  createDbTerminologyOpsStore,
  createDbTerminologyStore,
  createDrizzleTerminologyEraseStore,
  createPlatformObjectPort,
  createPlatformUploadSigner,
  mountTerminologyRoutes,
  registerM38Workers,
  registerTerminologyAbacPredicates,
  registerTerminologyErasers,
  registerTerminologySeams,
  scheduleM38Jobs,
} from "./modules/38-terminology/index";
import { createBereavementOutreachConsentProbe } from "./modules/39-consent/bereavement-outreach-consent-probe";
import {
  type M39AlertPort,
  M39_OUTBOX_EVENTS,
  M39_PLATFORM_JOB_ID,
  buildM39ConsentRenderConsumer,
  buildM39PatientDeceasedConsumer,
  buildM39PatientMergedConsumer,
  buildM39WorkerDeps,
  createConsentInternalNotesCipher,
  createDbConsentStore,
  createDrizzleConsentEraseStore,
  getConsentEvaluator,
  getConsentPatientReader,
  mountConsentRoutes,
  recordCascadeAckForOrg,
  registerConsentAbacPredicates,
  registerConsentErasers,
  registerConsentSeams,
  registerM39CronWorkers,
  scheduleM39Jobs,
  wireM39Tenancy,
} from "./modules/39-consent/index";
import { buildPart2ConsentStateReader } from "./modules/39-consent/part2-consent-state-reader";
import {
  type M40AlertPort,
  M40_OUTBOX_EVENTS,
  M40_PLATFORM_JOB_ID,
  buildM29NppesPlatformConsumers,
  createDbBaaStore,
  createDbMdmStore,
  createDbNppesNpiSource,
  createDrizzleMdmEraseStore,
  facilityKindsForIds,
  facilityPostalCodesForIds,
  getMdmEntityProvider,
  mountMdmRoutes,
  registerM40CronWorkers,
  registerMdmAbacPredicates,
  registerMdmErasers,
  registerMdmSeams,
  scheduleM40Jobs,
  wireM40Tenancy,
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
     * from `chartwarden_app` (#105). Absent ⇒ the key provider refuses with a stated reason.
     */
    platformDb?: DbClient;
    /** The catalog-validating tx outbox publisher (TASK-002) — the M5 PatientMutator's §4.6
     * `m5.patient.updated` emit rides it. Absent on slice/test boots (mutator stays in-memory). */
    outboxPublisher?: OutboxPublishPort;
    /** F-165 (#248, m24 group) — the dedicated Redis/Valkey client M5's `CaseloadStore` shift-assignment cache
     * reads/writes through. Absent on slice/test boots (no `queueConnection`) or when Redis is
     * unconfigured; `CaseloadStore` then stays Phase-1 (`patient_assignment` alone). */
    caseloadShiftCacheRedis?: Redis | null;
    /** WP 3.7 - the ONE message-body cipher the messaging provider and the chart-promotion snapshot reader share. */
    messageBodyCipher?: ReturnType<typeof createMessageBodyCipher>;
    /** Told how many orgs the real M19 EscalationRouter was bound for (0 when none), so the boot probe in `bootChartWarden` can stay quiet about the deny-stub. */
    onEscalationRouterBound?: (boundOrgCount: number) => void;
    /** WP 3.7 - the chart-promotion reader M8 and M14 show their reviewer (M36's binding). Absent => fail-closed deny-stub. */
    promotionSource?: ChartPromotionSourceReader;
  } = {},
): void {
  // AUTH-T05b: pass the DB-backed SessionContextStore in production (composition root supplies it when
  // a DB client is present); the slice/tests fall back to M2's in-memory store.
  registerIdentitySeams({
    sessions: deps.sessionContextStore,
    db: deps.db,
    organizationDb: deps.organizationDb,
    // GAP-006 — the tenant-provisioning confirm also materializes the org's roles (M3's writer, injected: M2 may
    // not import M3). Runs on the tenant pool under the new org's RLS scope, never the platform pool.
    ...(deps.db
      ? {
          onTenantOrganizationAvailable: async (organizationId: string) => {
            await materializeRoleTemplatesForOrg(deps.db as DbClient, organizationId);
            // Platform-ops operators join the new org (self-only `platform_alert_audience`) so `role_set` alerts reach them.
            await bindPlatformStaffToOrg(deps.db as DbClient, organizationId);
          },
        }
      : {}),
  }); // M2 — SessionContextResolver + AuditorSessionMinter + TenantOrgCreationProvider (§4.7 / M34 §7.1)
  // M3 — register the live RBAC resolver (DB-backed effective permissions) when a DB client is present,
  // turning `requirePermission` from fail-closed to real resolution. Slice/tests keep the default.
  // TASK-004 — the handle is CAPTURED so the M3 route mount binds the SAME resolver + §2.5
  // invalidation cache for /me/permissions, anti-escalation, and grant/revoke cache drops.
  if (deps.db) liveRbacHandle = registerDbEffectivePermissionResolver(deps.db);
  // M3 — SupervisorReader (membership location scope + derived supervision) for M33/M36; deny-stub without a db.
  registerAuthorizationSeams({ db: deps.db });
  // M3 — register M3's own `step_up_recent` ABAC predicate (§4.2.1 — the step-up freshness gate every
  // `requireStepUp` route resolves through). It reads M2's SessionContextResolver seam (registered just
  // above) lazily at request time, so registration order only requires the seam present by first request.
  registerAuthorizationAbacPredicates();
  // M38 — TerminologyProvider (§4.5). Production backs it with the Drizzle store over the real M38
  // tables (FB-T01); slice/tests keep the in-memory default.
  registerTerminologySeams(deps.db ? { store: createDbTerminologyStore(deps.db) } : {});
  // M36 — AlertEmitter (§4.6): GAP-096 — the real Drizzle-backed T04 resolution/fan-out engine binds
  // over a DB client; slice/tests keep the in-memory default (createInMemoryAlertEmitter). The
  // DB-backed MessagingProvider (§4.6 channel/message CRUD with per-tenant DEK encryption) registers
  // over the deny-stub when a DB client is present too (FB-T05).
  registerMessagingSeams(
    deps.db
      ? {
          // GAP-057 — M34's two recipient resolvers are registered onto the emitter's registry here (M36
          // cannot import M34); without this every rule naming them would throw/never deliver.
          emitter: createDrizzleAlertEmitter(deps.db, {
            // WP 4.6 (ADR-0073): the notification policy's flag gate (default off per tenant).
            flags: createDrizzleFeatureFlagReader(deps.db),
            extendResolvers: m34ResolverExtension(
              createDrizzleM34AlertResolverPorts(deps.db, {
                roleSetMembers: createDrizzleRoleSetMembersReader(deps.db),
              }),
            ),
          }),
          provider: createDbMessagingProvider(deps.db, {
            ...(deps.outboxPublisher
              ? { outbox: bindCallerModule(deps.outboxPublisher, "m36") }
              : {}),
            ...(deps.messageBodyCipher ? { cipher: deps.messageBodyCipher } : {}),
          }),
          ...(deps.promotionSource ? { promotionSource: deps.promotionSource } : {}),
          // WP 6.2 (ADR-0110): aggregate response analytics for M33's route; the tenant flag is read per call.
          responseAnalytics: createResponseAnalyticsReader({
            db: deps.db,
            flags: createDrizzleFeatureFlagReader(deps.db),
          }),
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
          db: deps.db,
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
          // F-165 (#248, m24 group) — the shift-assignment Valkey cache is unioned in additively ONLY when a
          // dedicated Redis client is configured; a slice/test boot (or Redis genuinely unconfigured)
          // keeps the Phase-1 `patient_assignment`-only store.
          caseload: {
            store: deps.caseloadShiftCacheRedis
              ? createCaseloadStoreWithShiftCache(
                  createDrizzleCaseloadStore(deps.db),
                  deps.caseloadShiftCacheRedis,
                )
              : createDrizzleCaseloadStore(deps.db),
          },
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
    deps.db ? { db: deps.db, store: createDrizzleAdmissionReaderStore(deps.db) } : {},
  );
  // M7 — the §7.8 CarePlanReader (encounter-relevance picker + the 5-/15-day overdue sign-gate M8
  // consumes). Slice/tests keep the in-memory store + real clock; the Drizzle-backed store lands with
  // M7's routes/repos (M7-T05+).
  // TASK-002 — CarePlanReader binds the full Drizzle store on a db boot (SUD/D7 redaction resolves
  // the M39 ConsentEvaluator lazily, fail-closed).
  registerCarePlanSeams(deps.db ? { store: createDrizzleCarePlanReaderStore(deps.db) } : {});
  // M8 — the four §4.7 owned seams (billable/signed/mileage/creator). M8 also CONSUMES M7's CarePlanReader
  // (registered just above) for the encounter authoring picker + the overdue sign-gate. Slice/tests keep
  // the in-memory store; the Drizzle-backed store lands with M8's routes/repos (M8-T09+).
  // M8 — back the §4.7 reader seams with the Drizzle store when a db is present (#107): the live
  // SignedEncountersReader.signedEncountersForPatientSince over the real encounter table (the prior in-memory
  // default returned empty, zeroing M30's HVLDL numerator). Slice/tests keep the in-memory store.
  // GAP-069 — the store's render / mileage / draft-insert are real (no in-memory fallback). The draft insert
  // emits `m8.encounter.created` through the same caller-bound publisher the route service uses, and the
  // pinned narrative opens through the lazily-resolved tenant key ring (M34 binds after the seams wire).
  registerEncounterSeams(
    deps.db
      ? {
          store: createDrizzleEncounterReaderStore(deps.db, {
            ...(deps.outboxPublisher
              ? { outbox: bindCallerModule(deps.outboxPublisher, "m8") }
              : {}),
            narrativeCipher: createHearthnoteCiphers(lazyTenantKeys(getTenantKeyProvider))
              .narrative,
          }),
          db: deps.db,
        }
      : {},
  );
  // M9 — the two §4.7 / D7 owned seams (LatestAssessmentProvider + ScaleSeriesProvider) M7/M10/M14/M28/M32
  // consume for latest-scale reads + trend series/deltas. Slice/tests keep the in-memory store; the
  // Drizzle-backed store lands with M9's routes/repos (M9-T05+).
  // TASK-002 — LatestAssessmentProvider + ScaleSeriesProvider bind the Drizzle store on a db boot.
  // KNOWN GAP (agent finding): the M9 route write path never populates provider_entity_id/location_id,
  // so a route-recorded row's latest-read throws AssessmentSeamDataGapError until the write path sites
  // captures — loud, never a fabricated context.
  registerAssessmentSeams(deps.db ? { store: createDrizzleAssessmentReaderStore(deps.db) } : {});
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
    providerEntities: deps.db ? buildOrgProviderEntityLister(deps.db) : undefined,
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
  registerOrderSeams(deps.db ? { store: createDrizzleOrderSeamStore(deps.db) } : {});
  // M12 — the two §2.10 D17 owned READ seams (MedicationOrderProvider — the medication-order read path M13
  // (eMAR administration context) / M14 / M19 / M28 (FHIR) / M30 / M31 (portal) / M33 consume — + RefillInboxProvider
  // — the refill-inbox read path the prescriber UI + M19/M33 consume). Slice/tests keep the in-memory store;
  // the Drizzle-backed store lands with M12's routes/repos (M12-T08+).
  // TASK-002 — MedicationOrderProvider + RefillInboxProvider bind the Drizzle store on a db boot
  // (D14 allowlist sig projection; the cost-basis + comfort-kit rollups REFUSE with
  // M12_SEAM_SCHEMA_GAP — no cost column / not M12's table — never a fabricated $0 or "no kit").
  registerDoseSpotSeams(
    deps.db ? { store: createDrizzleDoseSpotSeamStore(deps.db), db: deps.db } : {},
  );
  // M13 — the two §2.12 D16 owned READ seams (MedicationAdministrationProvider — the administration read path M14
  // (IDG "administrations since last meeting") / M28 (FHIR) / M30 (PRN-effectiveness / missed-dose /
  // comfort-kit-timeliness measures) / M31 (portal summary) / M33 (dashboards) / M37 (IPU IV-pump overlay)
  // consume — + ReconciliationProvider — the reconciliation-worksheet read path M14/M30 consume). Slice/tests
  // keep the in-memory store; the Drizzle-backed store lands with M13's routes/repos (M13-T08+).
  // TASK-002 — MedicationAdministrationProvider + ReconciliationProvider bind the full Drizzle
  // store on a db boot (12/12 methods; §3.6 free-text denylist keys scrubbed from `data`).
  registerEmarSeams(deps.db ? { store: createDrizzleEmarSeamStore(deps.db) } : {});
  // M14 — the three §4.8 owned READ seams (IdgPacketProvider — the packet-snapshot + M22 render handshake M22
  // (minutes / packet PDF) + M33 consume — + IdgDecisionProvider — the decision read path M30
  // (decision-to-careplan-update latency) + M33 consume — + IdgScheduleProvider — the meeting-schedule +
  // 15-day-cadence read path M28 (FHIR) + M30 (cadence-adherence) + M33 consume). Slice/tests keep the
  // in-memory store; the Drizzle-backed store lands with M14's routes/repos (M14-T05+).
  // TASK-002 — the three IDG providers bind the full Drizzle store on a db boot.
  // `decisionsForCarePlan` reads the migration-0155 `idg_decision.care_plan_id` link (populated at
  // record time via M7's CarePlanReader; a NULL link honestly never matches — task-11 closed the gap).
  registerIdgSeams(deps.db ? { store: createDrizzleIdgSeamStore(deps.db) } : {});
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
  // `unavailable` until the nightly aggregator persists a resolved staff denominator — never a fabricated 0% breach).
  registerDisciplinePlanSeams(
    deps.db
      ? {
          store: createDrizzleDisciplinePlanSeamStore(deps.db),
        }
      : {},
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
  registerBereavementSeams(deps.db ? { store: createDrizzleBereavementSeamStore(deps.db) } : {});
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
    volunteerGatesSatisfied: async ({ organizationId, volunteerMembershipId }) => {
      try {
        const status = await getSeam("VolunteerComplianceProvider").effectiveStatusFor(
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
    deps.db ? { store: buildDrizzleSuppliesSeamStore(deps.db), db: deps.db } : {},
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
  const oncallSeamStore = deps.db ? buildDrizzleOncallSeamStore(deps.db) : undefined;
  if (oncallSeamStore) registerOncallSeams({ store: oncallSeamStore });
  // ADR-0057 item 12 - the real M19 EscalationRouter (tier 1 only), UNBOUND unless `ESCALATION_ROUTER_ORGS` names orgs. Other orgs keep the
  // deny-stub's exact answer; with the variable empty nothing is registered and behaviour is identical to before.
  let m19RouterBoundOrgCount = 0;
  if (deps.db && oncallSeamStore) {
    m19RouterBoundOrgCount = registerEscalationRouterForAllowlist({
      store: oncallSeamStore,
      reads: buildDrizzleEscalationRouterReads({
        db: deps.db,
        patientReader: () => getSeam("PatientReader"),
        siteReader: buildFoundationSiteReader(),
        listProviderEntityIds: buildOrgProviderEntityLister(deps.db),
      }),
      fallback: escalationRouterDenyStub,
      allowlistRaw: process.env.ESCALATION_ROUTER_ORGS,
      warn: (message) => console.warn(message),
    }).size;
  }
  deps.onEscalationRouterBound?.(m19RouterBoundOrgCount);
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
      // GAP-060 — §8.6 coordinate decipher over the same per-tenant DEK envelope M20's write path seals with.
      decipher: createCoordinateDecipher(
        createSafetyCiphers(lazyTenantKeys(getTenantKeyProvider)).decipher,
        () => getRequestContext()?.organizationId,
      ),
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
    const portalStore = buildDrizzlePortalStore(
      deps.db,
      undefined,
      buildPortalDisclosureReader(deps.db),
    );
    registerM31PublishedSeams({ registerSeam }, createM31PublishedSeamImpls(portalStore));
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
  // compliance breakdowns — the route service's UI-003 hardcode was NOT copied).
  // GAP-133 — the coordinate-bearing `EvvLocationProvider` reads open the §D10 per-tenant DEK envelope over
  // M34's key ring (resolved lazily: M34 binds it after the seams are wired).
  registerEvvSeams(
    deps.db
      ? { store: createDrizzleEvvSeamStore(deps.db, { coordsCipher: m18CoordsCipher() }) }
      : {},
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
  // F-197 (#248) — `portalConsent:` was NEVER passed here, even when `deps.db` is present, so it silently
  // fell back to `registerDocumentSeams`'s in-memory default in every real deployment — `DocumentSeamDeps`'s
  // own doc comment always said "M39 ConsentEvaluator in prod," but no production call site ever supplied
  // one. Mirrors `registerConsentSeams`'s own adjacent, already-correct pattern immediately below: a
  // real seam-backed port when `deps.db` is present, the in-memory default only in the slice/tests.
  const s3Config = deps.db ? s3ObjectStoreConfigFromEnv(process.env) : null;
  registerDocumentSeams(
    deps.db
      ? {
          store: createDrizzleDocumentSeamStore(deps.db),
          readers: createDrizzleDocumentReaderStore(deps.db),
          objects: s3Config ? createS3ObjectStore(s3Config) : createRefusingObjectStore(),
          portalConsent: createSudConsentEvaluatorPortalConsentPort(),
          // F-225 (#248) — the portal mint's §164.528 `document_access_log` append.
          portalAccessLog: createDrizzlePortalAccessLog(deps.db),
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
  // The team/location reach behind `reportable_scope` STAYS fail-closed, on purpose: M3 now registers a
  // `SupervisorReader` seam, but no consumer reads it yet, and `resolveSupervisedMembershipIds` stays a
  // deny-stub until the supervision definition is tightened (the grant's scope is ignored, and locations
  // come from the membership's default_location_ids). Until then every actor lacking org-wide authority
  // resolves to `self`, the narrowest scope.
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
  // M40 — the platform-only ABAC conjunct (`mdm_admin_platform_ops`) on `/api/v1/admin/mdm/*` (GAP-172):
  // role-only, no DB handle; M40's OWN name because the registry is single-owner per name.
  registerMdmAbacPredicates();
  // M33 — register the platform job id on the @chartwarden/tenancy allowlist so the §4.8 platform-scoped
  // workers (the on-PRIMARY MV refresh, the lag probe, the tenant eraser) may enter withPlatformContext
  // (the allowlist starts empty → fail-closed). The M34 `wireM34Tenancy` precedent.
  wireM33Tenancy();
  // M30 — register M30's platform job id on the @chartwarden/tenancy allowlist so the §4.8 cron fan-outs
  // (nightly recompute / monthly CAHPS sample / daily risk-register refresh / SRA reminders) may enter
  // withPlatformContext to enumerate active orgs (the allowlist starts empty → fail-closed). Prerequisite
  // for the cron fan-out; inert until the M2 active-org enumerator binds (issue #107, item 5). The
  // wireM33Tenancy / wireM34Tenancy precedent.
  wireM30Tenancy();
  wireM26Tenancy(); // GAP-076 — allowlist the cron job id so the cap crons may enter withPlatformContext
  wireM23Tenancy(); // M23 — allowlist the cron job id so the NOE/NOTR window-watch + eligibility stale-watch fan-outs may enter withPlatformContext
  wireM25Tenancy(); // M25 — allowlist the cron job id so the denial-aging/appeal-deadline fan-outs may enter withPlatformContext
  wireM24Tenancy(); // F-172 (#248, m1 group) — allowlist the cron job id so state-channel-health may enter withPlatformContext
  wireM27Tenancy(); // M27 (WX-PR-013) — allowlist the cron job id so filing-deadline-scan may enter withPlatformContext
  wireM29Tenancy(); // F-175 (#248) — allowlist the cron job id so the outbound-dispatch retry sweep may enter withPlatformContext
  wireM36DeliveryTenancy(); // GAP-101 — allowlist the M36 send_* delivery-sweep job id (withPlatformContext org enumeration)
  wireM31Tenancy(); // F-222 (#248) — allowlist the cron job id so the post-discharge-grace sweep may enter withPlatformContext
  // TASK-040D — allowlist M7/M9/M10's cron platform job ids (same fail-closed posture as M25/M30/M33/M34).
  wireM6Tenancy();
  wireM7Tenancy();
  wireM9Tenancy();
  wireM10Tenancy();
  wireM13Tenancy(); // GAP-038/039/040 — allowlist the cron job id so the M13 §4.8 crons may enter withPlatformContext
  wireM14Tenancy(); // GAP-092 — allowlist the cron job id so idg.review-clock-sweep may enter withPlatformContext
  wireM16Tenancy(); // GAP-048 — allowlist the cron job id so the 13-month close / miss-deadline / anniversary-lookahead fan-outs may enter withPlatformContext
  wireM28Tenancy(); // GAP-084 — allowlist the cron job id so the M28 §4.8 sweepers may enter withPlatformContext
  registerPlatformJob(M38_PLATFORM_JOB_ID); // GAP-108 — the M38 tenant_deprecation_scan fan-out's active-org enumeration
  wireM20Tenancy(); // F-111 (#249) — allowlist the cron job id so the SOS SLA watchdog may enter withPlatformContext
  wireM40Tenancy(); // GAP-173 — allowlist the M40 scan job id so the §4.3 BAA-expiration cron may enter withPlatformContext
  wireM39Tenancy(); // F-216 — allowlist the cron job id so the consent expiration/reminder crons may enter withPlatformContext
  registerPlatformJob(M11_PLATFORM_JOB_ID);
  registerPlatformJob(M11_VERBAL_TIMER_PLATFORM_JOB_ID); // §2.3 D3 — the verbal-order-expiry hourly sweep fan-out
  registerPlatformJob(M11_ORDER_SWEEPS_PLATFORM_JOB_ID); // GAP-032 — verbal pre-expiry / lab-results-overdue / completion-watcher org enumeration
  registerPlatformJob(M11_STUCK_TRANSMISSION_PLATFORM_JOB_ID); // F-201 — the stuck lab-order recovery tick's org enumeration
  registerPlatformJob(M22_FORM_RENDER_PLATFORM_JOB_ID); // GAP-140 — the form-render worker's org enumeration
  registerPlatformJob(M22_RETENTION_ROTATION_PLATFORM_JOB_ID); // GAP-141 — the retention-rotation sweep's org enumeration
  registerPlatformJob(M22_RECORDS_REQUEST_EXPIRY_PLATFORM_JOB_ID); // F-238 — the hourly records-request expiry sweep's org enumeration
  wireAdmittingGrantExpiryTenancy(); // M5 — the admitting-grant expiry sweep's org enumeration
  wireAmendmentSlaTenancy(); // GAP-118 — M5 §4.5 amendment SLA scan's org enumeration
  registerPlatformJob(M5_SNAPSHOT_REBUILD_PLATFORM_JOB_ID); // M5 §4.5 — the quarterly privacy-snapshot rebuild's org enumeration
  wireM12Tenancy(); // F-164 (#248) — allowlist the cron job id so the dosespot_sync_queue drain may enter withPlatformContext
  wireM19Tenancy(); // F-155 (#248) — allowlist the cron job id so the on_call_roster_sync_queue drain + catch-up-seed workers may enter withPlatformContext
  // F-071/#174 — allowlist M37's cron job id so ipu.rn-coverage-watchdog may enter withPlatformContext.
  // Without the watchdog nothing ever wrote `ipu_rn_coverage_window`, and the four write paths that read
  // it treat an absent row as uncovered — so every GIP and respite admission was refused at open.
  wireM37Tenancy();
  // F-033/#93 — allowlist the platform partition-rotation job. Unlike the module crons above this one
  // belongs to no module: the 43 time-RANGE tables it keeps ahead are spread across ~20 modules and no
  // module can see the others', so it is registered here with them rather than from a module wiring file.
  wirePartitionRotationTenancy();
  // GAP-113 / GAP-117 — the M1 idempotency.cleanup sweeper and the M3 reap_breakglass cron fan out over the
  // active orgs through the audited platform pool, so both job ids must be allowlisted.
  wireIdempotencyCleanupTenancy();
  wireM3ReaperTenancy();
  wireAuditArchiveTenancy(); // GAP-113 — the audit.archive job reads every tenant's closed audit partitions
  // M34 — the 8 §4.6 ABAC predicate resolvers (the platform-ops tenant surface gates on
  // `tenant_lifecycle_platform_ops`, role-only; `dsar_export_*` composes the M5 CaseloadProvider seam,
  // registered above). GAP-098: on a DB boot the grant/session/flag/onboarding-task facts resolve through the
  // Drizzle resolver (platform-scoped, audited); support sessions and flag writes are gated on them. Without a
  // platform credential the fail-closed slice resolver stands, so those routes deny rather than fail open.
  registerTenantPlatformAbacPredicates({
    resolver:
      deps.db && deps.platformDb
        ? buildDrizzleTenantPlatformAbacResolver({
            db: deps.db,
            platformDb: deps.platformDb,
            auditBypass: m34PlatformBypassAuditor,
            loadFlagRows: createDrizzleFeatureFlagScopeLoader(deps.platformDb),
          })
        : SLICE_M34_ABAC_RESOLVER,
  });
  // M34 (Phase 2D) — register M34's platform job id on the @chartwarden/tenancy allowlist (the allowlist starts
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
  // F-236 (ADR-0048) — the pipeline is now BUILT when this deployment configures at least one model
  // backend (OLLAMA_* / ANTHROPIC_*, see 32-ai-platform/backends/config.ts) and has both credentials. The
  // blocker named above — the per-tenant DEK cipher — exists (M34's key provider, resolved lazily because
  // M34 registers it further down). Building it makes a governed call POSSIBLE, not active: `ai.full`
  // stays OFF for every tenant, the DocLens capabilities stay at DESIGN_REVIEW, and every other gate still
  // runs. No backend configured ⇒ exactly the previous posture (registry only, inference deny-stubs). A
  // MALFORMED AI configuration throws here — a deployment that asked for a backend and silently got none
  // would read as "AI is off" when it is "AI is misconfigured".
  const m32Backends = buildConfiguredModelBackends(aiBackendConfigFromEnv(process.env));
  // GAP-161 - the seam-side stores publish the same `m32.*` events through the catalog-validating publisher.
  const wiredM32Events = deps.outboxPublisher
    ? createM32EventEmitter(bindCallerModule(deps.outboxPublisher, "m32"))
    : undefined;
  const m32PromptRegistry = deps.db
    ? createAiPromptRegistry({
        store: createDrizzleAiPromptTemplateStore({
          db: deps.db,
          platformDb: deps.db,
          auditBypass: m34PlatformBypassAuditor,
          jobId: M32_PLATFORM_JOB_ID,
          events: wiredM32Events,
        }),
        // F-236 — templates are reviewed files in the repo (packages/ai-platform/prompts), pinned by hash
        // on their `ai_prompt_template` row; the registry refuses a body whose hash drifted.
        artifacts: createFilesystemAiPromptArtifactReader(
          process.env.AI_PROMPT_ROOT ?? process.cwd(),
        ),
      })
    : undefined;
  registerAiPlatformSeams(
    deps.db
      ? {
          ...(m32PromptRegistry ? { promptRegistry: m32PromptRegistry } : {}),
          ...(deps.platformDb && m32Backends.length > 0
            ? {
                pipeline: buildLiveAiInvocationPipeline({
                  db: deps.db,
                  platformDb: deps.platformDb,
                  auditBypass: m34PlatformBypassAuditor,
                  keys: {
                    dekForOrg: (orgId) => getTenantKeyProvider().dekForOrg(orgId),
                    dekForOrgVersion: (orgId, version) =>
                      getTenantKeyProvider().dekForOrgVersion(orgId, version),
                  },
                  flags: createDrizzleFeatureFlagReader(deps.db),
                  backends: m32Backends,
                  events: wiredM32Events,
                }),
                actors: createDrizzleAiSeamActorResolver(deps.db),
                projector: createDocLensOutputProjector(),
              }
            : {}),
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
          // F-236 — the SAME registry instance the seams publish (the comment above's own requirement;
          // it used to build a second one).
          promptRegistry: m32PromptRegistry as NonNullable<typeof m32PromptRegistry>,
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
  registerM29PublishedSeams(deps.db ? { store: createDrizzleM29PublishedSeamStore(deps.db) } : {});
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
            isInCaseload: (input) => getSeam("CaseloadProvider").isInCaseload(input),
          },
        })
      : denyStubM29AbacResolver,
  });
  // M34 — register the PACKAGE-OWNED seams (the D5 `TenantKeyProvider` + the lifecycle/onboarding/support/
  // export-shard publishes). These live in `@chartwarden/saas-tenant-platform`'s own registry (M1 imports the
  // `TenantKeyProvider` interface, so the live-impl home is the package, not the M1 registry).
  // `validateModule34Seams()` HARD-FAILS boot if the mandatory `TenantKeyProvider` is absent (D5) — so the
  // platform never serves a request whose PHI ciphertext it cannot key. Phase 2D: when a DB client is
  // present, `registerLiveM34Seams` binds the REAL Drizzle-backed providers (lifecycle/onboarding/support
  // reads over the §3 repos under withOrgContext/withPlatformContext + the D5 key provider over the real
  // key-ring repo + the platform-KEK unwrap port, bound from `M34_TENANT_KEK` (#105 / ADR-0045), or the
  // provision gateway as the fallback). Without a DB client (tests / no-db boot) the fail-closed slice key
  // provider keeps boot green.
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
      // NOT `deps.db`: migration 0052 §5 revokes chartwarden_app's SELECT on tenant_key_ring, so the request
      // path's credential cannot read a wrapped DEK at all. The platform login holds the grant.
      keyRingDb: deps.platformDb,
    });
  } else {
    bootstrapModule34(SLICE_MODULE_34_SEAM_DEPS);
  }
  validateModule34Seams();
  // M36 WP 2.13 / ADR-0058 P1 — message bodies sealed under the tenant ring DEK resolve it through M34's provider.
  // Bound lazily (resolved per use) so a DB-less slice boot keeps the fail-closed deny provider: a ring body then fails
  // to open rather than falling back to anything. M36 cannot import M34 (M34 dependsOn M36); this is the one binding.
  setMessageBodyKeyProvider(() => getTenantKeyProvider());
  assertM36BodyBootEnv(process.env); // a M36_BODY_SEAL_SCHEME typo, or ring without the KEK / platform pool, stops the boot
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
 * M34 `platform.bypass_invoked` auditor (audit #9). M1's @chartwarden/tenancy requires a `PlatformBypassAuditor`
 * for EVERY `withPlatformContext` entry, so "every cross-tenant read is audited" is a type-level guarantee.
 * This binds M4's PLATFORM-SCOPED audit helper over the platform tx the bypass runs on: it writes one
 * `platform.bypass_invoked` row (organizationId null — a cross-tenant action has no single org; actorKind
 * `system`; the caller's jobId + reason in context) at the event's own severity, atomically with the platform
 * work. If the write fails it propagates, so the cross-tenant read fails rather than serving an UNAUDITED
 * bypass (the fail-closed posture).
 *
 * Uses `auditPlatformEvent` (NOT the plain `audit()` helper, WX-PR-024): `audit()`'s `tx.insert(...)` runs as
 * the caller's own role — `chartwarden_app` in production — which holds no INSERT policy admitting a null-org
 * `audit_event` row (ADR-0010 bans a policy shaped to allow it). `auditPlatformEvent` instead calls the
 * SECURITY DEFINER `audit_writer_insert_platform_event` function (migration 0187), so this write actually
 * succeeds under real RLS instead of throwing on every `withPlatformContext` entry codebase-wide.
 */
export const m34PlatformBypassAuditor: PlatformBypassAuditor<DbClient> = async (tx, event) => {
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
 * Fail-closed slice resolver for M34's §4.6 ABAC predicates, used only when the boot has no DB or no
 * platform credential. Every owner-fact load denies (returns null/false). The DB boot binds the Drizzle
 * resolver instead (GAP-098).
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
     * chartwarden_destruction, migration 0157). The append-only clinical/billing tables grant
     * chartwarden_app no DELETE, so per-patient erase stores bind THIS pool when present; absent, they
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
  // clinical/billing tables (M7–M13, M23, M25) grant chartwarden_app no DELETE — the erase path needs
  // the destruction-granted credential at deployment; M4's performErasure throws typed-UNBOUND
  // (audit_event is HELPER_ONLY + append-only — the crypto-erase adapter lands in packages/audit);
  // M36's sole-tenant-user leg refuses without a platform membership enumerator (D9 is an
  // inherently cross-tenant read); M40's provisional DELETE awaits its grant.
  const db = deps.db;
  // Privileged erase pool: the destruction credential when provisioned, else the tenant pool
  // (whose missing DELETE grants make the erase fail loudly — the honest interim).
  const eraseDb = deps.destructionDb ?? db;
  registerIdentityErasers(db ? { store: createDrizzleIdentityEraserStore(db) } : {}); // M2 — `identity`
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
  registerTerminologyErasers(eraseDb ? { store: createDrizzleTerminologyEraseStore(eraseDb) } : {}); // M38
  // M36 — the D9 sole-tenant-user leg resolves through the audited platform-context membership
  // read when the platform credential is present; without it that ONE leg keeps its typed refusal.
  registerMessagingErasers(
    db
      ? {
          store: createDrizzleMessagingEraseStore(eraseDb ?? db, {
            // WP 1.5: the attachment bytes live in the tenant's MinIO bucket; the structural erase destroys them
            // BEFORE it deletes the rows that point at them (the refusing port, when MINIO_* is unset, throws).
            attachmentStorage: buildM36AttachmentStorage(process.env),
            ...(deps.platformDb
              ? {
                  soleTenantUserIds: buildSoleTenantUserResolver({
                    platformDb: deps.platformDb,
                    auditBypass: m34PlatformBypassAuditor,
                    jobId: M36_SOLE_TENANT_JOB_ID,
                  }),
                }
              : {}),
          }),
        }
      : {},
  );
  registerMdmErasers(eraseDb ? { store: createDrizzleMdmEraseStore(eraseDb) } : {}); // M40 — `mdm_tenant_overlays`
  registerPatientErasers(eraseDb ? { store: createDrizzlePatientEraseStore(eraseDb) } : {}); // M5 — `clinical_record`
  registerConsentErasers(eraseDb ? { store: createDrizzleConsentEraseStore(eraseDb) } : {}); // M39 — `consent`
  registerAdmissionErasers(eraseDb ? { store: createDrizzleAdmissionEraseStore(eraseDb) } : {}); // M6 — `admission_record`
  registerCarePlanErasers(eraseDb ? { store: createDrizzleCarePlanEraseStore(eraseDb) } : {}); // M7 — `care_plan_record`
  registerEncounterErasers(eraseDb ? { store: createDrizzleEncounterEraseStore(eraseDb) } : {}); // M8 — `encounter_record`
  registerAssessmentErasers(eraseDb ? { store: createDrizzleAssessmentEraseStore(eraseDb) } : {}); // M9 — `clinical_assessment`
  registerHopeErasers(eraseDb ? { store: createDrizzleHopeEraseStore(eraseDb) } : {}); // M10 — `hope_record` (CMS 10-year block in the orchestrator)
  registerOrderErasers(eraseDb ? { store: createDrizzleOrderEraseStore(eraseDb) } : {}); // M11 — `order_record`
  // M12 — `medication_order_record`; the injected M11 cascade removes the med-order-targeted
  // signature/verbal rows at erase time (task-15 — the cross-eraser ownership decision).
  registerDoseSpotErasers(
    eraseDb
      ? {
          store: createDrizzleMedicationOrderEraseStore(eraseDb, {
            orderSignatureCascade: createMedicationOrderSignatureCascade(eraseDb),
          }),
        }
      : {},
  );
  registerEmarErasers(eraseDb ? { store: createDrizzleEmarEraseStore(eraseDb) } : {}); // M13 — `emar_record`
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
  registerBereavementErasers(deps.db ? { store: createDrizzleBereavementEraseStore(deps.db) } : {});
  registerIdgErasers(eraseDb ? { store: createDrizzleIdgEraseStore(eraseDb) } : {}); // M14 — `idg_record` (patient-scoped rows; meetings/minutes survive, minutes hash-redacted)
  // M22 — `documents`. With the MINIO_* env contract the erase destroys real object versions via
  // the SigV4 adapter (task-15); without it, object destruction refuses via DegradedError BEFORE
  // any row delete (retryable, never orphaned keys).
  {
    const s3EraseConfig = eraseDb ? s3ObjectStoreConfigFromEnv(process.env) : null;
    registerDocumentErasers(
      eraseDb
        ? {
            store: createDrizzleDocumentEraseStore(
              eraseDb,
              s3EraseConfig ? { objects: createS3ObjectStore(s3EraseConfig) } : {},
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
  registerReportingErasers(eraseDb ? { store: createDrizzleReportingEraseStore(eraseDb) } : {}); // M33 — `reporting_class` (drilldown audit count-only, destruction-blocked)
  registerQualityErasers(eraseDb ? { store: createDrizzleQualityEraseStore(eraseDb) } : {}); // M30 — `quality_class` (compliance/survey evidence count-only, destruction-blocked)
  registerCostReportErasers(eraseDb ? { store: createDrizzleCostReportEraseStore(eraseDb) } : {}); // M27 — `cost_report_class` (evidence delete refuses until the M4 elevated destruction-cert binding lands)
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
  registerTriageErasers(deps.db ? { store: createDrizzleTriageEraseStore(deps.db) } : {});
  // M20-T02 — `safety_record` (per-PATIENT destruction-cert callback that DELETES NOTHING: §3.7 files ten
  // of M20's thirteen tables as "structural row retained with redacted markers". It redacts the free text
  // §3.5 says may describe the patient on the incidents and SOS alerts linked to them, redacts `action_taken`
  // on the attached acknowledgments, and LAST severs the patient/visit linkage. The clinician's own SOS
  // coordinates and location stream, both check-in tables, the policy-version replay rows, the supervisor
  // subscriptions, the advisory polygons and the clinician's emergency-contact consent are never touched —
  // that is a different data subject's workers-comp evidence.) The Drizzle store binds when a DB client is
  // present; without one the slice's in-memory store stands.
  registerSafetyErasers(deps.db ? { store: createDrizzleSafetyEraseStore(deps.db) } : {});
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
  registerFhirGatewayEraser(deps.db ? { store: createDrizzleFhirGatewayEraseStore(deps.db) } : {});
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
type ProcessRole = "all" | "api" | "worker" | "listener";

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
    throw new ChartWardenError("SIGNUP_DISABLED", "self-serve signup is not enabled", 503);
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
      const acceptedEmail = await withPlatformContext(
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
            throw new ChartWardenError("INVITATION_INVALID", "invitation is invalid", 404);
          }
          if (invitation.status !== "pending" || invitation.expiresAt <= new Date()) {
            throw new ChartWardenError(
              "INVITATION_INVALID",
              "invitation is expired or already used",
              409,
            );
          }

          // An invitation issued earlier must not redeem once the tenant was suspended or offboarded.
          const [tenant] = await platformTx
            .select({ status: schema.tenantAccount.status })
            .from(schema.tenantAccount)
            .where(eq(schema.tenantAccount.id, invitation.tenantAccountId))
            .limit(1)
            // A share lock holds off a concurrent lifecycle transition (which updates this row) until we commit,
            // so a tenant suspended between this check and the membership insert cannot slip an admin in.
            .for("share");
          if (!tenant || !canInviteFirstAdmin(tenant.status)) {
            throw new ChartWardenError(
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
                    eq(schema.memberships.organizationId, invitation.organizationId),
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
              if (!membership) throw new Error("first-admin membership creation failed");

              // GAP-006 — nothing in production used to create `role` rows, so this threw on every fresh tenant.
              // Materialize the org's roles (create-only, idempotent) in THIS transaction, then take the org's
              // OWN org_admin row; a platform-owned template row, if one ever exists, is only a fallback.
              await materializeRoleTemplatesInTx(tx, invitation.organizationId);
              const [ownOrgAdmin] = await tx
                .select()
                .from(schema.roles)
                .where(
                  and(
                    eq(schema.roles.organizationId, invitation.organizationId),
                    eq(schema.roles.key, "org_admin"),
                  ),
                )
                .limit(1);
              const [templateOrgAdmin] = ownOrgAdmin
                ? []
                : await tx
                    .select()
                    .from(schema.roles)
                    .where(
                      and(isNull(schema.roles.organizationId), eq(schema.roles.key, "org_admin")),
                    )
                    .limit(1);
              const orgAdmin = ownOrgAdmin ?? templateOrgAdmin;
              if (!orgAdmin) throw new Error("org_admin role is unavailable after materialization");
              await tx
                .insert(schema.membershipRoles)
                .values({
                  organizationId: invitation.organizationId,
                  membershipId: membership.id,
                  roleId: orgAdmin.id,
                  grantedBy: user.id,
                })
                .onConflictDoNothing({
                  target: [schema.membershipRoles.membershipId, schema.membershipRoles.roleId],
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
            throw new ChartWardenError("INVITATION_INVALID", "invitation was already used", 409);
          }
          return invitation.inviteeEmail.trim().toLowerCase();
        },
      );
      return { accepted: true, email: acceptedEmail };
    },
  };
}

/**
 * The bound M23 HETS 270/271 port (§4.4). `provider_entity` is M1-owned (arch:tables), so the 2100B NPI +
 * organization-name read is the M1 bootstrap reader; the MBI comes from M5's `MbiUnlockReader` seam
 * (resolved lazily per check, so boot registration order never matters).
 */
function buildM23HetsPort(db: DbClient, config: M23HetsConfig) {
  return buildHetsEligibilityPort({
    transport: createM23HetsTransport(config),
    submitterId: config.submitterId,
    usage: config.usage,
    mbiUnlock: () => getSeam("MbiUnlockReader"),
    providers: buildProviderEligibilityIdentityReader(db),
  });
}

/**
 * The M23 reader ports the claim assembly (route) AND the validation-run worker (GAP-070) both read through.
 * One builder so the route and the worker see the same facts. `provider_entity` is M1-owned (arch:tables), so
 * the CCN reader lives here in the composition root and is shared by the write-service's control-number
 * derivation and the assembly's `mdm.resolveProviderEntity`.
 */
function buildM23AssemblyPorts(db: DbClient): {
  readonly providerCcn: ProviderCcnPort;
  readonly assemblyPorts: Omit<M23BootAssemblyPorts, "outbox" | "providerCcn">;
} {
  const providerCcn: ProviderCcnPort = {
    async ccnForProviderEntity(tx: unknown, organizationId: string, providerEntityId: string) {
      const [provider] = await (tx as DbClient)
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
  };
  const assemblyPorts: Omit<M23BootAssemblyPorts, "outbox" | "providerCcn"> = {
    // F-121 (#251) — M6's range-shaped seam function, bound directly (M6 needs no per-request
    // handle; it opens its own withOrgContext, the admissionSchedulingContextForOrg pattern).
    m6ClaimRange: {
      forRange: (orgId, patientId, range) =>
        claimAssemblyRangeContextForOrg(db, orgId, patientId, range),
    },
    // FY2027 — M6's election addendum facts for the `election_addendum_signed` rule (42 CFR 418.24(c)).
    m6ElectionAddendum: {
      forAdmission: (orgId, admissionId) =>
        electionAddendumComplianceForOrg(db, orgId, admissionId),
    },
    // F-209 (#251) — M7's org-explicit, patient-keyed claim-diagnosis read.
    m7ClaimDiagnoses: {
      forRange: (orgId, patientId, range) => claimDiagnosesForOrg(db, orgId, patientId, range),
    },
    // F-122 (#251) — M8's two new range-shaped seam functions, same org-explicit binding.
    m8BillableEncounters: {
      inRange: (orgId, providerEntityId, patientId, range) =>
        billableEncountersInRangeForOrg(db, orgId, providerEntityId, patientId, range),
    },
    m8SignedEncounters: {
      inRange: (orgId, patientId, range) =>
        signedEncounterSnapshotsInRangeForOrg(db, orgId, patientId, range),
    },
    // F-123 (#251) — the M8 encounter→visit bridge + M18's bulk compliance read.
    m8EncounterVisitIds: {
      forEncounters: (orgId, encounterIds) => encounterVisitIdsForOrg(db, orgId, encounterIds),
    },
    m18Compliance: {
      forVisits: (orgId, visitIds) => complianceStatesForVisitsForOrg(db, orgId, visitIds),
    },
    // F-213 (#252) - mdm placeOfService: M5's effective-dated address history (the registered
    // PatientAddressReader seam, resolved lazily per call so boot registration order never
    // matters) + M40's merge-resolved facility.kind. M23 imports neither module.
    placeOfService: {
      residence: {
        residencesBetween: (orgId, patientId, from, to) =>
          (getSeam("PatientAddressReader") as PatientAddressReader).residencesBetween(
            orgId,
            patientId,
            from,
            to,
          ),
      },
      facilityKinds: {
        kindsFor: (facilityIds) => facilityKindsForIds(db, facilityIds),
      },
    },
    // Wage-index value codes 61 / G8 (CMS ch. 11 s30.3): the residence ZIP on the claim's last day (M5) and the
    // patient's facility residence spans (M5) with each facility's address (M40); G8 is the facility overlapping the
    // inpatient dates. Resolved lazily per call, like placeOfService above.
    claimZips: {
      residencePostalCode: async (orgId, patientId, asOf) =>
        (
          await (getSeam("PatientAddressReader") as PatientAddressReader).residenceAt(
            orgId,
            patientId,
            asOf,
          )
        )?.postalCode ?? null,
      facilitySpans: async (orgId, patientId, range, stays) => {
        // M37 (`ipu_admission`) is the system of record for where an inpatient stay was delivered; M5's facility
        // residence spans stand in only for stays M37 does not know.
        const m37Facilities = await inpatientFacilityIdsForPeriodsForOrg(
          db,
          orgId,
          stays.map((s) => s.levelOfCarePeriodId),
        );
        const spans = await (
          getSeam("PatientAddressReader") as PatientAddressReader
        ).residencesBetween(orgId, patientId, range.from, range.to);
        const facilityIds = [
          ...new Set([
            ...m37Facilities.values(),
            ...spans.flatMap((s) => (s.kind === "facility" && s.facilityId ? [s.facilityId] : [])),
          ]),
        ];
        const postal = await facilityPostalCodesForIds(db, facilityIds);
        const m37Postal = new Map(
          [...m37Facilities].map(([periodId, facilityId]) => [
            periodId,
            postal.get(facilityId) ?? null,
          ]),
        );
        return composeFacilitySpans(stays, m37Postal, toFacilitySpans(spans, postal));
      },
    },
  };
  return { providerCcn, assemblyPorts };
}

export async function bootChartWarden(requestedRole: ProcessRole = "all"): Promise<void> {
  // GAP-086 — `listener` is the M29 MLLP listener process (§4.11: a SIBLING process to the API for crash isolation). It
  // boots the same composition root (seams, tenancy, key ring) but, like `api`, constructs NO BullMQ workers / crons / outbox
  // dispatcher — it only binds the feed listeners and serves /health on `LISTENER_HEALTH_PORT`.
  const listenerProcess = requestedRole === "listener";
  // Set by wireModuleSeams (via buildServer's registerModuleSeams) and read by the M36 EscalationRouter boot probe below.
  let m19RouterBoundOrgCount = 0;
  const role: Exclude<ProcessRole, "listener"> = listenerProcess ? "api" : requestedRole;
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
  // ADR-0049 Phase 4 — where an organization's emailed links point (its own subdomain when TENANT_BASE_DOMAIN is set,
  // else the global origin exactly as before). Undefined without a database: no org to name, global origins apply.
  const tenantAppOrigin = dbHandle ? createDbTenantAppOrigin(dbHandle.db) : undefined;
  const appOriginFor = tenantAppOrigin
    ? (orgId: string) => tenantAppOrigin.appOrigin(orgId)
    : undefined;
  const portalOriginFor = tenantAppOrigin
    ? (orgId: string) => tenantAppOrigin.portalOrigin(orgId)
    : undefined;
  // GAP-037 — the DoseSpot adapter. UNBOUND unless `DOSESPOT_TENANT_CONFIGS` holds a complete config for a tenant:
  // an unconfigured tenant gets a non-retryable DegradedError from every call, is never queued for transmission,
  // and keeps activating orders locally. The breaker's open/close edges are collected here and published as
  // `m12.dosespot_degraded` / `_recovered` by the next M12 cron tick.
  const m12TenantConfig = createEnvTenantConfigResolver();
  const m12BreakerEdges = createBreakerEdgeRecorder();
  const m12DoseSpotClient = createHttpDoseSpotClient({
    resolver: m12TenantConfig,
    onBreakerEdge: (edge) => m12BreakerEdges.record(edge),
  });
  // M35 §5.2 platform-ops admin surface runs its cross-tenant reads/writes through a SEPARATE platform
  // credential — NOT the tenant `chartwarden_app` pool. The six PLATFORM-ONLY M35 tables
  // (revenue_recognition_snapshot, stripe_webhook_event, patient_pseudonym_key, stripe_api_call_audit,
  // platform_retained_invoice[_line]; migration 0143) have RLS enabled with NO chartwarden_app grant, so a
  // tenant-pool read fails closed with `permission denied`. DATABASE_PLATFORM_URL points at a least-privilege
  // platform login role (SELECT/write on those tables + the org-scoped M35 tables it reads cross-tenant +
  // audit_event INSERT + BYPASSRLS). Absent → the M35 platformRunner below stays undefined and the admin
  // surface is fail-closed (503) — the prod-safe default (never the superuser, never the tenant pool).
  const platformDbHandle = process.env.DATABASE_PLATFORM_URL
    ? createDbClient({ connectionString: process.env.DATABASE_PLATFORM_URL })
    : undefined;
  // F-172 (#248) — `PseudonymKeyProvider.activeKey()`'s first real implementation. `patient_pseudonym_key`
  // is one of the six platform-only M35 tables the comment above already names, so this rides the SAME
  // `platformDbHandle` credential; the KEK ring is a SEPARATE secret (`M35_PSEUDONYM_KEY_KEK`) from
  // `M34_TENANT_KEK`. Absent either half, `pseudonymKeyProvider` fails closed with a stated reason —
  // never silently returns a zero/derived key — so the two consumers below dead-letter loudly rather than
  // pseudonymizing under a key nobody configured.
  const pseudonymKeyRing = loadPseudonymKekRing(process.env);
  const pseudonymKeyProvider: PseudonymKeyProvider =
    platformDbHandle && pseudonymKeyRing
      ? createDrizzlePseudonymKeyProvider(platformDbHandle.db, pseudonymKeyRing)
      : {
          activeKey() {
            return Promise.reject(
              new Error(
                "PseudonymKeyProvider unbound: requires both DATABASE_PLATFORM_URL and M35_PSEUDONYM_KEY_KEK to be configured",
              ),
            );
          },
        };
  // F-175 (#248) — the M29 outbound-dispatch per-feed rate limiter (`external_feed.rate_limit_msg_per_sec`),
  // constructed ONCE and shared between the fresh-dispatch `OutboxConsumerBinding` and the retry-sweep
  // worker (both below) so the throttle budget is genuinely shared across both send paths, not doubled.
  const m29OutboundRateLimiter = createM29OutboundRateLimiter();
  // TASK-003 follow-up — the DESTRUCTION credential (a login role IN ROLE chartwarden_destruction,
  // migration 0157: DELETE/UPDATE grants scoped to exactly what the erase stores execute, org-pinned
  // RLS policies — never BYPASSRLS). The append-only clinical/billing tables grant chartwarden_app no
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
  // WP 5.6 (ADR-0086): the message destruction executor exists only with BOTH the destruction credential and the platform pool (the weekly
  // retention tick fans out over active orgs). Without them nothing can ever run, so the screen must not claim dry_run or live.
  const m36RetentionDestructionWired = Boolean(destructionDbHandle && platformDbHandle);
  if (!m36RetentionDestructionWired && process.env[RETENTION_DESTRUCTION_EXECUTE_ENV] === "true") {
    console.warn(
      `\u26a0\ufe0f  ${RETENTION_DESTRUCTION_EXECUTE_ENV}=true but the message destruction executor is NOT wired (it needs DATABASE_DESTRUCTION_URL and DATABASE_PLATFORM_URL): nothing will be destroyed and the retention screen reports destruction as off.`,
    );
  }
  if (platformDbHandle) registerPlatformJob("m35-subscription-admin");
  if (platformDbHandle) registerPlatformJob(M35_JOBS_PLATFORM_JOB_ID); // GAP-059 — M35 worker set's active-org fan-out
  if (platformDbHandle) registerPlatformJob(M8_PLATFORM_JOB_ID);
  if (platformDbHandle) registerPlatformJob(M17_PLATFORM_JOB_ID);
  if (platformDbHandle) registerPlatformJob(M3_CLOSE_ENGAGEMENTS_PLATFORM_JOB_ID); // GAP-011 — authz.close_engagements fan-out
  if (platformDbHandle) registerPlatformJob(M4_AUDIT_JOBS_PLATFORM_JOB_ID); // GAP-014 — M4 audit jobs' active-org fan-out
  if (platformDbHandle) registerPlatformJob(M18_PLATFORM_JOB_ID);
  if (platformDbHandle) registerPlatformJob(M15_PLATFORM_JOB_ID);
  if (platformDbHandle) registerPlatformJob(M5_GEOCODE_COVERAGE_JOB_ID);
  if (platformDbHandle) registerPlatformJob(M28_BAA_COVERAGE_JOB_ID);
  if (platformDbHandle) registerPlatformJob(M3_ROLE_TEMPLATE_BACKFILL_JOB_ID);
  // GAP-062 — the M21 §4.6 par-monitor / unreturned-kit-monitor / supply-request-monitor active-org fan-out.
  if (platformDbHandle) registerPlatformJob(M21_PLATFORM_JOB_ID);
  // M36 D9 — the sole-tenant membership read the offboarding eraser runs (audited platform entry).
  if (platformDbHandle) registerPlatformJob(M36_SOLE_TENANT_JOB_ID);
  // M34 tenant shred — the identity eraser's sole-tenant subjects, resolved by the SAME rule as M36's.
  if (platformDbHandle) registerPlatformJob(M34_SHRED_SOLE_TENANT_JOB_ID);
  // M36 WP 2.13 / ADR-0058 P1 — legacy message-body envelope rows vs MESSAGING_ENCRYPTION_KEY. A production boot with
  // legacy rows and no usable key FAILS CLOSED (unreadable history); otherwise the count is logged. In production a count
  // that cannot be taken is ALSO fatal (re-run db:provision-roles for the column grant BEFORE deploying); elsewhere it warns.
  if (platformDbHandle) {
    registerPlatformJob(M36_BODY_LEGACY_COUNT_JOB_ID);
    await runLegacyBodyBootCheck({
      count: () =>
        countLegacyBodiesAllTenants({
          platformDb: platformDbHandle.db,
          auditBypass: m34PlatformBypassAuditor,
          jobId: M36_BODY_LEGACY_COUNT_JOB_ID,
        }),
      log: console,
    });
  } else if (process.env.NODE_ENV === "production") {
    // assertProductionEnv requires DATABASE_PLATFORM_URL, so this is unreachable in a validated boot; if validation is ever
    // bypassed the legacy-row check must not silently not run.
    throw new Error(
      "M36 legacy message-body check cannot run in production without DATABASE_PLATFORM_URL; refusing to boot (ADR-0058 P1)",
    );
  }
  // audit C1 — RLS is the tenancy control, and a role with BYPASSRLS makes every policy decorative.
  // The migrator now gates that grant on CHARTWARDEN_DEV_BYPASSRLS + non-production, but a grant applied
  // by hand (or by an older migrate run against this cluster) would leave no trace at boot. Ask the
  // cluster directly and refuse to serve. Dev/test only warn — the local single-org demo needs the
  // bypass for pre-org reads until the platform pool lands.
  if (dbHandle) {
    const bypassing = await dbHandle.db.execute(
      sql`SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    const row = (bypassing as unknown as { rows?: Array<{ rolbypassrls?: boolean }> }).rows?.[0];
    if (row?.rolbypassrls === true) {
      const message =
        "the database role this process connects as (current_user) has BYPASSRLS: " +
        "row-level security is NOT enforced for any query, on any table.";
      if (process.env.NODE_ENV === "production") {
        throw new Error(`Refusing to boot — ${message} Revoke it (ALTER ROLE … NOBYPASSRLS).`);
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
  const m23LaunchConfig = integrationEnabled(process.env, M23_LAUNCH_GATEWAY_ENABLED_ENV)
    ? m23LaunchGatewayConfigFromEnv(process.env)
    : null;
  const m23LaunchGateway = m23LaunchConfig ? createM23LaunchGateway(m23LaunchConfig) : null;
  // M23 §4.4 HETS 270/271 — bound ONLY when `M23_HETS_TRANSPORT` is set (`core_mime` to CMS / a clearinghouse,
  // or the dev/test `sandbox`, refused in production). Unset → the eligibility.refresh worker stays unbound and
  // POST /billing/eligibility/check keeps answering 503: never a fabricated eligibility result. A present but
  // invalid configuration throws here, so a typo fails the boot instead of silently disabling eligibility.
  const m23HetsConfig = m23HetsConfigFromEnv(process.env);
  // ADR-0053 D3 - the platform's clearinghouse binding. Unset keeps every transport call at CH_NOT_WIRED; a vendor
  // named with no adapter in this build throws here, so a misconfigured deploy refuses to boot.
  const clearinghouseBinding = bindPlatformClearinghouse(process.env, {
    attempts: dbHandle ? createDrizzleAttemptStore(dbHandle.db) : null,
    onAnomaly: (anomaly) => app.log.warn({ anomaly }, "Clearinghouse anomaly"),
  });
  const m23SubmissionQueues =
    queueConnection && m23LaunchGateway ? buildM23SubmissionQueuePort(queueConnection) : null;
  // F-153 (#248) — the `revalidate.consumer` producer, unlike submission, needs no MAC/X12 launch
  // gateway — only the Valkey connection the worker itself already requires to run. Built unconditionally
  // (queueConnection may still be undefined; the port fails closed per-call in that case, RULE 4).
  const m23RevalidateEnqueue = buildM23RevalidateEnqueuePort(queueConnection);
  // GAP-070 — the `validation-run` / `eligibility.refresh` producer (queue connection only; no launch gateway).
  const m23WorkQueues = queueConnection ? buildM23WorkQueueEnqueuePort(queueConnection) : null;
  // M24 (WX-PR-011) — the Oregon launch-gateway, gated the same way as M23's (unset in dev/test/CI so
  // nothing calls out by accident). The adapter registry always constructs (WA/ID/CA/NV deny-stubs register
  // regardless); only Oregon's wire I/O gets a real gateway when one resolves.
  // GAP-146 — in production an unset M24_LAUNCH_GATEWAY_ENABLED means enabled (opt-out, like M23's switch).
  const m24LaunchConfig = m24LaunchGatewayConfigFromEnv(
    withM24LaunchGatewayDefault(process.env) as NodeJS.ProcessEnv,
  );
  const m24OregonGateway = m24LaunchConfig ? createM24OregonGateway(m24LaunchConfig) : null;
  const m24AdapterRegistry = new MedicaidAdapterRegistry([], m24OregonGateway);
  const m24SubmissionQueues =
    queueConnection && m24OregonGateway ? buildM24SubmissionQueuePort(queueConnection) : null;
  // F-165 (#248, m24 group) — the `medicaid-revalidate` producer, mirroring M23's `revalidate.consumer` port
  // above: needs no Oregon launch gateway, only the Valkey connection. Built unconditionally
  // (queueConnection may still be undefined; the port fails closed per-call in that case, RULE 4).
  const m24RevalidateEnqueue = buildM24RevalidateEnqueuePort(queueConnection);
  // M29 D11 (GAP-045) — the §4.1.4 manual NPPES-sync enqueue. Built here (not in the worker-runner
  // section) because the ROUTE needs it and the route mount runs first; the nightly repeatable + the
  // Worker that drains this same queue are registered further below. Absent REDIS_URL → the trigger route
  // 503s and the nightly run simply does not exist on this deployment — both honest, neither silent.
  const m29NppesSync = queueConnection ? buildNppesManualSyncTrigger(queueConnection) : null;
  const m34ProvisionConfig = integrationEnabled(process.env, M34_PROVISION_GATEWAY_ENABLED_ENV)
    ? m34ProvisionGatewayConfigFromEnv(process.env)
    : null;
  const m34ProvisionGateway = m34ProvisionConfig
    ? createM34ProvisionGateway(
        m34ProvisionConfig,
        undefined,
        // Tenant host set: the first-admin link is `<tenant origin>/tenant-invite/<token>`; unset keeps M34_INVITATION_ACCEPT_URL.
        parseTenantBaseDomain() && appOriginFor
          ? async (orgId) => {
              const origin = await appOriginFor(orgId);
              return origin ? `${origin}/tenant-invite` : undefined;
            }
          : undefined,
      )
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
    queueConnection && platformDbHandle && m34ProvisionGateway && m34TenantStorage
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
  // F-152 (#248) — M11's §2.7 D7 order-suggestion banner (`orders:suggestion:<patientId>`, 7-day TTL).
  // A dedicated connection rather than reusing `stepUpRedisClient`: low-traffic and non-hot-path like
  // that one, but a distinct concern per this file's own one-connection-per-concern convention (see
  // `rateLimitRedisClient` below) — mixing concerns on one connection couples their failure/retry
  // tuning together for no shared benefit.
  const orderSuggestionRedisClient = queueConnection
    ? new Redis({
        ...(queueConnection as RedisOptions),
        maxRetriesPerRequest: null,
      })
    : null;

  // F-164 (#248) — M14's §4.5 "since last IDG" per-patient projection cache
  // (`chartwarden:m14:idg:since-last-idg:<patientId>`, 30-day TTL). A dedicated connection, the
  // `orderSuggestionRedisClient` shape immediately above: low-traffic, non-hot-path, and a distinct
  // concern from every other client on this file's one-connection-per-concern convention.
  const m14SinceLastIdgRedisClient = queueConnection
    ? new Redis({
        ...(queueConnection as RedisOptions),
        maxRetriesPerRequest: null,
      })
    : null;

  // F-165 (#248, m24 group) — M5's `CaseloadStore` shift-assignment cache
  // (`chartwarden:m5:caseload-cache:<org>:<userId>`, per-entry TTL off each visit's own scheduled end). A
  // dedicated connection, the `orderSuggestionRedisClient`/`m14SinceLastIdgRedisClient` shape
  // immediately above: this one sits on the `CaseloadProvider` ABAC read path (see
  // `05-patient/seams/shift-caseload-cache.ts`'s header for why a read error there degrades rather
  // than propagates), a distinct failure/retry concern from every other client on this file's
  // one-connection-per-concern convention.
  const m5CaseloadShiftCacheRedisClient = queueConnection
    ? new Redis({
        ...(queueConnection as RedisOptions),
        maxRetriesPerRequest: null,
      })
    : null;

  stepUpRedisClient?.on("error", () => {});
  orderSuggestionRedisClient?.on("error", () => {});
  m14SinceLastIdgRedisClient?.on("error", () => {});
  m5CaseloadShiftCacheRedisClient?.on("error", () => {});
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
  // M36 WP 4.1/4.2 - the urgent and acknowledgment-request limiters fall back to per-replica memory without a shared store: N
  // replicas then allow N times the budget. That is bounded but weaker, so say so loudly in production instead of silently.
  if (!rateLimitStore && process.env.NODE_ENV === "production") {
    console.warn(
      "[m36] WARNING: no shared rate-limit store is configured (REDIS_URL); the urgent-message and acknowledgment-request limiters use per-replica memory, so each replica allows its own full budget.",
    );
  }
  // WP 2.7b / ADR-0058 P2 - the global-search limiter (active only on the cluster-wide store) and P1 ring key provider.
  // Both are shared by the route mount and the indexer/worker; the ring cache is resolved per call (bound later at boot).
  const m36SearchRateLimit = buildGlobalSearchRateLimit(rateLimitStore);
  const m36SearchKeys = createRingSearchKeyProvider(() => sharedRingDekCache());
  // ADR-0058 name exclusion: patient / caregiver / contact names never reach the index. M5's keyset name enumeration is injected as a
  // port (M36 reads no M5 table); one instance is shared by the query route and the indexer / maintenance worker.
  const m36NameExclusions = dbHandle
    ? createNameExclusions({
        db: dbHandle.db,
        keys: m36SearchKeys,
        names: {
          fragmentsPage: (organizationId, afterId, limit) =>
            patientNameFragmentsPageForOrg(dbHandle.db, organizationId, afterId, limit),
        },
      })
    : undefined;
  // TASK-040B — the outbox dispatcher (below, ~worker-runner section) is constructed AFTER
  // buildServer() returns `app` (it needs `app.addHook`/`app.log`), but the readinessProbe is
  // built and passed INTO buildServer() before that. This ref lets the probe's outbox-depth check
  // close over the eventual dispatcher instance rather than needing it to exist yet; undefined
  // (no DATABASE_PLATFORM_URL / dispatcher disabled) reports "ok" — nothing to be unready about.
  let outboxDispatcherRef: OutboxDispatcher | undefined;
  // WP 1.1 / ADR-0054 — the Socket.IO transport is OPT-IN per environment (the web client keeps polling until the
  // flag is on). `realtimeRef` is late-bound like the dispatcher ref: the readiness probe is built before the
  // server exists. Consumers (worker side) never hold the Server: they reach every api node through the Valkey
  // emitter (addendum A1), on a dedicated connection; the emitter port refuses to publish unless it is ready, so the dispatcher retries.
  const realtimeEnabled = process.env.REALTIME_ENABLED === "true";
  let realtimeRef: RealtimeHandle | undefined;
  const realtimeEmitterClient =
    realtimeEnabled && queueConnection
      ? new Redis({ ...(queueConnection as RedisOptions), maxRetriesPerRequest: null })
      : null;
  realtimeEmitterClient?.on("error", () => {});
  const realtimeEmitter = realtimeEmitterClient
    ? createRealtimeEmitter(realtimeEmitterClient)
    : undefined;
  // TASK-040C (OPS-005/006) — shared by BOTH the readiness probe (below) and the metrics registry's
  // `chartwarden_outbox_pending_depth` gauge, so the "no dispatcher running yet/at all → 0" fallback is
  // defined exactly once instead of duplicated at each call site.
  const outboxPendingDepth = () => outboxDispatcherRef?.pendingDepth() ?? Promise.resolve(0);
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
    // GAP-159 - the 22 spec 4.10 `m31.*` events (record-only); REQUIRED for `m31OutboxPublisher` to validate.
    M31_OUTBOX_EVENTS,
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
    // GAP-010 — M3's five spec'd `m3.*` events (break-glass invoked/ended, role assigned/revoked,
    // engagement closed). `m3.breakglass.invoked` declares m36, whose `buildM36BreakGlassAlertConsumer` is bound
    // below; the break-glass store publishes it in the invoke's own tx.
    M3_OUTBOX_EVENTS,
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
  // GAP-159 - M31's catalog-validating publisher + the shared emitter. The logger is late-bound: the emitter is
  // built before `app` exists, and a decision-point emit failure must reach the real log, not vanish.
  const m31OutboxPublisher = bindCallerModule(txOutboxPublisher, "m31");
  // GAP-161 - M32's catalog-validating publisher + the shared emitter (same-tx emits from the Drizzle stores).
  const m32Events = createM32EventEmitter(bindCallerModule(txOutboxPublisher, "m32"));
  let m31Warn: (message: string, context: Record<string, string>) => void = (message, context) =>
    console.warn(message, context);
  const m31Events = dbHandle
    ? createM31EventEmitter({
        db: dbHandle.db,
        publisher: m31OutboxPublisher,
        warn: (message, context) => m31Warn(message, context),
      })
    : undefined;
  bindM31EventEmitter(m31Events);
  // GAP-004 — the M5 §7.8 death-cascade `m5.patient.deceased` emit (deceased-db.ts).
  const m5OutboxPublisher = bindCallerModule(txOutboxPublisher, "m5");
  const m6OutboxPublisher = bindCallerModule(txOutboxPublisher, "m6");
  // FY2027 — the 42 CFR 418.24(c)/(d) election statement addendum service: one instance shared by M6's routes
  // and its M7 plan-of-care consumer. Non-covered determinations come through `composeNonCoveredItemsReaders`
  // (M7 unrelated problems, M12 not-covered medication orders, M21 not-covered DME / supply requests). The M12 /
  // M21 readers resolve through their seams on each call: those seams register later in boot.
  const m6ElectionAddendum = dbHandle
    ? createElectionAddendumService({
        db: dbHandle.db,
        outbox: m6OutboxPublisher,
        sources: {
          nonCoveredItems: composeNonCoveredItemsReaders([
            createUnrelatedProblemItemsReader(dbHandle.db),
            {
              listForAdmission: (orgId, admissionId) =>
                getSeam("NonCoveredMedicationsReader").listForAdmission(orgId, admissionId),
            },
            {
              listForAdmission: (orgId, admissionId) =>
                getSeam("NonCoveredDmeSuppliesReader").listForAdmission(orgId, admissionId),
            },
          ]),
          diagnoses: createAddendumDiagnosesReader(dbHandle.db),
          // (c)(3) name + hospice medical record identifier, through M5's published PatientReader seam.
          patientIdentity: async (organizationId, patientId) => {
            const p = await getSeam("PatientReader").findById({ organizationId, id: patientId });
            return p ? { name: `${p.firstName} ${p.lastName}`.trim(), mrn: p.mrn } : null;
          },
        },
        // A scanned signed paper copy (418.24(c)(9)) must be an ACTIVE M22 version of this patient + admission.
        documentValidator: createDocumentReaderEvidenceValidator(() => getSeam("DocumentReader")),
      })
    : null;
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
      return reader.activeBedAssignmentForLevelOfCarePeriod(organizationId, levelOfCarePeriodId);
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
  // GAP-056 — the M18 aggregator ports (state selection live; transport/credentials/M5 identifier fail-closed).
  const m18AggregatorDeps = dbHandle
    ? buildEvvAggregatorDeps(dbHandle.db, {
        rawStates: process.env.EVV_AGGREGATOR_STATES,
        sandataApiBaseUrl: process.env.SANDATA_API_BASE_URL,
        rawCredentials: process.env.EVV_AGGREGATOR_CREDENTIALS,
      })
    : undefined;
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
  // GAP-078 — M26 PS&R import. The raw CSV goes to the tenant bucket as a DEK-encrypted envelope (the M34
  // `TenantKeyProvider`, resolved lazily — it registers during boot) and the `cap:psr-reconcile` job is
  // produced on the platform Valkey. Either missing (no MINIO_* / no Valkey) leaves the port unbound, so
  // `importPsr` fails closed with a typed 503 rather than queueing an import that can never reconcile.
  const m26PsrS3Config = s3ObjectStoreConfigFromEnv(process.env);
  const m26PsrObjects = m26PsrS3Config
    ? createS3ObjectStore({ ...m26PsrS3Config, publicEndpoint: m26PsrS3Config.endpoint })
    : null;
  const m26PsrFiles = m26PsrObjects
    ? createPsrFileStore({
        keys: {
          dekForOrg: (orgId) => getTenantKeyProvider().dekForOrg(orgId),
          dekForOrgVersion: (orgId, version) =>
            getTenantKeyProvider().dekForOrgVersion(orgId, version),
        },
        objects: {
          putObject: async ({ organizationId, objectKey, bytes }) => {
            await m26PsrObjects.putObject({
              bucket: deriveTenantBucket(organizationId),
              objectKey,
              bytes,
            });
          },
          getObject: async ({ organizationId, objectKey }) => {
            const { url } = await m26PsrObjects.presign({
              organizationId,
              descriptor: {
                bucket: deriveTenantBucket(organizationId),
                objectKey,
                ttlSeconds: 60,
                accessKind: "content_download",
              },
            });
            const res = await fetch(url);
            if (!res.ok) throw new Error(`PS&R object read failed with HTTP ${res.status}`);
            return new Uint8Array(await res.arrayBuffer());
          },
        },
      })
    : undefined;
  const m26PsrEnqueuer = queueConnection ? buildPsrReconcileEnqueuer(queueConnection) : null;
  const m35OutboxPublisher = bindCallerModule(txOutboxPublisher, "m35");
  // GAP-058 — Stripe bindings (all optional, each fail-closed when its env is absent) and the ONE audited
  // platform runner every M35 platform-table touch shares (admin routes, webhook ingest, workers).
  const m35Stripe = loadM35StripeConfig(process.env);
  const m35PlatformRunner: PlatformRunner | undefined = platformDbHandle
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
    : undefined;
  const m37OutboxPublisher = bindCallerModule(txOutboxPublisher, "m37");
  const m39OutboxPublisher = bindCallerModule(txOutboxPublisher, "m39");
  // GAP-101 — M36's first publisher: the out-of-band dispatcher + vendor-webhook reconcile emit
  // `m36.notification.delivery_failed` in the same tx that settles the delivery `failed`.
  const m36OutboxPublisher = bindCallerModule(txOutboxPublisher, "m36");
  // WP 1.5 — M36 attachment storage (over M22's per-tenant MinIO store) + malware scanner, shared by the routes and the
  // scan sweep. No MINIO_* => uploads answer 503; no scanner (MESSAGING_ATTACHMENT_SCANNER) => nothing leaves `pending`.
  const m36AttachmentBinding = buildM36AttachmentBinding(process.env, (message) =>
    console.warn(`⚠️  ${message}`),
  );
  if (s3ObjectStoreConfigFromEnv(process.env) && !destructionDbHandle) {
    console.warn(
      "⚠️  M36 attachments are enabled (MINIO_* is set) but DATABASE_DESTRUCTION_URL is not: the attachment orphan reaper is off and a tenant erase will refuse (chartwarden_app cannot DELETE message_attachment). Provision chartwarden_destruction_login (db:provision-roles) and set it.",
    );
  }
  // GAP-099 — M40's first publisher. It had none until now because nothing could WRITE a canonical
  // (migration 0019 created `mdm_canonical_writer` and never a function owning it), so there was no
  // canonical change for M40 to announce; migration 0202 built the write path and events-by-m40.ts the
  // catalog. Publishes platform-wide (`organizationId: null`) — a canonical belongs to no tenant.
  const m40OutboxPublisher = bindCallerModule(txOutboxPublisher, "m40");
  const m28OutboxPublisher = bindCallerModule(txOutboxPublisher, "m28");
  // GAP-084 — the M28 bulk-export machinery. Output objects live in the tenant's own MinIO bucket via the SAME
  // SigV4 adapter M22 uses (a stateless signer — nothing to share). Without the MINIO_* contract OR a queue
  // connection, `$export` answers 501 instead of accepting a job nothing can run (the refusing store stands in
  // for the worker/sweeper deps below so the inbound + session crons still run).
  const m28ExportS3Config = s3ObjectStoreConfigFromEnv(process.env);
  const m28ExportObjects = buildFhirExportObjectStore(
    m28ExportS3Config ? createS3ObjectStore(m28ExportS3Config) : createRefusingObjectStore(),
    (organizationId) => deriveTenantBucket(organizationId as OrgId),
  );
  const m28ExportQueue =
    queueConnection && m28ExportS3Config ? buildBulkExportEnqueuePort(queueConnection) : null;
  // GAP-108 — M38's §4.3 job layer. Release files live in ONE platform bucket (never a tenant bucket) behind the same
  // SigV4 adapter M22 uses; the producer needs Valkey. Either missing leaves the admin load/upload routes answering
  // 503 (no silent success) and the load worker reading through a refusing port. The embeddings backend (local BGE-small
  // sidecar) is not built: `embedderUnavailable` keeps refresh-embeddings fail-closed (503) and semantic search on fuzzy.
  const m38S3Config = s3ObjectStoreConfigFromEnv(process.env);
  const m38S3 = m38S3Config
    ? (createS3ObjectStore(m38S3Config) as unknown as PlatformS3Slice)
    : null;
  const m38PlatformBucket = process.env.TERMINOLOGY_PLATFORM_BUCKET?.trim() || undefined;
  const m38Producer = queueConnection ? buildTerminologyProducer(queueConnection) : null;
  const m2OutboxPublisher = bindCallerModule(txOutboxPublisher, "m2");
  const m3OutboxPublisher = bindCallerModule(txOutboxPublisher, "m3");
  // F-202/F-203 (#248) — M11's two-person lab-recovery control. Its compliance alerts are DURABLE (F-203): the service
  // publishes `m11.order.recovery_alert_requested` in the recovery's own transaction and
  // `buildM11RecoveryAlertConsumer` (registered with the outbox consumers below) delivers it to M36's AlertEmitter, so
  // there is no alert port here. The bound that forces a high-trust co-signer, and the org-rate alert threshold, are
  // env-overridable; an invalid value FALLS BACK to the default rather than disabling the bound.
  const m11RecoveryControls = {
    escalationThreshold: parseRecoveryBound(
      process.env.M11_RECOVERY_ESCALATION_THRESHOLD,
      RECOVERY_ESCALATION_THRESHOLD,
    ),
    orgRateThreshold: parseRecoveryBound(
      process.env.M11_RECOVERY_ORG_RATE_THRESHOLD,
      RECOVERY_ORG_RATE_THRESHOLD,
    ),
    // F-205 — refuse to file a recovery nobody else can co-sign. M11 does not own the membership/role tables, so the
    // count is answered here, in the composition root, under the caller's org context (RLS-scoped).
    countEligibleCosigners: dbHandle
      ? buildM11CosignerCounter(
          dbHandle.db,
          createMembershipsHoldingPermissionReader(dbHandle.db),
          [LAB_RECOVERY_KEYS.recover, LAB_RECOVERY_KEYS.cosignEscalated],
        )
      : undefined,
  };
  // M24 §8.7 — the trading-partner secret cipher port. Built once at boot so a missing/short KEK surfaces
  // here, not on the first tenant write; left undefined when no key is configured, which makes credential
  // WRITES fail closed while every other M24 route keeps working (production requires the key via env.ts).
  // ONE trimmed "is the key set" test for M24 and M23, so a whitespace-only value is "unset" for both.
  const billingCredentialKeyConfigured =
    (process.env.M24_CREDENTIAL_ENCRYPTION_KEY?.trim() ?? "") !== "";
  const m24CredentialCipher = billingCredentialKeyConfigured
    ? buildCredentialCipherPort()
    : undefined;
  // M23 — the MAC-portal client-secret cipher (`POST /billing/mac-credentials`). Same custody model and KEK as the M24
  // cipher above (domain-separated per module); built once at boot so a malformed key fails the boot, not the first
  // write. Unset => the write path answers 503 SEAM_UNBOUND (production requires the key via env.ts).
  const m23MacSecretCipher = buildMacSecretCipherFromEnv(process.env);
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
  // M24 → M1 (`provider_entity` CCN) and M24 → M6 (`level_of_care_period`) — each owner's own reader, each
  // under its own `withOrgContext` (assembleClaim calls them outside its org-context transaction; the bare
  // `db.select`s these replaced ran with no `app.org_id` and 500'd every Medicaid claim assembly).
  const m24CcnReader = dbHandle
    ? { ccnForProviderEntity: buildProviderEntityCcnResolver(dbHandle.db).ccnFor }
    : undefined;
  const m24LocPeriodReader = dbHandle ? createAdmissionLocPeriodsReader(dbHandle.db) : undefined;
  // M24 → M40 (place-of-service follow-up) — `facility` is M40-owned/NON_ORG_SCOPED; same escape-valve
  // posture as `m24LocPeriodReader`, but NON_ORG_SCOPED so no org context. Batched by id so one claim assembly issues at most one query here.
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
    async residenceAt(organizationId: string, patientId: string, asOfDate: string) {
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
    async encountersInWindow(organizationId: string, patientId: string, from: string, to: string) {
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
  // The Postmark adapter binds ONLY when POSTMARK_SERVER_TOKEN + a verified POSTMARK_FROM_ADDRESS are configured
  // (credentials come from env alone; see 36-messaging/transactional-email-binding.ts). Otherwise it stays unbound:
  // production keeps dropping email and the link-delivery routes keep answering 503, with a loud boot line.
  const emailBinding = bindTransactionalEmail({
    env: process.env,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  const emailTransport = emailBinding.emailTransport;
  // M36 §4.4 out-of-band vendor transports (GAP-062) + the §4.2 endpoint-verification sender (GAP-063): env-gated,
  // per channel; an unconfigured channel stays on the fail-closed deny transport and is named at boot (SOS voice
  // is called out on its own). See 36-messaging/delivery/transport-binding.ts.
  const outOfBandBinding = bindOutOfBandTransports({
    env: process.env,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  // GAP-032 - the M20 SOS-terminus effect bag. Built where the cron workers are wired (it needs the queue-side
  // deps); the route layer's readiness probe reads it lazily through this holder.
  let m20TerminusBag: ReturnType<typeof buildM20TerminusDeps> | undefined;
  // TASK-030 — the web app's origin, for building the M2 invite-accept link (`${origin}/invite/:token`).
  // `WEB_APP_URL` is an explicit override; `BETTER_AUTH_URL` (already production-required, §bootstrap/
  // env.ts) is reused as the same-origin-SPA default per its own baseURL comment above; dev falls back
  // to the Vite origin, matching every other dev fallback in this file. Undefined only if production
  // sets neither — the invite route then omits `inviteUrl` rather than guess a wrong origin.
  const webAppBaseUrl = webAppBaseUrlFromEnv(process.env);
  // GAP-115 follow-up / M31 sign-in - the §5.3.1 failed-attempt budgets for the two NEW unauthenticated-or-pre-org
  // doors (link redemption, portal session establishment). Same store as the login throttle (Valkey when REDIS_URL is
  // set, per-replica otherwise), each under its OWN key prefix so a run against one door cannot lock out another.
  const doorFailureStore = rateLimitRedisClient
    ? createRedisFailedLoginStore(rateLimitRedisClient)
    : createInMemoryFailedLoginStore();
  const onThrottleStoreError = (err: unknown) =>
    process.stderr.write(
      `[throttle] failed-attempt store unavailable - failing open: ${String(err)}\n`,
    );
  const linkRedeemThrottle = createCredentialThrottle(doorFailureStore, {
    keyPrefix: "link-redeem",
    onStoreError: onThrottleStoreError,
  });
  // #589 - the screen-lock unlock's own per-user failed-password budget: reserved atomically BEFORE the hash, no IP
  // bucket, and fail-CLOSED on a store error (unlike the login-door throttles above). See unlock-guard.ts.
  const unlockGuard = createUnlockGuard(doorFailureStore, {
    onStoreError: (err) =>
      process.stderr.write(
        `[throttle] screen-unlock counter store unavailable - failing CLOSED (503): ${String(err)}\n`,
      ),
  });
  const portalSignInThrottle = createCredentialThrottle(doorFailureStore, {
    keyPrefix: "portal-signin",
    onStoreError: onThrottleStoreError,
  });
  // Without a bound transactional-email PROVIDER (the Postmark adapter, credentials + verified From from env) production
  // DROPS every email. A collaborator / funeral-home link nobody can receive must not be minted, so in production the
  // delivery port stays UNBOUND (the invite routes answer 503 LINK_DELIVERY_UNAVAILABLE) until the adapter is bound;
  // dev/test log the link via the console transport. The flag is derived from the adapter actually being bound.
  // The auditor invite had no bound-provider gate: in production the no-op transport "delivered" the link and the
  // enrolment reported a pending auditor who was sent nothing. `linkEmailTransport` THROWS when production is
  // unbound, which that route already maps to 503 AUDITOR_LINK_DELIVERY_FAILED.
  const linkEmailTransport = emailBinding.linkEmailTransport;
  const linkLandingBaseUrl = process.env.PORTAL_APP_URL ?? webAppBaseUrl;
  // Per-tenant origins alone (TENANT_BASE_DOMAIN set, no global PORTAL_APP_URL / WEB_APP_URL) are enough to send.
  const linkDelivery =
    (linkLandingBaseUrl || (parseTenantBaseDomain() && portalOriginFor)) &&
    emailBinding.linkDeliveryAvailable
      ? createLinkDelivery({
          transport: emailTransport,
          ...(linkLandingBaseUrl ? { baseUrl: linkLandingBaseUrl } : {}),
          ...(portalOriginFor ? { baseUrlFor: portalOriginFor } : {}),
        })
      : undefined;
  // GAP-002/GAP-004 — M2 §8.1 authentication audit trail (login, failure, lockout, logout, 2FA, passkey,
  // session revoke, password reset). Audit-write loss is logged loudly but never fails the auth request.
  const authAuditSink = dbHandle
    ? createAuthAuditSink({ db: dbHandle.db as unknown as AuthAuditDb })
    : undefined;
  const authAuditErrorLogger = (err: unknown, event: { eventType: string }) =>
    app.log.error({ err, eventType: event.eventType }, "auth audit write failed");
  // GAP-003/GAP-005 — the server-side MFA matrix (M2 §2.3): roles from M3's org-explicit reader (M2 may not read
  // M3's tables), factors from M2's enrolment reader. OPT-IN via
  // `CHARTWARDEN_MFA_ENFORCEMENT=true` (the web app has no enrolment UI yet - see resolveMfaEnforcement).
  const mfaGate = dbHandle
    ? createMfaEnrolmentGate({
        enforced: resolveMfaEnforcement(process.env),
        factors: createDbMfaEnrollmentReader(dbHandle.db),
        sessionProvedFactor: createDbSessionProofReader(dbHandle.db),
        roleKeysForMembership: async ({ organizationId, membershipId }) =>
          (await membershipRoleKeysForOrg(dbHandle.db, organizationId, [membershipId])).get(
            membershipId,
          ) ?? [],
        activeMembershipsOf: createDbActiveMembershipLister(dbHandle.db),
      })
    : undefined;
  // ADR-0049 / ADR-0088 — per-tenant subdomains. Unset TENANT_BASE_DOMAIN is single-host mode (the demo, dev):
  // no guard. Set, the host → organization lookup needs the database, so a missing handle is a boot error rather
  // than a guard that silently never runs.
  const tenantBaseDomain = parseTenantBaseDomain();
  if (tenantBaseDomain && !dbHandle) {
    throw new Error(
      "TENANT_BASE_DOMAIN is set but there is no database to resolve tenant hosts from",
    );
  }
  const tenantHostResolver =
    tenantBaseDomain && dbHandle
      ? createCachingTenantHostResolver(createDbTenantHostResolver(dbHandle.db))
      : undefined;
  // The same rule decides Better Auth's trusted origins, the passkey ceremony, step-up and the realtime handshake.
  const tenantOrigins = tenantHostResolver
    ? createTenantOriginMatcher({ baseDomain: tenantBaseDomain, resolver: tenantHostResolver })
    : undefined;
  const tenantHost = tenantHostResolver
    ? createTenantHostGuard({ baseDomain: tenantBaseDomain, resolver: tenantHostResolver })
    : null;
  const auth = dbHandle
    ? createIdentityAuth(dbHandle.db as Parameters<typeof createIdentityAuth>[0], {
        emailTransport,
        // GAP-002 — the password-reset leg of the M2 §8.1 authentication trail (the rest is the bridge's).
        auditSink: authAuditSink,
        onAuditError: authAuditErrorLogger,
        ...(tenantOrigins ? { tenantOrigins } : {}),
        ...(tenantOrigins && tenantBaseDomain
          ? {
              userMayUseTenantHost: createUserMayUseTenantHost(
                createDbPublicTenantLookups(dbHandle.db),
                tenantBaseDomain,
              ),
            }
          : {}),
      })
    : undefined;
  const authenticate = auth
    ? createSessionAuthenticate({
        getSnapshot: (request) => getIdentitySession(auth, request.raw.headers),
        getResolver: () => getSeam("SessionContextResolver"),
        // GAP-003 — hold an org-bound staff session at the MFA-enrolment stage until the role's factor exists.
        ...(mfaGate
          ? {
              mfaEnrolment: {
                check: ({ userId, sessionId, roleKeys }) =>
                  mfaGate.forRoles({ userId, sessionId, roleKeys }),
              },
            }
          : {}),
        // GAP-002 — SESSION_POLICY idle/absolute timeouts, enforced server-side on every request.
        ...(dbHandle ? { sessionTimeout: createDbSessionTimeoutEnforcer(dbHandle.db) } : {}),
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
        unauthenticatedPerMinute: Number(process.env.RATE_LIMIT_UNAUTHENTICATED_PER_MINUTE),
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
  // WP 3.4 - communication tasks. ONE binding for the routes (flag + service) and the offboarding reassignment, so they
  // share a store; off unless the tenant flag `messaging.tasks` is on (revocation reassigns regardless of the flag).
  // Late-bound: the logger exists only once `app` is built (assigned beside `m31Warn`).
  let m36TaskWarn: (message: string, context: Record<string, string>) => void = (
    message,
    context,
  ) => console.warn(message, context);
  const m36Tasks = dbHandle
    ? buildTaskDeps({
        warn: (message, context) => m36TaskWarn(message, context),
        db: dbHandle.db,
        flags: featureFlagReader,
        outbox: m36OutboxPublisher,
        messaging: createDbMessagingRouteService(dbHandle.db),
      })
    : undefined;
  // WP 3.5 - clinical handoffs. ONE binding for the routes (flag + service), the expiry tick, the notification consumer's
  // ports and the offboarding sweep, so they share a store; off unless the tenant flag `messaging.handoffs` is on (the tick
  // and the sweep run regardless of the flag). The caseload and patient-label ports are M5's (injected, M36 never imports M5).
  let m36HandoffWarn: (message: string, context: Record<string, string>) => void = (
    message,
    context,
  ) => console.warn(message, context);
  const m36Handoffs = dbHandle
    ? buildHandoffDeps({
        warn: (message, context) => m36HandoffWarn(message, context),
        db: dbHandle.db,
        flags: featureFlagReader,
        outbox: m36OutboxPublisher,
        messaging: createDbMessagingRouteService(dbHandle.db),
        caseloadPatientIds: (organizationId, userId) =>
          getSeam("CaseloadProvider").caseloadPatientIds({ organizationId, userId } as never),
        patientLabels: (organizationId, patientIds) =>
          patientDisplayLabelsForOrg(dbHandle.db, organizationId, patientIds),
        permissionsFor: async (organizationId, userId) =>
          resolveActorPermissions({ organizationId, userId }),
      })
    : undefined;
  // WP 3.8 - lifecycle review queue. ONE binding for the routes (flag `messaging.tasks` + service) and the lifecycle consumer's
  // queue port, so they share a store. The consumer queues regardless of the flag (a safety record); the routes and the alerts
  // honour it. The Part 2 gate, active-user check and display-name resolver default to the platform's own.
  let m36ReviewWarn: (message: string, context: Record<string, string>) => void = (
    message,
    context,
  ) => console.warn(message, context);
  const m36Review = dbHandle
    ? buildReviewDeps({
        db: dbHandle.db,
        flags: featureFlagReader,
        outbox: m36OutboxPublisher,
        messaging: createDbMessagingRouteService(dbHandle.db),
        patientLabels: (organizationId, patientIds) =>
          patientDisplayLabelsForOrg(dbHandle.db, organizationId, patientIds),
      })
    : undefined;
  // WP 3.10 - "ask a nurse about a medication". One binding for the routes; off unless the tenant flags
  // `messaging.medication_questions` AND `messaging.tasks` are on. Never an order path: it reads no order or prescribing
  // permission. The same messaging service instance sends the message, link and task in one transaction.
  const m36MedicationQuestions = dbHandle
    ? (() => {
        // Same outbox as the mounted routes, so the question's message events (mentions, hints) fire like any send.
        const messaging = createDbMessagingRouteService(dbHandle.db, {
          outbox: m36OutboxPublisher,
        });
        return buildMedicationQuestionDeps({
          db: dbHandle.db,
          flags: featureFlagReader,
          outbox: m36OutboxPublisher,
          messaging: {
            canViewChannel: messaging.canViewChannel,
            sendMessage: messaging.sendMessage,
          },
          permissionsFor: async (organizationId, userId) =>
            resolveActorPermissions({ organizationId, userId }),
        });
      })()
    : undefined;
  // WP 4.2 - acknowledgment requests (ADR-0069). ONE binding for the routes, the urgent entry's in-transaction hook and the
  // notification consumer; creating a request is off unless the tenant flag `messaging.ack_requests` is on (an existing request can
  // always be settled). Stores the request and its history and exposes four transitions; it does not time, route, escalate or page
  // anyone (WP 4.3 - 4.5).
  const m36Ack = dbHandle
    ? (() => {
        const messaging = createDbMessagingRouteService(dbHandle.db, {
          outbox: m36OutboxPublisher,
        });
        return buildAckDeps({
          db: dbHandle.db,
          flags: featureFlagReader,
          outbox: m36OutboxPublisher,
          messaging: { canViewChannel: messaging.canViewChannel },
          permissionsFor: async (organizationId, userId) =>
            resolveActorPermissions({ organizationId, userId }),
        });
      })()
    : undefined;
  // WP 4.4 - durable escalation timers (ADR-0070). The DATABASE decides what is due; a delayed BullMQ job per (request, tier,
  // window) and a per-minute sweeper only wake the escalation, which is one guarded write. The ACTION is behind the ops flag
  // `messaging.escalation_timers` (default off): with it off a due request is left untouched. The router is the M19 seam
  // (today the fail-closed deny-stub), resolved lazily and wrapped in the org-checking guard; the timer queue exists only with a
  // Redis connection, otherwise nothing is armed and the sweeper alone wakes the escalation.
  let m36AckEscalationError: (
    context: { organizationId: string; requestId: string },
    err: unknown,
  ) => void = (context, err) =>
    console.error("M36 ack escalation request failed", {
      ...context,
      reason: err instanceof Error ? err.name : "unknown",
    });
  // M14 on-demand packet build: ONE producer on the existing `idg.packets-cron` queue (the worker that consumes it
  // is registerM14CronWorkers); same queue + same owner as the cron, so `arch:queue-names` is unchanged.
  const m14PacketBuildQueue = queueConnection
    ? new Queue(M14_QUEUES.packetsBuild, { connection: queueConnection })
    : undefined;
  const m36AckTimerQueue = queueConnection
    ? new Queue(MESSAGING_QUEUES.ackEscalationTimer, { connection: queueConnection })
    : undefined;
  // WP 4.10 (ADR-0077) - snooze (non-urgent out-of-band notices only) and reminders. ONE binding for the routes and the minute sweep; off
  // unless the tenant flag `messaging.notification_policy` is on. A snooze never quiets an urgent or acknowledgment-bound alert.
  const m36SnoozeReminders = dbHandle
    ? buildSnoozeReminderBinding({
        db: dbHandle.db,
        flags: featureFlagReader,
        messaging: createDbMessagingRouteService(dbHandle.db),
      })
    : undefined;
  // The walk skips a candidate who cannot view the channel (ADR-0070 limit i). A consent-seam outage must retry the tick, not read as
  // "cannot view" (which would skip the user and could end the ladder), so this one instance throws on it.
  const m36EscalationCanView = dbHandle
    ? createDbMessagingRouteService(dbHandle.db, { throwOnSeamUnavailable: true }).canViewChannel
    : undefined;
  const m36AckEscalation =
    m36Ack && m36EscalationCanView
      ? buildEscalationBinding({
          flags: featureFlagReader,
          store: m36Ack.store,
          outbox: m36OutboxPublisher,
          router: {
            resolveTier: (orgId, request) => getEscalationRouter().resolveTier(orgId, request),
          },
          stillQualified: m36Ack.stillQualified,
          canViewChannel: m36EscalationCanView,
          ...(m36AckTimerQueue ? { timers: createBullmqTimerPort(m36AckTimerQueue) } : {}),
          // Ids and the error class only: a database error can carry statement parameters. Swapped for the app logger below.
          onError: (context, err) => m36AckEscalationError(context, err),
        })
      : undefined;
  // WP 4.1 - "Urgent clinical". One binding for the routes; off unless the tenant flags `messaging.urgent_clinical` AND
  // `messaging.sbar` are on. It stores and marks an urgent message and tells the named recipient in-app; it does not page,
  // escalate or acknowledge (WP 4.2 - 4.4).
  const m36Urgent = dbHandle
    ? (() => {
        const messaging = createDbMessagingRouteService(dbHandle.db, {
          outbox: m36OutboxPublisher,
        });
        return buildUrgentDeps({
          db: dbHandle.db,
          flags: featureFlagReader,
          outbox: m36OutboxPublisher,
          messaging: {
            canViewChannel: messaging.canViewChannel,
            sendMessage: messaging.sendMessage,
          },
          permissionsFor: async (organizationId, userId) =>
            resolveActorPermissions({ organizationId, userId }),
          // WP 4.2: the request is created in the send transaction when `messaging.ack_requests` is on.
          ...(m36Ack ? { responseTracker: m36Ack.responseTracker } : {}),
        });
      })()
    : undefined;
  // WP 3.7 - chart promotion. ONE binding for the routes (flag + service), the ChartPromotionSourceReader seam M8 and M14
  // read, and the two outbox consumers' ports; off unless the tenant flag `messaging.promotions` is on (the outcome
  // consumer records an owner's decision regardless of the flag). The snapshot reader opens message bodies with the SAME
  // cipher instance the messaging provider uses (`m36MessageBodyCipher`, passed to wireModuleSeams below): no second crypto.
  let m36PromotionWarn: (message: string, context: Record<string, string>) => void = (
    message,
    context,
  ) => console.warn(message, context);
  const m36MessageBodyCipher = createMessageBodyCipher();
  const m36Promotions = dbHandle
    ? buildPromotionDeps({
        warn: (message, context) => m36PromotionWarn(message, context),
        db: dbHandle.db,
        flags: featureFlagReader,
        outbox: m36OutboxPublisher,
        messaging: createDbMessagingRouteService(dbHandle.db),
        bodyOpener: m36MessageBodyCipher,
        permissionsFor: async (organizationId, userId) =>
          resolveActorPermissions({ organizationId, userId }),
      })
    : undefined;
  // F-173 (#248, m1 group) — the Drizzle-backed `SystemStatusReader` (`bootstrap/system-status-store.ts`).
  // F-156 found the composition root never overrode the in-memory boot default, so `POST
  // /admin/system/status` had never once persisted to the real `system_status` table in any environment.
  // Same `dbHandle`-gated swap shape as `featureFlagReader` immediately above; `system_status` carries no
  // RLS, so the reader is safe on the same handle with no org envelope (see the store file's own header).
  const systemStatusReader = dbHandle ? createDrizzleSystemStatusReader(dbHandle.db) : undefined;
  // ── WP 5.7 export builder/sweep (ADR-0089, PROPOSED): the artefact builder, the download reader and the expiry sweep, bound once over the
  // object store, the tenant KEK and the message body cipher; the build queue's enqueuer feeds the `m36.export.approved` consumer below.
  const m36Export = dbHandle
    ? buildM36ExportBinding({
        db: dbHandle.db,
        outbox: m36OutboxPublisher,
        env: process.env,
        kekRing: loadPlatformKekRing(process.env),
        bodyCipher: m36MessageBodyCipher,
      })
    : null;
  const m36ExportBuildEnqueuer = queueConnection
    ? createExportBuildEnqueuer(queueConnection)
    : null;
  // ── end WP 5.7 export builder/sweep binding
  const app = buildServer({
    db: dbHandle?.db,
    authenticate,
    tenantHost,
    ...(featureFlagReader ? { featureFlagReader } : {}),
    ...(systemStatusReader ? { systemStatusReader } : {}),
    // WX-PR-017 — SD-055 rate-limit tiers enforced cluster-wide over the dedicated Valkey connection
    // above when REDIS_URL is set; falls back to the M1 baseline's own per-process default otherwise
    // (a slice/test/no-Redis boot, where a single process IS the whole "cluster").
    security: {
      // CORS is a browser HTTP concern. Native callback schemes are trusted only inside Better Auth
      // and must never become Access-Control-Allow-Origin values.
      corsAllowOrigins: resolveWebTrustedOrigins(),
      ...(rateLimitStore ? { rateLimitStore } : {}),
      ...(rateLimitTiers ? { rateLimitTiers } : {}),
    },
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
      outboxDepthThreshold: Number(process.env.OUTBOX_READY_DEPTH_THRESHOLD ?? 500),
      capabilities: () => ({
        m22DocumentUpload: s3ObjectStoreConfigFromEnv(process.env) ? "ready" : "disabled",
        m23AsyncWorkers: m23SubmissionQueues ? "ready" : "disabled",
        m24AsyncWorkers: m24SubmissionQueues ? "ready" : "disabled",
        m34AsyncWorkers: m34ProvisionQueue ? "ready" : "disabled",
        // The Socket.IO server runs in the api role only; "degraded" = Valkey fan-out is down (polling still works).
        realtime: realtimeRef ? realtimeRef.state() : "disabled",
      }),
    }),
    // Postgres-backed idempotency. The bootstrap default is an in-memory Map, and nothing ever
    // replaced it — so on the production mount an Idempotency-Key was process-local: a retry landing
    // on another replica re-ran the mutation, which for the M23/M26/M30 write surfaces that REQUIRE
    // the header means a duplicated claim submission or settlement. Absent a DB the in-memory default
    // still applies (slice/tests), which is correct: there is nowhere durable to put it.
    ...(dbHandle ? { idempotencyStore: createDbIdempotencyStore(dbHandle.db) } : {}),
    // Mount module REST routes when a DB client is present (progressive backend wiring). M3 first:
    // the role catalog runs on the real Drizzle RoleStore; other module routes append here as their
    // stores land. The slice/tests boot without this (foundation routes only).
    registerModuleRoutes: dbHandle
      ? (app) => {
          // M3 — role catalog + grants on real stores; TASK-004 threads the boot-registered RBAC
          // handle so /me/permissions + anti-escalation read the live engine and grant/revoke/edit
          // drop the §2.5 cache immediately.
          mountAuthorizationRoutes(
            app,
            dbHandle.db,
            liveRbacHandle,
            m3OutboxPublisher as M3OutboxPublisher,
            // The minted auditor link is emailed (M2 `auth.send_magic_link`); without a web origin the
            // delivery throws and the enrolment route answers 503 rather than reporting a phantom invite.
            createAuditorLinkEmailDelivery({
              transport: linkEmailTransport,
              baseUrl: webAppBaseUrl,
              ...(appOriginFor ? { baseUrlFor: appOriginFor } : {}),
            }),
          );
          // GAP-011 — engagements (createDbEngagementStore) and auditor sessions (M2's durable
          // `auditor_magic_link` issuer behind the AuditorSessionMinter seam) are both durable now; the
          // break-glass Compliance notification is durable via the m3.breakglass.invoked outbox event (GAP-010).
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
          const rbacForProposals = liveRbacHandle;
          const proposedRoleResolver: ActorPermissionResolver = rbacForProposals
            ? ({ organizationId, userId }) =>
                rbacForProposals.resolver({ organizationId, userId } as Parameters<
                  RbacEngineHandle["resolver"]
                >[0])
            : () => new Set<string>();
          mountIdentityRoutes(app, dbHandle.db, createDbAdminMembershipReader(dbHandle.db), {
            emailTransport,
            webAppBaseUrl,
            ...(appOriginFor ? { appOriginFor } : {}),
            // GAP-008 — both halves share the LIVE rbac resolver (same §2.5 cache the routes use): the
            // guard bounds a proposal at invite time, the attacher re-bounds it by the INVITER's
            // permissions at accept. Without an engine handle the resolver is empty ⇒ fail closed.
            roleAttacher: createDbProposedRoleAttacher(
              dbHandle.db,
              proposedRoleResolver,
              m3OutboxPublisher as M3OutboxPublisher,
            ),
            proposedRoleGuard: createProposedRoleGuard({
              lookup: createDbOrgRoleLookup(dbHandle.db),
              effectivePermissions: proposedRoleResolver,
              audit: createTenantAuditExecutor(dbHandle.db),
            }),
            credentialAdmin: createIdentityCredentialAdmin(auth!),
            provisioningRoles: createDbProvisioningRoleResolver(dbHandle.db),
            validateLocations: (organizationId, locationIds) =>
              withOrgContext(dbHandle.db, { organizationId, userId: "" }, (tx) =>
                buildFoundationSiteReader().allLocationsOpenInOrg(
                  tx as unknown as DbClient,
                  organizationId,
                  locationIds,
                ),
              ),
            // #138/F-060/F-116 — the day-one dashboard seed, bound the same way as roleAttacher just
            // above and for the identical import-boundary reason (M33's implementation; M2 cannot
            // import it).
            dashboardSeeder: createDbSystemDashboardSeeder(dbHandle.db),
            outbox: m2OutboxPublisher,
            // GAP-115 — M5's deceased-status fact for the funeral-home link (M2 may not read M5's table).
            deceasedPatients: {
              isDeceased: (organizationId, patientId) =>
                patientIsDeceasedForOrg(dbHandle.db, organizationId, patientId),
            },
            // GAP-115 follow-up - the DURABLE collaborator / funeral link store (migration 0521): M6's siting of the
            // patient (the ARCH-011 columns), the server-only Better Auth session mint a redemption ends in, the
            // delivery channel (UNBOUND in production until the email provider is - see above), the redemption
            // throttle and M5's minimum decedent read for `GET /funeral/case`.
            linkPatientSite: {
              siteForPatient: (organizationId, patientId) =>
                patientSiteForOrg(dbHandle.db, organizationId, patientId),
            },
            ...(auth ? { linkSessions: createLinkSessionMinter(auth) } : {}),
            ...(linkDelivery ? { linkDelivery } : {}),
            linkRedeemThrottle,
            ...(auth ? { passwordVerifier: createPasswordVerifier(auth) } : {}),
            unlockGuard,
            // #602 - an org-less session's unlock has no tenant: the platform-scoped audit writer takes the row.
            platformUnlockAudit: (input) =>
              auditPlatformEvent(dbHandle.db, {
                eventType: input.eventType,
                resourceKind: "session",
                resourceId: input.sessionId,
                outcome: input.outcome,
                correlationId: input.correlationId,
                retentionClass: "compliance",
                context: { userId: input.userId },
              }),
            ...(mfaGate ? { mfaGate } : {}),
            funeralCases: {
              read: (organizationId, patientId) =>
                funeralCaseForOrg(dbHandle.db, organizationId, patientId),
            },
          });
          // GAP-115 — the M2 org-admin surface (organizations, provider entities, locations, tenant step-up
          // overrides). `POST /provider-entities` seals the EIN with the tax-id cipher bound below; unbound it would
          // answer 503 TAX_ID_CIPHER_UNBOUND — an EIN is never stored in the clear.
          mountOrgAdminRoutes(app, dbHandle.db, {
            outbox: m2OutboxPublisher,
            // The EIN is sealed under the tenant's own DEK from M34's key ring (resolved per call, so this is safe to
            // build before M34 registers; until a platform KEK is bound the provider refuses and the create fails
            // closed with a 5xx rather than storing an EIN in the clear).
            taxIdCipher: createTaxIdCipher({
              dekForOrg: (orgId) => getTenantKeyProvider().dekForOrg(orgId),
              dekForOrgVersion: (orgId, version) =>
                getTenantKeyProvider().dekForOrgVersion(orgId, version),
            }),
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
          mountOrganizationLifecycleRoutes(app, dbHandle.db, m2OutboxPublisher, (organizationId) =>
            tenantHostResolver?.invalidateOrganization(organizationId),
          );
          // M2 §2.2.4 / §7.7 — redeem an emailed auditor link into a scoped, read-only `auditor` session.
          // Public (the token is the credential); M3 grants the one least-privilege role inside the
          // redemption transaction; Better Auth mints the signed session cookie. Per-IP and per-org attempt
          // budgets over the shared Valkey store (in-memory only on a single instance without one).
          if (auth) {
            const auditorLimiterStore = rateLimitStore ?? createInMemoryRateLimitStore();
            const auditorLimiter = (keyPrefix: string, limit: number) =>
              createBudgetedRateLimiter(auditorLimiterStore, {
                limit,
                windowMs: 15 * 60 * 1000,
                keyPrefix,
                onStoreError: (err) =>
                  app.log.warn({ err }, "auditor redeem rate-limit store error"),
              });
            const auditorAccess = createDbAuditorAccessGrantor();
            registerAuditorRedeemRoutes(app, {
              redemption: {
                db: dbHandle.db,
                sessions: createAuditorSessionIssuer(auth),
                access: auditorAccess,
                onRedeemed: (organizationId, userId) =>
                  liveRbacHandle?.invalidateActor(organizationId, userId),
              },
              ipLimiter: auditorLimiter("auditor-redeem:ip", 20),
              orgLimiter: auditorLimiter("auditor-redeem:org", 200),
            });
            // M2 §7.7 — the enrolment ceremony an `auditor` session must finish (BAA terms + second factor)
            // before it can read. The role grant happens HERE, at activation, not at redemption.
            registerAuditorEnrolmentRoutes(app, {
              enrolment: createAuditorEnrolment({
                db: dbHandle.db,
                access: auditorAccess,
                onActivated: (organizationId, userId) =>
                  liveRbacHandle?.invalidateActor(organizationId, userId),
              }),
              ipLimiter: auditorLimiter("auditor-enrol:ip", 60),
              userLimiter: auditorLimiter("auditor-enrol:user", 30),
            });
          }
          // ADR-0049 Phase 4 — unauthenticated tenant discovery: the host's public name for the sign-in page, and the
          // `app.` landing's "email me my organization's address". Both 404 unless TENANT_BASE_DOMAIN is set.
          {
            const publicTenantStore = rateLimitStore ?? createInMemoryRateLimitStore();
            const publicTenantLimiter = (keyPrefix: string, limit: number) =>
              createBudgetedRateLimiter(publicTenantStore, {
                limit,
                windowMs: 15 * 60 * 1000,
                keyPrefix,
                failClosed: true, // an unauthenticated email-sending route: an outage must not lift its budget
                onStoreError: (err) =>
                  app.log.warn({ err }, "public tenant rate-limit store error"),
              });
            registerPublicTenantRoutes(app, {
              baseDomain: tenantBaseDomain,
              ...createDbPublicTenantLookups(dbHandle.db),
              emailTransport,
              ipLimiter: publicTenantLimiter("find-my-org:ip", 10),
              emailLimiter: publicTenantLimiter("find-my-org:email", 3),
              onBackgroundError: (err) =>
                app.log.warn({ err }, "find-my-organization email failed"),
            });
          }
          mountAuditRoutes(app, dbHandle.db, {
            outbox: m4OutboxPublisher,
            countGovernanceOverlay: countHoldOverlayMessages,
          }); // M4 — audit-log search + GAP-003 compliance surface
          // M5 — patient census/chart reads + §4.3 direct merge (F-171, #248) + the Privacy Officer surface
          // (§4.2 resync, §5.1 /patients/:id/privacy). The officer's cross-module reads are ports: M39 answers
          // the Part 2 consent state, M22 the DocLens SUD batches, M4's audit query the snapshot's trail.
          mountPatientRoutes(
            app,
            dbHandle.db,
            m5OutboxPublisher,
            {
              consent: buildPart2ConsentStateReader(dbHandle.db),
              intake: buildIntakeSudBatchReader(dbHandle.db),
              history: (() => {
                const auditQuery = createDbAuditQuery(dbHandle.db);
                return {
                  async snapshotHistory(organizationId: string, patientId: string) {
                    const page = await auditQuery.searchEvents(organizationId, {
                      resourceKind: "patient_privacy_flag_snapshot",
                      resourceId: patientId,
                      limit: 100,
                    });
                    return page.items.map((e) => ({
                      at: e.createdAt,
                      actorUserId: e.actorUserId,
                      eventType: e.eventType,
                      before: e.before,
                      after: e.after,
                    }));
                  },
                };
              })(),
            },
            {
              // GAP-119 — the census KPI strip's admission-owned figures: M6 publishes the org-explicit read, M5
              // receives it as a port (no cross-module table read).
              admissionSummary: (organizationId) =>
                admissionCensusSummaryForOrg(dbHandle.db, organizationId),
              // GAP-010 — the SSN / state-id envelope over M34's per-tenant key ring. The provider is resolved per
              // call, so this is safe to build before M34 registers; until a platform KEK is bound the key ring
              // refuses `dekForOrg` and SSN capture answers 503 IDENTIFIER_CIPHER_UNBOUND (never an unencrypted write).
              identifierCipher: createPatientIdentifierCipher(
                lazyIdentifierKeys(getTenantKeyProvider),
              ),
            },
          );
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
            // GAP-022 — the F2F performer role is derived from the clinician's real role grants.
            buildF2fClinicianRoleReader(dbHandle.db),
            // FY2027 R-F2F-06 — the § 418.22(b)(4) signed-clinical-note attestation reads M8's note facts.
            {
              signedNoteFor: (orgId, encounterId) =>
                signedEncounterNoteForOrg(dbHandle.db, orgId, encounterId),
            },
            // FY2027 — the election statement addendum routes (42 CFR 418.24(c)/(d)).
            m6ElectionAddendum ?? undefined,
            // Readmission workflow — whether the prior election's NOTR / final claim is on file (M23's own query;
            // M6 may not import M23, so the fact crosses here).
            {
              closureFor: (organizationId, q) =>
                priorElectionClosureForOrg(dbHandle.db, organizationId, q),
            },
          ); // M6 — reads + the T02 referral/admission write lifecycle over Drizzle+RLS, m6.* transactional outbox
          // Clinical core (M7–M14, M17, M18, M22) — reads mounted over the real Drizzle route services under
          // RLS, replacing the retired in-memory scaffold. Each module's write lifecycle is live (no route
          // returns 501). See each module's `*-route-service-db.ts`.
          mountCarePlanRoutes(app, dbHandle.db, m7OutboxPublisher); // M7 — reads + the T02 write lifecycle over Drizzle+RLS, m7.* transactional outbox
          // M8 — reads + the T02 write lifecycle over Drizzle+RLS, m8.* transactional outbox. Two DEK
          // envelopes over the SAME M34 key ring M39's consent notes and M31's status reasons use:
          // `hearthnote_selection.free_text_cipher` (§3.6, #114) and
          // `hearthnote_assembled_output.layer1_cipher` / `final_cipher` (§2.6, #122). On a DB boot the key
          // ring is LIVE (`registerLiveM34Seams`, #105 / ADR-0045); only a DB-less slice boot, or a deployment
          // with no platform KEK / provision gateway, leaves it unbound, and then both refuse with
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
          // M11 — reads + the write lifecycle over Drizzle+RLS, m11.order.* transactional outbox. F-181 (#248): the
          // fourth argument is what lets a signed lab order request its outbound HL7 ORM (M5 demographics, M40
          // physician + facility, M29's single active `orm_outbound` feed) — refused-not-fabricated when unresolvable.
          mountOrderRoutes(
            app,
            dbHandle.db,
            m11OutboxPublisher,
            buildM11OrmRequestedPorts({
              patient: hl7OrmDemographicsInTx,
              feeds: buildDrizzleOutboundFeedResolver(),
              // F-188 — the evidence the attested recovery checks a `not_received_by_lab` against.
              outboundEvidence: ormOutboundEvidenceForOrder,
            }),
            // F-202 — the two-person recovery control's compliance alerts. The seam is resolved LAZILY (at emit time):
            // it is registered during boot, after the routes mount.
            m11RecoveryControls,
          );
          // F-201 (#248) — the held-order worklist: lab orders waiting on a human's verification with the lab.
          registerHeldTransmissionRoutes(app, {
            recovery: buildM11StuckRecovery(dbHandle.db, m11OutboxPublisher),
          });
          mountDoseSpotRoutes(app, dbHandle.db, m12OutboxPublisher, {
            transmissionEnabledFor: (organizationId) =>
              m12TenantConfig.isConfiguredFor(organizationId),
          }); // M12 — reads + the write lifecycle over Drizzle+RLS, m12.* transactional outbox
          // F-230 (#248) — the public `POST /webhooks/dosespot` (HMAC + replay window + dedup + DEK-encrypted receipt;
          // Dispensed/PickedUp -> `medication_order_dispense` + `m12.medication_order.dispensed_at_pharmacy`).
          // FAIL-CLOSED: with no `DOSESPOT_WEBHOOK_SECRETS` bound (the default — no DoseSpot credentials exist)
          // the route answers 503 to everything and logs one warning; it never verifies against a default.
          registerDoseSpotWebhookRoute(app, {
            db: dbHandle.db,
            outbox: m12OutboxPublisher,
            secrets: createEnvWebhookSecretResolver(),
            cipher: createWebhookBodyCipher(getTenantKeyProvider()),
          });
          mountEmarRoutes(app, dbHandle.db, m13OutboxPublisher); // M13 — reads + the write lifecycle over Drizzle+RLS, m13.* transactional outbox
          mountIdgRoutes(
            app,
            dbHandle.db,
            m14OutboxPublisher,
            {
              // M14 read enrichment — org-explicit BATCHED seams bound as locally-declared ports (M14 imports no M5/M6 code):
              // M5 "First L." + MRN last-4 for the agenda/packet/decision/action-item reads, and M6's per-patient recert/F2F
              // window (M6's own window math) for GET /idg/meetings/:id/recert-windows.
              patientDisplay: {
                displayForPatients: (organizationId, patientIds) =>
                  patientDisplayLabelsForOrg(dbHandle.db, organizationId, patientIds),
              },
              recertWindows: {
                recertWindowsForPatients: (organizationId, patientIds) =>
                  idgRecertWindowsForOrg(dbHandle.db, organizationId, patientIds),
              },
              // M2's identity-owned batched staff display read (name only) — the minutes "Finalized by".
              membershipDisplay: {
                displayForMemberships: (organizationId, membershipIds) =>
                  membershipDisplayForOrg(dbHandle.db, organizationId, membershipIds),
              },
              // M1's org-explicit site display read (organization + location NAMES only) — the minutes PDF header.
              siteDisplay: {
                displayForSite: (organizationId, locationIds) =>
                  siteDisplayForOrg(dbHandle.db, organizationId, locationIds),
              },
              // M3's authorization-owned batched role-key read (keys only) — the authoritative basis M14 validates an
              // attendance row's discipline against when a coordinator records SOMEONE ELSE (attendance trust, 0286).
              membershipRoles: {
                roleKeysForMemberships: (organizationId, membershipIds) =>
                  membershipRoleKeysForOrg(dbHandle.db, organizationId, membershipIds),
              },
            },
            (q) => getCaseloadProvider().caseloadPatientIds(q),
            m14PacketBuildQueue ? createBullmqPacketBuildQueuePort(m14PacketBuildQueue) : undefined,
            // Fail-open (availability control only, not a probing oracle): 10/min/user, 60/min/org.
            createRouteRateLimit({
              store: rateLimitStore ?? createInMemoryRateLimitStore(),
              limit: M14_PACKET_BUILD_ROUTE_RATE_LIMIT,
              keyPrefix: "m14-packet-build",
            }),
          ); // GAP-128 — M14 packet/idg-history per-patient scope over M5's registered CaseloadProvider; M14 — reads + the write lifecycle over Drizzle+RLS, m14.*/idg.decision_recorded transactional outbox
          mountSchedulingRoutes(app, dbHandle.db, m17OutboxPublisher); // M17 — reads + the write lifecycle over Drizzle+RLS, m17.* transactional outbox
          // GAP-055 follow-up (ADR-0035): the device-attestation requirement + session-device binding are behind
          // `EVV_DEVICE_ATTESTATION_ENFORCED` (default OFF — no attested client exists yet). Read ONCE here from the
          // process env (already validated by `assertProductionEnv`) and injected — never from a request.
          const evvDeviceAttestationEnforced = isEvvDeviceAttestationEnforced(process.env);
          app.log.info(
            { deviceAttestationEnforced: evvDeviceAttestationEnforced },
            evvDeviceAttestationEnforced
              ? "M18 EVV capture: device attestation + session-device binding ENFORCED"
              : "M18 EVV capture: device attestation + session-device binding NOT enforced (EVV_DEVICE_ATTESTATION_ENFORCED unset/false; capture records the clinician's most-recently-approved device)",
          );
          mountEvvRoutes(app, dbHandle.db, m18OutboxPublisher, {
            deviceAttestationEnforced: evvDeviceAttestationEnforced,
            // GAP-133 — capture seals coords under the tenant DEK; no key bound ⇒ the capture is refused.
            coordsCipher: m18CoordsCipher(),
            // A coordinate the location list cannot open reads as null and is logged as an integrity fault.
            onCoordsFault: ({ organizationId, eventId, error }) =>
              app.log.error(
                { organizationId, eventId, err: error },
                "M18 coords could not be opened",
              ),
          }); // M18 — reads + the write lifecycle over Drizzle+RLS, m18.evv.* transactional outbox
          // M22 — reads + the write lifecycle over Drizzle+RLS; the reader is the `documents.doclens` DocLens gate
          // (F-091). F-235 (#248): review completion now PUBLISHES `m22.extraction.commit_requested` (the
          // DocLens → M5 demographics writeback), so the mount takes the m22 publisher + the tenant-DEK
          // cipher that decrypts `extraction_candidate.value_cipher` server-side at commit.
          mountDocumentRoutes(
            app,
            dbHandle.db,
            featureFlagReader,
            {
              outbox: m22OutboxPublisher,
              cipher: createCandidateValueCipher(getTenantKeyProvider()),
            },
            // F-236 — `POST /intake/uploads/:id/extraction/run` enqueues; the worker process runs it.
            queueConnection ? createDocLensIntakeEnqueue(queueConnection) : undefined,
          );
          mountTerminologyRoutes(app, dbHandle.db, featureFlagReader, {
            ...(m38Producer ? { jobs: m38Producer } : {}),
            ...(m38S3 ? { uploads: createPlatformUploadSigner(m38S3, m38PlatformBucket) } : {}),
            embeddingsAvailable: embedderUnavailable.available,
          });
          if (m38Producer) {
            app.addHook("onClose", async () => {
              await Promise.all(m38Producer.queues.map((q) => q.close()));
            });
          }
          // M38 (GAP-108: the load / refresh-embeddings routes now enqueue the §4.3 jobs; /uploads presigns the platform bucket) — terminology read surface + tenant value-set extensions (FB-T01), the §4.1 value-set catalog + §7.3 remediation report + the platform-ops admin surface (GAP-063); the reader is the §7.7 `ai.full` semantic-search gate (F-091)
          mountMdmRoutes(app, dbHandle.db); // M40 — MDM entity directory + overlay/BAA + platform-ops (FB-T02)
          mountConsentRoutes(app, dbHandle.db, {
            outbox: m39OutboxPublisher,
            cipher: createConsentInternalNotesCipher(getTenantKeyProvider()),
            patientReader: getConsentPatientReader(),
            // GAP-171 — the manual cascade retry raises the CRITICAL cascade-failed alert on exhaustion too.
            alerts: getSeam("AlertEmitter") as M39AlertPort,
          }); // M39 — immutable consent lifecycle + transactional outbox/render
          mountMessagingRoutes(app, dbHandle.db, {
            // ── WP 5.7 (ADR-0089, PROPOSED) restricted messaging export: request / decide / read side (B1). Requesting is behind the tenant
            // flag `messaging.export`; approve, reject, cancel and download never are. The builder side adds `artefactReader` here.
            messagingExport: {
              flags: featureFlagReader,
              holds: async (organizationId, userId, permissionKey) =>
                (await resolveActorPermissions({ organizationId, userId })).has(permissionKey),
              // WP 5.7 export builder/sweep: the decrypting reader the download route calls (absent => the download is refused 503).
              ...(m36Export ? { artefactReader: m36Export.artefactReader } : {}),
            },
            // ── end WP 5.7 export mount
            // WP 5.8 (ADR-0087, PROPOSED) - break-glass read grants; honoured only while the tenant flag `messaging.break_glass` is on.
            breakGlass: {
              flags: featureFlagReader,
              holdsInvoke: async (organizationId, userId) =>
                (await resolveActorPermissions({ organizationId, userId })).has(
                  "messaging.break_glass.invoke",
                ),
            },
            // WP 5.5 (ADR-0083) - device and session manager. Revoking a session closes its sockets on every api node through the Valkey
            // emitter; with realtime off there are no sockets to close. Always on: a security control has no tenant flag.
            sessionDevices: {
              ...(realtimeEmitter
                ? {
                    disconnectSession: (sessionId: string) =>
                      realtimeEmitter.disconnectRoom(sessionRoom(sessionId)),
                  }
                : {}),
              warn: (event, context) => app.log.warn(context, event),
            },
            // GAP-063 — delivers the sms/email endpoint OTP; unbound => registration answers 503.
            sendEndpointVerificationCode: outOfBandBinding.sendEndpointVerificationCode,
            outbox: m36OutboxPublisher,
            attachments: m36AttachmentBinding,
            // WP 5.6 (ADR-0086) - retention overview and legal holds: M4's hold seam (apply/release in the caller's tx) and the audit reader.
            retentionGovernance: {
              holds: createMessagingGovernanceHoldPort({ outbox: m4OutboxPublisher }),
              auditQuery: createDbAuditQuery(dbHandle.db),
              // "placed by" / redaction people: M2's by-id directory reader (M36 reads no identity table).
              staffNames: readStaffNames,
              // The single-officer redaction fallback (PROVISIONAL, off per tenant): the tenant flag and M3's count of people who can approve.
              redactionFallback: {
                enabled: async (organizationId: string) =>
                  (await featureFlagReader?.forOrg(organizationId))?.[
                    REDACTION_SINGLE_OFFICER_FLAG_KEY
                  ] === true,
                eligibleApprovers: buildActivePermissionHolderCounter(
                  createMembershipsHoldingPermissionReader(dbHandle.db),
                ),
              },
              // The destruction executor's mode for the screen: the tenant ops flag, then the deployment's execute switch.
              destructionMode: async (organizationId) =>
                m36RetentionDestructionWired
                  ? retentionDestructionModeOf(
                      (await featureFlagReader?.forOrg(organizationId))?.[
                        RETENTION_DESTRUCTION_FLAG_KEY
                      ] === true,
                      process.env[RETENTION_DESTRUCTION_EXECUTE_ENV] === "true",
                    )
                  : "off",
            },
            globalSearch: {
              keys: m36SearchKeys,
              ...(m36NameExclusions ? { exclusions: m36NameExclusions } : {}),
              ...(m36SearchRateLimit.rateLimit ? { rateLimit: m36SearchRateLimit.rateLimit } : {}),
            },
            globalSearchRateLimitActive: m36SearchRateLimit.active,
            // WP 2.12 - ephemeral presence/typing; Valkey when REDIS_URL is set, off unless the tenant flag is on.
            presence: buildPresenceDeps({
              redis: rateLimitRedisClient,
              rateLimitStore,
              flags: featureFlagReader,
              onStoreError: (err) => app.log.warn({ err }, "presence rate-limit store unavailable"),
            }),
            // WP 3.2 - message -> clinical record links; read-through, off unless the tenant flag is on.
            clinicalLinks: buildClinicalLinkDeps({ db: dbHandle.db, flags: featureFlagReader }),
            // WP 3.3 - SBAR structured messages; off unless the tenant flag `messaging.sbar` is on.
            sbar: buildSbarDeps({ db: dbHandle.db, flags: featureFlagReader }),
            // WP 3.4 - communication tasks; off unless the tenant flag `messaging.tasks` is on.
            ...(m36Tasks ? { tasks: m36Tasks } : {}),
            // WP 3.5 - clinical handoffs; off unless the tenant flag `messaging.handoffs` is on.
            ...(m36Handoffs ? { handoffs: m36Handoffs } : {}),
            // WP 3.8 - lifecycle review queue; off unless the tenant flag `messaging.tasks` is on.
            ...(m36Review ? { review: m36Review } : {}),
            // WP 3.10 - ask a nurse about a medication; off unless tenant flags `messaging.medication_questions` AND `messaging.tasks` are on.
            ...(m36MedicationQuestions ? { medicationQuestions: m36MedicationQuestions } : {}),
            // WP 4.1 - urgent clinical message; off unless tenant flags `messaging.urgent_clinical` AND `messaging.sbar` are on.
            ...(m36Urgent
              ? {
                  urgent: {
                    ...m36Urgent,
                    // Fail-closed per-user / per-org / per-pair limiter; the in-memory store is per replica (weaker, still bounded).
                    rateLimit: buildUrgentRateLimit(
                      rateLimitStore ?? createInMemoryRateLimitStore(),
                      { isReplay: m36Urgent.isReplay },
                    ),
                  },
                }
              : {}),
            // WP 4.2 - acknowledgment requests; creating one is off unless tenant flag `messaging.ack_requests` is on.
            ...(m36Ack
              ? {
                  ackRequests: {
                    service: m36Ack.service,
                    // Fail-closed per-user / per-org / per-pair limiter on create and reassign; per replica on the in-memory store.
                    rateLimit: buildAckRateLimit(rateLimitStore ?? createInMemoryRateLimitStore()),
                    // ADR-0078: the picker reads have their own buckets.
                    candidatesRateLimit: buildAckRateLimit(
                      rateLimitStore ?? createInMemoryRateLimitStore(),
                      { keyPrefix: ACK_PICKER_RATE_LIMIT_KEY_PREFIX },
                    ),
                  },
                }
              : {}),
            // WP 4.10 - snooze and reminders; off unless the tenant flag `messaging.notification_policy` is on.
            ...(m36SnoozeReminders
              ? { snoozeReminders: { service: m36SnoozeReminders.service } }
              : {}),
            // WP 6.1 (ADR-0100) - smart work inbox (read-only); off unless the tenant flag `messaging.smart_inbox` is on.
            smartInbox: { flags: featureFlagReader },
            // WP 3.7 - chart promotion; off unless the tenant flag `messaging.promotions` is on.
            ...(m36Promotions ? { promotions: m36Promotions } : {}),
            // WP 3.6 - IDG discussions (read-only); off unless tenant flags `messaging.idg` AND `messaging.clinical_links` are on.
            idgDiscussions: buildIdgDiscussionDeps({ db: dbHandle.db, flags: featureFlagReader }),
            // WP 4.12 - on-call directory (read-only); off unless the tenant flag `messaging.oncall_directory` is on.
            oncall: buildOnCallDirectoryDeps({ db: dbHandle.db, flags: featureFlagReader }),
            // WP 5.9 (ADR-0084) - workforce offboarding: preview and run the offboarding of a departed user. Always on (a security control).
            // It calls the sweeps the deactivation event already runs, the ADR-0078 supervisor reassign and the ADR-0083 session revoke.
            ...(m36Ack && m36Tasks && m36Handoffs
              ? {
                  offboarding: {
                    ack: m36Ack.service,
                    attention: {
                      alerts: getSeam("AlertEmitter") as AlertEmitter,
                      opsNotice: (notice) => m36AckOpsNotice(notice),
                    },
                    endMemberships: (orgId: string, userId: string) =>
                      endChannelMembershipsForUser(dbHandle.db, orgId, userId),
                    reassignTasks: m36Tasks.reassignForLeaver,
                    resolveHandoffs: m36Handoffs.reassignForLeaver,
                    warn: (event: string, context: Record<string, string>) =>
                      app.log.warn(context, event),
                  },
                }
              : {}),
          }); // M36 — channel/thread/alert-inbox/prefs reads (FB-T04; writes → FB-T05) + WP 1.5 attachments
          // GAP-101 — the §4.9 inbound vendor webhooks (Twilio sms/voice status, Postmark event): signature-authenticated
          // (replay window + HMAC / IP allowlist + bearer), reconciling `notification_delivery`. FAIL-CLOSED: a vendor
          // secret that is not configured answers 503 and never verifies against a default.
          mountMessagingWebhookRoutes(app, { db: dbHandle.db, outbox: m36OutboxPublisher });
          // M34 (Phase 2D) — mount the platform-ops + tenant-scoped surfaces over the DRIZZLE route services
          // (RLS-scoped reads under withPlatformContext/withOrgContext; commands enqueue the §4.3 queue job
          // through the BullMQ producer). The platform queue producer + the tenant queue producer are the
          // SAME Valkey connection the workers run on. The platform service's cross-tenant reads are audited
          // through `m34PlatformBypassAuditor`; tenant reads are live, while async commands refuse until the
          // worker capability set is complete. Both fall back to the in-memory slice when no DB client is present (tests).
          const m34PlatformEnqueue = buildPlatformEnqueue(queueConnection);
          const m34TenantEnqueue = buildTenantEnqueue(queueConnection);
          mountTenantPlatformRoutes(app, dbHandle.db, {
            platform: buildDrizzlePlatformService({
              platformDb: platformDbHandle?.db ?? dbHandle.db,
              enqueue: m34PlatformEnqueue.enqueue,
              provisionJobs: m34PlatformEnqueue.provisionJobs,
              // Any active hold (org-wide, patient-scoped or messaging-only) blocks destroying the tenant's key.
              legalHoldClear: async (organizationId) => {
                const scope = await activeLegalHoldScopeForOrg(dbHandle.db, organizationId);
                return !scope.orgWide && !scope.messagingHeld && scope.patientIds.size === 0;
              },
              ...(m34ProvisionGateway
                ? { invitationDelivery: m34ProvisionGateway.invitation }
                : {}),
              auditBypass: m34PlatformBypassAuditor,
              outbox: m34OutboxPublisher,
              // F-091 — M1 owns the `feature_flag` schema, so the §4.7 admin seam is built here and
              // injected rather than constructed inside M34 (which would create a schema import edge the
              // route file's own header says must not exist). On the PLATFORM pool: migration 0001's write
              // policies never admit a NULL org, so a platform-global flag is uncreatable from a tenant
              // connection by design.
              featureFlags: createDrizzleFeatureFlagAdmin(
                platformDbHandle?.db ?? dbHandle.db,
                // §4.7 kill switch — audited emergency control; only with a real platform credential
                // (without one the seam refuses 501 rather than flip a flag unaudited).
                platformDbHandle
                  ? buildFeatureFlagKillSwitchPorts({
                      platformDb: platformDbHandle.db,
                      auditBypass: m34PlatformBypassAuditor,
                      outbox: m34OutboxPublisher,
                      auditCritical: (tx, event) =>
                        auditPlatformEvent(tx, {
                          eventType: event.eventType,
                          resourceKind: "feature_flag",
                          resourceId: event.resourceId,
                          outcome: "success",
                          severity: "critical",
                          correlationId: event.correlationId,
                          context: event.context,
                        }),
                    })
                  : undefined,
              ),
            }),
            tenant: buildDrizzleTenantService({
              db: dbHandle.db,
              enqueue: m34TenantEnqueue.enqueue,
            }),
            // GAP-164 - the cross-tenant DSAR list + onboarding read/skip (audited platform credential) and the
            // tenant account + feature-flag routes (tenant pool; flags through the same M1 admin seam).
            ...(platformDbHandle
              ? {
                  platformOps: {
                    service: createDrizzlePlatformOpsService({
                      platformDb: platformDbHandle.db,
                      auditBypass: m34PlatformBypassAuditor,
                      platformJobId: M34_PLATFORM_JOB_ID,
                    }),
                  },
                }
              : {}),
            tenantAccountFlags: {
              service: createDrizzleTenantAccountFlagsService({
                db: dbHandle.db,
                flags: createDrizzleFeatureFlagAdmin(platformDbHandle?.db ?? dbHandle.db),
              }),
            },
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
                    app.log.warn({ err }, "signup rate-limit store unavailable — failing open"),
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
              tenantKeys: { dekForOrg: (orgId) => getTenantKeyProvider().dekForOrg(orgId) },
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
          // GAP-087 — the CAHPS pipeline's cipher + vendor-adapter map (R-11 config sealing, R-15 file download).
          const m30Cahps = buildM30CahpsWiring({
            db: dbHandle.db,
            keys: {
              dekForOrg: (orgId) => getTenantKeyProvider().dekForOrg(orgId),
              dekForOrgVersion: (orgId, version) =>
                getTenantKeyProvider().dekForOrgVersion(orgId, version),
            },
            outboxPublisher: m30OutboxPublisher,
            deathsForOrg: (organizationId, period) =>
              cahpsDeathCandidatesForOrg(dbHandle.db, organizationId, period),
            caregiverContactForOrg: (organizationId, patientId) =>
              primaryCaregiverContactForOrg(dbHandle.db, organizationId, patientId),
          });
          mountM30Routes(app, {
            cahpsExportFile: m30Cahps.exportFile,
            // D19 — M5's minimum-necessary display read ("First L." + MRN last-4), injected as a port; M30 reads no
            // M5 table. Only surfaced to callers holding `mortality.read_with_patient`.
            patientDisplay: {
              displayForPatients: (organizationId, patientIds) =>
                patientDisplayLabelsForOrg(dbHandle.db, organizationId, patientIds),
            },
            readService: buildDrizzleM30ReadService(dbHandle.db),
            writeService: buildDrizzleM30WriteService(dbHandle.db, {
              recompute: m30Recompute.enqueue,
              outbox: m30OutboxPublisher,
              // #107 item 3 — resolve provider_entity_id server-side for the NOT-NULL provider-scoped
              // compliance inserts (incident / infection / QAPI program / CAHPS ingest), inside the
              // mutation's own org-context tx. Removes the prior fail-closed 503.
              // GAP-154 — a patient-linked write is stamped with the SUBJECT's admission provider entity
              // (M6's org-explicit siting seam), not the org's primary one; the primary stays the fallback.
              providerEntity: {
                ...buildPrimaryProviderEntityResolver(),
                providerEntityIdForPatient: async (organizationId, patientId) =>
                  (
                    await activeAdmissionSitingForPatientForOrg(
                      dbHandle.db,
                      organizationId,
                      patientId,
                    )
                  )?.providerEntityId ?? null,
              },
              ...m30Cahps.writePorts,
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
            // GAP-058 — the inbound Stripe webhook binds when the signing secret, the payload key AND the
            // platform credential are all configured; otherwise it stays 503 (never half-bound).
            webhook:
              m35PlatformRunner && m35Stripe.webhookSecret && m35Stripe.cipher
                ? {
                    ingest: buildM35WebhookIngest({
                      platformRunner: m35PlatformRunner,
                      webhookSecret: m35Stripe.webhookSecret,
                      encryptor: m35Stripe.cipher,
                    }),
                  }
                : {},
            service: buildDrizzleM35RouteService(dbHandle.db, {
              outbox: m35OutboxPublisher,
              // GAP-060 — a client-supplied payment-method id is verified against Stripe (attached to THIS
              // org's customer) before it is stored; unset => attach refuses 503.
              ...(m35Stripe.client
                ? { paymentMethodVerifier: createStripePaymentMethodVerifier(m35Stripe.client) }
                : {}),
              // M35A-T03 — resolve the M2 `OrganizationReader` seam LAZILY (per call, after validateSeams has
              // applied its graceful deny-stub / M2 has registered the real reader), so the platform-ops admin
              // lists label cross-tenant rows with an org display name instead of a raw UUID.
              organizationReader: {
                readByIds: (ids) => getSeam("OrganizationReader").readByIds(ids),
              },
              // Platform-ops cross-tenant runner: each call is ONE allowlisted ("m35-subscription-admin"),
              // audited (`platform.bypass_invoked` via the shared M34 auditor) `withPlatformContext` tx against
              // the platform credential. Undefined → fail-closed (503), never a tenant-pool read.
              platformRunner: m35PlatformRunner,
            }),
          });
          // M37 (Inpatient Unit / IPU Management) — mount the §4.1 core route spine over the Drizzle route
          // service. Each mutation opens its own withOrgContext (RLS scopes every statement to app.org_id),
          // drives the pure @chartwarden/inpatient §2 machines, and emits its §4.4 m37.* event through the
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
              // F-219 — the intake worklist's M19 GIP-proposal entries: a SEAM PULL through M19's
              // org-explicit published read (M37 has no `dependsOn` edge to M19, so the port is injected
              // here). No outbox consumer and no M37 table — see `m19.triage_call.gip_admission_proposed`.
              gipProposals: {
                proposalsForOrg: (organizationId) =>
                  gipProposalsForOrg(dbHandle.db, organizationId),
              },
            }),
          });
          // M23 (Billing — Medicare) — mount the §4.1 route plugins over the Drizzle READ + WRITE services +
          // the boot-time claim-assembly service. Each mutation opens its own withOrgContext (RLS scopes every
          // statement to app.org_id), runs the pure @chartwarden/billing lifecycle reducer, and emits its §4.10
          // m23.* event through the catalog-validating tx publisher (callerModule `m23`) in the same unit of
          // work (D2 outbox-only). The assembly service binds ten of its eleven cross-module reader seams for
          // real (M5 payer, the five M6 range seams, M8 billable/signed encounters, M18 EVV, M38 terminology,
          // M40 provider entity + physician identity, all four referenceData methods) — see
          // `boot-assembly.ts`'s header for the exact per-seam accounting of what remains a deny-stub and
          // why; a still-unbound reader raises the typed 503 SEAM_UNBOUND, never a fabricated claim. The
          // §4.8 BullMQ submit/eligibility producer and the M1 secret-cipher / M4 override-audit ports are
          // injected where configured and stay fail-closed otherwise.
          //
          // `provider_entity` is M1-owned (arch:tables), so BOTH the write-service's control-number
          // derivation and the assembly-service's `mdm.resolveProviderEntity` bind the SAME `ProviderCcnPort`
          // instance here, rather than each module reading the schema directly.
          const { providerCcn: m23ProviderCcn, assemblyPorts: m23AssemblyPorts } =
            buildM23AssemblyPorts(dbHandle.db);
          mountM23Routes(app, {
            // F-210 — the tenant-entered hospice rate table (`/billing/rate-tables`); the SAME table the
            // assembly service's `referenceData.perDiemRateTable`/`chcHourlyRateCents` read (M23-owned, so
            // the boot assembly reads it over `dbHandle.db` directly — no injected port).
            rateTableService: buildDrizzleRateTableService(dbHandle.db),
            // The tenant-entered hospice visit-charge schedule (`/billing/visit-charge-schedules`); the SAME table the
            // assembly service reads the charge each visit line is billed at (M23-owned, over `dbHandle.db`).
            visitChargeService: buildDrizzleVisitChargeService(dbHandle.db),
            // F-211 — the tenant-entered CMS wage index (`/billing/wage-indexes`), read by the same boot assembly.
            wageIndexService: buildDrizzleWageIndexService(dbHandle.db),
            platformAdminService: buildDrizzlePlatformAdminService(dbHandle.db),
            // F-212 — the tenant-entered sequestration policy (`/billing/sequestration-policies`); the SAME table the
            // assembly service's `referenceData.activeSequestrationPolicy` reads (M23-owned, over `dbHandle.db`).
            sequestrationService: buildDrizzleSequestrationPolicyService(dbHandle.db),
            readService: buildDrizzleM23ReadService(dbHandle.db, {
              // How each claim's stay ended, from M6's live facts (org-explicit, batched): the claim list /
              // detail "needs attention" block — missing place of death / receiving care setting, and a Type
              // of Bill the resolver now derives differently (812/813 → 811/814).
              stayEndFacts: {
                forAdmissions: (orgId, admissionIds) =>
                  claimStayEndFactsForOrg(dbHandle.db, orgId, admissionIds),
              },
              // The hospice-periods read reports `hets_not_configured` when no transport is bound.
              hetsConfigured: m23HetsConfig !== null,
              // Two-tier RHC carry-over on the readmission screen: M6's earlier stays, merged with HETS.
              priorStays: {
                async forPatient(organizationId, patientId) {
                  const episodes = await priorEpisodesForOrg(
                    dbHandle.db,
                    organizationId,
                    patientId,
                  );
                  // Incl. a transfer-in's sending-hospice span (same election, carries into the count).
                  return rhcPriorStayFacts(episodes);
                },
              },
            }),
            writeService: buildDrizzleM23WriteService(dbHandle.db, {
              outbox: m23OutboxPublisher,
              // Readmission — a new NOE waits for the prior election's NOTR / final claim (M6's prior-stay facts).
              priorLiveEndedStay: {
                async latestPriorLiveEndedAdmission(organizationId, q) {
                  const prior = latestLiveEndedEpisode(
                    await priorEpisodesForOrg(
                      dbHandle.db,
                      organizationId,
                      q.patientId,
                      q.currentAdmissionId,
                    ),
                  );
                  return prior ? { admissionId: prior.admissionId } : null;
                },
              },
              jobs: buildM23OutboxBackedSubmissionGate({
                "claim.submit": m23SubmissionQueues !== null,
                "noe.submit": m23SubmissionQueues !== null,
                "notr.submit": m23SubmissionQueues !== null,
                // GAP-070 — real `validation-run` worker + outbox bridge whenever a queue connection exists.
                [M23_QUEUES.validationRun]: m23WorkQueues !== null,
                // HETS 270/271: accepted only when a transport is configured AND a worker can drain the
                // queue; otherwise refuse (503) rather than accept a request no worker can complete.
                "eligibility.refresh": m23WorkQueues !== null && m23HetsConfig !== null,
              }),
              providerCcn: m23ProviderCcn,
              ...(m23MacSecretCipher ? { secretCipher: m23MacSecretCipher } : {}),
              // §4.5 validation override: one prominent audit_event per override, in the override's own transaction.
              audit: buildM23OverrideAuditPort(),
              // GAP-144 — the MAC sandbox probe (portal health) when the launch gateway is configured.
              ...(m23LaunchGateway
                ? {
                    macSandbox: {
                      probe: async ({ macJurisdiction }) => {
                        const up = await m23LaunchGateway.macPortal.probeHealth(macJurisdiction);
                        return {
                          ok: up,
                          detail: up ? "MAC portal reachable" : "MAC portal unavailable",
                        };
                      },
                    },
                  }
                : {}),
            }),
            assemblyService: buildM23BootAssemblyService(dbHandle.db, {
              outbox: m23OutboxPublisher,
              providerCcn: m23ProviderCcn,
              ...m23AssemblyPorts,
            }),
            // The receiving hospice's Medicare transfer notice (TOB 8xC / 8xD, CMS Pub. 100-04 ch. 11
            // §20.1.3–§20.1.4). Submission rides the same outbox → BullMQ bridge + launch gateway as the NOE;
            // M6's org-explicit transfer-in read refreshes our admission date + physicians before filing.
            // ADR-0052 — the DDE work queue (human work tracking; no DDE integration or credential).
            attemptResolutionService: buildClearinghouseAttemptResolutionService(
              createDrizzleAttemptStore(dbHandle.db),
            ),
            ddeQueueService: buildDdeQueueService(dbHandle.db, {
              outbox: m23OutboxPublisher,
              // Assignable only to an active member whose role grants billing.dde.work (M3's holder reader).
              assigneeCanWork: buildDdeAssigneeEligibility(
                dbHandle.db,
                createMembershipsHoldingPermissionReader(dbHandle.db),
                createDbActorEnrichmentReader(dbHandle.db),
                ORG_WIDE_BILLING_SCOPE_ROLES,
              ),
            }),
            transferNoticeService: buildTransferNoticeService(dbHandle.db, {
              outbox: m23OutboxPublisher,
              jobs: buildM23OutboxBackedSubmissionGate({
                "transfer_notice.submit": m23SubmissionQueues !== null,
              }),
              transferInFacts: (organizationId, transferEventId) =>
                transferInNoticeContextForOrg(dbHandle.db, organizationId, transferEventId),
            }),
          });
          // M25 (Remittance & Denials) — mount the §4.1 route plugins over the Drizzle READ + WRITE
          // services. Each mutation opens its own withOrgContext (RLS scopes every statement to app.org_id),
          // validates the §2.2 transition via the pure domain machines, and version-checks the PATCH surfaces
          // (§2.5). The §4.5 m25.* transactional outbox publisher (`m25OutboxPublisher`) and the M38
          // terminology lookup (below) are BOUND on this db path — the no-op emit / deny-stub defaults only
          // apply to the db-less slice.
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
              const concept = await terminologyProvider.lookup("carc", carcCode);
              if (!concept) return null;
              const props = concept.properties;
              return {
                category: typeof props?.category === "string" ? props.category : "unmapped",
                plainLanguage: concept.display,
              };
            },
          };
          // WX-PR-012 — the 835 receive/post pipeline. The 835 is parsed in-process (TypeScript, ADR-0037); no
          // sidecar. No staged-object reader is wired yet, so `postAdvice` (which holds only the object key)
          // fails closed with a retryable X12_835_RAW_UNAVAILABLE until one is injected via `readRaw`.
          // `claims` binds M23's real ClaimSubmissionReader seam for Medicare advices and
          // M24's real MedicaidClaimMatchProvider seam for Medicaid advices (F-172, #248 m24 group) —
          // routed by each advice's own `payerKind` inside `service-drizzle.ts`; each degrades to "no
          // candidates"/"no patient id" — never fabricates or cross-routes a match — until its owning
          // module registers it, which now happens automatically at this same boot via
          // `registerM23PublishedSeams` / `registerM24PublishedSeams`.
          const m25IngestService = buildDrizzleM25IngestService(dbHandle.db, {
            client: createX12835Client(),
            onRetryableParseDegraded: (event) =>
              app.log.warn(
                event,
                "M25 835 post degraded (retryable); no staged-object reader wired?",
              ),
            outbox: m25OutboxPublisher,
            terminology: m25Terminology,
            claims: {
              medicare: buildM23BackedClaimMatchCandidateProvider(),
              medicaid: buildM24BackedClaimMatchCandidateProvider(),
            },
          });
          mountM25Routes(app, {
            readService: buildDrizzleM25ReadService(dbHandle.db, m25Terminology),
            // GAP-036 - the appeal packet reads the claim copy (M23) and the enclosure facts (M22) through their
            // published seams, so a bad enclosure id is refused at submit.
            writeService: buildDrizzleM25WriteService(dbHandle.db, m25OutboxPublisher, {
              appealSources: buildSeamAppealSourcePorts(),
              providerZones: (tx, providerEntityId) =>
                buildFoundationSiteReader().providerEntityTimezones(tx, providerEntityId),
            }),
            ingestService: m25IngestService,
            adrService: buildDrizzleAdrService(dbHandle.db, {
              // Milestone 2b: attachments are validated through M22/M23's seams and a filing emits the render
              // request on the same transaction (no outbox bound -> the filing is refused, never half-recorded).
              outbox: m25OutboxPublisher,
              sources: buildSeamAppealSourcePorts(),
              providerZones: (tx, providerEntityId) =>
                buildFoundationSiteReader().providerEntityTimezones(tx, providerEntityId),
            }),
            // Milestone 3: which path a denial takes (appeal vs. MAC reopening) and the reopening aggregate.
            reopeningService: buildDrizzleReopeningService(dbHandle.db),
            denialRouteService: buildDrizzleDenialRouteService(dbHandle.db),
            // Milestone 5: the TPE program tracker (programs, rounds, sampled claims, per-MAC thresholds).
            tpeService: buildDrizzleTpeService(dbHandle.db, {
              providerEntityExists: async (tx, organizationId, providerEntityId) =>
                (await buildFoundationSiteReader().providerEntityIdentifiers(
                  tx as never,
                  organizationId,
                  providerEntityId,
                )) !== null,
            }),
            // Milestone 4: QIC reconsideration evidence + decision clock, and the OMHA escalation.
            qicService: buildDrizzleQicService(dbHandle.db, {
              providerZones: (tx, providerEntityId) =>
                buildFoundationSiteReader().providerEntityTimezones(tx, providerEntityId),
            }),
            // Milestone 6a: submission attempts and receipts. Guided manual only: nothing is transmitted; the
            // esMD / fax adapters are unbound shells. The receipt document is validated through M22 / M23's seams.
            submissionService: buildDrizzleSubmissionService(dbHandle.db, {
              sources: buildSeamAppealSourcePorts(),
            }),
          });
          // M26 (Cap Management) — mount the §4.1 route plugins over the Drizzle READ + WRITE services; the
          // §4.10 `m26.cap.*` transactional outbox publisher binds here (events persist on the mutation's tx).
          mountM26Routes(app, {
            readService: buildDrizzleM26ReadService(dbHandle.db),
            writeService: buildDrizzleM26WriteService(
              dbHandle.db,
              m26OutboxPublisher,
              {
                ...(m26PsrFiles ? { files: m26PsrFiles } : {}),
                ...(m26PsrEnqueuer ? { enqueue: m26PsrEnqueuer.port } : {}),
              },
              async (tx, organizationId) => {
                // GAP-149 — the M40 CCN binding: the org's CCN when exactly one provider entity carries one.
                const rows = await (tx as DbClient)
                  .select({ ccn: schema.providerEntities.ccn })
                  .from(schema.providerEntities)
                  .where(eq(schema.providerEntities.organizationId, organizationId))
                  .limit(2);
                const ccn = rows.length === 1 ? rows[0]?.ccn : null;
                return typeof ccn === "string" && /^\d{6}$/.test(ccn) ? ccn : null;
              },
              // GAP-038 — M23's rate table supplies the inpatient-overage recoupment differential.
              (tx, organizationId, capYear, mix) =>
                resolveInpatientCapDifferential(
                  tx as Parameters<typeof resolveInpatientCapDifferential>[0],
                  organizationId,
                  capYear,
                  mix,
                ),
            ),
          });
          if (m26PsrEnqueuer)
            app.addHook("onClose", async () => void (await m26PsrEnqueuer.queue.close()));
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
          // patient-care-HOURS denominator for the 418.78(e) ratio is persisted on the hour ledger by the
          // nightly aggregator (M15-F04, migration 0347); the ratio answers `unavailable` only when it was
          // never computed or no signed visit has a resolved duration, never a fabricated 0%.
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
          const m16WriteService = buildDrizzleM16WriteService(dbHandle.db, m16ReadService, {
            outbox: m16OutboxPublisher,
            // GAP-129 — the tenant-DEK envelope (M34 key ring, resolved lazily like every other cipher below) for
            // a contact's email / phone / mailing address and a counselor's notes.
            cipher: createBereavementCipher({
              dekForOrg: (orgId) => getTenantKeyProvider().dekForOrg(orgId),
              dekForOrgVersion: (orgId, version) =>
                getTenantKeyProvider().dekForOrgVersion(orgId, version),
            }),
            // D6 — the confirm-contact consent gate. M39 answers over its published ConsentEvaluator seam
            // (the Drizzle store, read under withOrgContext for the caller's org): the contact's OWN
            // `bereavement_outreach_consent` record, pinned by id, and whether a survives-death
            // `family_caregiver_access` consent covers the decedent. Left unbound, the port fails closed
            // and refuses every confirm.
            bereavementConsentActive: createBereavementOutreachConsentProbe(getConsentEvaluator),
          });
          mountM16Routes(app, {
            readService: m16ReadService,
            writeService: m16WriteService,
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
          const m21AbacResolver = buildDrizzleSuppliesAbacResolver(dbHandle.db, {
            roleGrants: createDbEffectivePermissionStore(dbHandle.db),
          });
          const m21WriteService = buildDrizzleM21WriteService(dbHandle.db, m21ReadService, {
            outbox: m21OutboxPublisher,
            dispatcherEligible: async ({ organizationId, membershipId, locationId }) => {
              const roleKeys = await m21AbacResolver.roleKeysOf(organizationId, membershipId);
              const locationIds = await m21AbacResolver.locationIdsOf(organizationId, membershipId);
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
                if (typeof provider.isActiveEntity !== "function") return false;
                return await provider.isActiveEntity(organizationId, "dme_vendor", vendorId);
              } catch {
                return false;
              }
            },
          });
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
          // GAP-060 — the cipher, decipher and recipient counter ARE bound now (the "deliberately unbound"
          // paragraph above describes the pre-GAP-060 behaviour): the DEK envelope sits over
          // `getTenantKeyProvider()` (the M8/M29/M31/M39 precedent, resolved lazily) and the §4.5 count is
          // M20's own §4.3 supervisor registry (a floor — `null`, never 0, when nobody is confirmed).
          const m20Ciphers = createSafetyCiphers(lazyTenantKeys(getTenantKeyProvider));
          const m20ReadService = buildDrizzleM20ReadService(dbHandle.db, {
            decipher: m20Ciphers.decipher,
          });
          mountM20Routes(app, {
            // GAP-032 - PSAP line / terminus ledger status / readiness for the SOS terminus.
            terminus: {
              db: dbHandle.db,
              jurisdictions: () => getSeam("EmergencyServiceJurisdictionReader"),
              terminus: () => m20TerminusBag,
            },
            readService: m20ReadService,
            writeService: buildDrizzleM20WriteService(dbHandle.db, m20ReadService, {
              outbox: m20OutboxPublisher,
              cipher: m20Ciphers.cipher,
              recipientCountFor: createSosRecipientCounter({
                supervisorsForClinician: (orgId, membershipId, kind) =>
                  getSeam("SafetySupervisorProvider").supervisorsForClinician(
                    orgId,
                    membershipId,
                    kind,
                  ),
              }),
            }),
          });
          // M31 (Patient/Family Portal & Telehealth) — mount the forty-seven §4.1 routes over the Drizzle
          // store (the three owned tables) + the injected video adapter. GAP-051: the Daily.co adapter
          // is bound from TELEHEALTH_DAILY_* config (see telehealth/vendor-adapter.ts); with any of the three secrets
          // missing it stays UNBOUND (a fail-closed NOOP: join/record 503, webhooks 401) rather than reaching a
          // vendor with a half-configured key. Every lay READ route composes the upstream portal-summary seams and fails
          // CLOSED; the owned-table reads/writes (accounts, grants, telehealth lifecycle) are live over RLS.
          // The reason cipher seals the operator's suspend/reinstate reason (#117); it composes over the
          // SAME M34 key ring M39's consent notes use, which is live on a DB boot (`registerLiveM34Seams`);
          // it is a deny-stub only on a DB-less slice boot or when no platform KEK / provision gateway is
          // configured, and then those two routes refuse with 503 rather than recording an account status
          // change with no reason. Every other admin route is unaffected.
          // GAP-092 — the portal's provisioning services: account + grant creation (invitations), encrypted upload
          // staging handed to M22 intake, and notification preferences. Each cross-module fact arrives through a
          // locally-declared port bound HERE (M2 identity, M6 site, M39 consent, M22 intake); the sign-in credential
          // for an invitee stays M2's concern (magic link / password reset over the verified email).
          const portalTenantKeys = {
            dekForOrg: (orgId: string) => getTenantKeyProvider().dekForOrg(orgId),
            dekForOrgVersion: (orgId: string, version: string) =>
              getTenantKeyProvider().dekForOrgVersion(orgId, version),
          };
          const portalProvisioning = createPortalProvisioning({
            db: dbHandle.db,
            cipher: createPortalPhiCipher(portalTenantKeys),
            users: createPortalInviteeUserPort(dbHandle.db),
            consent: createPortalConsentPort(),
            site: {
              siteForPatient: (organizationId, patientId) =>
                patientSiteForOrg(dbHandle.db, organizationId, patientId),
            },
            delivery: createPortalInvitationDelivery({
              transport: emailTransport,
              baseUrl: process.env.PORTAL_APP_URL ?? webAppBaseUrl,
              ...(portalOriginFor ? { baseUrlFor: portalOriginFor } : {}),
            }),
            uploadIntake: buildPortalUploadIntakePort(dbHandle.db),
            // GAP-158 - accepting an invitation issued for a roster caregiver claims that caregiver for the login.
            caregiverLink: { linkInTx: linkCaregiverToUserInTx },
            // GAP-159 - invited / activated / granted ride the issue + accept transactions.
            events: m31Events,
          });
          // GAP-092 — a bereaved family member's own opt-out is M16's D9 transition (it cancels the contact's future
          // outreach); the scope read names which contact(s) the portal account is.
          const portalAuditQuery = createDbAuditQuery(dbHandle.db);
          mountM31Routes(app, {
            telehealth: buildDailyTelehealthAdapter(process.env),
            provisioning: portalProvisioning,
            bereavementOptOut: {
              async optOut({ organizationId, userId, portalAccountId }) {
                const scopes = await getSeam("BereavedPortalScopeProvider").scopeForPortalAccount(
                  organizationId,
                  portalAccountId as never,
                );
                let contactsOptedOut = 0;
                let alreadyOptedOut = 0;
                for (const scope of scopes) {
                  if (scope.status === "opted_out") {
                    alreadyOptedOut += 1;
                    continue;
                  }
                  if (!scope.mayOptOut) continue;
                  await m16WriteService.optOutContact(
                    {
                      organizationId,
                      userId,
                      membershipId: null,
                      roles: [],
                      sessionClass: "bereaved_portal",
                      locationIds: [],
                      portalAccountId,
                      stepUpRecent: false,
                    },
                    scope.contactId,
                    {
                      optOutKind: "full",
                      sourceKind: "portal_self_service",
                      reason: "opted out by the bereaved family member in the portal",
                    },
                  );
                  contactsOptedOut += 1;
                }
                if (contactsOptedOut === 0 && alreadyOptedOut === 0) {
                  throw new ChartWardenError(
                    "BEREAVEMENT_OPT_OUT_NOT_AVAILABLE",
                    "there is no bereavement contact on this account that can opt out right now",
                    409,
                  );
                }
                return { contactsOptedOut, alreadyOptedOut };
              },
            },
            // GAP-092 — the admin audit-views list: the account user's own read / disclosure trail from M4's
            // sanctioned `audit_event` reader (a page of the user's events, kept to the view / disclosure kinds).
            accountAudit: {
              async viewsForUser({ organizationId, userId, cursor, limit }) {
                const page = await portalAuditQuery.searchEvents(organizationId, {
                  actorUserId: userId,
                  ...(cursor ? { cursor } : {}),
                  ...(limit ? { limit } : {}),
                });
                return {
                  items: page.items
                    .filter((e) => /\.(viewed|list_viewed|disclosed)$/.test(e.eventType))
                    .map((e) => ({
                      eventId: e.id,
                      viewedAt: e.createdAt,
                      resourceKind: e.resourceKind,
                      eventType: e.eventType,
                    })),
                  nextCursor: page.nextCursor,
                };
              },
            },
            store: buildDrizzlePortalStore(dbHandle.db, m31Events),
            events: m31Events,
            // M31 invitee sign-in - M2's cross-tenant own-account read + the atomic session bind (migration 0520),
            // and the failed-bind throttle. Without these two routes would answer 503, never fake a sign-in.
            signIn: createPortalSignInStore(dbHandle.db, createOrgScopedAuditExecutor(dbHandle.db)),
            signInThrottle: portalSignInThrottle,
            reasonCipher: createPortalReasonCipher(getTenantKeyProvider()),
            // F-220 (#248) — the lazy telehealth room mint: M17's org-explicit published visit read + the
            // per-tenant DEK envelope for the two vendor-room columns. The vendor adapter stays UNBOUND above,
            // so a lazy mint fails closed (503) until a per-tenant vendor key vault exists.
            visitReader: {
              visitForOrg: (organizationId, visitId) =>
                getSeam("VisitReader").visitForEncounter(organizationId, visitId),
            },
            roomCipher: createPortalRoomCipher(getTenantKeyProvider()),
            // GAP-006 — the portal §164.526 submit lands as a real M5 `patient_amendment_request` row.
            amendmentIntake: createDbPortalAmendmentIntake(dbHandle.db),
            // GAP-092 — the caregiver-attested dose lands as a real M13 `administration_record`.
            caregiverAttestation: buildPortalCaregiverAttestationPort(
              dbHandle.db,
              m13OutboxPublisher,
            ),
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
            events: m32Events,
          };
          const m32PromptStore = createDrizzleAiPromptTemplateStore({
            db: dbHandle.db,
            platformDb: dbHandle.db,
            auditBypass: m34PlatformBypassAuditor,
            jobId: M32_PLATFORM_JOB_ID,
            events: m32Events,
          });
          // F-236 — R30 activation hashes the reviewed file it activates; an unresolvable reader made
          // every activation impossible. Same root as the seam-side registry (wireModuleSeams).
          const m32PromptArtifacts = createFilesystemAiPromptArtifactReader(
            process.env.AI_PROMPT_ROOT ?? process.cwd(),
          );
          const m32PromptRegistry = createAiPromptRegistry({
            store: m32PromptStore,
            artifacts: m32PromptArtifacts,
          });
          const m32Registry = createDrizzleAiCapabilityRegistryStore({
            db: dbHandle.db,
            platformDb: dbHandle.db,
            auditBypass: m34PlatformBypassAuditor,
            jobId: M32_PLATFORM_JOB_ID,
            events: m32Events,
          });
          // GAP-161 - the §4.8 triage-follow-up producer (R18 critical filing + R20 triage enqueue the plan).
          const m32FollowUp = queueConnection
            ? buildTriageFollowUpQueue(queueConnection)
            : undefined;
          if (m32FollowUp) app.addHook("onClose", () => m32FollowUp.queue.close());
          mountM32Routes(app, {
            followUpQueue: m32FollowUp?.port,
            governance: {
              registry: m32Registry,
              consent: createDrizzleAiTenantConsentStore({
                db: dbHandle.db,
                userId: "",
                events: m32Events,
              }),
              // W4.1's evidence resolver stays DENYING: the BAA / ZDR / clinical-reviewer checks are
              // three upstream seams nothing binds yet, and a default that answered "resolved" would
              // make the wave's most consequential consent gate a no-op indistinguishable from a
              // working one (governance/service.ts's header).
              evidence: createDenyingAiOptInEvidenceResolver(),
              evaluations: createDrizzleAiEvaluationRunStore(m32SafetyStoreDeps),
            },
            safety: {
              killSwitches: createDrizzleAiKillSwitchStore(m32SafetyStoreDeps),
              reports: createDrizzleAiHallucinationReportStore({
                db: dbHandle.db,
                userId: "",
                events: m32Events,
              }),
              evaluations: createDrizzleAiEvaluationRunStore(m32SafetyStoreDeps),
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
              events: m32Events,
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
            // GAP-083 — the request-time gates. The BAA port resolves the M40 seam LAZILY (a not-yet-
            // registered provider is the fail-closed deny-stub, never a boot error); the limiter is the
            // Valkey token bucket when REDIS_URL is set, per-process otherwise (the plugin's posture).
            baa: { isBaaActive: (input) => getFhirBaaStatusProvider().isBaaActive(input) },
            exports: m28ExportQueue
              ? { enqueue: m28ExportQueue.port, objects: m28ExportObjects }
              : undefined,
            rateLimiter: rateLimitRedisClient
              ? createRedisFhirClientRateLimiter(rateLimitRedisClient, {
                  onStoreError: (err) =>
                    app.log.warn({ err }, "M28 client rate limiter: Valkey error"),
                })
              : createInMemoryFhirClientRateLimiter(),
            tokenEndpointUrl: integrationEnabled(process.env, FHIR_TOKEN_ENDPOINT_ENABLED_ENV)
              ? process.env.FHIR_TOKEN_ENDPOINT_URL
              : undefined,
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
              // GAP-086 — an `mllp_client_cert` credential is validated + SEALED under the tenant DEK so the listener can bind it.
              credentialCipher: () => createM29InboundCipher(getTenantKeyProvider()),
            }),
            ...(m29NppesSync ? { nppesSyncTrigger: m29NppesSync.trigger } : {}),
          });
        }
      : undefined,
    registerModuleSeams: () =>
      wireModuleSeams({
        onEscalationRouterBound: (count) => {
          m19RouterBoundOrgCount = count;
        },
        sessionContextStore: dbHandle
          ? createDbSessionContextStore(
              dbHandle.db,
              createDbActorEnrichmentReader(dbHandle.db, {
                // GAP-007 - ids and counts only, never the scope body.
                onMalformedGrantScope: (report) =>
                  app.log.warn(report, "auth.grant_scope_malformed"),
              }),
            )
          : undefined,
        db: dbHandle?.db,
        organizationDb: platformDbHandle?.db,
        platformDb: platformDbHandle?.db,
        outboxPublisher: txOutboxPublisher,
        // F-165 (#248, m24 group) — see the client's own construction comment above.
        caseloadShiftCacheRedis: m5CaseloadShiftCacheRedisClient,
        messageBodyCipher: m36MessageBodyCipher,
        ...(m36Promotions ? { promotionSource: m36Promotions.sourceReader } : {}),
      }),
    registerModuleErasers: () =>
      wireModuleErasers({
        db: dbHandle?.db,
        platformDb: platformDbHandle?.db,
        destructionDb: destructionDbHandle?.db,
      }),
  });
  m31Warn = (message, context) => app.log.warn(context, message);
  m36TaskWarn = (message, context) => app.log.warn(context, message);
  m36HandoffWarn = (message, context) => app.log.warn(context, message);
  m36ReviewWarn = (message, context) => app.log.warn(context, message);
  m36PromotionWarn = (message, context) => app.log.warn(context, message);
  if (m23SubmissionQueues) {
    app.addHook("onClose", async () => {
      await Promise.all(m23SubmissionQueues.queues.map((queue) => queue.close()));
    });
  }
  app.addHook("onClose", async () => {
    await Promise.all(m23RevalidateEnqueue.queues.map((queue) => queue.close()));
    await Promise.all((m23WorkQueues?.queues ?? []).map((queue) => queue.close()));
  });
  if (m24SubmissionQueues) {
    app.addHook("onClose", async () => {
      await Promise.all(m24SubmissionQueues.queues.map((queue) => queue.close()));
    });
  }
  if (m24RevalidateEnqueue.queue) {
    const m24RevalidateQueue = m24RevalidateEnqueue.queue;
    app.addHook("onClose", async () => {
      await m24RevalidateQueue.close();
    });
  }
  if (m34ProvisionQueue) app.addHook("onClose", () => m34ProvisionQueue.close());
  // TASK-040B — close the readiness-probe's dedicated Redis connection on shutdown (the per-queue
  // BullMQ connections below close via their own onClose hooks; this one is health-check-only).
  if (redisHealthClient) app.addHook("onClose", () => redisHealthClient.quit());
  if (rateLimitRedisClient) app.addHook("onClose", () => rateLimitRedisClient.quit());
  // TASK-040C (OPS-005/006) — Prometheus metrics. HTTP + outbox counters/gauges register for EVERY
  // role (they're cheap and role-agnostic — an API-only replica's `chartwarden_outbox_pending_depth`
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
  // GAP-054 — how many active patients have no geocoded service address (each one's EVV captures record
  // `no_geofence_baseline`). Registered for every role; -1 when it cannot be measured (no DB / platform pool).
  const geocodeCoverageSampler: GeocodeCoverageSampler = async () => {
    if (!dbHandle || !platformDbHandle) return null;
    const activeOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M5_GEOCODE_COVERAGE_JOB_ID,
      reason: "GAP-054 geocode-coverage probe: active-org list",
    });
    return sampleGeocodeCoverage({
      listOrgs: () => activeOrgs.listActiveOrgs(),
      countForOrg: (organizationId) =>
        countActivePatientsWithoutGeocode(dbHandle.db, organizationId),
    });
  };
  registerGeocodeCoverageMetrics(metricsRegistry, geocodeCoverageSampler);
  // M36 WP 4.9 (ADR-0076) — overdue count and acknowledgment latency of the unacknowledged queue. Aggregated over the active orgs
  // (audited platform read of the org list only; the figures are counts under each org's RLS); -1 when it cannot be measured.
  // ADR-0079: the stalled-escalation figure is measured only for tenants with `messaging.escalation_timers` on.
  const ackQueueSampler = async () => {
    if (!dbHandle || !platformDbHandle) return null;
    const activeOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M36_ACK_QUEUE_METRICS_PLATFORM_JOB_ID,
      reason: "M36 WP 4.9 ack-queue gauges: active-org list",
    });
    const statsForOrg = createDbAckQueueStatsReader(dbHandle.db, {
      ...(m36AckEscalation ? { isEscalationEnabled: m36AckEscalation.isEnabled } : {}),
    });
    return sampleAckQueue({
      listOrgs: () => activeOrgs.listActiveOrgs(),
      statsForOrg: (organizationId) => statsForOrg(organizationId, new Date()),
    });
  };
  const ackQueueGuardedSampler = registerAckQueueMetrics(metricsRegistry, ackQueueSampler);
  // ADR-0079 (G-4) — ops notice claims shared across workers (Valkey `SET NX PX`; per process when Valkey is absent or errors), the one
  // ops sink for M36's ack notices, and the stalled-escalation watchdog: a plain timer in every process, independent of BullMQ, because
  // the per-org notices run INSIDE the sweep and cannot report that the sweep is not running.
  const m36OpsClaimsRedis = queueConnection
    ? new Redis({
        ...(queueConnection as RedisOptions),
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 2_000,
        retryStrategy: (times) => Math.min(times * 200, 2_000),
      })
    : undefined;
  m36OpsClaimsRedis?.on("error", () => {});
  const m36OpsNoticeClaims = createOpsNoticeClaims(m36OpsClaimsRedis);
  const m36AckOpsNotice = buildPlatformOpsNoticeSink({
    webhookUrl: process.env.OPS_ALERT_WEBHOOK_URL,
    log: (m) => app.log.warn(m),
  });
  if (dbHandle && platformDbHandle) {
    const stopAckQueueWatchdog = startAckQueueWatchdog({
      sample: ackQueueGuardedSampler,
      claims: m36OpsNoticeClaims,
      notify: m36AckOpsNotice,
    });
    app.addHook("onClose", async () => {
      stopAckQueueWatchdog();
      m36OpsClaimsRedis?.disconnect();
    });
  }
  if (dbHandle) {
    void warnOnGeocodeCoverageGap(geocodeCoverageSampler, {
      warn: (fields, message) => app.log.warn(fields, message),
      info: (fields, message) => app.log.info(fields, message),
    });
  }
  // GAP-083 follow-up — count ACTIVE FHIR clients whose BAA reference no longer resolves to an in-force M40
  // contract (they get 401 BAA_NOT_IN_FORCE on mint and reads). Fire-and-forget; never blocks boot. Org list
  // via the audited platform pool, client rows via the tenant pool under each org's RLS context.
  if (dbHandle) {
    const baaCoverageStore = createDrizzleFhirGatewayStore(dbHandle.db);
    const baaCoverageOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M28_BAA_COVERAGE_JOB_ID,
      reason: "GAP-083 FHIR client BAA coverage probe: active-org list",
    });
    void warnOnFhirBaaGap(
      () =>
        sampleFhirBaaCoverage({
          listOrgs: () => baaCoverageOrgs.listActiveOrgs(),
          activeClientRefs: async (organizationId) =>
            (await baaCoverageStore.listClients(organizationId, { status: "active" })).map(
              (c) => c.baaContractReference,
            ),
          baa: { isBaaActive: (input) => getFhirBaaStatusProvider().isBaaActive(input) },
          now: () => new Date().toISOString(),
        }),
      {
        warn: (fields, message) => app.log.warn(fields, message),
        info: (fields, message) => app.log.info(fields, message),
      },
    );
  }
  // GAP-006 — backfill: every ACTIVE org that predates the materializer (or was provisioned while it was unbound)
  // gets its roles. Create-only and idempotent, so it is safe on every boot; fire-and-forget like the probe above
  // (a failure is logged per org and never blocks boot - the first-admin accept re-materializes on demand).
  if (dbHandle && platformDbHandle) {
    const roleBackfillOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M3_ROLE_TEMPLATE_BACKFILL_JOB_ID,
      reason: "GAP-006 role-template backfill: active-org list",
    });
    void roleBackfillOrgs
      .listActiveOrgs()
      .then(async (orgs) => {
        for (const { organizationId } of orgs) {
          try {
            const result = await materializeRoleTemplatesForOrg(dbHandle.db, organizationId);
            if (result.rolesCreated.length > 0)
              app.log.info(
                { organizationId, roles: result.rolesCreated, grants: result.grantsCreated },
                "role templates materialized",
              );
          } catch (err) {
            app.log.error({ err, organizationId }, "role-template materialization failed");
          }
        }
      })
      .catch((err) => app.log.error({ err }, "role-template backfill could not list orgs"));
    // M34 - platform operators' alert-audience bindings: retry a provision-time bind that failed, pick up operators
    // added since, and expire the binding of any operator who no longer holds platform_ops. Boot-only, idempotent,
    // never resurrects a revoked membership (bootstrap/bind-platform-staff.ts). Failures are logged, never block boot.
    setPlatformStaffFailureSink((fields, message) => app.log.error(fields, message));
    void roleBackfillOrgs
      .listActiveOrgs()
      .then(async (orgs) => {
        const r = await reconcilePlatformStaff(dbHandle.db, orgs);
        if (r.bound + r.unbound + r.refreshed > 0)
          app.log.info(r, "platform-staff alert-audience bindings reconciled");
      })
      .catch((err) => app.log.error({ err }, "platform-staff reconcile could not list orgs"));
  }
  mountMetricsRoute(app, metricsRegistry);
  // WP 4.4 - the escalation timer queue the arming consumer adds to, and a boot report of what answers for the EscalationRouter. Until
  // M19 binds a router the registry holds the fail-closed deny-stub: an unacknowledged request cannot be routed to a tier, it
  // stays open and visible with its current assignee (ADR-0057, ADR-0070). Said once, loudly, so it is not a surprise.
  m36AckEscalationError = (context, err) =>
    app.log.error(
      { ...context, reason: err instanceof Error ? err.name : "unknown" },
      "M36 ack escalation request failed",
    );
  if (m14PacketBuildQueue) app.addHook("onClose", () => m14PacketBuildQueue.close());
  if (m36AckTimerQueue) {
    app.addHook("onClose", async () => {
      await m36AckTimerQueue.close();
    });
  }
  if (m36AckEscalation) {
    const NIL_UUID = "00000000-0000-0000-0000-000000000000";
    getEscalationRouter()
      .resolveTier(NIL_UUID, {
        patientId: NIL_UUID,
        requiredRole: ACK_ESCALATION_REQUIRED_ROLE,
        tier: 1,
        asOf: new Date().toISOString(),
      })
      .then((answer) => {
        // The probe asks about a nil org, which is never allowlisted: with orgs bound it would always read "deny-stub" and contradict the bound-for-N warning.
        if (answer.source === "deny_stub" && m19RouterBoundOrgCount === 0) {
          app.log.warn(
            "M36 EscalationRouter is the deny-stub (no M19 router is bound): unacknowledged requests cannot be escalated to a tier; they stay open with their assignee and the sender is told",
          );
        }
      })
      .catch((err) =>
        app.log.info(
          { reason: err instanceof Error ? err.name : "unknown" },
          "M36 EscalationRouter boot probe was refused (a bound router enforcing its org check)",
        ),
      );
  }
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
  // notes in registerModuleRoutes). CHARTWARDEN_INMEM_ASSERT=warn is the audit's one-iteration rollback.
  assertNoInMemoryBindingsOnDbBoot({ dbPresent: dbHandle !== undefined });
  if (dbHandle && auth) {
    // AC-05 — SECURITY_HARDENING §5.3.1's per-username + per-IP FAILED-attempt budgets. The global
    // SD-055 tier does cover /api/auth/* (it exempts no path, unlike the CSRF plugin), but it counts
    // ALL requests by IP at 30/min and so does nothing about a slow distributed run against one
    // named account — the credential-stuffing shape §5.3.1 actually names. Cluster-wide over Valkey
    // when REDIS_URL is set; per-replica otherwise. Usernames are hashed before they become keys.
    registerIdentityAuth(app, auth, {
      ...(authAuditSink ? { auditSink: authAuditSink, onAuditError: authAuditErrorLogger } : {}),
      // GAP-003/005 — record the factor a session PROVED at sign-in (TOTP / passkey / backup code) so the MFA matrix
      // can require assurance, not just enrolment. Fail closed: a failed write leaves the session unproven.
      ...(mfaGate && dbHandle
        ? {
            onSecondFactorVerified: async ({
              sessionId,
              factor,
            }: { sessionId: string; factor: "totp" | "webauthn" }) =>
              createDbSessionStepUpWriter(dbHandle.db).recordStepUp({
                sessionId,
                factor,
                at: new Date(),
              }),
            onSecondFactorError: (err: unknown) =>
              app.log.error({ err }, "recording the proved second factor failed"),
          }
        : {}),
      // GAP-005 — M2 §7.4: `two-factor/disable` is refused while the MFA matrix would no longer be met.
      ...(mfaGate
        ? {
            guard: async ({ relativePath, actor }) => {
              if (relativePath !== "/two-factor/disable" || !actor) return;
              const verdict = await mfaGate.forUserWithoutTotp(actor.userId);
              if (!verdict.satisfied)
                throw new ChartWardenError(
                  "MFA_REQUIRED_FOR_ROLE",
                  "your role requires a second factor; it cannot be disabled",
                  403,
                );
            },
          }
        : {}),
      credentialThrottle: createCredentialThrottle(
        rateLimitRedisClient
          ? createRedisFailedLoginStore(rateLimitRedisClient)
          : createInMemoryFailedLoginStore(),
        {
          onStoreError: (err) =>
            app.log.warn({ err }, "credential-throttle store unavailable — failing open"),
        },
      ),
    }); // AUTH-T02: mount /api/auth/* (needs BETTER_AUTH_SECRET/URL in prod)
    app.addHook("onClose", () => dbHandle.close());
  }
  // Close the separate M35 platform-ops credential pool on shutdown (when configured).
  if (platformDbHandle) app.addHook("onClose", () => platformDbHandle.close());
  if (destructionDbHandle) app.addHook("onClose", () => destructionDbHandle.close());

  // M37 D16 — the AI-prohibited-zone boot validator (§8.6). With a db, M32's real AIPromptRegistry is
  // registered (bootSeams ran inside buildServer), so this asks the D18 table-only query whether any active
  // prompt targets an M37 mutation zone (GIP criteria / IRC cap-override / restraint / body-release) and
  // REFUSES to listen if so — the deny-stub throws on a no-db slice boot, so it is gated on a real db. This
  // is belt-and-suspenders with the central AI_PROHIBITED_ZONES table (the R30 registration-time guard).
  if (dbHandle) {
    app.addHook("onReady", async () => {
      await validateIpuAIBlock(getSeam("AIPromptRegistry") as unknown as IpuAiPromptRegistryPort);
    });
    // GAP-137/141 — M21 D15, M23 D13 and M22 D7 AI-prohibited-zone boot validators, against the same real registry.
    app.addHook("onReady", async () => {
      const registry = getSeam("AIPromptRegistry") as unknown as IpuAiPromptRegistryPort;
      await validateSupplyAIBlock(registry);
      await validateBillingAiBlockAtBoot(registry);
      await validateDocumentsAIBlock(registry);
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
  // "the Phase 2D boot UPSERT" since the file was written while nothing performed it. GAP-057: complete —
  // M34's two recipient resolvers are registered on the emitter's registry (see registerMessagingSeams
  // above), so every rule is seeded; a nonzero skipped count is still logged.
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
            "M34 alert_rule seed skipped rules naming an unregistered recipient resolver",
          );
        }
      })
      .catch((err) => {
        app.log.error(err, "M34 alert_rule platform-default seed population failed");
      });
  }

  // ── worker-runner section (the M4-T11 BullMQ worker-construction precedent) ──────────────────────────
  // Construct the §4.3 M34 BullMQ Workers + the four cron-schedule Queue producers, and tear them down on
  // app close. Guarded by a Valkey connection (constructing a Worker opens the connection — never at import,
  // never in tests). When REDIS_URL is unset the workers are NOT constructed (the host still boots; the
  // command routes' enqueue ports already fail closed without a connection). The M4 audit workers
  // (GAP-014: registerAuditOpsWorkers/scheduleAuditOpsJobs) are constructed right after the M34 block below.
  // TASK-040A — also gated on `role !== "api"`: an API-only replica must not construct these (it would
  // re-register the same repeatable cron schedules on every replica and compete for the same jobs);
  // the "worker" role (or the default "all") does.
  if (role !== "api" && dbHandle && queueConnection) {
    // TASK-040D (OPS-012) — apply the shared `dlqPromotionSink` (declared above, before this block) to
    // EVERY module's constructed Worker set below (existing modules + TASK-040D's new M7/M9/M10 ones),
    // using BullMQ's own `Worker.name` (the queue name) as the source label — one call site, not one
    // bespoke wiring per module.
    const attachDlqAlertsToAll = (workers: readonly Worker[], modulePrefix: string): void => {
      for (const w of workers)
        attachDlqPromotionAlert(w, `${modulePrefix}:${w.name}`, dlqPromotionSink);
    };
    const m34Workers: Worker[] = [];
    // GAP-048 — the DSAR-export worker's object-store PUT + M22 DocumentRenderer capability. A fresh
    // SigV4 client off the SAME MINIO_* env contract M22 uses (not M22's own instance — createS3ObjectStore
    // is a pure stateless signer, nothing to share); `deriveTenantBucket`/`getDocumentRenderer` are M22's
    // real implementations, reachable here (the composition root) but not from M34's own module folder
    // (module-boundary discipline, ADR-0005 D1).
    const m34DsarS3Config = s3ObjectStoreConfigFromEnv(process.env);
    const m34DsarObjectStore = m34DsarS3Config ? createS3ObjectStore(m34DsarS3Config) : null;
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
              getDocumentRenderer().render({ orgId: args.organizationId }, "dsar_bundle", args),
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
          // WP 2.13: a published dek_rotation_completed drops this process's cached message-body DEKs for the org.
          outbox: {
            ...m34OutboxPublisher,
            async publish(...args: Parameters<typeof m34OutboxPublisher.publish>) {
              const result = await m34OutboxPublisher.publish(...args);
              const event = args[1];
              if (event.eventName === "m34.tenant.dek_rotation_completed") {
                invalidateMessageBodyKeys(event.organizationId ?? undefined);
              }
              return result;
            },
          },
          async destroyTenantKeyRing(input) {
            await platformDbHandle.db.transaction(async (tx) => {
              await tx.execute(
                sql`SELECT set_config('app.destroyed_by_membership_id', ${input.actorMembershipId}, true)`,
              );
              await tx.execute(
                sql`SELECT m34_destroy_tenant_key_ring(${input.tenantAccountId}, ${input.destructionCertId})`,
              );
            });
            // WP 2.13: this process must stop using a cached message-body DEK the moment the ring is destroyed (other
            // processes keep theirs for at most one cache TTL). The input names the tenant account, so drop every cached DEK.
            invalidateMessageBodyKeys();
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
                  actorUserId: await m34ActiveMembershipUserId(tx, input.actorMembershipId),
                };
              },
            };
          })(),
          shredSubjects: {
            patientIds: m34TenantPatientIds,
            // M36 D9 is the one sole-tenant rule: ANY membership elsewhere (revoked included) keeps the
            // identity; a revoked-only membership HERE still makes the user ours to erase.
            soleTenantUserIds: (platformDb, orgId) =>
              buildSoleTenantUserResolver({
                platformDb,
                auditBypass: m34PlatformBypassAuditor,
                jobId: M34_SHRED_SOLE_TENANT_JOB_ID,
              })(orgId),
          },
        },
      });
      const provisionWorker = registerM34ProvisionWorker(workerDeps);
      const dekRotateWorker = registerM34DekRotateWorker(workerDeps);
      m34Workers.push(provisionWorker);
      m34Workers.push(dekRotateWorker);
      app.addHook("onClose", () => Promise.all([provisionWorker.close(), dekRotateWorker.close()]));
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
      // GAP-163 — the nightly 7-day bundle reaper: DSAR / tenant-export bundles (PHI) are destroyed once their
      // presigned-URL TTL passes. Org-scoped sweep per active org (enumerated on the audited platform pool),
      // the object destroyed through the SAME stateless S3 client the export workers write with.
      if (m34DsarObjectStore) {
        const bundleExpiryWorker = registerM34BundleExpiryWorker({
          connection: queueConnection,
          db: dbHandle.db,
          listActiveOrgs: () =>
            buildActiveOrgEnumerator({
              platformDb: platformDbHandle.db,
              auditBypass: m34PlatformBypassAuditor,
              jobId: M34_PLATFORM_JOB_ID,
              reason: "M34 bundle-expiry sweep (active-org enumeration)",
            }).listActiveOrgs(),
          destroyObject: (args) =>
            m34DsarObjectStore.destroyAllVersions({
              bucket: deriveTenantBucket(args.organizationId),
              objectKey: args.objectKey,
              organizationId: args.organizationId,
            }),
          warn: (message, context) => app.log.warn(context, message),
        });
        m34Workers.push(bundleExpiryWorker);
        const bundleExpirySchedule = await scheduleM34BundleExpiryJob(queueConnection);
        app.addHook("onClose", () =>
          Promise.all([bundleExpiryWorker.close(), bundleExpirySchedule.close()]),
        );
      } else {
        app.log.warn(
          "M34 tenant.bundle_expiry_sweep NOT started: MINIO_* object-store configuration is absent, so DSAR / " +
            "tenant-export bundle objects will not be reaped after their 7-day TTL until it is configured",
        );
      }
      // GAP-163 - the three remaining M34 consumers. Platform sweeps run on the audited platform credential
      // (required by this block); onboarding is org-scoped on the tenant pool.
      const getM34AlertEmitter = () => getSeam("AlertEmitter") as AlertEmitter;
      // Automatic `onboarding → active`: the same lifecycle machine and guards as the platform route, driven by the
      // sweep under a system actor. It never enqueues, so its enqueue port refuses; the lifecycle alert goes through
      // the same lazily-resolved M36 emitter as the sweep's own alerts.
      const m34Activation = buildDrizzlePlatformService({
        platformDb: platformDbHandle.db,
        enqueue: {
          enqueue: async () => {
            throw new Error("the onboarding sweep's activation never enqueues a job");
          },
        },
        auditBypass: m34PlatformBypassAuditor,
        outbox: m34OutboxPublisher,
      });
      const m34SweepDeps = {
        activate: ({ tenantAccountId }: { tenantAccountId: string }) =>
          m34Activation.activateOnboardedTenant(tenantAccountId),
        connection: queueConnection,
        db: dbHandle.db,
        platformDb: platformDbHandle.db,
        auditBypass: m34PlatformBypassAuditor,
        outbox: m34OutboxPublisher,
        facts: {
          orgSeed: buildOrgSeedFactsReader(dbHandle.db),
          orgAdminCount: buildOrgAdminCountReader(dbHandle.db),
        },
        alerts: {
          emit: (
            orgId: string,
            input: Parameters<NonNullable<ReturnType<typeof getM34AlertEmitter>>["emit"]>[1],
          ) => getM34AlertEmitter().emit(orgId, input),
        },
        warn: (message: string, context: Record<string, string>) => app.log.warn(context, message),
        info: (message: string, context: Record<string, string>) => app.log.info(context, message),
      };
      const m34SweepWorkers = [
        registerM34BaaExpiryWorker(m34SweepDeps),
        registerM34SupportSessionCloseWorker(m34SweepDeps),
        registerM34OnboardingAdvanceWorker(m34SweepDeps),
      ];
      m34Workers.push(...m34SweepWorkers);
      const m34SweepSchedules = await scheduleM34PlatformSweepJobs(queueConnection);
      const m34SweepSchedulesInfo = describeM34SweepSchedules();
      app.log.info(
        { sweeps: m34SweepSchedulesInfo.map(({ sweep, cron }) => ({ sweep, cron })) },
        `M34 platform sweeps scheduled: ${m34SweepSchedulesInfo.map((s) => s.sweep).join(", ")}`,
      );
      app.addHook("onClose", () =>
        Promise.all([
          ...m34SweepWorkers.map((w) => w.close()),
          ...m34SweepSchedules.map((q) => q.close()),
        ]),
      );
      attachDlqAlertsToAll(m34Workers, "m34");
      app.log.info(
        `M34 key lifecycle workers constructed: provision, dek_rotate${destructionDbHandle ? ", shred" : ""}${m34DsarExportDeps ? ", dsar_export" : ""}${m34TenantExportDeps ? ", tenant_export" : ""}`,
      );
    } else {
      app.log.warn(
        "M34 tenant provisioning disabled: platform DB, provision gateway, and MINIO_* configuration are required",
      );
    }

    // ── GAP-059 — M35 worker set: dunning engine, usage aggregator, payment-method expiry watch, revenue
    // snapshot, invoice reconciler, Stripe webhook handler, refund executor. Same worker-runner shape as the M4
    // block below: needs the platform pool (active-org fan-out + the platform-only tables) and Valkey. The
    // webhook handler is scheduled only with the payload key, the refund executor only with a Stripe secret
    // key - without them those two stay un-run rather than pretending (rows remain `unprocessed` / `approved`).
    if (platformDbHandle && m35PlatformRunner) {
      const m35Orgs = buildActiveOrgEnumerator({
        platformDb: platformDbHandle.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M35_JOBS_PLATFORM_JOB_ID,
        reason: "GAP-059 M35 billing jobs active-org fan-out",
      });
      const m35Log = (message: string, detail: Record<string, unknown>) =>
        app.log.warn(detail, message);
      const m35Workers = registerM35Workers({
        connection: queueConnection,
        jobs: {
          db: dbHandle.db,
          platformRunner: m35PlatformRunner,
          outbox: m35OutboxPublisher,
          listOrgs: () => m35Orgs.listActiveOrgs(),
          log: m35Log,
        },
        ...(m35Stripe.cipher ? { cipher: m35Stripe.cipher } : {}),
        ...(m35Stripe.client
          ? {
              refunds: {
                platformRunner: m35PlatformRunner,
                client: m35Stripe.client,
                outbox: m35OutboxPublisher,
                log: m35Log,
              },
            }
          : {}),
      });
      attachDlqAlertsToAll(m35Workers, "m35");
      app.addHook("onClose", () => Promise.all(m35Workers.map((w) => w.close())));
      void scheduleM35Jobs(queueConnection, {
        webhookHandler: m35Stripe.cipher !== undefined,
        refundExecutor: m35Stripe.client !== undefined,
      })
        .then((queues) => {
          app.addHook("onClose", () => Promise.all(queues.map((q) => q.close())));
        })
        .catch((err) => app.log.error(err, "M35 job schedule registration failed"));
      app.log.info(
        `M35 workers constructed: dunning, usage, payment-method expiry, revenue snapshot, reconciler${m35Stripe.cipher ? ", webhook handler" : ""}${m35Stripe.client ? ", refund executor" : ""}`,
      );
    } else {
      app.log.warn("M35 workers disabled: DATABASE_PLATFORM_URL (active-org fan-out) is required");
    }

    // ── GAP-014 — M4 §4.4 audit jobs (build_export sweep, daily retention_scan, execute_destruction sweep) ──
    // Same worker-runner shape as the M34 block above. Needs the platform pool for the active-org fan-out;
    // exports additionally need the MINIO_* object store, destruction the DATABASE_DESTRUCTION_URL credential.
    // seal_partition + integrity_sample (the sealed hash chain and its sampled verification) are built in
    // 04-audit/jobs/audit-integrity-job.ts; only the spec's pgBackRest backup comparison is not (no reader).
    if (platformDbHandle) {
      const m4AuditOrgs = buildActiveOrgEnumerator({
        platformDb: platformDbHandle.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M4_AUDIT_JOBS_PLATFORM_JOB_ID,
        reason: "GAP-014 M4 audit jobs (export/retention/destruction) active-org fan-out",
      });
      const m4Ops = {
        db: dbHandle.db,
        listOrgs: () => m4AuditOrgs.listActiveOrgs(),
        ...(m34DsarObjectStore
          ? {
              objectStore: {
                putObject: (args: {
                  organizationId: string;
                  objectKey: string;
                  bytes: Uint8Array;
                  mimeType: string;
                }) =>
                  m34DsarObjectStore.putObject({
                    bucket: deriveTenantBucket(args.organizationId),
                    objectKey: args.objectKey,
                    bytes: args.bytes,
                    mimeType: args.mimeType,
                  }),
              },
            }
          : {}),
        ...(destructionDbHandle
          ? {
              eraserPorts: createDrizzleAuditEraserPorts(dbHandle.db, {
                destructionDb: destructionDbHandle.db,
              }),
            }
          : {}),
        log: (message: string, detail: Record<string, unknown>) => app.log.warn(detail, message),
      };
      // M4 §4.4 — the sealed audit hash chain (`audit.seal_partition`) and its sampled verification
      // (`audit.integrity_sample`). Gated per org by the `audit_hash_chain_enabled` feature flag (M4 D2,
      // default OFF: a disabled org gets `skipped` run rows, never a clean-looking pass). A mismatch raises
      // the M36 alert `m4.audit.integrity_mismatch` and fails the job.
      const m4Integrity = {
        db: dbHandle.db,
        listOrgs: () => m4AuditOrgs.listActiveOrgs(),
        reader: createDbAuditChainReader(dbHandle.db),
        alerts: getSeam("AlertEmitter") as {
          emit(
            orgId: string,
            input: {
              eventType: string;
              payload: Record<string, unknown>;
              severity: string;
              correlationId: string;
            },
          ): Promise<unknown>;
        },
        isHashChainEnabled: async (organizationId: string) =>
          (await featureFlagReader?.forOrg(organizationId))?.[AUDIT_HASH_CHAIN_FLAG] === true,
        ...(process.env.AUDIT_INTEGRITY_SAMPLE_SIZE
          ? { sampleSize: Number(process.env.AUDIT_INTEGRITY_SAMPLE_SIZE) }
          : {}),
        log: (message: string, detail: Record<string, unknown>) => app.log.error(detail, message),
      };
      const m4Workers = registerAuditOpsWorkers({
        connection: queueConnection,
        ops: m4Ops,
        integrity: m4Integrity,
      });
      attachDlqAlertsToAll(m4Workers, "m4");
      app.addHook("onClose", () => Promise.all(m4Workers.map((w) => w.close())));
      void scheduleAuditOpsJobs(queueConnection, {
        exports: m34DsarObjectStore !== null,
        destruction: destructionDbHandle !== undefined,
        integrity: true,
      })
        .then((queues) => {
          app.addHook("onClose", () => Promise.all(queues.map((q) => q.close())));
        })
        .catch((err) => app.log.error(err, "M4 audit job schedule registration failed"));
      app.log.info(
        `M4 audit workers constructed: retention_scan, seal_partition, integrity_sample${m34DsarObjectStore ? ", build_export" : ""}${destructionDbHandle ? ", execute_destruction" : ""}`,
      );
    } else {
      app.log.warn(
        "M4 audit workers disabled: DATABASE_PLATFORM_URL (active-org fan-out) is required",
      );
    }

    // ── GAP-011 — M3 §4.5.1 `authz.close_engagements` cron (activate/close engagements, revoke auditor links) ──
    if (platformDbHandle) {
      const m3CloseEngagementsOrgs = buildActiveOrgEnumerator({
        platformDb: platformDbHandle.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M3_CLOSE_ENGAGEMENTS_PLATFORM_JOB_ID,
        reason: "GAP-011 authz.close_engagements active-org fan-out",
      });
      void registerCloseEngagementsWorker({
        connection: queueConnection,
        db: dbHandle.db,
        outbox: m3OutboxPublisher as M3OutboxPublisher,
        revokeAuditorLinks: (organizationId, engagementId) =>
          revokeAuditorMagicLinksForEngagement(dbHandle.db, organizationId, engagementId),
        activeOrgs: m3CloseEngagementsOrgs,
      })
        .then(({ worker, queue }) => {
          attachDlqAlertsToAll([worker], "m3");
          app.addHook("onClose", () => Promise.all([worker.close(), queue.close()]));
        })
        .catch((err) => app.log.error(err, "M3 close_engagements worker construction failed"));
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
    // tenant `chartwarden_app` pool when configured — `mvRefresh`'s nightly cross-tenant REFRESH needs the
    // `chartwarden_platform` credential's ownership + BYPASSRLS over the report_mv.* views (provisioned by
    // `scripts/db/provision-runtime-roles.ts`) to genuinely span every tenant; `chartwarden_app` has no
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
        tenantKeys: { dekForOrg: (orgId) => getTenantKeyProvider().dekForOrg(orgId) },
        mvRefreshEnqueue: m33MvRefreshEnqueue.enqueue,
      }),
    );
    attachDlqAlertsToAll(m33Workers, "m33");
    app.addHook("onClose", async () => {
      await Promise.all(m33Workers.map((w) => w.close()));
      await Promise.all([m33LagProbeRedis?.quit(), m33MvRefreshEnqueue.queue?.close()]);
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
    app.log.info({ queues: m33Workers.length }, "M33 §4.8 BullMQ reporting workers constructed");

    // ── platform.partition_rotate — the time-partition rotation cron (F-033 / #93) ─────────────────────
    //
    // Keeps the current + 3 following months of partitions created for every time-RANGE partitioned
    // table, discovered from `pg_catalog` (migration 0224). Runs on the 1st, 8th and 15th: the work is a
    // no-op once the window is covered, so three cheap chances beat one tick that a restart can eat.
    //
    // It uses the PLATFORM credential, not the tenant pool. Partition DDL needs ownership of the parent
    // table and `chartwarden_app` has none — the definer-rights `rotate_time_partitions` bridges that, and
    // `scripts/db/provision-runtime-roles.ts` grants EXECUTE on it to `chartwarden_platform`. Falling back to
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

    // ── audit.archive — the cold tier for closed audit_event partitions (GAP-113, M1 §4.8) ───────────────
    // Monthly: copy each CLOSED audit_event partition older than the hot window to object storage as
    // checksummed gzip parts + a manifest, VERIFY them back from the store, and (only if AUDIT_ARCHIVE_DETACH=true)
    // detach the partition. It never drops anything — destruction is M4's certificate-driven act. Unconfigured
    // (no AUDIT_ARCHIVE_BUCKET, or no MINIO_* credentials) it is a logged skip: the hot tier keeps everything.
    // Platform credential, like partition rotation: reading every tenant's audit rows and detaching a partition
    // are definer-rights functions (migration 0432) that `chartwarden_platform` is granted EXECUTE on.
    const auditArchiveSetup = auditArchiveConfigFromEnv(process.env);
    const auditArchiveWorker = new Worker(
      AUDIT_ARCHIVE_QUEUE,
      async () => {
        if (!auditArchiveSetup || !m34DsarObjectStore) {
          app.log.warn(
            {
              bucketConfigured: auditArchiveSetup !== null,
              objectStoreConfigured: m34DsarObjectStore !== null,
            },
            "audit.archive skipped: AUDIT_ARCHIVE_BUCKET and the MINIO_* credentials are both required",
          );
          return { skipped: "unconfigured" };
        }
        const run = await runAuditArchive({
          withCatalog: platformCatalogRunner({
            platformDb: platformDbHandle?.db ?? dbHandle.db,
            auditBypass: m34PlatformBypassAuditor,
          }),
          store: m34DsarObjectStore,
          config: auditArchiveSetup.config,
          hotMonths: auditArchiveSetup.hotMonths,
          log: (msg, detail) => app.log.info(detail, msg),
        });
        return { archived: run.archived.length, deferred: run.deferred };
      },
      { connection: queueConnection, concurrency: 1 },
    );
    attachDlqAlertsToAll([auditArchiveWorker], "platform");
    app.addHook("onClose", async () => {
      await auditArchiveWorker.close();
    });
    try {
      const auditArchiveQueue = new Queue(AUDIT_ARCHIVE_QUEUE, { connection: queueConnection });
      await auditArchiveQueue.add(
        "scheduled",
        {},
        {
          repeat: { pattern: AUDIT_ARCHIVE_CRON },
          attempts: 5,
          backoff: { type: "exponential", delay: 30_000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
      app.addHook("onClose", async () => {
        await auditArchiveQueue.close();
      });
    } catch (err) {
      app.log.error(err, "audit.archive cron registration failed");
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
        return getSeam("HopeOrgRollupProvider").timepointCompletionRollup(organizationId, period);
      },
      submissionPostureRollup(organizationId, period) {
        return getSeam("HopeOrgRollupProvider").submissionPostureRollup(organizationId, period);
      },
      sfvTimelinessRollup(organizationId, period) {
        return getSeam("HopeOrgRollupProvider").sfvTimelinessRollup(organizationId, period);
      },
      j2051FollowUpRollup(organizationId, period) {
        return getSeam("HopeOrgRollupProvider").j2051FollowUpRollup(organizationId, period);
      },
      openSfvObligationCount(organizationId) {
        return getSeam("HopeOrgRollupProvider").openSfvObligationCount(organizationId);
      },
    };
    // #107 item 2 — bind the active-org enumerator so the §4.8 cron fan-outs enumerate every active tenant
    // under withPlatformContext (allowlisted via wireM30Tenancy above; audited by the shared platform-bypass
    // auditor — its event records the M30 jobId, so the "M34" name is incidental, the auditor is module-agnostic).
    const m30ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
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
    // GAP-087 — the real CAHPS sample cron + export worker ports (sealed caregiver contact, vendor adapters, job row).
    const m30CahpsWorker = buildM30CahpsWiring({
      db: dbHandle.db,
      keys: {
        dekForOrg: (orgId) => getTenantKeyProvider().dekForOrg(orgId),
        dekForOrgVersion: (orgId, version) =>
          getTenantKeyProvider().dekForOrgVersion(orgId, version),
      },
      outboxPublisher: m30OutboxPublisher,
      deathsForOrg: (organizationId, period) =>
        cahpsDeathCandidatesForOrg(dbHandle.db, organizationId, period),
      caregiverContactForOrg: (organizationId, patientId) =>
        primaryCaregiverContactForOrg(dbHandle.db, organizationId, patientId),
    });
    const m30WorkerDeps = buildM30WorkerDeps({
      connection: queueConnection,
      db: dbHandle.db,
      cahpsPipeline: m30CahpsWorker.pipeline,
      hopeProvider: m30HopeConsumer,
      activeOrgs: m30ActiveOrgs,
      deathDischargeReader: m30DeathDischargeReader,
      signedEncounters: m30SignedEncounters,
      levelOfCarePeriodReader: m30LevelOfCarePeriodReader,
      dischargeReader: m30DischargeReader,
      admissionOnsetReader: m30AdmissionOnsetReader,
      medicationOrders: m30MedicationOrders,
      // GAP-090 — the three operational measures whose published seams need a request context run in the
      // worker via org-explicit `...ForOrg` reads (each opens its own `withOrgContext` on the job's org).
      visitOnTimeCountsForOrg: (organizationId, window) =>
        onTimeVisitCountsForOrg(dbHandle.db, organizationId, window),
      evvComplianceCountsForOrg: (organizationId, window) =>
        evvComplianceCountsForOrg(dbHandle.db, organizationId, window),
      medicationOrdersForAdmissionForOrg: (organizationId, admissionId) =>
        medicationOrdersForAdmissionForOrg(dbHandle.db, organizationId, admissionId),
      // WX-PR-014 — the nightly-recompute + risk-register-refresh cron fan-outs: the per-org provider-entity
      // lister (already used for M30's published seams) + the real BullMQ producer + the SAME tx-scoped
      // outbox publisher the M30 routes already use (`m30.measure.value_emitted` / `m30.risk_register
      // .refreshed` are called UNCONDITIONALLY by their workers — without this every recompute/refresh job
      // throws on its last line and rolls back, see M30WorkerDeps' doc comment).
      providerEntities: buildOrgProviderEntityLister(dbHandle.db),
      // D9 backfill — the nightly `m30.assign-unassigned-mortality-reviews` cron assigns pre-fix / no-MD-at-the-time
      // reviews through the SAME resolver the m6.discharge.death consumer binds (so a later-appointed MD is picked up).
      resolveMedicalDirectorForOrg: buildMortalityReviewerResolver(
        dbHandle.db,
        createMembershipsHoldingRoleKeyReader(dbHandle.db),
      ),
      recomputeEnqueue: m30CronRecompute.enqueue,
      outboxPublisher: m30OutboxPublisher,
      // GAP-155 — the SRA-reminder cron's §4.9 dispatch (sra_due_90/60/30 + sra_overdue) emits through M36.
      alertEmitter: getSeam("AlertEmitter") as Parameters<
        typeof buildM30WorkerDeps
      >[0]["alertEmitter"],
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
    // GAP-155 - the CAP-overdue producer: daily scan of CAP action items (incident_report.kind_data._m30.capPlan),
    // publishing m30.incident.cap_overdue through the real catalog-validating publisher + raising the M36 alert.
    const m30CapOverdueWorker = registerM30CapOverdueWorker({
      connection: queueConnection,
      db: dbHandle.db,
      listActiveOrgs: () => m30ActiveOrgs.listActiveOrgs(),
      outboxPublisher: m30OutboxPublisher,
      resolveOwnerUserIds: buildMembershipUserResolver(dbHandle.db),
      emit: (organizationId, input) =>
        (
          getSeam("AlertEmitter") as {
            emit(orgId: string, i: typeof input): Promise<unknown>;
          }
        ).emit(organizationId, input),
      warn: (message, context) => app.log.warn(context, message),
    });
    m30Workers.push(m30CapOverdueWorker);
    try {
      const m30CapOverdueSchedule = await scheduleM30CapOverdueJob(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all([m30CapOverdueWorker.close(), m30CapOverdueSchedule.close()]);
      });
    } catch (err) {
      app.log.error(err, "M30 cap-overdue cron-schedule registration failed");
    }
    // GAP-049 - the scheduled §4.9 alerts with no cron: mortality-review overdue + CoP attestation cadence.
    const m30ReviewOverdueWorker = registerM30ReviewOverdueWorker({
      connection: queueConnection,
      db: dbHandle.db,
      listActiveOrgs: () => m30ActiveOrgs.listActiveOrgs(),
      emit: (organizationId, input) =>
        (
          getSeam("AlertEmitter") as {
            emit(orgId: string, i: typeof input): Promise<unknown>;
          }
        ).emit(organizationId, input),
      warn: (message, context) => app.log.warn(context, message),
    });
    m30Workers.push(m30ReviewOverdueWorker);
    try {
      const m30ReviewOverdueSchedule = await scheduleM30ReviewOverdueJob(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all([m30ReviewOverdueWorker.close(), m30ReviewOverdueSchedule.close()]);
      });
    } catch (err) {
      app.log.error(err, "M30 review-overdue cron-schedule registration failed");
    }
    // GAP-049 - the REPEAT half of the sentinel / abuse (4h / 6h until triaged), outbreak (12h until reviewed) and
    // threshold (7d until a project is chartered) cadences. Origin-anchored buckets over the consumer's correlation id;
    // a page that resolves nobody falls back to the tenant admins rather than being absorbed by the dedupe.
    const m30AlertRepeatWorker = registerM30AlertRepeatWorker({
      connection: queueConnection,
      db: dbHandle.db,
      listActiveOrgs: () => m30ActiveOrgs.listActiveOrgs(),
      emit: (organizationId, input) =>
        emitWithRecipientFallback(
          getSeam("AlertEmitter") as AlertEmitter,
          organizationId,
          input,
          (message, context) => app.log.warn(context, message),
        ),
      warn: (message, context) => app.log.warn(context, message),
    });
    m30Workers.push(m30AlertRepeatWorker);
    try {
      const m30AlertRepeatSchedule = await scheduleM30AlertRepeatJob(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all([m30AlertRepeatWorker.close(), m30AlertRepeatSchedule.close()]);
      });
    } catch (err) {
      app.log.error(err, "M30 alert-repeat cron-schedule registration failed");
    }
    // GAP-161 - M32 §4.8 `ai:hallucination-triage-followup` consumer: executes the plan R18/R20 enqueue
    // (platform kill switch, the incident_demotion edge attributed to the triage owner, the system-locked alert).
    {
      const m32WorkerStoreDeps = {
        db: dbHandle.db,
        platformDb: dbHandle.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M32_PLATFORM_JOB_ID,
        userId: "",
        events: m32Events,
      };
      const m32WorkerRegistry = createDrizzleAiCapabilityRegistryStore({
        db: dbHandle.db,
        platformDb: dbHandle.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M32_PLATFORM_JOB_ID,
        events: m32Events,
      });
      const m32TriageWorker = registerM32TriageFollowUpWorker({
        connection: queueConnection,
        safety: {
          killSwitches: createDrizzleAiKillSwitchStore(m32WorkerStoreDeps),
          reports: createDrizzleAiHallucinationReportStore({
            db: dbHandle.db,
            userId: "",
            events: m32Events,
          }),
          evaluations: createDrizzleAiEvaluationRunStore(m32WorkerStoreDeps),
          registry: m32WorkerRegistry,
        },
        governance: {
          registry: m32WorkerRegistry,
          consent: createDrizzleAiTenantConsentStore({
            db: dbHandle.db,
            userId: "",
            events: m32Events,
          }),
          evidence: createDenyingAiOptInEvidenceResolver(),
          evaluations: createDrizzleAiEvaluationRunStore(m32WorkerStoreDeps),
        },
      });
      // GAP-161 - `ai:token-ledger-rollup` (hourly): the soft/hard token-cap alerts had no producer anywhere.
      const m32RollupWorker = registerM32TokenRollupWorker({
        connection: queueConnection,
        listActiveOrgs: () => m30ActiveOrgs.listActiveOrgs(),
        spendForOrg: buildSpendReader(dbHandle.db),
        budgetFor: (organizationId, capabilityKey) =>
          createOrganizationSettingsAiTokenBudgetResolver(dbHandle.db).budgetFor(
            organizationId,
            capabilityKey,
          ),
        warn: (message, context) => app.log.warn(context, message),
      });
      const m32RollupSchedule = await scheduleM32TokenRollupJob(queueConnection);
      attachDlqAlertsToAll([m32TriageWorker, m32RollupWorker], "m32");
      app.addHook("onClose", () =>
        Promise.all([m32TriageWorker.close(), m32RollupWorker.close(), m32RollupSchedule.close()]),
      );
    }
    app.log.info({ queues: m30Workers.length }, "M30 §4.8 BullMQ HQRP/quality workers constructed");
    // ── M27 §4.8 Cost-Report workers + the filing-deadline cron (same worker-runner shape) ──────────────
    // WX-PR-013 bound the outbox/alerts/active-org ports for real (the M25 alert/active-org-enumerator
    // pattern); the M1 DEK + Xero/Gusto pull seams + M6/M8 statistics seams remain explicit deny-stub
    // forward work (see wiring.ts / jobs/m27-jobs.ts for why — RULE 4 still applies: those typed thunks
    // throw only when a JOB RUNS, so boot stays green).
    const m27ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
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
            correlationId: cronAlertCorrelationId("m27-cron", alertCode, payload),
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
        // GAP-149 — the report's CCN selects its cap period (a two-CCN org otherwise read an arbitrary CCN's cap).
        providerCcn: buildProviderEntityCcnResolver(dbHandle.db).ccnFor,
        providerEntity: () => getSeam("MdmEntityProvider") as M27ProviderEntityResolver,
        // M23 billed-census + M25 actual interim payments + M12 drug-cost basis (opaque rich-seams; cast to
        // M27's consumer views). Each degrades to its deny-stub (rule SKIPS) until the producer binds live.
        patientDays: () => getSeam("PatientDaysProvider") as M27PatientDaysSeam,
        settlement: () => getSeam("ClaimSettlementProvider") as M27ClaimSettlementSeam,
        drugCost: () => getSeam("DrugCostBillingReader") as M27DrugCostSeam,
      }),
      // The §4320/§4330 allocation-input shaper — reads M27's materialized Worksheet A/A-1…A-4/B-1 + the
      // statistics census and assembles the hospice chain inputs (Worksheet B step-down on the B-1 statistical
      // basis → Worksheet C per-diem cost by level of care). No cap/settlement worksheet on the form (M26).
      allocationInputs: buildM27AllocationInputs(),
      // GAP-080 — the S-3 statistics sources: M6 service census + M5 payer program (Part I), M8 completed visits by
      // discipline (Part III), FTE from M27's own wage import (Part II), M16 bereavement census (Part IV). Every
      // cross-module fact is an org-explicit port (arch:tables stays green: M27 reads no foreign table).
      statisticsSeams: buildM27StatisticsSeams({
        db: dbHandle.db,
        serviceCensus: (organizationId, window) =>
          serviceCensusForOrg(dbHandle.db, organizationId, window),
        payerPrograms: (organizationId, patientIds, asOf) =>
          payerProgramsForPatientsForOrg(dbHandle.db, organizationId, patientIds, asOf),
        visitCounts: (organizationId, window) =>
          visitCountsByDisciplineForOrg(dbHandle.db, organizationId, window),
        bereavementCensus: (organizationId, window) =>
          bereavementCensusForOrg(dbHandle.db, organizationId, window),
      }),
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
    app.log.info({ queues: m27Workers.length }, "M27 §4.8 BullMQ cost-report workers constructed");
    // ── M23 §4.8 Billing workers. THREE tiers, by what each needs (GAP-069 / GAP-070):
    //   1. queue connection only (here, always): `eligibility.refresh`, `validation-run`, `revalidate.consumer`
    //      and the three per-org watchdog crons (NOE/NOTR window-watch, eligibility stale-watch). They do no
    //      X12/MAC-portal I/O, so they must NOT sit behind the launch gateway — they did not exist at all before
    //      (registerM23Workers had no caller), so revalidation jobs piled up unconsumed and every watch tick threw
    //      `unboundWorkerPort`.
    //   2. + the launch gateway: claim/NOE/NOTR submit[.retry], the 999/277CA ack pulls and MAC-portal health.
    //   3. HETS 270/271 (`hets`) is bound only when `M23_HETS_TRANSPORT` is configured (M5's MbiUnlockReader
    //      supplies the transient MBI). Unconfigured, the `eligibility.refresh` job fails closed when it runs
    //      and the route-side gate keeps refusing eligibility checks (503).
    const m23AlertEmitter = getSeam("AlertEmitter") as {
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
    const m23ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M23_PLATFORM_JOB_ID,
      reason: "M23 §4.8 watchdog cron fan-out (active-org enumeration)",
    });
    const m23ClaimSeamPorts = buildM23AssemblyPorts(dbHandle.db);
    const m23ValidationRunner = buildM23ValidationRunner({
      db: dbHandle.db,
      outbox: m23OutboxPublisher,
      seams: buildM23BootAssemblySeams(dbHandle.db, {
        outbox: m23OutboxPublisher,
        providerCcn: m23ClaimSeamPorts.providerCcn,
        ...m23ClaimSeamPorts.assemblyPorts,
      }),
      // The §11.A eligibility rules read eligibility_check only when HETS can actually refresh it.
      eligibilityBound: m23HetsConfig !== null,
    });
    const m23Hets = m23HetsConfig ? buildM23HetsPort(dbHandle.db, m23HetsConfig) : undefined;
    app.log.info(
      { hetsTransport: m23HetsConfig?.transport ?? "unbound" },
      "M23 HETS 270/271 eligibility transport",
    );
    const m23CoreWorkerDeps = buildM23WorkerDeps({
      connection: queueConnection,
      db: dbHandle.db,
      outbox: m23OutboxPublisher,
      // F-161 (#248) — the §4.9 window-watch/portal-health alert routing, over the live M36 AlertEmitter
      // seam (the M27 `WX-PR-013` pattern).
      alerts: {
        dispatch: async ({ alertCode, severity, organizationId, payload }) => {
          // Platform-status alerts (MAC portal up/down) carry no tenant (organizationId ""): fan out once per
          // active org so each tenant's admins hear about it instead of an org-less alert reaching nobody.
          const targetOrgs =
            organizationId === ""
              ? (await m23ActiveOrgs.listActiveOrgs()).map((o) => o.organizationId)
              : [organizationId];
          for (const orgId of targetOrgs) {
            await m23AlertEmitter.emit(orgId, {
              eventType: alertCode,
              payload,
              severity,
              correlationId: cronAlertCorrelationId("m23-cron", alertCode, payload),
            });
          }
        },
      },
      activeOrgs: m23ActiveOrgs,
      noticeWindow: buildNoticeWindowPort(),
      validationRunner: m23ValidationRunner,
      // F-153 (#248) — the real target resolver for the `revalidate.consumer` worker.
      revalidationTargets: buildDrizzleRevalidationTargetResolver(),
      // The revalidate consumer's `validation-run` fan-out producer (GAP-070).
      enqueue: m23WorkQueues?.port,
      // §4.4 HETS 270/271 — bound only when configured (see `m23HetsConfig` above).
      hets: m23Hets,
      // ADR-0052 — the window-watch crons file a DDE work item for each at-risk NOE/NOTR (idempotent).
      ddeWatchdog: buildDdeWatchdog({ outbox: m23OutboxPublisher }),
      logger: app.log,
    });
    let m23Workers: Worker[] = [
      ...registerM23DomainWorkers(m23CoreWorkerDeps),
      ...registerM23WatchCronWorkers(m23CoreWorkerDeps),
    ];
    if (m23LaunchGateway) {
      const m23LaunchWorkerDeps = buildM23WorkerDeps({
        ...m23CoreWorkerDeps,
        x12: m23LaunchGateway.x12,
        macPortal: m23LaunchGateway.macPortal,
        // GAP-143 — the distinct MAC jurisdictions of the tenants' configured submitter credentials (was a
        // hard-coded 'ngs_j6', so every other MAC's acks were never pulled).
        jurisdictions: buildMacJurisdictionLister({
          orgs: m23ActiveOrgs,
          readOrg: buildDrizzleOrgMacJurisdictionReader(dbHandle.db),
          onOrgError: (organizationId, err) =>
            app.log.error({ err, organizationId }, "M23 MAC jurisdiction read failed for org"),
        }),
      });
      m23Workers = [
        ...m23Workers,
        // claim/NOE/NOTR submit[.retry] + the two ack-pull crons (F-161: the portal-health cron was never
        // registered either, so it never ran a tick in any deployment).
        ...registerM23LaunchWorkers(m23LaunchWorkerDeps),
        ...registerM23PortalHealthWorker(m23LaunchWorkerDeps),
      ];
    } else {
      app.log.warn(
        "M23 launch workers disabled: configure X12 and MAC gateway URLs and bearer tokens",
      );
    }
    // M23 and M27 once shared a queue named `validation-run`; move any M23 job still stranded on it (never dropped).
    sweepLegacyValidationRunQueue(queueConnection)
      .then((result) =>
        app.log.info(
          result,
          "M23 legacy validation-run queue sweep complete (jobs moved, never dropped)",
        ),
      )
      .catch((err) => app.log.error(err, "M23 legacy validation-run queue sweep failed"));
    attachDlqAlertsToAll(m23Workers, "m23");
    app.addHook("onClose", async () => {
      await Promise.all(m23Workers.map((worker) => worker.close()));
    });
    try {
      // The watchdog schedules need only the tier-1 workers above. With the launch gateway,
      // `scheduleM23Jobs` is the superset (the same watch patterns + ack pulls + portal health) — BullMQ
      // dedupes an identical repeat pattern re-added to the same queue.
      const m23ScheduleQueues = m23LaunchGateway
        ? await scheduleM23Jobs(queueConnection)
        : await scheduleM23WatchJobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m23ScheduleQueues.map((queue) => queue.close()));
      });
    } catch (err) {
      app.log.error(err, "M23 cron schedule registration failed");
    }
    app.log.info(
      { queues: m23Workers.length },
      "M23 domain + watchdog (+ launch) workers constructed",
    );
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
      app.log.info({ queues: m24Workers.length }, "M24 launch submission workers constructed");
    } else {
      app.log.warn(
        "M24 launch workers disabled: configure M24_LAUNCH_GATEWAY_ENABLED and M24_CREDENTIAL_ENCRYPTION_KEY",
      );
    }
    // F-165 (#248, m24 group) — the `medicaid-revalidate` worker, unlike the submit/poll pair above, needs no
    // Oregon launch gateway or credential resolver (it only re-runs the rule engine + drives the pure
    // machine's `revalidate` edge) — constructed whenever a queue connection exists, independent of
    // `m24OregonGateway`/`m24CredentialResolver`.
    const m24RevalidateWorker = registerM24RevalidateWorker({
      connection: queueConnection,
      db: dbHandle.db,
      outbox: m24OutboxPublisher,
    });
    app.addHook("onClose", async () => {
      await m24RevalidateWorker.close();
    });
    // GAP-071 — the `rb-day-daily-sweep` + `medicaid-eligibility-stale-watchdog` §4.9 crons. Before this nothing
    // inserted an `rb_day` row, so Medicaid room-and-board could never be billed. Needs only a queue connection
    // + db (no gateway/cipher); the M6 LOC-of-day is pulled through an org-explicit port (M24 does not depend
    // on M6), the active-org fan-out runs under the allowlisted M24 platform job id.
    const m24CronActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M24_PLATFORM_JOB_ID,
      reason:
        "M24 §4.9 rb-day-daily-sweep / eligibility-stale-watchdog cron fan-out (active-org enumeration)",
    });
    const m24CronWorkers = registerM24CronWorkers({
      connection: queueConnection,
      activeOrgs: m24CronActiveOrgs,
      rbDaySweep: buildDrizzleRbDaySweepStore({
        db: dbHandle.db,
        locPeriods: {
          periodsForPatient: (organizationId, patientId, range) =>
            levelOfCarePeriodsForPatientForOrg(dbHandle.db, organizationId, patientId, range),
        },
      }),
      eligibilityWatchdog: buildDrizzleEligibilityWatchdogStore(dbHandle.db),
      // The §4.10 `medicaid.eligibility.stale_at_assembly` alert over the live M36 AlertEmitter seam (the
      // M23 `dispatch` adapter shape); the per-(org, patient, lastCheckedAt) correlationId is the dedupe key.
      eligibilityAlerts: {
        dispatch: async ({ eventType, organizationId, severity, correlationId, payload }) => {
          await (
            getSeam("AlertEmitter") as {
              emit(
                orgId: string,
                input: {
                  eventType: string;
                  payload: Record<string, unknown>;
                  severity: string;
                  correlationId: string;
                },
              ): Promise<unknown>;
            }
          ).emit(organizationId, { eventType, payload, severity, correlationId });
        },
      },
      log: app.log,
    });
    attachDlqAlertsToAll(m24CronWorkers, "m24-cron");
    app.addHook("onClose", async () => {
      await Promise.all(m24CronWorkers.map((worker) => worker.close()));
    });
    try {
      const m24CronQueues = await scheduleM24Jobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m24CronQueues.map((queue) => queue.close()));
      });
    } catch (err) {
      app.log.error(err, "M24 rb-day / eligibility cron schedule registration failed");
    }
    app.log.info("M24 rb-day-daily-sweep + eligibility-stale-watchdog cron workers constructed");
    // F-172 (#248, m1 group) — the `state-channel-health` §4.9 cron: genuinely unbuilt before now
    // (`M24_CRON_QUEUES.stateChannelHealth` was declared with no worker/schedule/handler anywhere — not
    // merely unwired). Requires the §8.7 credential cipher port (to decrypt trading-partner credentials —
    // the same RULE-4 gate the submit/poll workers use); the Oregon gateway probe itself degrades to a
    // permanent no-op (StateChannelHealthProbePort returns null for every state) rather than throwing when
    // `m24OregonGateway` is unconfigured, so this cron constructs whenever a queue connection + the cipher
    // exist — it will simply observe and report nothing until Oregon's launch gateway is also configured.
    if (m24CredentialCipher) {
      const m24ActiveOrgs = buildActiveOrgEnumerator({
        platformDb: platformDbHandle?.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M24_PLATFORM_JOB_ID,
        reason: "M24 §4.9 state-channel-health cron fan-out (active-org enumeration)",
      });
      const m24StateChannelHealthWorker = registerM24StateChannelHealthWorker({
        connection: queueConnection,
        db: dbHandle.db,
        activeOrgs: m24ActiveOrgs,
        listPeStates: buildDrizzleActivePeStatesLister(),
        credentials: buildDrizzleStateChannelCredentialResolver(m24CredentialCipher),
        probe: buildStateChannelHealthProbe(m24OregonGateway),
        outbox: m24OutboxPublisher,
      });
      app.addHook("onClose", async () => {
        await m24StateChannelHealthWorker.close();
      });
      try {
        const m24StateChannelHealthQueue = await scheduleM24StateChannelHealthJob(queueConnection);
        app.addHook("onClose", async () => {
          await m24StateChannelHealthQueue.close();
        });
      } catch (err) {
        app.log.error(err, "M24 state-channel-health cron schedule registration failed");
      }
      app.log.info("M24 state-channel-health cron worker constructed");
    } else {
      app.log.warn(
        "M24 state-channel-health cron disabled: configure M24_CREDENTIAL_ENCRYPTION_KEY",
      );
    }
    // F-175 (#248) — the M29 outbound-dispatch retry sweep: a poll-based cron over `idx_hmo_next_retry`
    // (`status='queued' AND nextRetryAt<=now`), the mechanism `./outbound/queues.ts`'s own header decides
    // on and justifies over a per-row BullMQ delayed job. Needs only a queue connection + the tenant DEK
    // seam (both unconditionally available whenever `dbHandle` exists, per the comment on the fresh-
    // dispatch consumer above) — constructs whenever `queueConnection` exists, the `m24RevalidateWorker`
    // "no extra credential needed" shape.
    if (queueConnection) {
      const m29ActiveOrgs = buildActiveOrgEnumerator({
        platformDb: platformDbHandle?.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M29_PLATFORM_JOB_ID,
        reason:
          "M29 §4.9-shaped outbound-dispatch retry-sweep cron fan-out (active-org enumeration)",
      });
      const m29RetrySweepWorker = registerM29OutboundRetrySweepWorker({
        connection: queueConnection,
        db: dbHandle.db,
        outbox: m29OutboxPublisher,
        keys: getTenantKeyProvider(),
        rateLimiter: m29OutboundRateLimiter,
        activeOrgs: m29ActiveOrgs,
      });
      app.addHook("onClose", async () => {
        await m29RetrySweepWorker.close();
      });
      try {
        const m29RetrySweepQueue = await scheduleM29OutboundRetrySweepJob(queueConnection);
        app.addHook("onClose", async () => {
          await m29RetrySweepQueue.close();
        });
      } catch (err) {
        app.log.error(err, "M29 outbound-dispatch retry-sweep cron schedule registration failed");
      }
      app.log.info("M29 outbound-dispatch retry-sweep cron worker constructed");
    } else {
      app.log.warn("M29 outbound-dispatch retry-sweep cron disabled: configure REDIS_URL");
    }
    // GAP-043 - the listener-health WATCHER: decides `listener_down` / `listener_recovered` from the listener's heartbeat, an
    // active TCP probe and the newest inbound frame, in THIS (worker) process so it survives the listener dying. State and
    // event are one transaction; the M36 `feed-health-alerts` consumer (bound below, unconditionally) turns the event into the
    // page. OFF unless M29_LISTENER_WATCH_ENABLED=true (an env with no listener must not page "down" for every active feed);
    // when on, M29_LISTENER_PROBE_HOST is required and the listener process stops paging listener_down itself.
    const feedHealthWatch = resolveFeedHealthWatchConfig(process.env);
    if (feedHealthWatch.enabled && queueConnection) {
      const feedWatchOrgs = buildActiveOrgEnumerator({
        platformDb: platformDbHandle?.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M29_PLATFORM_JOB_ID,
        reason: "M29 listener-health watcher fan-out (active-org enumeration)",
      });
      const feedHealthWatchWorker = registerM29FeedHealthWatchWorker({
        connection: queueConnection,
        activeOrgs: feedWatchOrgs,
        store: createDrizzleFeedWatchStore({ db: dbHandle.db, outbox: m29OutboxPublisher }),
        probeTcp: probeTcpPort,
        probeHost: feedHealthWatch.probeHost,
        now: () => new Date(),
        log: (level, event, fields) => app.log[level](fields, event),
      });
      app.addHook("onClose", async () => {
        await feedHealthWatchWorker.close();
      });
      try {
        const feedHealthWatchQueue = await scheduleM29FeedHealthWatchJob(queueConnection);
        app.addHook("onClose", async () => {
          await feedHealthWatchQueue.close();
        });
      } catch (err) {
        app.log.error(err, "M29 listener-health watcher schedule registration failed");
      }
      app.log.info("M29 listener health watcher constructed (M29_LISTENER_WATCH_ENABLED)");
    } else if (feedHealthWatch.enabled) {
      app.log.error(
        "M29_LISTENER_WATCH_ENABLED=true but no queue connection (REDIS_URL): the listener-health watcher is NOT running and the listener has stopped paging listener_down",
      );
    }
    // F-222 (#248) — M31 §4.8 `m31.post-discharge-grace.cron`: the daily sweep that ends care-time portal access
    // for patients discharged alive past the 30-day grace FLOOR and not re-admitted. Reads M6 through the org-
    // explicit published `portalDischargedPastGraceForOrg` (M31 imports no M6 code); bounded per org per run.
    if (queueConnection) {
      const m31ActiveOrgs = buildActiveOrgEnumerator({
        platformDb: platformDbHandle?.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M31_PLATFORM_JOB_ID,
        reason: "M31 §4.8 post-discharge-grace sweep cron fan-out (active-org enumeration)",
      });
      const m31PostDischargeGraceWorker = registerM31PostDischargeGraceWorker({
        connection: queueConnection,
        db: dbHandle.db,
        events: m31Events,
        activeOrgs: m31ActiveOrgs,
        m6: {
          portalDischargedPastGraceForOrg: (organizationId, patientIds, cutoffDate) =>
            portalDischargedPastGraceForOrg(dbHandle.db, organizationId, patientIds, cutoffDate),
        },
      });
      app.addHook("onClose", async () => {
        await m31PostDischargeGraceWorker.close();
      });
      // GAP-159 - the 5-minute telehealth late-join watchdog (spec 4.8): aborts rooms past the 15-minute window.
      const m31LateJoinWatchdogWorker = registerM31LateJoinWatchdogWorker({
        connection: queueConnection,
        db: dbHandle.db,
        events: m31Events,
        activeOrgs: m31ActiveOrgs,
        warn: (message, context) => app.log.warn(context, message),
      });
      app.addHook("onClose", async () => {
        await m31LateJoinWatchdogWorker.close();
      });
      try {
        const m31LateJoinWatchdogQueue = await scheduleM31LateJoinWatchdogJob(queueConnection);
        app.addHook("onClose", async () => {
          await m31LateJoinWatchdogQueue.close();
        });
      } catch (err) {
        app.log.error(err, "M31 late-join-watchdog cron schedule registration failed");
      }
      try {
        const m31PostDischargeGraceQueue = await scheduleM31PostDischargeGraceJob(queueConnection);
        app.addHook("onClose", async () => {
          await m31PostDischargeGraceQueue.close();
        });
      } catch (err) {
        app.log.error(err, "M31 post-discharge-grace cron schedule registration failed");
      }
      app.log.info("M31 post-discharge-grace cron worker constructed");
    } else {
      app.log.warn("M31 post-discharge-grace cron disabled: configure REDIS_URL");
    }
    // ── M25 §4.8 Remittance crons (denial-aging rebucket + appeal-deadline watch) — same worker-runner
    // shape. buildM25WorkerDeps binds only the connection + db; the M2 active-org enumerator (the per-org
    // cron fan-out source, under withPlatformContext) + the M36 alert router stay fail-closed-unbound at boot
    // (RULE 4 — the typed thunks in cron-workers.ts throw only when a CRON TICK RUNS, so boot stays green).
    // Bind the active-org enumerator (the cron fan-out source; allowlisted via wireM25Tenancy, audited by
    // the shared module-agnostic platform-bypass auditor) + the M36 AlertEmitter so the crons enumerate
    // every active tenant under withPlatformContext and fire the §4.9 typed alerts.
    const m25ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M25_PLATFORM_JOB_ID,
      reason: "M25 §4.8 cron fan-out (active-org enumeration)",
    });
    const platformAlertEmitter = getSeam("AlertEmitter") as {
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
        await platformAlertEmitter.emit(organizationId, {
          eventType: alertCode,
          payload,
          severity,
          correlationId: cronAlertCorrelationId("m25-cron", alertCode, payload),
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
    app.log.info({ queues: m25Workers.length }, "M25 §4.8 BullMQ remittance crons constructed");

    // ── M26 §4.8 Cap-Management crons (nightly projection recompute · cap-year auto-close · stale-PS&R
    // watchdog). GAP-076: the M2 active-org enumerator and the M36 AlertEmitter-backed alert router are
    // bound (as every peer cron module does) — left on the fail-closed/no-op defaults every tick threw
    // "enumerator not bound", so the projection, the D8 cap-year auto-close and the PS&R watchdog never
    // ran. Idempotent recompute/close via the §2.6 unique constraints.
    const m26ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M26_PLATFORM_JOB_ID,
      reason: "M26 §4.8 cap cron fan-out (active-org enumeration)",
    });
    const m26Alerts: M26WorkerAlertPort = {
      dispatch: async ({ alertCode, severity, organizationId, payload }) => {
        await platformAlertEmitter.emit(organizationId, {
          eventType: alertCode,
          payload,
          severity,
          correlationId: cronAlertCorrelationId("m26-cron", alertCode, payload),
        });
      },
    };
    const m26Workers = registerM26CronWorkers({
      connection: queueConnection,
      db: dbHandle.db,
      activeOrgs: m26ActiveOrgs,
      alerts: m26Alerts,
      // GAP-041 — the outbox is bound unconditionally: the nightly projection and the year-close cron publish
      // projection_updated / threshold_crossed / year_closing through it (they were lost to a no-op publisher).
      outbox: m26OutboxPublisher,
      ...(m26PsrFiles ? { psrFiles: m26PsrFiles } : {}),
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
    app.log.info({ queues: m26Workers.length }, "M26 §4.8 BullMQ cap crons constructed");

    // ── M7 §4.6 `care-plan.gates` cron (TASK-040D — the M25 worker-runner shape) ─────────────────────────
    // The CoP 418.56 5-/15-day gate scans. Absent this, they never ran in production — this is the fix.
    const m7ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
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
    app.log.info({ queues: m7Workers.length }, "M7 §4.6 BullMQ care-plan.gates cron constructed");

    // ── M17 Phase-3 scheduling automation: recurring materialization + visit attention ───────────────
    const m17ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M17_PLATFORM_JOB_ID,
      reason: "M17 scheduling automation cron fan-out (recurrence materialization + attention)",
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
      platformDb: platformDbHandle?.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M8_PLATFORM_JOB_ID,
      reason: "M8 encounter automation cron fan-out (attention + cosignature SLA)",
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
    app.log.info({ queues: m8Workers.length }, "M8 Phase-3 encounter automation crons constructed");

    // ── M18 §4.8 EVV crons (GAP-056): late-check sweep + aggregator submitter drain + response poller ─────
    if (m18AggregatorDeps) {
      const m18ActiveOrgs = buildActiveOrgEnumerator({
        platformDb: platformDbHandle?.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M18_PLATFORM_JOB_ID,
        reason:
          "M18 EVV crons fan-out (late-check sweep + aggregator submitter/poller + dek-rotation re-seal)",
      });
      const m18Workers = registerM18CronWorkers({
        connection: queueConnection,
        db: dbHandle.db,
        outbox: m18OutboxPublisher,
        activeOrgs: m18ActiveOrgs,
        aggregator: m18AggregatorDeps,
        coordsKeys: m18CoordsKeys(), // §4.8 m18.dek-rotation daily re-seal sweep
      });
      attachDlqAlertsToAll(m18Workers, "m18");
      app.addHook("onClose", async () => {
        await Promise.all(m18Workers.map((w) => w.close()));
      });
      try {
        const m18ScheduleQueues = await scheduleM18Jobs(queueConnection);
        app.addHook("onClose", async () => {
          await Promise.all(m18ScheduleQueues.map((q) => q.close()));
        });
      } catch (err) {
        app.log.error(err, "M18 cron-schedule registration failed");
      }
      app.log.info({ queues: m18Workers.length }, "M18 EVV crons constructed");
    }

    // ── M15 §4.6 discipline-plan crons (GAP-044) ─────────────────────────────────────────────────────────
    // supervisory overdue (6h) / MSW + chaplain initial overdue / volunteer gate-watcher / hour aggregator.
    // None of the five existed before GAP-044: five catalogued `m15.*` events were never emitted and a
    // lapsed 418.78 gate was only ever caught fail-closed at read time.
    const m15ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M15_PLATFORM_JOB_ID,
      reason: "M15 discipline-plan crons fan-out (supervisory/initial-overdue/gate-watcher/hours)",
    });
    const m15WorkerDeps = buildM15WorkerDeps({
      connection: queueConnection,
      db: dbHandle.db,
      outbox: m15OutboxPublisher,
      activeOrgs: m15ActiveOrgs,
      // M8's signed-encounter digest carries no duration — the composition-root adapter reads the bracket.
      log: app.log,
    });
    const m15Workers = registerM15CronWorkers(m15WorkerDeps);
    attachDlqAlertsToAll(m15Workers, "m15");
    app.addHook("onClose", async () => {
      await Promise.all(m15Workers.map((w) => w.close()));
    });
    try {
      const m15ScheduleQueues = await scheduleM15Jobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m15ScheduleQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M15 cron-schedule registration failed");
    }
    app.log.info({ queues: m15Workers.length }, "M15 discipline-plan crons constructed");

    // ── M6 admission F2F due-reminder cron ───────────────────────────────────────────────────────────────
    const m6ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M6_PLATFORM_JOB_ID,
      reason: "M6 admission F2F due-reminder cron fan-out (active-org enumeration)",
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

    app.log.info({ queues: m6Workers.length }, "M6 admission due-reminder crons constructed");

    // ── M1 idempotency.cleanup (GAP-113) + M3 reap_breakglass (GAP-117) ──────────────────────────────────
    const m1m3ActiveOrgs = (jobId: string, reason: string) =>
      buildActiveOrgEnumerator({
        platformDb: platformDbHandle?.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId,
        reason,
      });
    const m3ReaperWorkers = registerM3CronWorkers(queueConnection, {
      db: dbHandle.db,
      outbox: m3OutboxPublisher as M3OutboxPublisher,
      activeOrgs: m1m3ActiveOrgs(
        M3_PLATFORM_JOB_ID,
        "M3 reap_breakglass cron (active-org enumeration)",
      ),
    });
    const idempotencyCleanupWorker = registerIdempotencyCleanupWorker(queueConnection, {
      db: dbHandle.db,
      activeOrgs: m1m3ActiveOrgs(
        IDEMPOTENCY_CLEANUP_JOB_ID,
        "M1 idempotency.cleanup cron (active-org enumeration)",
      ),
    });
    attachDlqAlertsToAll([...m3ReaperWorkers, idempotencyCleanupWorker], "m1m3");
    app.addHook("onClose", async () => {
      await Promise.all([...m3ReaperWorkers, idempotencyCleanupWorker].map((w) => w.close()));
    });
    try {
      const m1m3ScheduleQueues = [
        ...(await scheduleM3Jobs(queueConnection)),
        await scheduleIdempotencyCleanup(queueConnection),
      ];
      app.addHook("onClose", async () => {
        await Promise.all(m1m3ScheduleQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M1/M3 cleanup cron-schedule registration failed");
    }
    app.log.info("M1 idempotency.cleanup and M3 reap_breakglass crons constructed");

    // ── M21 §4.6 crons (GAP-062) ─────────────────────────────────────────────────────────────────────────
    // par-monitor (`m21.par.below_threshold` / `stockout_imminent`), unreturned-kit-monitor (the automatic
    // 30-day `overdue` flip + `m21.comfort_kit.return_overdue`) and the supply-request monitor (the 72h
    // `system_auto_confirm` receipt fallback + the vendor/delivery lateness advisories). Active-org fan-out
    // over the audited platform pool; each org's work runs under withOrgContext, publishing through the
    // catalog-validating tx publisher (`m21`).
    const m21ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M21_PLATFORM_JOB_ID,
      reason: "M21 §4.6 supplies cron fan-out (active-org enumeration)",
    });
    const m21AlertEmitter = getSeam("AlertEmitter") as {
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
    const m21Workers = registerM21CronWorkers(
      buildM21WorkerDeps({
        connection: queueConnection,
        db: dbHandle.db,
        outbox: m21OutboxPublisher,
        activeOrgs: m21ActiveOrgs,
        // par-monitor's 04:00-local gate: M1's owner read (M21 must not read `location` itself).
        locationTimezone: (tx, locationId) =>
          buildFoundationSiteReader().locationTimezone(tx, locationId),
        alerts: {
          emit: async ({ organizationId, kind, payload }) => {
            await m21AlertEmitter.emit(organizationId, {
              eventType: kind,
              payload,
              severity: typeof payload.severity === "string" ? payload.severity : "medium",
              correlationId: `m21-cron:${kind}`,
            });
          },
        },
      }),
    );
    attachDlqAlertsToAll(m21Workers, "m21");
    app.addHook("onClose", async () => {
      await Promise.all(m21Workers.map((w) => w.close()));
    });
    try {
      const m21ScheduleQueues = await scheduleM21Jobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m21ScheduleQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M21 cron-schedule registration failed");
    }
    app.log.info({ queues: m21Workers.length }, "M21 §4.6 supplies crons constructed");

    // ── M28 §4.8 workers (GAP-084) ───────────────────────────────────────────────────────────────────────
    // fhir.bulk-export (projects through the SAME consent-gated pipeline the sync reads use, re-checking the
    // client's status / BAA / scopes at execution time) + its sweeper (24h expiry + MinIO purge, orphan
    // re-queue), the inbound SLA watch (pending -> expired + M36 alert), the +30d inbound payload shred and the
    // client-session sweeper. Active-org fan-out over the audited platform pool; every org's work runs under
    // withOrgContext, publishing through the catalog-validating tx publisher (`m28`).
    const m28ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M28_PLATFORM_JOB_ID,
      reason: "M28 §4.8 FHIR gateway workers fan-out (active-org enumeration)",
    });
    const m28DisclosureStore = createDrizzleFhirGatewayStore(dbHandle.db);
    const m28Alerts = getSeam("AlertEmitter") as {
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
    const m28EnqueueForSweeper = m28ExportQueue ?? buildBulkExportEnqueuePort(queueConnection);
    const m28Workers = registerM28Workers({
      connection: queueConnection,
      bulkExport: {
        db: dbHandle.db,
        outbox: m28OutboxPublisher,
        objects: m28ExportObjects,
        // M5's keyset patient-id enumeration, injected as a port (M28 reads no M5 table).
        patients: {
          patientIdsPage: (organizationId, afterId, limit) =>
            patientIdsPageForOrg(dbHandle.db, organizationId, afterId, limit),
        },
        baa: { isBaaActive: (input) => getFhirBaaStatusProvider().isBaaActive(input) },
        disclosures: m28DisclosureStore,
        log: app.log,
      },
      sweeper: {
        db: dbHandle.db,
        outbox: m28OutboxPublisher,
        objects: m28ExportObjects,
        enqueue: m28EnqueueForSweeper.port,
        activeOrgs: m28ActiveOrgs,
        log: app.log,
      },
      inbound: {
        db: dbHandle.db,
        outbox: m28OutboxPublisher,
        activeOrgs: m28ActiveOrgs,
        alerts: {
          emit: async ({ organizationId, kind, payload, correlationId }) => {
            await m28Alerts.emit(organizationId, {
              eventType: kind,
              payload,
              severity: "warn",
              correlationId,
            });
          },
        },
        log: app.log,
      },
      sessions: { db: dbHandle.db, activeOrgs: m28ActiveOrgs, log: app.log },
      // §4.8 fhir.capability-snapshot-validator — reads on the tenant pool (SELECT USING (true)); the one-time
      // INSERT of the signed snapshot rides the audited platform pool (absent => verify-only, warned).
      capability: {
        db: dbHandle.db,
        signingKey: process.env.FHIR_CAPABILITY_SIGNING_KEY,
        buildStatement: buildGatewayCapabilityStatement,
        releaseTag: CAPABILITY_RELEASE_TAG,
        ...(platformDbHandle
          ? {
              runPlatform: (fn) =>
                withPlatformContext(
                  platformDbHandle.db,
                  {
                    jobId: M28_PLATFORM_JOB_ID,
                    reason: "M28 fhir.capability-snapshot-validator persists the signed snapshot",
                  },
                  m34PlatformBypassAuditor,
                  fn,
                ),
            }
          : {}),
        log: app.log,
      },
    });
    attachDlqAlertsToAll(m28Workers, "m28");
    app.addHook("onClose", async () => {
      await Promise.all(m28Workers.map((w) => w.close()));
      await m28ExportQueue?.queue.close();
      if (!m28ExportQueue) await m28EnqueueForSweeper.queue.close();
    });
    try {
      const m28ScheduleQueues = await scheduleM28Jobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m28ScheduleQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M28 cron-schedule registration failed");
    }
    app.log.info({ queues: m28Workers.length }, "M28 §4.8 FHIR gateway workers constructed");

    // ── M38 §4.3 workers (GAP-108) ───────────────────────────────────────────────────────────────────────
    // One real Worker per queue: load_version (fetch → checksum → parse → stage → activate, resumable from `staged`,
    // failed loads leave no residue), refresh_expansions, refresh_embeddings, tenant_deprecation_scan and the five
    // scheduled_* source jobs. Writes go through the `terminology_loader` SECURITY DEFINER functions as `chartwarden_app`;
    // the tenant scan fans out over the audited active-org enumerator and reaches each org's code usage through the
    // owner-published CarePlanReader seam. Tier-1 fetches need TERMINOLOGY_LOADER_EGRESS=on; tier-2 (SNOMED / RxNorm /
    // LOINC) sit behind the fail-closed credential deny-stub — no licensed fetch is wired.
    if (m38Producer) {
      const m38Store = createDbLoaderStore(dbHandle.db);
      const m38Objects = m38S3Config
        ? createPlatformObjectPort(
            createS3ObjectStore({ ...m38S3Config, publicEndpoint: m38S3Config.endpoint }),
            m38PlatformBucket,
          )
        : {
            async read(): Promise<Uint8Array> {
              throw new Error("platform object storage is not configured (MINIO_* unset)");
            },
            async write(): Promise<void> {
              throw new Error("platform object storage is not configured (MINIO_* unset)");
            },
          };
      const m38Embeddings = embedderUnavailable;
      const m38ActiveOrgs = buildActiveOrgEnumerator({
        platformDb: platformDbHandle?.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M38_PLATFORM_JOB_ID,
        reason: "M38 §4.3 tenant_deprecation_scan fan-out (active-org enumeration)",
      });
      const m38Alerts = getSeam("AlertEmitter") as {
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
      const m38Workers = registerM38Workers({
        connection: queueConnection,
        load: {
          store: m38Store,
          objects: m38Objects,
          followUps: m38Producer,
          log: app.log,
          today: () => new Date().toISOString().slice(0, 10),
          embeddingsAvailable: m38Embeddings.available,
        },
        scheduled: {
          store: m38Store,
          objects: m38Objects,
          followUps: m38Producer,
          log: app.log,
          now: () => new Date(),
          fetchImpl: fetch,
          egressEnabled: process.env.TERMINOLOGY_LOADER_EGRESS === "on",
          publicAdapters: PUBLIC_SOURCE_ADAPTERS,
          licensed: licensedSourceDenyStub,
        },
        expansions: { writer: createDbExpansionWriter(dbHandle.db) },
        embeddings: {
          store: createDbEmbeddingStore(dbHandle.db),
          embedder: m38Embeddings,
          continueRun: (system, versionId) => m38Producer.continueEmbeddings(system, versionId),
        },
        scan: {
          activeOrgs: m38ActiveOrgs,
          ops: createDbTerminologyOpsStore(dbHandle.db),
          producers: [carePlanCodeUsageProducer(() => getSeam("CarePlanReader"))],
          alerts: m38Alerts,
          log: app.log,
        },
        failVersion: (versionId, reason) => m38Store.fail(versionId, reason),
        log: app.log,
      });
      attachDlqAlertsToAll(m38Workers, "m38");
      app.addHook("onClose", async () => {
        await Promise.all(m38Workers.map((w) => w.close()));
        await Promise.all(m38Producer.queues.map((q) => q.close()));
      });
      try {
        const m38ScheduleQueues = await scheduleM38Jobs(queueConnection);
        app.addHook("onClose", async () => {
          await Promise.all(m38ScheduleQueues.map((q) => q.close()));
        });
      } catch (err) {
        app.log.error(err, "M38 cron-schedule registration failed");
      }
      app.log.info({ queues: m38Workers.length }, "M38 §4.3 terminology workers constructed");
    }

    // ── M9 §4.8 `license`/`changes`/`cadence` crons (TASK-040D — the M25 worker-runner shape) ────────────
    // `summary`/`eraser` (M9_QUEUES) stay out of scope — event-driven / M4-destruction-cert consumers.
    const m9ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M9_PLATFORM_JOB_ID,
      reason: "M9 §4.8 license/change-escalation/cadence cron fan-out (active-org enumeration)",
    });
    const m9WorkerDeps = buildM9WorkerDeps({
      connection: queueConnection,
      db: dbHandle.db,
      outbox: m9OutboxPublisher,
      activeOrgs: m9ActiveOrgs,
      // GAP-181 — the cadence scan's active-patient population (M6, org-explicit, keyset-paginated).
      activeAdmissions: {
        activeAdmissionsForOrg: (organizationId, afterAdmissionId, limit) =>
          idgActiveAdmissionsForOrg(dbHandle.db, organizationId, afterAdmissionId, limit),
      },
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
    app.log.info({ queues: m9Workers.length }, "M9 §4.8 BullMQ compliance-scan crons constructed");

    // ── M20 §4.8 `m20.sos-sla-watchdog.cron` (F-111, #249 — the M9 worker-runner shape) ─────────────────
    // `decideSosWatchdog` (lifecycle/sos-escalator.ts) shipped with M20-T03 and had no production caller
    // anywhere: no file under 20-field-safety matched *cron*/*worker*/*job*, so an unacknowledged SOS
    // alert sat in `acknowledging` (or any later tier) forever. GAP-032: the tier-3 -> emergency_terminus
    // rung is now entered at the SLA breach and its page/dial/PSAP effects run from the durable intent
    // ledger (jobs/cron-workers.ts's header, terminus/). consumers/m36-delivery-failed.ts deliberately
    // still does NOT enter the terminus: one failed SMS must not be able to auto-dial a spouse.
    const m20ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M20_PLATFORM_JOB_ID,
      reason: "M20 §4.8 SOS SLA watchdog cron fan-out (active-org enumeration)",
    });
    m20TerminusBag = buildM20TerminusDeps({
      env: process.env,
      db: dbHandle.db,
      caller: createSosContactCaller(outOfBandBinding.transports.voice),
      decipher: createSafetyCiphers(lazyTenantKeys(getTenantKeyProvider)).decipher,
      log: (line) => process.stderr.write(`${line}\n`),
    });
    const m20WorkerDeps = buildM20WorkerDeps({
      connection: queueConnection,
      db: dbHandle.db,
      outbox: m20OutboxPublisher,
      policy: createSafetyPolicyProvider(buildDrizzleSafetySeamStore(dbHandle.db)),
      // GAP-032 — the SOS emergency-terminus effects: the platform page to ChartWarden ops, the M36 voice call
      // to the consented emergency contact (gated OFF by CHARTWARDEN_SOS_CONTACT_DIAL), and the M40 PSAP
      // lookup. An unbound port degrades to a RECORDED ledger skip and a loud boot line - it never stops
      // the terminus being entered (see 20-field-safety/terminus/build.ts).
      terminus: m20TerminusBag,
      activeOrgs: m20ActiveOrgs,
      // GAP-061 — the overdue detector's D14 after-hours zone, through M1's owner reader (M20 reads no
      // `location` row itself).
      locationTimezone: (tx, locationId) =>
        buildFoundationSiteReader().locationTimezone(tx, locationId),
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
    // GAP-061 — `registerM20CronWorkers` now also constructs the §4.8 `m20.overdue-detector.cron` (30 s, the
    // lone-worker overdue check-in detector; it subsumes the post-visit closer) and the hourly
    // `m20.coverage-gap-watchdog.cron`, both over the same deps (real catalog-validating `m20OutboxPublisher`).
    app.log.info(
      { queues: m20Workers.length },
      "M20 §4.8 SOS SLA watchdog + overdue-detector + coverage-gap-watchdog crons constructed",
    );

    // ── M16 §4.9 bereavement crons (GAP-048 — the M20 worker-runner shape) ───────────────────────────────
    // `closeAt13Months` and `missDeadline` had no caller anywhere: plans never auto-closed at death_date + 13
    // months, no outreach was ever marked `missed` (so M30's missed/overdue counts were permanently 0) and no
    // anniversary reminder was ever alerted. Three time-driven queues now produce them (`m16-close-13mo`,
    // `m16-miss-deadline`, `m16-anniversary-lookahead`); each writes its row change + the m16.* outbox event
    // through the real catalog-validating tx publisher in ONE per-row org tx. `alerts` is left unbound like
    // M16's routes: the M36 alerts ride the outbox events, and the workers' best-effort alert port is optional.
    const m16ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M16_PLATFORM_JOB_ID,
      reason: "M16 §4.9 bereavement cron fan-out (active-org enumeration)",
    });
    const m16WorkerDeps = buildM16WorkerDeps({
      connection: queueConnection,
      db: dbHandle.db,
      outbox: m16OutboxPublisher,
      activeOrgs: m16ActiveOrgs,
    });
    const m16Workers = registerM16CronWorkers(m16WorkerDeps);
    attachDlqAlertsToAll(m16Workers, "m16");
    app.addHook("onClose", async () => {
      await Promise.all(m16Workers.map((w) => w.close()));
    });
    try {
      const m16ScheduleQueues = await scheduleM16Jobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m16ScheduleQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M16 cron-schedule registration failed");
    }
    app.log.info({ queues: m16Workers.length }, "M16 §4.9 bereavement crons constructed");

    // ── M10 §4.8 HOPE crons (TASK-040D — the M25 worker-runner shape) ────────────────────────────────────
    // `hope-window-watchdog` + `sfv-watchdog`, plus (F-058 / F-072) the three §4.10 submission stages on
    // the shared `hope.submission` queue: `assemble-hope-submission`, `iqies-submit-worker` and
    // `iqies-reconcile-worker`. `alerts`/`scheduling`/`validation`/`retention` are still out of scope —
    // see jobs/cron-workers.ts's own header.
    //
    // The iQIES adapter is bound to `createUnboundIqiesAdapter` because there is no live transport to
    // bind: iQIES has no submission API (CMS HOPE FAQs Q30) — submission is the manual package upload
    // (#177). That binding is DELIBERATE and is not the same as leaving the port unbound — the deny-stub
    // raises a typed `retryable: false` DegradedError, so the job DLQs immediately (no retry storm) and
    // `attachDlqAlertsToAll` surfaces it, while Tier-2 capture is untouched (§5.6 / §7.10).
    const m10ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
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
      // GAP-181 — the monthly `hope-retention-scan` is gated on M4's active legal holds (M10 never reads
      // `legal_hold`). No tenant override is bound: the architecture horizons (7y / 10y) already exceed every
      // regulatory floor, and an override could only lengthen them.
      retentionHolds: {
        activeLegalHoldScopeForOrg: (organizationId) =>
          activeLegalHoldScopeForOrg(dbHandle.db, organizationId),
      },
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
      "M10 §4.8 BullMQ HOPE crons constructed (watchdogs + monthly retention scan; iQIES submission is the manual package flow)",
    );

    // ── M14 §4.8 crons: `idg.review-clock-sweep` (GAP-092), `idg.schedule-materialise` (§7.1) and
    // `idg.packets-cron` (§4.9.1 `tminus-24h-build`, F-171 — the real T-24h packet-build worker) — the
    // M9/M10/M25 worker-runner shape. `m6`/`m7` are the org-explicit ports `packet-build.ts` needs
    // (`idgPacketInclusionForOrg`/`idgCurrentLevelOfCareForOrg` on M6, `idgPacketCarePlanContextForOrg` on
    // M7), wired here rather than imported by M14 directly — a locally-declared structural port type on
    // the M14 side, the `arch:boundaries` type-only-import rule (F-165's `m16-plan-closed.ts` precedent).
    const m14ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M14_PLATFORM_JOB_ID,
      reason:
        "M14 §4.8 idg.review-clock-sweep / idg.schedule-materialise / idg.packets-cron fan-out (active-org enumeration)",
    });
    const m14WorkerDeps = buildM14WorkerDeps({
      connection: queueConnection,
      db: dbHandle.db,
      outbox: m14OutboxPublisher,
      activeOrgs: m14ActiveOrgs,
      redis: m14SinceLastIdgRedisClient ?? undefined,
      // GAP-042 — the review-clock sweep's per-active-admission population (M6, keyset-paginated).
      activeAdmissions: {
        activeAdmissionsForOrg: (organizationId, afterAdmissionId, limit) =>
          idgActiveAdmissionsForOrg(dbHandle.db, organizationId, afterAdmissionId, limit),
      },
      m6: {
        inclusionForOrg: (organizationId, locationId, asOfIso, wrapUpDays) =>
          idgPacketInclusionForOrg(dbHandle.db, organizationId, locationId, asOfIso, wrapUpDays),
        currentLevelOfCareForOrg: (organizationId, admissionId, asOfIso) =>
          idgCurrentLevelOfCareForOrg(dbHandle.db, organizationId, admissionId, asOfIso),
      },
      m7: {
        carePlanContextForOrg: (organizationId, patientId, asOfIso) =>
          idgPacketCarePlanContextForOrg(dbHandle.db, organizationId, patientId, asOfIso),
      },
      // §2.4 cover `nextRecertDueAt`/`f2fWindowState` — M6's own window math, snapshotted at packet freeze.
      recertWindows: {
        recertWindowsForOrg: (organizationId, patientIds, asOfIso) =>
          idgRecertWindowsForOrg(dbHandle.db, organizationId, patientIds, new Date(asOfIso)),
      },
      // §2.4 `sinceLastIdg.flaggedEvents` — three org-explicit BATCHED source seams (M14 imports none of their code):
      // M6 hospital/ER (ADT-derived windows), M13 missed doses, M30 falls + infections, M19 GIP-proposal triage calls (F-218).
      flaggedEventSources: [
        {
          source: "m6.hospital",
          flaggedEventsForOrg: (organizationId, patientIds, sinceIso) =>
            idgHospitalEventsForOrg(dbHandle.db, organizationId, patientIds, sinceIso),
        },
        {
          source: "m13.missed_dose",
          flaggedEventsForOrg: (organizationId, patientIds, sinceIso) =>
            idgMissedDosesForOrg(dbHandle.db, organizationId, patientIds, sinceIso),
        },
        {
          source: "m30.fall_infection",
          flaggedEventsForOrg: (organizationId, patientIds, sinceIso) =>
            idgQualityFlaggedEventsForOrg(dbHandle.db, organizationId, patientIds, sinceIso),
        },
        // F-218 — M19 after-hours triage calls that proposed a GIP admission (`care_plan_change_indicated`).
        {
          source: "m19.triage_care_plan_change",
          flaggedEventsForOrg: (organizationId, patientIds, sinceIso) =>
            idgTriageCarePlanChangesForOrg(dbHandle.db, organizationId, patientIds, sinceIso),
        },
      ],
      // §2.4 `hopeContext` — M10's org-explicit batched open-timepoint + open-SFV read.
      hope: {
        hopeContextForOrg: (organizationId, patientIds) =>
          idgHopeContextForOrg(dbHandle.db, organizationId, patientIds),
      },
      // F-230 `medicationHistory` — M12's org-explicit batched external-medication-history STATE (the seam-pull
      // binding of `m14 <- m12.medication_history_pulled`; reads the ingest ledger, counts/instants only).
      medicationHistory: {
        medicationHistoryForOrg: (organizationId, patientIds) =>
          idgMedicationHistoryForOrg(dbHandle.db, organizationId, patientIds),
      },
      // The packet PDF's org/location header + named carry-forward assignees (M1 / M2 org-explicit seams; the
      // worker has no request, so both take the org id explicitly and open their own `withOrgContext`).
      siteDisplay: {
        displayForSite: (organizationId, locationIds) =>
          siteDisplayForOrg(dbHandle.db, organizationId, locationIds),
      },
      membershipDisplay: {
        displayForMemberships: (organizationId, membershipIds) =>
          membershipDisplayForOrg(dbHandle.db, organizationId, membershipIds),
      },
      locationTimezone: {
        locationTimezone: (organizationId, locationId) =>
          withOrgContext(dbHandle.db, { organizationId, userId: "" }, (tx) =>
            buildFoundationSiteReader().locationTimezone(tx as unknown as DbClient, locationId),
          ),
      },
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

    // ── M13 §4.8 crons (GAP-038/039/040): `m13.extend-schedule`, `m13.missed-dose-sweep`,
    // `m13.reconciliation-due-warning`, `m13.kit-return-overdue`, `m13.prn-reassessment-overdue`. None
    // existed: scheduled doses stopped after the 7-day activation window, nothing ever wrote `missed_dose`
    // (M30 published a fabricated 0% rate), and no deadline signal (late reconciliation, unreturned kit,
    // uncaptured PRN reassessment) was ever produced. Every pass is org-explicit (a cron tick is not a
    // request): the active-org fan-out runs under the audited platform context, each org's work opens its own
    // `withOrgContext`, and events go through the REAL catalog-validating `m13OutboxPublisher`. M12's order
    // facts and M1's location timezone are the same org-explicit seams the activation materializer uses; M9's
    // `ScaleSeriesProvider` (request-scoped read) runs under an explicit per-org `runWithRequestContext`.
    const m13ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M13_PLATFORM_JOB_ID,
      reason: "M13 §4.8 eMAR cron fan-out (active-org enumeration)",
    });
    const m13Workers = registerM13CronWorkers({
      connection: queueConnection,
      db: dbHandle.db,
      outbox: m13OutboxPublisher,
      activeOrgs: m13ActiveOrgs,
      orderContext: (organizationId, orderId) =>
        medicationOrderScheduleContextForOrg(dbHandle.db, organizationId, orderId),
      locationTimezone: (organizationId, locationId) =>
        withOrgContext(dbHandle.db, { organizationId, userId: "" }, (tx) =>
          buildFoundationSiteReader().locationTimezone(tx as unknown as DbClient, locationId),
        ),
      reassessmentCaptured: (organizationId, patientId, scaleType, fromIso, toIso) =>
        runWithRequestContext({ organizationId, userId: "", systemActor: true }, async () => {
          const series = await getSeam("ScaleSeriesProvider").series(
            patientId as PatientId,
            scaleType as ScaleType,
            fromIso,
            toIso,
          );
          return series.points.length > 0;
        }),
    });
    attachDlqAlertsToAll(m13Workers, "m13");
    app.addHook("onClose", async () => {
      await Promise.all(m13Workers.map((w) => w.close()));
    });
    try {
      const m13ScheduleQueues = await scheduleM13Jobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m13ScheduleQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M13 cron-schedule registration failed");
    }
    app.log.info({ queues: m13Workers.length }, "M13 §4.8 BullMQ eMAR crons constructed");

    // ── M39 §4.9 crons: `m39.consent_expiration` + `m39.expiration_reminder` (F-216) — the ONLY producers
    // of `m39.consent.expired` / `m39.consent.expiring_soon` (M5's §7.6 privacy snapshot consumes `.expired`).
    // Hourly, per-org, org-explicit: each tick enumerates active orgs under the audited platform context and
    // opens one `withOrgContext` tx per page, flipping the row and publishing through the REAL catalog-
    // validating M39 publisher in that same tx. First-run backlog is bounded by `M39_CRON_BOUNDS`.
    const m39ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M39_PLATFORM_JOB_ID,
      reason:
        "M39 §4.9 consent-expiration / expiration-reminder cron fan-out (active-org enumeration)",
    });
    const m39WorkerDeps = buildM39WorkerDeps({
      connection: queueConnection,
      db: dbHandle.db,
      outbox: m39OutboxPublisher,
      activeOrgs: m39ActiveOrgs,
      // GAP-171 — the live M36 seam: the CRITICAL `m39.consent.revoked_cascade_failed` alert.
      alerts: getSeam("AlertEmitter") as M39AlertPort,
    });
    const m39Workers = registerM39CronWorkers(m39WorkerDeps);
    attachDlqAlertsToAll(m39Workers, "m39");
    app.addHook("onClose", async () => {
      await Promise.all(m39Workers.map((w) => w.close()));
    });
    try {
      const m39ScheduleQueues = await scheduleM39Jobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m39ScheduleQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M39 cron-schedule registration failed");
    }
    app.log.info(
      { queues: m39Workers.length },
      "M39 §4.9 BullMQ consent-expiration + expiration-reminder + revocation-cascade-retry crons constructed",
    );

    // ── M40 §4.3 `mdm.baa_expiration_scan` (GAP-173): daily, per-org, org-explicit. Warns (90/30/0 days) before
    // a facility/payer BAA lapses and the §7.7 gate starts denying disclosure to it. Alerts go through the live
    // M36 AlertEmitter (idempotent on `(org, correlationId)`), so a daily re-scan never re-raises a window.
    // GAP-173 — the remaining §4.3 jobs share the same Worker set: license-expiration, fuzzy-dedup (writes
    // `merge_request` through the 0473 definer function), provisional-aging (org-less platform-ops notice —
    // durable audit row + the log/webhook sink below, never a tenant alert), and the NPPES nightly delta (fallback-
    // only) / weekly full sweep. The NPPES HTTP client and M29's last-sync read are M29's, so M40 receives them as
    // injected closures here (it must not import M29 or read its table).
    const m40NppesClient = new NppesClient({
      fetch: (url, init) => fetch(url, init as RequestInit),
      log: (level, event, fields) => app.log[level]({ ...fields, event }, "m40.nppes.fallback"),
    });
    const m40Workers = registerM40CronWorkers({
      connection: queueConnection,
      db: dbHandle.db,
      orgs: buildActiveOrgEnumerator({
        platformDb: platformDbHandle?.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M40_PLATFORM_JOB_ID,
        reason: "M40 §4.3 scheduled scans fan-out (active-org enumeration)",
      }),
      alerts: getSeam("AlertEmitter") as M40AlertPort,
      platformOps: buildPlatformOpsNoticeSink({
        webhookUrl: process.env.OPS_ALERT_WEBHOOK_URL,
        log: (m) => app.log.warn(m),
      }),
      m29LastSyncCompletedAt: () => lastCompletedNppesSyncAt(dbHandle.db),
      fetchProvider: async (npi) => {
        const result = await m40NppesClient.fetchByNpi(npi as Npi);
        if (result.kind !== "found" && result.kind !== "deactivated") return null;
        return {
          npi,
          status: result.kind === "deactivated" ? "deactivated" : "active",
          lastName: result.provider.basic.lastName,
          specialtyTaxonomy: primaryTaxonomyCode(result.provider),
        };
      },
    });
    attachDlqAlertsToAll(m40Workers, "m40");
    app.addHook("onClose", async () => {
      await Promise.all(m40Workers.map((w) => w.close()));
    });
    try {
      const m40ScheduleQueues = await scheduleM40Jobs(queueConnection, {
        includeNppes: process.env.NPPES_SYNC_DISABLED !== "1",
      });
      app.addHook("onClose", async () => {
        await Promise.all(m40ScheduleQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M40 cron-schedule registration failed");
    }

    // ── M36 §4.4 out-of-band delivery workers (GAP-101): `messaging.send_push|sms|voice|email`. A repeatable
    // tick per queue sweeps the pending `notification_delivery` rows of every active org (bounded batch, leased
    // claim, §4.4.1 retry/backoff), dispatches through the transport SEAM and settles the row; a terminal failure
    // publishes `m36.notification.delivery_failed` in the same tx. The transports are `outOfBandBinding.transports`
    // (GAP-062): the real web-push / Twilio SMS+voice / Postmark adapter per channel when its env is set, otherwise
    // that channel's fail-closed DENY transport — so an unconfigured out-of-band delivery settles `failed`
    // (`transport_not_configured`) rather than sitting `pending` forever or being reported as sent.
    const m36DeliveryActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M36_DELIVERY_PLATFORM_JOB_ID,
      reason: "M36 §4.4 send_* delivery sweep (active-org enumeration)",
    });
    // WP 4.7: an out-of-band alert whose base URL is unusable ships with generic wording and NO link.
    // Warn at boot in production-like envs, and log (reason code + channel only, no content) each generic fallback.
    if (process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging") {
      let baseUrlUsable = false;
      try {
        baseUrlUsable = /^https?:$/.test(new URL(webAppBaseUrl ?? "").protocol);
      } catch {
        baseUrlUsable = false;
      }
      if (!baseUrlUsable)
        app.log.warn(
          "WEB_APP_URL / BETTER_AUTH_URL is empty or not a valid http(s) URL: out-of-band alerts will ship without a link",
        );
    }
    setOutOfBandFallbackObserver((event) =>
      app.log.warn(
        { reason: event.reason, channel: event.channel },
        "M36 out-of-band alert rendered with generic wording (unproven or wrong-channel notification)",
      ),
    );
    const m36DeliveryWorkers = registerM36DeliveryWorkers({
      connection: queueConnection,
      store: createDrizzleDeliveryDispatchStore(dbHandle.db, m36OutboxPublisher),
      transports: outOfBandBinding.transports,
      appBaseUrl: webAppBaseUrl ?? "",
      activeOrgs: m36DeliveryActiveOrgs,
      onError: (context, err) => app.log.error({ ...context, err }, "M36 delivery sweep error"),
    });
    attachDlqAlertsToAll(m36DeliveryWorkers, "m36");
    app.addHook("onClose", async () => {
      await Promise.all(m36DeliveryWorkers.map((w) => w.close()));
    });
    try {
      const m36DeliveryScheduleQueues = await scheduleM36DeliveryJobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m36DeliveryScheduleQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M36 delivery-sweep schedule registration failed");
    }

    // ── M36 WP 1.5 — `messaging.attachment_scan` (every minute): the retry path for completed uploads the scanner
    // could not answer for. `complete` already tries one scan inline. Fan-out needs the platform pool; the verdict is
    // applied per org under withOrgContext. Without a scanner the sweep is a no-op and attachments stay pending.
    if (platformDbHandle) {
      const m36AttachmentScanOrgs = buildActiveOrgEnumerator({
        platformDb: platformDbHandle.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M36_INTEGRITY_PLATFORM_JOB_ID,
        reason: "M36 WP 1.5 attachment_scan active-org fan-out",
      });
      const m36AttachmentScanWorkers = registerM36AttachmentScanWorker({
        connection: queueConnection,
        service: createAttachmentService({
          db: dbHandle.db,
          storage: m36AttachmentBinding.storage,
          scanner: m36AttachmentBinding.scanner,
          outbox: m36OutboxPublisher,
          canViewChannel: async () => false, // the sweep is not a reader
          // The orphan reaper deletes rows, which only the destruction credential may do (the app role has no DELETE).
          reaperDb: destructionDbHandle?.db,
          // Message only. The storage adapter signs URLs and sanitizes its own fetch errors, but M22's store `opError`
          // embeds the bucket and object key in its message - for attachments those are ids only
          // (`messaging/<channelId>/<attachmentId>`), never a file name or PHI. A signed URL must never reach a log.
          onScanError: (context, err) =>
            app.log.warn(
              { ...context, reason: err instanceof Error ? err.message : "unknown" },
              "M36 attachment scan deferred (row stays pending)",
            ),
          // Alert-worthy: the pipeline has not been able to judge this file for a long time (the row stays pending and is
          // retried hourly; it is NOT quarantined, because "the scanner was down" is not a verdict).
          onScanUnavailable: (context) =>
            app.log.error(
              context,
              "M36 attachment scan unavailable (row stays pending; check the scanner / bucket)",
            ),
          onReapError: (context, err) =>
            app.log.warn(
              { ...context, reason: err instanceof Error ? err.message : "unknown" },
              "M36 attachment reap deferred (row and object kept)",
            ),
        }),
        activeOrgs: m36AttachmentScanOrgs,
        // Message only (not the error object): DB/driver errors can carry statement parameters.
        onError: (context, err) =>
          app.log.error(
            { ...context, reason: err instanceof Error ? err.message : "unknown" },
            "M36 attachment scan error",
          ),
      });
      if (!destructionDbHandle) {
        app.log.warn(
          "M36 attachment orphan reaper disabled: DATABASE_DESTRUCTION_URL is not set (abandoned uploads are kept)",
        );
      }
      attachDlqAlertsToAll(m36AttachmentScanWorkers, "m36");
      app.addHook("onClose", async () => {
        await Promise.all(m36AttachmentScanWorkers.map((w) => w.close()));
      });
      try {
        const m36AttachmentScanQueues = await scheduleM36AttachmentScanJobs(queueConnection);
        app.addHook("onClose", async () => {
          await Promise.all(m36AttachmentScanQueues.map((q) => q.close()));
        });
      } catch (err) {
        app.log.error(err, "M36 attachment-scan schedule registration failed");
      }
    }

    // ── M36 WP 2.6 — `messaging.scheduled_send` (every minute): sends the scheduled messages that came due. Each one is
    // re-checked at dispatch (sender still a member holding messaging.send, channel not archived, announcement policy)
    // and sent through the live write core in the same transaction that deletes the row; a failed re-check blocks the
    // row and publishes `m36.message.schedule_blocked` (consumer below tells the sender). Active-org fan-out needs the
    // platform pool; the sends themselves run per org under the sender's tenant context.
    if (platformDbHandle) {
      const m36ScheduledSendOrgs = buildActiveOrgEnumerator({
        platformDb: platformDbHandle.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M36_INTEGRITY_PLATFORM_JOB_ID,
        reason: "M36 WP 2.6 scheduled_send active-org fan-out",
      });
      const m36ScheduledSendWorkers = registerM36ScheduledSendWorker({
        connection: queueConnection,
        dispatcher: createScheduledSendDispatcher({
          db: dbHandle.db,
          cipher: createMessageBodyCipher(),
          outbox: m36OutboxPublisher,
          // A consent/care-team outage must retry the row (bounded), not block it as "not a member".
          canViewChannel: createDbMessagingRouteService(dbHandle.db, {
            throwOnSeamUnavailable: true,
          }).canViewChannel,
          permissionsFor: async (organizationId, userId) =>
            resolveActorPermissions({ organizationId, userId }),
          // Ids only: a DB/driver error can carry statement parameters, and a sealed body must never reach a log.
          onRowError: (context, err) =>
            app.log.error(
              { ...context, reason: err instanceof Error ? err.name : "unknown" },
              "M36 scheduled send row failed",
            ),
        }),
        activeOrgs: m36ScheduledSendOrgs,
        onError: (context, err) =>
          app.log.error(
            { ...context, reason: err instanceof Error ? err.message : "unknown" },
            "M36 scheduled send error",
          ),
      });
      attachDlqAlertsToAll(m36ScheduledSendWorkers, "m36");
      app.addHook("onClose", async () => {
        await Promise.all(m36ScheduledSendWorkers.map((w) => w.close()));
      });
      try {
        const m36ScheduledSendQueues = await scheduleM36ScheduledSendJobs(queueConnection);
        app.addHook("onClose", async () => {
          await Promise.all(m36ScheduledSendQueues.map((q) => q.close()));
        });
      } catch (err) {
        app.log.error(err, "M36 scheduled-send schedule registration failed");
      }
    } else {
      app.log.warn(
        "M36 scheduled send disabled: DATABASE_PLATFORM_URL (active-org fan-out) is required; scheduled messages stay queued",
      );
    }

    // ── M36 WP 3.5 — `messaging.handoff_expiry` (every minute): closes the handoff offers whose (policy-capped) deadline
    // passed, so accountability stays with the sender and the sender and supervisors are told. A read-time check alone
    // would never fire when nobody opens the handoff. Active-org fan-out needs the platform pool; each handoff closes in
    // its own system-context transaction. Runs for flag-off tenants too: accountability must never stall on a flag.
    if (platformDbHandle && m36Handoffs) {
      const m36HandoffExpiryOrgs = buildActiveOrgEnumerator({
        platformDb: platformDbHandle.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M36_INTEGRITY_PLATFORM_JOB_ID,
        reason: "M36 WP 3.5 handoff_expiry active-org fan-out",
      });
      const m36HandoffExpiryWorkers = registerM36HandoffExpiryWorker({
        connection: queueConnection,
        expireDue: m36Handoffs.expireDue,
        activeOrgs: m36HandoffExpiryOrgs,
        // Ids and the error class only: a database error can carry statement parameters.
        onError: (context, err) =>
          app.log.error(
            { ...context, reason: err instanceof Error ? err.name : "unknown" },
            "M36 handoff expiry error",
          ),
      });
      attachDlqAlertsToAll(m36HandoffExpiryWorkers, "m36");
      app.addHook("onClose", async () => {
        await Promise.all(m36HandoffExpiryWorkers.map((w) => w.close()));
      });
      try {
        const m36HandoffExpiryQueues = await scheduleM36HandoffExpiryJobs(queueConnection);
        app.addHook("onClose", async () => {
          await Promise.all(m36HandoffExpiryQueues.map((q) => q.close()));
        });
      } catch (err) {
        app.log.error(err, "M36 handoff-expiry schedule registration failed");
      }
    } else {
      app.log.warn(
        "M36 handoff expiry disabled: DATABASE_PLATFORM_URL (active-org fan-out) is required; open handoffs stay offered",
      );
    }

    // ── M36 WP 5.8 (ADR-0087, PROPOSED) — `messaging.break_glass_review_sweep` (hourly): a break-glass review still open three days after its
    // grant ended raises one overdue alert to the review-permission holders (idempotent on the review id). Active-org fan-out needs the
    // platform pool. Runs for flag-off tenants too: accountability for a grant that exists must not stall on a flag.
    if (platformDbHandle) {
      const m36BreakGlassReviewSweep = createBreakGlassReviewSweep({
        db: dbHandle.db,
        alerts: getSeam("AlertEmitter") as AlertEmitter,
      });
      const m36BreakGlassReviewWorkers = registerM36BreakGlassReviewWorker({
        connection: queueConnection,
        overdueForOrg: m36BreakGlassReviewSweep.overdueForOrg,
        activeOrgs: buildActiveOrgEnumerator({
          platformDb: platformDbHandle.db,
          auditBypass: m34PlatformBypassAuditor,
          jobId: M36_INTEGRITY_PLATFORM_JOB_ID,
          reason: "M36 WP 5.8 break_glass_review_sweep active-org fan-out",
        }),
        // Ids and the error class only: a database error can carry statement parameters.
        onError: (context, err) =>
          app.log.error(
            { ...context, reason: err instanceof Error ? err.name : "unknown" },
            "M36 break-glass review sweep error",
          ),
      });
      attachDlqAlertsToAll(m36BreakGlassReviewWorkers, "m36");
      app.addHook("onClose", async () => {
        await Promise.all(m36BreakGlassReviewWorkers.map((w) => w.close()));
      });
      try {
        const m36BreakGlassReviewQueues = await scheduleM36BreakGlassReviewJobs(queueConnection);
        app.addHook("onClose", async () => {
          await Promise.all(m36BreakGlassReviewQueues.map((q) => q.close()));
        });
      } catch (err) {
        app.log.error(err, "M36 break-glass review sweep schedule registration failed");
      }
    } else {
      app.log.warn(
        "M36 break-glass review sweep disabled: DATABASE_PLATFORM_URL (active-org fan-out) is required; overdue reviews raise no alert",
      );
    }

    // ── WP 5.7 export builder/sweep (ADR-0089, PROPOSED) — `messaging.export_build` (event-driven: approved -> encrypted artefact) and
    // `messaging.export_expiry_sweep` (hourly: deletes the artefact of each export past its 24 h link). Both run for flag-off tenants too: an
    // approved export still builds and an artefact must still expire. The sweep's active-org fan-out needs the platform pool.
    if (m36Export && m36ExportBuildEnqueuer) {
      const m36ExportBuildWorkers = registerM36ExportBuildWorker({
        connection: queueConnection,
        builder: m36Export.builder,
        // The closed code and the error class only (never a message): an unexpected build failure is otherwise invisible to operations.
        onFailed: (info) => app.log.warn(info, "M36 export build failed"),
      });
      attachDlqAlertsToAll(m36ExportBuildWorkers, "m36");
      app.addHook("onClose", async () => {
        await Promise.all(m36ExportBuildWorkers.map((w) => w.close()));
        await m36ExportBuildEnqueuer.queue.close();
      });
    }
    if (m36Export && platformDbHandle) {
      const m36ExportExpiryWorkers = registerM36ExportExpiryWorker({
        connection: queueConnection,
        expireForOrg: m36Export.sweep.expireForOrg,
        // An approved export whose build job was lost (queue flushed) is enqueued again; the job id makes a live duplicate a no-op.
        staleApprovedForOrg: m36Export.sweep.staleApprovedForOrg,
        ...(m36ExportBuildEnqueuer ? { enqueue: m36ExportBuildEnqueuer.enqueue } : {}),
        activeOrgs: buildActiveOrgEnumerator({
          platformDb: platformDbHandle.db,
          auditBypass: m34PlatformBypassAuditor,
          jobId: M36_INTEGRITY_PLATFORM_JOB_ID,
          reason: "M36 WP 5.7 export_expiry_sweep active-org fan-out",
        }),
        // Ids and the error class only: a database error can carry statement parameters.
        onError: (context, err) =>
          app.log.error(
            { ...context, reason: err instanceof Error ? err.name : "unknown" },
            "M36 export expiry sweep error",
          ),
      });
      attachDlqAlertsToAll(m36ExportExpiryWorkers, "m36");
      app.addHook("onClose", async () => {
        await Promise.all(m36ExportExpiryWorkers.map((w) => w.close()));
      });
      try {
        const m36ExportExpiryQueues = await scheduleM36ExportExpiryJobs(queueConnection);
        app.addHook("onClose", async () => {
          await Promise.all(m36ExportExpiryQueues.map((q) => q.close()));
        });
      } catch (err) {
        app.log.error(err, "M36 export expiry sweep schedule registration failed");
      }
    }
    // ── end WP 5.7 export builder/sweep workers

    // ── M36 WP 4.10 — `messaging.reminder_sweep` (every minute): raises the alert of each reminder that came due and deletes the row.
    // A tenant with `messaging.notification_policy` off is skipped (its reminders wait). Active-org fan-out needs the platform pool.
    if (platformDbHandle && m36SnoozeReminders) {
      const m36ReminderOrgs = buildActiveOrgEnumerator({
        platformDb: platformDbHandle.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M36_INTEGRITY_PLATFORM_JOB_ID,
        reason: "M36 WP 4.10 reminder_sweep active-org fan-out",
      });
      const m36ReminderWorkers = registerM36ReminderSweepWorker({
        connection: queueConnection,
        sweep: m36SnoozeReminders.sweep(getSeam("AlertEmitter") as AlertEmitter, (event) =>
          app.log.warn(event, "M36 reminder dropped without a recipient"),
        ),
        activeOrgs: m36ReminderOrgs,
        // Ids and the error class only: a database error can carry statement parameters.
        onError: (context, err) =>
          app.log.error(
            { ...context, reason: err instanceof Error ? err.name : "unknown" },
            "M36 reminder sweep error",
          ),
      });
      attachDlqAlertsToAll(m36ReminderWorkers, "m36");
      app.addHook("onClose", async () => {
        await Promise.all(m36ReminderWorkers.map((w) => w.close()));
      });
      try {
        const m36ReminderQueues = await scheduleM36ReminderSweepJobs(queueConnection);
        app.addHook("onClose", async () => {
          await Promise.all(m36ReminderQueues.map((q) => q.close()));
        });
      } catch (err) {
        app.log.error(err, "M36 reminder-sweep schedule registration failed");
      }
    } else {
      app.log.warn(
        "M36 reminders disabled: DATABASE_PLATFORM_URL (active-org fan-out) is required; reminders stay pending",
      );
    }

    // ── M36 WP 4.4 — durable escalation timers. `messaging.ack_escalation_timer` runs the delayed job armed per (request,
    // tier, window); `messaging.ack_escalation_sweep` (every minute) finds the requests the DATABASE says are past their
    // deadline whether or not a job exists (a flushed Redis, a lost job, a request nobody could route yet). Both run the same
    // guarded write, so together they cannot escalate twice. The action itself is behind `messaging.escalation_timers`
    // (default off). A job that exhausts its retries is copied to its DLQ queue and audited as `m36.dlq_job`.
    if (platformDbHandle && m36AckEscalation) {
      const m36AckEscalationOrgs = buildActiveOrgEnumerator({
        platformDb: platformDbHandle.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M36_INTEGRITY_PLATFORM_JOB_ID,
        reason: "M36 WP 4.4 ack_escalation_sweep active-org fan-out",
      });
      const m36AckEscalationWorkers = registerM36AckEscalationWorkers({
        connection: queueConnection,
        service: m36AckEscalation.service,
        activeOrgs: m36AckEscalationOrgs,
        recordDlq: createDlqAuditRecorder(dbHandle.db),
        // WP 4.9 (ADR-0076): the threshold notice (log line + optional OPS_ALERT_WEBHOOK_URL) per organisation per tick.
        observeOrg: createAckQueueNoticeEvaluator({
          statsForOrg: (organizationId) =>
            createDbAckQueueStatsReader(dbHandle.db, {
              isEscalationEnabled: m36AckEscalation.isEnabled,
            })(organizationId, new Date()),
          notify: m36AckOpsNotice,
          claims: m36OpsNoticeClaims,
        }),
        // ADR-0079 (G-5): keeps failed_unreachable requests in front of the supervisors (bounded, backed-off, once per stage fleet-wide).
        ...(m36Ack
          ? {
              watchUnreachable: createUnreachableWatch({
                store: m36Ack.store,
                isEnabled: m36AckEscalation.isEnabled,
                claims: m36OpsNoticeClaims,
                attention: {
                  alerts: getSeam("AlertEmitter") as AlertEmitter,
                  opsNotice: m36AckOpsNotice,
                },
                onError: (context, err) =>
                  app.log.error(
                    { ...context, reason: err instanceof Error ? err.name : "unknown" },
                    "M36 unreachable watch error",
                  ),
              }).watch,
            }
          : {}),
        // Ids and the error class only: a database error can carry statement parameters.
        onError: (context, err) =>
          app.log.error(
            { ...context, reason: err instanceof Error ? err.name : "unknown" },
            "M36 ack escalation error",
          ),
        onDlqError: (context, err) =>
          app.log.error(
            { ...context, reason: err instanceof Error ? err.name : "unknown" },
            "M36 ack escalation DLQ landing failed",
          ),
      });
      attachDlqAlertsToAll(m36AckEscalationWorkers.workers, "m36");
      app.addHook("onClose", async () => {
        // The queue-events listener first (it feeds the DLQ queue), then the workers, then the queues; one failure skips none.
        await Promise.allSettled([m36AckEscalationWorkers.events.close()]);
        await Promise.allSettled(m36AckEscalationWorkers.workers.map((w) => w.close()));
        await Promise.allSettled([
          m36AckEscalationWorkers.dlqQueue.close(),
          m36AckEscalationWorkers.timerQueue.close(),
        ]);
      });
      try {
        const m36AckEscalationQueues = await scheduleM36AckEscalationJobs(queueConnection);
        app.addHook("onClose", async () => {
          await Promise.all(m36AckEscalationQueues.map((q) => q.close()));
        });
      } catch (err) {
        app.log.error(err, "M36 ack-escalation schedule registration failed");
      }
    } else if (m36AckEscalation) {
      app.log.warn(
        "M36 ack escalation sweep disabled: DATABASE_PLATFORM_URL (active-org fan-out) is required; a lost timer is not recovered",
      );
    }

    // ── M36 WP 1.9 (audit F8) — nightly `messaging.hash_verify` (message heads + revision chain) and weekly
    // `messaging.retention_scan` (plan only, hold-aware). Active-org fan-out needs the platform pool; each org's
    // run opens its own tenant transaction and records its summary through @chartwarden/audit.
    if (platformDbHandle) {
      const m36IntegrityOrgs = buildActiveOrgEnumerator({
        platformDb: platformDbHandle.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M36_INTEGRITY_PLATFORM_JOB_ID,
        reason: "M36 WP 1.9 hash_verify / retention_scan active-org fan-out",
      });
      const m36IntegrityWorkers = registerM36IntegrityWorkers({
        connection: queueConnection,
        db: dbHandle.db,
        cipher: createMessageBodyCipher(),
        messageHolds: { activeHolds: activeLegalHolds, openCertificate: openMessageCertificate },
        attachmentObjectsEnabled: async (organizationId: string) =>
          (await featureFlagReader?.forOrg(organizationId))?.[
            RETENTION_ATTACHMENT_DESTRUCTION_FLAG_KEY
          ] === true,
        // WP 5.6 (ADR-0086): the message destruction executor, after the weekly scan. Needs the destruction credential; off per tenant unless
        // `messaging.retention_destruction` is on, and a DRY RUN unless M36_RETENTION_DESTRUCTION_EXECUTE=true.
        ...(destructionDbHandle
          ? {
              destruction: {
                destructionDb: destructionDbHandle.db,
                messageHolds: {
                  activeHolds: activeLegalHolds,
                  openCertificate: openMessageCertificate,
                  approvedCertificates: approvedMessageCertificates,
                  completeCertificate: completeMessageCertificate,
                  expiredCertificateIds: expiredMessageCertificateIds,
                  lockCertificate: lockMessageCertificate,
                  certificateIsLive: messageCertificateIsLive,
                  reserveCertificateCount: reserveMessageCertificateCount,
                  settleCertificateCount: settleMessageCertificateCount,
                },
                onBatchError: (err: unknown) =>
                  app.log.error(
                    {
                      err:
                        err instanceof Error ? { name: err.name, message: err.message } : "unknown",
                    },
                    "M36 retention destruction batch failed",
                  ),
                isEnabled: async (organizationId: string) =>
                  (await featureFlagReader?.forOrg(organizationId))?.[
                    RETENTION_DESTRUCTION_FLAG_KEY
                  ] === true,
                execute: process.env[RETENTION_DESTRUCTION_EXECUTE_ENV] === "true",
                // The attachment-object step reuses the reaper's deadline-bound destroy and the destruction credential's stamp.
                attachmentObjects: {
                  isEnabled: async (organizationId: string) =>
                    (await featureFlagReader?.forOrg(organizationId))?.[
                      RETENTION_ATTACHMENT_DESTRUCTION_FLAG_KEY
                    ] === true,
                  destroyObjectsForMessages: createAttachmentService({
                    db: dbHandle.db,
                    storage: m36AttachmentBinding.storage,
                    scanner: m36AttachmentBinding.scanner,
                    canViewChannel: async () => false,
                    reaperDb: destructionDbHandle.db,
                    onReapError: (context, err) =>
                      app.log.warn(
                        { ...context, reason: err instanceof Error ? err.message : "unknown" },
                        "M36 retention attachment-object destroy deferred (row and object kept)",
                      ),
                  }).destroyObjectsForMessages,
                },
              },
            }
          : {}),
        activeOrgs: m36IntegrityOrgs,
        onError: (context, err) => app.log.error({ ...context, err }, "M36 integrity job error"),
      });
      attachDlqAlertsToAll(m36IntegrityWorkers, "m36");
      app.addHook("onClose", async () => {
        await Promise.all(m36IntegrityWorkers.map((w) => w.close()));
      });
      try {
        const m36IntegrityQueues = await scheduleM36IntegrityJobs(queueConnection);
        app.addHook("onClose", async () => {
          await Promise.all(m36IntegrityQueues.map((q) => q.close()));
        });
      } catch (err) {
        app.log.error(err, "M36 integrity-job schedule registration failed");
      }
    } else {
      app.log.warn(
        "M36 hash_verify / retention_scan disabled: DATABASE_PLATFORM_URL (active-org fan-out) is required",
      );
    }

    // M11 D5 — one repeatable hourly trigger enumerates active org ids under the audited platform
    // context; each delegated service call opens its own tenant/RLS transaction before touching PHI.
    const m11StandingActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
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
    // M11 §2.3 D3 — the verbal-order-expiry hourly sweep. Fans out over active orgs the same way the
    // standing-spawn worker above does; the real scan/write logic lives on `OrderRouteService
    // .expireOverdueVerbals`, this is a thin fan-out wrapper (F-164, #248).
    const m11VerbalTimerActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M11_VERBAL_TIMER_PLATFORM_JOB_ID,
      reason: "M11 §2.3 D3 verbal-order-expiry hourly sweep fan-out",
    });
    const m11VerbalTimerWorker = registerM11VerbalOrderExpiryWorker({
      connection: queueConnection,
      activeOrgs: m11VerbalTimerActiveOrgs,
      // F-202 — the same tick lapses stale two-person recovery requests, so the backend needs the alert port too.
      service: createDbOrderBackend(
        dbHandle.db,
        m11OutboxPublisher,
        undefined,
        m11RecoveryControls,
      ),
    });
    attachDlqAlertsToAll([m11VerbalTimerWorker], "m11");
    app.addHook("onClose", async () => {
      await m11VerbalTimerWorker.close();
    });
    try {
      const m11VerbalTimerQueue = await scheduleM11VerbalOrderExpiry(queueConnection);
      app.addHook("onClose", async () => {
        await m11VerbalTimerQueue.close();
      });
    } catch (err) {
      app.log.error(err, "M11 verbal-order-expiry schedule registration failed");
    }
    // F-201 (#248) — the stuck lab-order recovery tick (every 15 minutes): auto-retry of orders refused before any
    // outbound row existed (bounded — attempts, backoff, window) and the held-order aging escalation (warn, then
    // critical). Fans out over active orgs like the two M11 sweeps above; each service call opens its own tenant/RLS
    // transaction. Grep this factory: a worker that is bound but never constructed is dead code.
    const m11StuckTransmissionActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M11_STUCK_TRANSMISSION_PLATFORM_JOB_ID,
      reason: "M11 stuck lab-order recovery (auto-retry + held-order aging) fan-out",
    });
    const m11StuckTransmissionWorker = registerM11StuckTransmissionWorker({
      connection: queueConnection,
      activeOrgs: m11StuckTransmissionActiveOrgs,
      service: buildM11StuckRecovery(dbHandle.db, m11OutboxPublisher, (event, fields) =>
        app.log.warn({ event, ...fields }, event),
      ),
    });
    attachDlqAlertsToAll([m11StuckTransmissionWorker], "m11");
    app.addHook("onClose", async () => {
      await m11StuckTransmissionWorker.close();
    });
    try {
      const m11StuckTransmissionQueue = await scheduleM11StuckTransmission(queueConnection);
      app.addHook("onClose", async () => {
        await m11StuckTransmissionQueue.close();
      });
    } catch (err) {
      app.log.error(err, "M11 stuck-transmission schedule registration failed");
    }
    // GAP-032 — M11 §4.8 verbal pre-expiry alert (15 min), lab-results-overdue sweep (daily 04:00 UTC, D18) and
    // completion-watcher (daily). Per-org fan-out like the sweeps above; grep `registerM11OrderSweepWorkers`: a
    // worker that is bound but never constructed is dead code.
    const m11OrderSweepWorkers = registerM11OrderSweepWorkers({
      connection: queueConnection,
      activeOrgs: buildActiveOrgEnumerator({
        platformDb: platformDbHandle?.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M11_ORDER_SWEEPS_PLATFORM_JOB_ID,
        reason: "M11 §4.8 verbal pre-expiry / lab-results-overdue / completion-watcher fan-out",
      }),
      sweep: { db: dbHandle.db, outbox: m11OutboxPublisher },
      // The completion criterion is answered by the owners' own reads (M21 delivery; M6's order-triggered periods).
      facts: {
        async factsFor(tx, organizationId, candidates) {
          const idsOf = (...kinds: string[]) =>
            candidates.filter((c) => kinds.includes(c.kind)).map((c) => c.id);
          const delivered = await deliveredSourceOrderIdsForOrg(
            tx,
            organizationId,
            idsOf("supply", "comfort_kit"),
          );
          const m6 = await orderTriggeredRecordsForOrg(tx, organizationId, {
            recertOrderIds: idsOf("recertification"),
            locOrderIds: idsOf("level_of_care_change"),
          });
          return new Map(
            candidates.map((c) => [
              c.id,
              {
                supplyDelivered: delivered.has(c.id),
                recertPeriodLive: m6.recertOrderIds.has(c.id),
                locPeriodExists: m6.locOrderIds.has(c.id),
              },
            ]),
          );
        },
      },
    });
    attachDlqAlertsToAll(m11OrderSweepWorkers, "m11");
    app.addHook("onClose", async () => {
      await Promise.all(m11OrderSweepWorkers.map((w) => w.close()));
    });
    try {
      const m11OrderSweepQueues = await scheduleM11OrderSweeps(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m11OrderSweepQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M11 order-sweep schedule registration failed");
    }
    // F-238 — the hourly records-request expiry sweep: an outbound records request nobody answered by its
    // `expires_on` day moves `requested` → `expired`. Same per-org fan-out as the M11 sweeps above; each
    // org's write is its own org-explicit `withOrgContext` transaction (a cron tick is not a request).
    const m22RecordsRequestExpiryWorker = registerRecordsRequestExpiryWorker({
      connection: queueConnection,
      activeOrgs: buildActiveOrgEnumerator({
        platformDb: platformDbHandle?.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M22_RECORDS_REQUEST_EXPIRY_PLATFORM_JOB_ID,
        reason: "F-238 records-request expiry hourly sweep fan-out",
      }),
      expireForOrg: (organizationId) => expireRecordsRequestsForOrg(dbHandle.db, organizationId),
      log: (msg, detail) => app.log.info(detail, msg),
    });
    attachDlqAlertsToAll([m22RecordsRequestExpiryWorker], "m22");
    app.addHook("onClose", async () => {
      await m22RecordsRequestExpiryWorker.close();
    });
    try {
      const m22RecordsRequestExpiryQueue = await scheduleRecordsRequestExpiry(queueConnection);
      app.addHook("onClose", async () => {
        await m22RecordsRequestExpiryQueue.close();
      });
    } catch (err) {
      app.log.error(err, "M22 records-request expiry schedule registration failed");
    }
    // GAP-140/141 — the M22 §4.8 workers. Best-effort M36 alerts ride the AlertEmitter seam (a throw never fails a
    // tick; the durable record is the form_fill row / the next daily report / the failed job).
    const m22AlertEmitter = getSeam("AlertEmitter") as {
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
    // `form-render`: consumes `form_fill` rows in `queued` (the admin retry used to flip a row nothing consumed).
    const m22FormRenderWorker = registerFormRenderWorker({
      connection: queueConnection,
      db: dbHandle.db,
      renderer: getDocumentRenderer(),
      activeOrgs: buildActiveOrgEnumerator({
        platformDb: platformDbHandle?.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M22_FORM_RENDER_PLATFORM_JOB_ID,
        reason: "M22 form-render worker fan-out (active-org enumeration)",
      }),
      onTerminalFailure: async (alert) => {
        await m22AlertEmitter.emit(alert.organizationId, {
          eventType: "m22.document.render_failed",
          payload: {
            aggregateType: alert.aggregateType,
            aggregateId: alert.aggregateId,
            formFillId: alert.formFillId,
            failureReason: alert.failureReason,
            retryCount: alert.retryCount,
          },
          severity: "critical",
          correlationId: `m22-form-render:${alert.formFillId}`,
        });
      },
      log: (msg, detail) => app.log.info(detail, msg),
    });
    // `retention-rotation`: the intake_artifact disposition+30d sweep (promote; report destruction-pending).
    const m22RetentionRotationWorker = registerRetentionRotationWorker({
      connection: queueConnection,
      db: dbHandle.db,
      activeOrgs: buildActiveOrgEnumerator({
        platformDb: platformDbHandle?.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M22_RETENTION_ROTATION_PLATFORM_JOB_ID,
        reason: "M22 retention-rotation daily sweep fan-out (active-org enumeration)",
      }),
      onDestructionPending: async (alert) => {
        await m22AlertEmitter.emit(alert.organizationId, {
          eventType: "document.retention_destruction_pending",
          payload: {
            retentionClass: alert.retentionClass,
            destructionPending: alert.destructionPending,
            scheduledFor: alert.oldestDispositionAt,
          },
          severity: "info",
          correlationId: `m22-retention:${alert.organizationId}:${alert.oldestDispositionAt.slice(0, 10)}`,
        });
      },
      log: (msg, detail) => app.log.info(detail, msg),
    });
    // `ai-block-validator`: the nightly re-run of the D7 boot check against the live registry.
    const m22AiBlockValidatorWorker = registerAiBlockValidatorWorker({
      connection: queueConnection,
      registry: () => getSeam("AIPromptRegistry") as unknown as IpuAiPromptRegistryPort,
      onViolation: (message) => {
        app.log.error({ event: "m22.ai_block.violation" }, message);
      },
    });
    attachDlqAlertsToAll(
      [m22FormRenderWorker, m22RetentionRotationWorker, m22AiBlockValidatorWorker],
      "m22",
    );
    app.addHook("onClose", async () => {
      await Promise.all([
        m22FormRenderWorker.close(),
        m22RetentionRotationWorker.close(),
        m22AiBlockValidatorWorker.close(),
      ]);
    });
    for (const [label, schedule] of [
      ["form-render", scheduleFormRender],
      ["retention-rotation", scheduleRetentionRotation],
      ["ai-block-validator", scheduleAiBlockValidator],
    ] as const) {
      try {
        const queue = await schedule(queueConnection);
        app.addHook("onClose", async () => {
          await queue.close();
        });
      } catch (err) {
        app.log.error(err, `M22 ${label} schedule registration failed`);
      }
    }
    // M5 §4.5 `patient.snapshot_rebuild` — the quarterly full privacy-snapshot rebuild (D3 "quarterly full
    // rebuild job reconciles drift"). Same per-org fan-out as the sweeps above; per org it pages the patients
    // and re-derives each one in its own org-explicit `withOrgContext` transaction as the system (the officer
    // resync's own derivation: M39 Part 2 state decides `sud`, a DocLens flag is never lifted while M39 is
    // silent), writing only drifted rows and emitting `m5.patient.privacy_flag_changed` only on a real change.
    const m5SnapshotRebuildPorts = {
      consent: buildPart2ConsentStateReader(dbHandle.db),
      intake: buildIntakeSudBatchReader(dbHandle.db),
    };
    const m5SnapshotRebuildWorker = registerSnapshotRebuildWorker({
      connection: queueConnection,
      activeOrgs: buildActiveOrgEnumerator({
        platformDb: platformDbHandle?.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M5_SNAPSHOT_REBUILD_PLATFORM_JOB_ID,
        reason: "M5 §4.5 quarterly privacy-snapshot rebuild fan-out",
      }),
      rebuildForOrg: (organizationId) =>
        rebuildPrivacySnapshotsForOrg(dbHandle.db, organizationId, {
          outbox: m5OutboxPublisher,
          ports: m5SnapshotRebuildPorts,
        }),
      log: (msg, detail) => app.log.info(detail, msg),
    });
    // GAP-118 — M5 §4.5 `amendment_sla_scan`: daily, once-per-request due-soon / overdue events for pending
    // §164.526 amendment requests (M36 pages the privacy officer + compliance).
    const m5AmendmentSlaWorker = registerAmendmentSlaWorker(queueConnection, {
      db: dbHandle.db,
      outbox: m5OutboxPublisher,
      activeOrgs: buildActiveOrgEnumerator({
        platformDb: platformDbHandle?.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M5_AMENDMENT_SLA_PLATFORM_JOB_ID,
        reason: "M5 §4.5 amendment SLA scan fan-out",
      }),
    });
    // Backstop: end `admitting_staff` access grants still open after 14 days (the event hooks are primary).
    const m5AdmittingGrantExpiryWorker = registerAdmittingGrantExpiryWorker(queueConnection, {
      db: dbHandle.db,
      activeOrgs: buildActiveOrgEnumerator({
        platformDb: platformDbHandle?.db,
        auditBypass: m34PlatformBypassAuditor,
        jobId: M5_ADMITTING_GRANT_EXPIRY_PLATFORM_JOB_ID,
        reason: "M5 admitting-grant expiry sweep fan-out",
      }),
    });
    attachDlqAlertsToAll(
      [m5SnapshotRebuildWorker, m5AmendmentSlaWorker, m5AdmittingGrantExpiryWorker],
      "m5",
    );
    app.addHook("onClose", async () => {
      await m5SnapshotRebuildWorker.close();
      await m5AmendmentSlaWorker.close();
      await m5AdmittingGrantExpiryWorker.close();
    });
    try {
      const m5AdmittingGrantExpiryQueue = await scheduleAdmittingGrantExpiry(queueConnection);
      app.addHook("onClose", async () => {
        await m5AdmittingGrantExpiryQueue.close();
      });
    } catch (err) {
      app.log.error(err, "M5 admitting-grant expiry schedule registration failed");
    }
    try {
      const m5AmendmentSlaQueue = await scheduleAmendmentSla(queueConnection);
      app.addHook("onClose", async () => {
        await m5AmendmentSlaQueue.close();
      });
    } catch (err) {
      app.log.error(err, "M5 amendment SLA schedule registration failed");
    }
    try {
      const m5SnapshotRebuildQueue = await scheduleSnapshotRebuild(queueConnection);
      app.addHook("onClose", async () => {
        await m5SnapshotRebuildQueue.close();
      });
    } catch (err) {
      app.log.error(err, "M5 privacy-snapshot rebuild schedule registration failed");
    }
    // M12 §2.6 D4 / §2.8 D10 — the `dosespot_sync_queue` drain (patient-sync + MedHx-fetch). Scheduled
    // separately from the six outbox consumers that enqueue onto it (below) — the drain performs real
    // outbound vendor I/O, so it runs as its own scheduled worker (F-164, #248).
    const m12SyncActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M12_PLATFORM_JOB_ID,
      reason: "M12 §2.6/§2.8 dosespot_sync_queue drain fan-out",
    });
    const m12SyncWorker = registerDoseSpotSyncQueueWorker({
      db: dbHandle.db,
      activeOrgs: m12SyncActiveOrgs,
      outbox: m12OutboxPublisher,
      connection: queueConnection,
      doseSpotClient: m12DoseSpotClient,
      demographicsForOrg: (organizationId, patientId) =>
        dosespotSyncDemographicsForOrg(dbHandle.db, organizationId, patientId),
    });
    attachDlqAlertsToAll([m12SyncWorker], "m12");
    app.addHook("onClose", async () => {
      await m12SyncWorker.close();
    });
    try {
      const m12SyncQueue = await scheduleDoseSpotSyncQueueDrain(queueConnection);
      app.addHook("onClose", async () => {
        await m12SyncQueue.close();
      });
    } catch (err) {
      app.log.error(err, "M12 dosespot_sync_queue drain schedule registration failed");
    }
    // GAP-037 — the seven §4.8 crons (transmit_newrx, transmit_queued_on_recovery, rx_benefit_prewarm, refill_sla,
    // ial2_expiry_warn, transmission_timeout_sweep, epcs_attempt_expiry_sweep). The vendor-facing four run only for
    // tenants with a bound adapter; the three DB-only ones run for every org.
    const m12CronWorkers = registerM12CronWorkers({
      connection: queueConnection,
      db: dbHandle.db,
      outbox: m12OutboxPublisher,
      client: m12DoseSpotClient,
      activeOrgs: m12SyncActiveOrgs,
      config: m12TenantConfig,
      breakerEdges: m12BreakerEdges,
    });
    attachDlqAlertsToAll(m12CronWorkers, "m12");
    app.addHook("onClose", async () => {
      await Promise.all(m12CronWorkers.map((w) => w.close()));
    });
    try {
      const m12CronQueues = await scheduleM12Jobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m12CronQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M12 §4.8 cron-schedule registration failed");
    }
    app.log.warn(
      {
        configuredTenants: m12TenantConfig.configuredOrganizationIds().length,
        unverifiedEndpoints: unverifiedEndpoints(),
      },
      describeM12AdapterPosture(m12TenantConfig.configuredOrganizationIds()),
    );
    // M19 §4.5 path 1 / §4.8 — the `on_call_roster_sync_queue` drain (`m19.shift-sync.debounced`) +
    // catch-up-seed workers (m19 `handlers-unbound` group, #248; F-155's own finding, now built).
    // `reconcileOnCallRoster`/`decideRosterSyncTrigger` (`roster/shift-sync.ts`) were complete and unit-
    // tested since M19-T04 with no jobs/ tier anywhere in this module to run them — no proactive Direct-
    // model roster sync had ever executed. The drain reads no PHI and performs no outbound vendor I/O
    // (unlike M12's), so it needs no dedicated outbox publisher of its own here.
    const m19ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M19_PLATFORM_JOB_ID,
      reason: "M19 §4.5/§4.8 on_call_roster_sync_queue drain + catch-up-seed fan-out",
    });
    const m19Workers = registerM19CronWorkers({
      db: dbHandle.db,
      activeOrgs: m19ActiveOrgs,
      connection: queueConnection,
    });
    attachDlqAlertsToAll(m19Workers, "m19");
    app.addHook("onClose", async () => {
      await Promise.all(m19Workers.map((w) => w.close()));
    });
    try {
      const m19Queues = await scheduleM19Jobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m19Queues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M19 on_call_roster_sync_queue schedule registration failed");
    }
    // M19 §4.8 Tier-1 crons (GAP-057) — `m19.shift-open.cron` / `m19.shift-close.cron` (5 min) and the
    // `m19.coverage-gap-watchdog.cron` (30 min). `activateShift`/`completeShift` ran only from the manual route
    // and the only `coverage_gap` emit was the reactive D10 arm. Same org fan-out as the roster-sync workers
    // above; events go through the real catalog-validating `m19OutboxPublisher` in each shift's own org tx.
    const m19Tier1Workers = registerM19Tier1CronWorkers({
      db: dbHandle.db,
      activeOrgs: m19ActiveOrgs,
      outbox: m19OutboxPublisher,
      providerEntities: buildFoundationSiteReader(),
      connection: queueConnection,
    });
    attachDlqAlertsToAll(m19Tier1Workers, "m19");
    app.addHook("onClose", async () => {
      await Promise.all(m19Tier1Workers.map((w) => w.close()));
    });
    try {
      const m19Tier1Queues = await scheduleM19Tier1Jobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m19Tier1Queues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(
        err,
        "M19 Tier-1 shift-open/close + coverage-gap watchdog schedule registration failed",
      );
    }
    // M19 §4.8 non-Tier-1 crons (GAP-057 follow-up) — `m19.callback-sla.cron` (1 min),
    // `m19.awaiting-callback-timeout.cron` (10 min), `m19.close-documented.cron` (15 min) and
    // `m19.escalation-sla` (5 min). `closeCall` and the callback/escalation SLA alerts had no caller; the two
    // SLA ticks publish `m19.triage_call.*_sla_breached` through the real catalog-validating
    // `m19OutboxPublisher` (M36's `oncall-alerts` consumer turns them into pages), the other two advance calls
    // (timeout -> `disposition_pending`, documented -> `closed`) in each call's own org tx.
    const m19TriageWorkers = registerM19TriageCronWorkers({
      db: dbHandle.db,
      activeOrgs: m19ActiveOrgs,
      outbox: m19OutboxPublisher,
      connection: queueConnection,
    });
    attachDlqAlertsToAll(m19TriageWorkers, "m19");
    app.addHook("onClose", async () => {
      await Promise.all(m19TriageWorkers.map((w) => w.close()));
    });
    try {
      const m19TriageQueues = await scheduleM19TriageJobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m19TriageQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(
        err,
        "M19 callback-sla / awaiting-callback-timeout / close-documented / escalation-sla schedule registration failed",
      );
    }
    // ── M37 §4.8 `ipu.rn-coverage-watchdog` cron (F-071/#174 — the M14 worker-runner shape) ──────────────
    //
    // The producer that did not exist. `ipu_rn_coverage_window` is a MATERIALIZED invariant that
    // `openAdmission`, `requestBed`, `initiateTransfer` and `applyRestraint` all read, each treating an
    // absent row as uncovered (correctly, fail-closed). Nothing ever wrote a row, and
    // `planOpenAdmission` refuses every non-`arranged` admission on that flag — so no GIP and no
    // inpatient-respite admission could be opened on any deployment. The pure grid builder
    // (`@chartwarden/inpatient` `buildCoverageWindows`) has existed and been unit-tested since M37-T07; this
    // is the worker its own header named and that was never built.
    const m37ActiveOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle?.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M37_PLATFORM_JOB_ID,
      reason: "M37 §4.8 ipu.rn-coverage-watchdog cron fan-out (active-org enumeration)",
    });
    const m37WorkerDeps = buildM37WorkerDeps({
      connection: queueConnection,
      db: dbHandle.db,
      outbox: m37OutboxPublisher,
      activeOrgs: m37ActiveOrgs,
      // Batch 11 — the nursing-note shift watchdog reads M8's signed encounters ONLY through the registered,
      // org-explicit `SignedEncountersReader` seam (resolved lazily per call, the M24 precedent above).
      signedEncounters: {
        async signedEncountersForPatientSince(organizationId, patientId, sinceIso) {
          const reader = getSeam("SignedEncountersReader") as {
            signedEncountersForPatientSince(
              organizationId: string,
              patientId: string,
              since: string,
            ): Promise<ReadonlyArray<{ signedAt: string; signedByMembershipId: string }>>;
          };
          return reader.signedEncountersForPatientSince(organizationId, patientId, sinceIso);
        },
      },
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

    // ── M37 §2.6/§4.8 `ipu.iv-bedside-check-watchdog` cron (GAP-107) ─────────────────────────────────────
    // Every 5 minutes: a running continuous infusion on an IPU patient that has gone a full bedside-check
    // interval without a recorded segment raises `m37.iv_safety_overlay.bedside_check_overdue` (M36 alerts the
    // care team). Infusion activity is M13's, read through its org-explicit `ivSessionActivityForOrg` (M37 never
    // reads M13's tables); the org fan-out is the same audited enumerator as the rn-coverage watchdog.
    const m37IvBedsideWorkers = registerM37IvBedsideWorker({
      connection: queueConnection,
      db: dbHandle.db,
      outbox: m37OutboxPublisher,
      activeOrgs: m37ActiveOrgs,
      ivActivity: (organizationId, orderIds) =>
        ivSessionActivityForOrg(dbHandle.db, organizationId, orderIds),
    });
    attachDlqAlertsToAll(m37IvBedsideWorkers, "m37");
    app.addHook("onClose", async () => {
      await Promise.all(m37IvBedsideWorkers.map((w) => w.close()));
    });
    try {
      const m37IvBedsideQueues = await scheduleM37IvBedsideWatchdog(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m37IvBedsideQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M37 iv-bedside-check-watchdog schedule registration failed");
    }

    // ── M29 D11 — the platform NPPES sync worker + its 02:30 UTC nightly repeatable (GAP-045) ────────────
    // `NPPES_SYNC_SCHEDULE` shipped as pure data whose own comment promised "the M29-T08 worker binds this
    // to the BullMQ scheduler"; that worker was never written, so the nightly run never happened and
    // `nppes_provider` / `nppes_sync_run` were empty in every deployment. This is that binding.
    //
    // UNLIKE EVERY OTHER CRON HERE, this one is NOT an active-org fan-out: NPPES is one public CMS
    // directory shared platform-wide (D11), so there is no per-org tick and no `buildActiveOrgEnumerator`.
    // Its writes go through migration 0199's `nppes_writer_*` SECURITY DEFINER functions (the two tables
    // are SELECT-only to `chartwarden_app`), and its five §4.10 events publish platform-wide
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
      log: (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>) => {
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
        app.log.error(err, "M29 NPPES nightly-sync schedule registration failed");
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

    // TASK-040C (OPS-005/006) — the `chartwarden_bullmq_queue_jobs` gauge, over one dedicated read-only
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
  // F-236 (ADR-0048) — the DocLens intake worker (stages 2–4: Docling → classify → extract → ground →
  // DEK-encrypted candidates). Worker role only. Every AI call inside it goes through the governed M32
  // seams, so with `ai.full` off (every tenant) a run classifies nothing and records `awaiting_capability`
  // — it never fails open. No docling-worker configured ⇒ the unbound client, whose typed 503 makes the
  // job retry rather than pretend the document had no text.
  if (role !== "api" && dbHandle && queueConnection) {
    const intakeS3Config = s3ObjectStoreConfigFromEnv(process.env);
    const intakeObjects = intakeS3Config
      ? createS3ObjectStore({ ...intakeS3Config, publicEndpoint: intakeS3Config.endpoint })
      : null;
    const doclingConfig = doclingConfigFromEnv(process.env);
    const intakeWorker = registerDocLensIntakeWorker(
      queueConnection,
      {
        db: dbHandle.db,
        docling: doclingConfig
          ? createHttpDoclingClient(doclingConfig)
          : createUnboundDoclingClient(),
        presignSource: async ({ organizationId, bucket, objectKey }) => {
          if (!intakeObjects) {
            throw new DegradedError(
              "document-storage",
              "no object store is bound (MINIO_* is not configured)",
            );
          }
          const { url } = await intakeObjects.presign({
            organizationId,
            descriptor: { bucket, objectKey, ttlSeconds: 300, accessKind: "content_download" },
          });
          return url;
        },
        cipher: createCandidateValueCipher(getTenantKeyProvider()),
        classifier: () => getSeam("DocLensClassifier") as DocLensClassifierPort,
        extractor: () => getSeam("DocLensExtractor") as DocLensExtractorPort,
        // F-237 — stage 5 and the model pass of SUD detection go through the same governed M32 seams
        // (each refuses on its own gates; the job degrades to "unverified" / "rules only").
        visionVerifier: () => getSeam("DocLensVisionVerifier") as DocLensVisionVerifierPort,
        sudDetector: () => getSeam("DocLensSudDetector") as DocLensSudDetectorPort,
        outbox: m22OutboxPublisher,
        // F-238 — ICD-10-CM (M38) for the code scanner + coding checks; skipped, and said so, when no
        // release is loaded (`bun run db:load:icd10cm`).
        codingTerminology: () => createCodingTerminology(),
        // F-238 — each document's name/DOB checked against the batch's patient (M5) or referral (M6).
        identityTargets: createIdentityTargetPorts(),
      },
      (msg, detail) => app.log.info(detail, msg),
    );
    app.addHook("onClose", async () => {
      await intakeWorker.close();
    });
  }
  // F-236 (ADR-0048) — the M32 backend health sweep: the only writer of `ai_model_backend.last_health_status`
  // (the routing gate never routes `unknown`). Worker role only — one writer — and only when this
  // deployment configures a backend and has the platform credential (its two-column grant).
  // GAP-086 — M29's inbound PARSE worker (ADT → proposals, ORU → lab observations / the unmatched-review queue). Poll-based
  // over `hl7_message_inbound.parse_status='in_progress'` with `FOR UPDATE SKIP LOCKED`, so any number of replicas coordinate
  // through the table. It runs wherever workers run (`worker` / `all`); it is harmless with nothing to parse.
  if (role !== "api" && dbHandle && platformDbHandle) {
    const parseDb = dbHandle.db;
    const m29InboundPorts = buildM29InboundSeamPorts();
    const m29ParseOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M29_PLATFORM_JOB_ID,
      reason: "M29 inbound HL7 parse-worker fan-out (active-org enumeration)",
    });
    const m29ParseWorker = startM29ParseWorker({
      db: parseDb,
      cipher: createM29InboundCipher(getTenantKeyProvider()),
      patientReader: () => getPatientReader(),
      orderReader: () => m29InboundPorts.orderReader,
      terminology: () => m29InboundPorts.terminology,
      consent: () => m29InboundPorts.consent,
      // `organization.settings.hl7_internal_mrn_authority` (M5's registered key) gates cascade level L1; M1 owns the table,
      // so the composition root reads it.
      internalMrnAuthority: async (organizationId) => {
        const rows = await withOrgContext(parseDb, { organizationId, userId: "" }, (tx) =>
          (tx as unknown as DbClient)
            .select({ settings: schema.organizations.settings })
            .from(schema.organizations)
            .where(eq(schema.organizations.id, organizationId))
            .limit(1),
        );
        const value = (rows[0]?.settings as Record<string, unknown> | undefined)
          ?.hl7_internal_mrn_authority;
        return typeof value === "string" && value !== "" ? value : undefined;
      },
      outbox: m29OutboxPublisher,
      activeOrgs: m29ParseOrgs,
      log: (level, event, fields) => app.log[level](fields, event),
    });
    app.addHook("onClose", async () => {
      await m29ParseWorker.close();
    });
    app.log.info("M29 inbound HL7 parse worker constructed");
  } else if (role !== "api") {
    app.log.warn(
      "M29 inbound HL7 parse worker DISABLED: it needs DATABASE_URL and DATABASE_PLATFORM_URL (active-org enumeration)",
    );
  }
  // GAP-086 — the M29 MLLP LISTENER (§4.11). Explicit opt-in: a listener binds TCP ports that accept PHI from outside, so it is
  // OFF unless `M29_MLLP_LISTENER_ENABLED=true`, and it only runs in the dedicated `listener` process (or the all-in-one `all`
  // role for local dev) — never in a scaled-out api/worker replica. Every skipped case is logged LOUDLY.
  if (process.env.M29_MLLP_LISTENER_ENABLED !== "true") {
    app.log.warn(
      "M29 MLLP listener is OFF (set M29_MLLP_LISTENER_ENABLED=true and run PROCESS_ROLE=listener): NO inbound HL7 (ADT/ORU) is being accepted",
    );
  } else if (!(listenerProcess || requestedRole === "all")) {
    app.log.warn(
      `M29_MLLP_LISTENER_ENABLED=true is ignored in the '${requestedRole}' process role — run PROCESS_ROLE=listener (or 'all' for local dev)`,
    );
  } else if (!dbHandle || !platformDbHandle) {
    app.log.error(
      "M29 MLLP listener cannot start: it needs DATABASE_URL and DATABASE_PLATFORM_URL (active-org enumeration) — NO inbound HL7 is being accepted",
    );
  } else {
    const listenerDb = dbHandle.db;
    const listenerOrgs = buildActiveOrgEnumerator({
      platformDb: platformDbHandle.db,
      auditBypass: m34PlatformBypassAuditor,
      jobId: M29_PLATFORM_JOB_ID,
      reason: "M29 MLLP listener supervisor feed enumeration (active-org enumeration)",
    });
    const listener = await startM29ListenerProcess({
      db: listenerDb,
      cipher: createM29InboundCipher(getTenantKeyProvider()),
      activeOrgs: listenerOrgs,
      baaGate: () => getSeam("BaaStatusProvider") as ExternalInterfaceBaaGate,
      alerts: () => getSeam("AlertEmitter") as ListenerAlertPort,
      log: (level, event, fields) => app.log[level](fields, event),
      // GAP-043 - with the worker-role watcher on, this process leaves facts (heartbeat + bound) and the watcher pages.
      watcherOwnsListenerDown: resolveFeedHealthWatchConfig(process.env).enabled,
    });
    app.addHook("onClose", async () => {
      await listener.shutdown();
    });
    app.log.warn(
      `M29 MLLP listener ENABLED: ${listener.boundFeedIds().length} feed listener(s) bound (reconciling every 30s)`,
    );
  }
  if (role !== "api" && dbHandle && platformDbHandle) {
    const sweepBackends = buildConfiguredModelBackends(aiBackendConfigFromEnv(process.env));
    if (sweepBackends.length > 0) {
      const stopSweep = startAiBackendHealthSweep({
        backends: sweepBackends,
        platformDb: platformDbHandle.db,
        log: (msg, detail) => app.log.info(detail ?? {}, msg),
      });
      app.addHook("onClose", async () => stopSweep());
    }
  }
  if (role !== "api" && dbHandle && process.env.OUTBOX_DISPATCHER_DISABLED !== "1") {
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
      // WP 2.7b C2 (ADR-0058, Accepted) — global message search, writer side. Gated by data, not code: the tenant flag
      // defaults OFF, the platform flag is absent (= OFF) and the ring key provider throws (fail closed) while no ring is bound. One call builds the indexer consumer (bound below) and the `messaging.search_maintenance`
      // worker; the worker needs the queue connection (the platform pool is already required by this block).
      const m36GlobalSearch = await registerM36GlobalSearch({
        db: dbHandle.db,
        cipher: createMessageBodyCipher(),
        keys: m36SearchKeys,
        exclusions:
          m36NameExclusions ?? createNameExclusions({ db: dbHandle.db, keys: m36SearchKeys }),
        // Ids and a fixed reason only; never a tag, token or body text.
        onIndexError: (info) => app.log.warn(info, "M36 global search index write skipped"),
        ...(queueConnection
          ? {
              worker: {
                connection: queueConnection,
                activeOrgs: buildActiveOrgEnumerator({
                  platformDb: platformDbHandle.db,
                  auditBypass: m34PlatformBypassAuditor,
                  jobId: M36_INTEGRITY_PLATFORM_JOB_ID,
                  reason: "M36 WP 2.7b search_maintenance active-org fan-out",
                }),
                onError: (context, err) =>
                  app.log.error(
                    { ...context, reason: err instanceof Error ? err.name : "unknown" },
                    "M36 global search maintenance error",
                  ),
              },
            }
          : {}),
      });
      for (const w of m36GlobalSearch.workers)
        attachDlqPromotionAlert(w, `m36:${w.name}`, dlqPromotionSink);
      app.addHook("onClose", () => m36GlobalSearch.close());
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
              activeAdmissionDraftContextForPatient(dbHandle.db, organizationId, patientId),
          }),
          buildM12IdgDecisionConsumer({
            db: dbHandle.db,
            outbox: m12OutboxPublisher,
            resolveAdmissionContext: (organizationId, patientId) =>
              activeAdmissionDraftContextForPatient(dbHandle.db, organizationId, patientId),
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
          // F-151 — the §2.6 / D6 M39 consent-revocation cascade. M39 is the source of truth for
          // consent; M16 never gate-keeps, it cascades a revoked bereavement-outreach consent into a
          // contact opt-out.
          buildM16ConsentRevokedConsumer({
            db: dbHandle.db,
            outbox: m16OutboxPublisher,
          }),
          // F-158 (#248) — M2's half of the same M39 cascade: terminates the patient's own
          // `patient_portal` sessions when their `portal_access` consent is revoked. Deliberately
          // scoped to that one consent type only — see the consumer file's header for why
          // `family_caregiver_access` needs a new M31 read seam this pass does not build.
          buildM2ConsentRevokedConsumer({ db: dbHandle.db }),
          // F-153 (#248) — the §4.5 death-discharge SECONDARY verifier (a redundant safety net, not a
          // second creation path): re-runs the same §4.3.1 intake decider off `m6.admission.discharged`
          // (filtered to reason='death') for the case `m6.bereavement.eligible` fails to fire or land.
          buildM16DischargeDeathSecondaryConsumer({
            db: dbHandle.db,
            outbox: m16OutboxPublisher,
            resolveAdmission: async (organizationId, admissionId) =>
              admissionSchedulingContextForOrg(dbHandle.db, organizationId, admissionId),
          }),
          // F-159 (#248) — the §4.5 post-death-grant handler: confirms a proposed bereaved contact onto
          // the roster once M39 signs the exact bereavement-outreach consent requested for them.
          buildM16ConsentSignedConsumer({
            db: dbHandle.db,
            outbox: m16OutboxPublisher,
          }),
          // F-227 (#248) — the D18 external-source gate release: an `m6.discharge.cosigned` that names a
          // `sourceProposalId` flips the matching plan's `cosignStatus` to `cosigned` and unlocks the
          // counselor's first contact. A for-cause cosign (no source proposal) is a no-op here.
          buildM16DischargeCosignedConsumer({
            db: dbHandle.db,
            outbox: m16OutboxPublisher,
          }),
          // F-159 (#248) — the §2.6/D9 patient-level opt-out cascade: honoring a directive the patient
          // already gave (cosign-exempt, unlike the five D7 clinical-judgment closure reasons).
          buildM16PatientOptOutChangedConsumer({
            db: dbHandle.db,
            outbox: m16OutboxPublisher,
          }),
          // GAP-130 — M16 §4.5 / D15 / §7.5: a signed `bereavement_contact` encounter appends the
          // in-person contact-log row (with `source_encounter_id`) and completes the matched outreach.
          buildM16EncounterSignedConsumer({
            db: dbHandle.db,
            outbox: m16OutboxPublisher,
          }),
          // GAP-130 — M16 §4.5 / D14 / §7.6: M22's render of a per-outreach card/letter stamps
          // `bereavement_outreach.rendered_document_id` (+ completes §4.5's three auto-complete kinds).
          buildM16DocumentRenderedConsumer({
            db: dbHandle.db,
            outbox: m16OutboxPublisher,
          }),
          // F-160 (#248) — M26's CapConsumerStore, 8 of 9 `handlers-unbound` events now live-bound.
          buildM26UpstreamConsumer(
            createDrizzleCapConsumerStore(dbHandle.db, {
              // GAP-150 — `m26.cap.accrual_recorded` rides the same tx as the accrual line.
              outbox: m26OutboxPublisher,
              mbi: {
                mbiNormalizedForPatient: (organizationId, patientId) =>
                  mbiNormalizedForPatient(dbHandle.db, organizationId, patientId),
              },
              firstElection: {
                firstElectionEffectiveDateInRange: (organizationId, patientId, from, to) =>
                  firstElectionEffectiveDateInRangeForOrg(
                    dbHandle.db,
                    organizationId,
                    patientId,
                    from,
                    to,
                  ),
              },
            }),
          ),
          // F-160 (#248) — M31's telehealth trio: force-end on M17 visit cancel/reschedule, reconcile
          // on the M8 encounter that closed out the call.
          buildM31VisitCancelledTelehealthConsumer({ db: dbHandle.db, events: m31Events }),
          buildM31VisitRescheduledTelehealthConsumer({ db: dbHandle.db }),
          buildM31EncounterSignedTelehealthConsumer({ db: dbHandle.db }),
          // F-164 (#248) — 2 more of M31's confirmed-genuine F-139 pairs: the bereavement-window
          // plan-closure grant revocation and the broad m39.consent.revoked grant cascade.
          buildM31BereavementPlanClosedConsumer({ db: dbHandle.db, events: m31Events }),
          buildM31ConsentRevokedGrantCascadeConsumer({
            db: dbHandle.db,
            events: m31Events,
            // GAP-171 — M31 ACKs its leg of the §2.2.3 revocation cascade so it can reach `completed`.
            ackCascade: ({ organizationId, consentRecordId }) =>
              recordCascadeAckForOrg(dbHandle.db, {
                organizationId,
                consentRecordId,
                consumer: "m31_portal",
              }),
          }),
          // GAP-171 — the other three §2.2.3 cascade consumers: each runs its leg (M22: restrict disclosure-
          // attached documents on `media_release`; M28 / M36: pull-path attestation) then ACKs, so a cascade
          // completes only when all four have. Org-explicit ACK seam; tenant from the envelope.
          buildM22ConsentRevokedConsumer({
            db: dbHandle.db,
            ackCascade: ({ organizationId, consentRecordId }) =>
              recordCascadeAckForOrg(dbHandle.db, {
                organizationId,
                consentRecordId,
                consumer: "m22_documents",
              }),
          }),
          buildM28ConsentRevokedConsumer({
            ackCascade: ({ organizationId, consentRecordId }) =>
              recordCascadeAckForOrg(dbHandle.db, {
                organizationId,
                consentRecordId,
                consumer: "m28_fhir",
              }),
          }),
          buildM36ConsentRevokedConsumer({
            ackCascade: ({ organizationId, consentRecordId }) =>
              recordCascadeAckForOrg(dbHandle.db, {
                organizationId,
                consentRecordId,
                consumer: "m36_messaging",
              }),
          }),
          // F-165 (#248) — the D6 bereaved-mode lateral flip's INSERT half, re-checked past F-164's
          // BLOCKED verdict: migration 0257 nullable-widens granted_by_membership_id, and the consent
          // version resolves via bereaved_contact.status + M39's ConsentEvaluator. The candidate read
          // goes through M16's org-explicit bereavedContactFlipCandidatesForPlanForOrg seam (arch:tables).
          buildM31BereavementPlanOpenedConsumer({
            db: dbHandle.db,
            events: m31Events,
            bereavedContactFlipCandidatesForPlan: bereavedContactFlipCandidatesForPlanForOrg,
          }),
          // F-167 (#248) — the per-contact-exact D6 lateral-flip trigger: `contact_active` fires once per
          // CONTACT at the moment its own bereavement_outreach_consent is verified, the real primary
          // trigger `plan_opened`'s own header names (that one fires per-PLAN, before any contact
          // confirms, so its own per-contact loop almost always no-ops). The candidate read goes through
          // M16's new single-contact org-explicit seam (`bereavedContactFlipCandidateForOrg`).
          buildM31BereavementContactActiveConsumer({
            db: dbHandle.db,
            events: m31Events,
            bereavedContactFlipCandidateForContact: bereavedContactFlipCandidateForOrg,
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
          // F-152 — the D14 EVV-authoritative `published → en_route → in_visit` advances. EVV is the
          // spec's own AUTHORITATIVE driver of the visit lifecycle; nothing ever bound either event.
          buildM17EvvCheckInConsumer({
            db: dbHandle.db,
            outbox: m17OutboxPublisher,
          }),
          buildM17EvvAtPatientAddressConsumer({ db: dbHandle.db }),
          // F-196 (#248) — the §4.10 missing-EVV resolution stamp. Informational only; does not move
          // `status` (the visit is already `completed` by the time this fires).
          buildM17EvvLateCheckResolvedConsumer({ db: dbHandle.db }),
          // F-158 (#248) — the §3.3 EVV checkout/correction provenance pointers. `check_out_recorded`
          // stamps `evv_check_out_event_id` only (deliberately no lifecycle transition — completion is
          // `m8.encounter.signed`-only, per M17's own spec and `visit-machine.ts`'s `isSystemActor` guard);
          // `event_corrected` repoints whichever pointer column named the superseded event.
          buildM17EvvCheckOutConsumer({ db: dbHandle.db }),
          buildM17EvvEventCorrectedConsumer({ db: dbHandle.db }),
          // F-152 — the §7.5 SOS-resolution visit cancellation. M20's own catalog entry says M20 never
          // writes an M17 row; this event IS the request and M17's D3 handler decides.
          buildM17SosVisitCancellationConsumer({
            db: dbHandle.db,
            outbox: m17OutboxPublisher,
          }),
          // F-166 (#248) — the §7.5 volunteer-gate scheduler warning (M15's own catalog entry: "so M17
          // must drop the volunteer from the schedule") and the §2.2.4 D5 after-hours triage proposal
          // (M19's own worked example names this as the D5 proposal-worker trigger).
          buildM17VolunteerAssignmentInactivatedConsumer({
            db: dbHandle.db,
            outbox: m17OutboxPublisher,
          }),
          buildM17TriageVisitNeededConsumer({
            db: dbHandle.db,
            outbox: m17OutboxPublisher,
            admissionSitingForPatient: activeAdmissionSitingForPatientForOrg,
          }),
          buildM36ClinicalAlertConsumer(getSeam("AlertEmitter") as AlertEmitter),
          // WP 5.8 (ADR-0087, PROPOSED) - one fixed-text in-app alert for the compliance reviewers when a break-glass grant is opened.
          buildM36BreakGlassNotificationsConsumer({
            alerts: getSeam("AlertEmitter") as AlertEmitter,
          }),
          // ── WP 5.7 (ADR-0089, PROPOSED) - one fixed-text in-app alert for the approvers when a messaging export is requested (B1).
          buildM36ExportNotificationsConsumer({
            alerts: getSeam("AlertEmitter") as AlertEmitter,
          }),
          // ── end WP 5.7 export notification consumer
          // ── WP 5.7 export builder/sweep: an approved export becomes one build job (job id = export job id, so a redelivery is a no-op).
          ...(m36ExportBuildEnqueuer
            ? [buildM36ExportBuildConsumer({ enqueue: m36ExportBuildEnqueuer.enqueue })]
            : []),
          // ── end WP 5.7 export builder/sweep consumer
          buildM36MessageMentionConsumer({
            alerts: getSeam("AlertEmitter") as AlertEmitter,
            messaging: createDbMessagingRouteService(dbHandle.db),
            actorDisplayName: createMentionActorNameResolver(dbHandle.db),
          }),
          // WP 3.4 - one generic in-app alert per assignment / reassignment / lost owner (access re-checked at delivery).
          buildM36TaskNotificationsConsumer({
            alerts: getSeam("AlertEmitter") as AlertEmitter,
            messaging: createDbMessagingRouteService(dbHandle.db),
          }),
          // WP 3.5 - fixed-text in-app alerts for a handoff offer / acceptance / unaccepted outcome (supervisors via the
          // seeded role rule). Bound only with the handoff binding; the expiry tick and revocation sweep feed it.
          ...(m36Handoffs
            ? [
                buildM36HandoffNotificationsConsumer({
                  alerts: getSeam("AlertEmitter") as AlertEmitter,
                  stillOffered: m36Handoffs.stillOffered,
                  markNeedsAttention: m36Handoffs.markNeedsAttention,
                  isActiveUser: m36Handoffs.isActiveUser,
                }),
              ]
            : []),
          // WP 3.10 - one fixed-text in-app alert for the supervisor audience when a medication question has no nurse.
          buildM36MedicationQuestionNotificationsConsumer({
            alerts: getSeam("AlertEmitter") as AlertEmitter,
          }),
          // WP 4.1 - one fixed-text in-app alert for the named recipient of an urgent clinical message (not a page).
          ...(m36Urgent
            ? [
                buildM36UrgentNotificationsConsumer({
                  alerts: getSeam("AlertEmitter") as AlertEmitter,
                  messaging: createDbMessagingRouteService(dbHandle.db),
                  stillQualified: m36Urgent.stillQualified,
                  warn: (message, context) => app.log.warn(context, message),
                }),
              ]
            : []),
          // WP 4.2 - one fixed-text in-app alert for the assignee of an important request, or the new assignee of a reassign.
          ...(m36Ack
            ? [
                buildM36AckNotificationsConsumer({
                  alerts: getSeam("AlertEmitter") as AlertEmitter,
                  messaging: createDbMessagingRouteService(dbHandle.db),
                  isWaitingForAssignee: m36Ack.isWaitingForAssignee,
                  stillQualified: m36Ack.stillQualified,
                  warn: (message, context) => app.log.warn(context, message),
                }),
              ]
            : []),
          // WP 4.4 - arms the escalation timer for a request that was requested, reassigned or escalated (reads the request's
          // current window from the database; ignores the escalation flag: arming writes nothing to the request).
          ...(m36AckEscalation
            ? [buildM36AckTimerArmingConsumer({ armFromRequest: m36AckEscalation.armFromRequest })]
            : []),
          // WP 4.4 - generic in-app alerts: the tier's clinician an unacknowledged request was escalated to, and the sender and
          // assignee (plus the supervisor audience when the ladder is exhausted) when no tier could be reached.
          ...(m36Ack && m36AckEscalation
            ? [
                buildM36AckEscalationNotificationsConsumer({
                  alerts: getSeam("AlertEmitter") as AlertEmitter,
                  opsNotice: m36AckOpsNotice,
                  messaging: createDbMessagingRouteService(dbHandle.db),
                  readRequest: m36AckEscalation.readRequest,
                  stillQualified: m36Ack.stillQualified,
                  warn: (message, context) => app.log.warn(context, message),
                }),
              ]
            : []),
          // WP 4.5 (ADR-0071) - when EVERY out-of-band route to a request's assignee has failed, try the next tier now or mark the
          // request failed_unreachable (same flag and guarded router as the timer; with the flag off the request is left as it is).
          ...(m36AckEscalation
            ? [
                buildM36AckDeliveryFailureConsumer({
                  readRoutes: createDeliveryRouteReader(
                    dbHandle.db,
                    m36AckEscalation.windowStartOfMessage,
                  ),
                  service: m36AckEscalation.deliveryFailure,
                  opsNotice: m36AckOpsNotice,
                  warn: (message, context) => app.log.warn(context, message),
                  info: (message, context) => app.log.info(context, message),
                }),
              ]
            : []),
          // WP 4.5 - a request nobody could be reached for is never silent: the supervisor audience, the sender and the assignee get a
          // generic in-app alert, and the ops notice sink (log line plus OPS_ALERT_WEBHOOK_URL) is raised.
          ...(m36Ack && m36AckEscalation
            ? [
                buildM36AckUnreachableNotificationsConsumer({
                  alerts: getSeam("AlertEmitter") as AlertEmitter,
                  messaging: createDbMessagingRouteService(dbHandle.db),
                  readRequest: m36AckEscalation.readRequest,
                  opsNotice: m36AckOpsNotice,
                  warn: (message, context) => app.log.warn(context, message),
                }),
              ]
            : []),
          // WP 3.7 - records the decision M8 / M14 report for a chart-promotion proposal (always, regardless of the flag) and
          // tells the requester; and tells the reviewers a proposal is waiting (the requester when nobody can be reached).
          ...(m36Promotions
            ? [
                buildM36PromotionOutcomesConsumer({
                  alerts: getSeam("AlertEmitter") as AlertEmitter,
                  applyOutcome: (orgId, outcome) =>
                    m36Promotions.service.applyOutcome(orgId, outcome),
                  warn: (message, context) => m36PromotionWarn(message, context),
                }),
                buildM36PromotionNotificationsConsumer({
                  alerts: getSeam("AlertEmitter") as AlertEmitter,
                  requestFacts: m36Promotions.requestFacts,
                  careTeamMembers: async (organizationId, patientId) =>
                    getSeam("CareTeamProvider").careTeamMembers({ organizationId, patientId }),
                  canSignAddendum: async (organizationId, userId) =>
                    (await resolveActorPermissions({ organizationId, userId })).has(
                      "encounter.addendum_sign",
                    ),
                }),
              ]
            : []),
          // WP 2.6 — tells the sender a scheduled message was blocked at dispatch (generic in-app text, no PHI).
          buildM36ScheduleBlockedConsumer({ alerts: getSeam("AlertEmitter") as AlertEmitter }),
          // GAP-039/040 — M13's missed-dose / PRN-reassessment-overdue / reconciliation / kit-return alerts
          // (M13 spec §4.9): previously unconsumed (M36 sat on the seam-consumer list).
          buildM36EmarAlertConsumer(getSeam("AlertEmitter") as AlertEmitter),
          // GAP-105 — M37's irc-cap / restraint-reassessment / bed-cleaning / GIP-staleness watchdog alerts
          // (M37 spec §4.9): the crons that raise them now exist, and M36 consumes them.
          buildM36IpuAlertConsumer(getSeam("AlertEmitter") as AlertEmitter),
          // GAP-104 — the care_team channel membership lifecycle: assignment created/ended re-sync the roster (a
          // clinician taken off the caseload loses channel access), discharge/death archive the channel.
          buildM36ChannelMembershipSyncConsumer({
            syncCareTeam: (orgId, patientId) =>
              (getSeam("MessagingProvider") as MessagingProvider).syncCareTeamChannel(
                orgId,
                patientId,
              ),
            archiveCareTeam: (orgId, patientId) =>
              (getSeam("MessagingProvider") as MessagingProvider).archiveCareTeamChannel(
                orgId,
                patientId,
              ),
            reopenCareTeam: (orgId, patientId) =>
              setCareTeamChannelArchived(dbHandle.db, orgId, patientId, false),
            patientIdForAdmission: async (orgId, admissionId) =>
              (
                await (
                  getSeam("AdmissionStatusReader") as AdmissionStatusReader
                ).getAdmissionSummary(orgId, admissionId)
              ).patientId,
            // WP 3.9 - a clinician taken off the team: their open care-team tasks for that patient are queued for a
            // supervisor (tasks only; handoffs keep ADR-0062's guarantees). Bound only with the review binding.
            ...(m36Review
              ? {
                  routeForReview: buildCareTeamReviewRouter({
                    db: dbHandle.db,
                    careTeamMembers: async (organizationId, patientId) =>
                      getSeam("CareTeamProvider").careTeamMembers({ organizationId, patientId }),
                    alerts: getSeam("AlertEmitter") as AlertEmitter,
                    isFlagOn: m36Review.isEnabled,
                    warn: (message, context) => m36ReviewWarn(message, context),
                  }),
                }
              : {}),
          }),
          // WP 3.8 - a patient who is discharged, dies or transfers out: their open care-team tasks are queued for a
          // supervisor's decision (never deleted, never auto-closed) and the people affected are told. Bound only with
          // the review binding; the care_team archive above is the posting restriction, this is the follow-up check.
          ...(m36Review
            ? [
                buildM36PatientLifecycleReviewConsumer({
                  alerts: getSeam("AlertEmitter") as AlertEmitter,
                  admissionCare: (orgId, admissionId) =>
                    (
                      getSeam("AdmissionStatusReader") as AdmissionStatusReader
                    ).getAdmissionPatientCare(orgId, admissionId),
                  queueForPatient: m36Review.queueForPatient,
                  isFlagOn: m36Review.isEnabled,
                  warn: (message, context) => m36ReviewWarn(message, context),
                }),
              ]
            : []),
          // WP 1.1 / audit F3 — a revoked membership or offboarded user loses channel access immediately (the
          // sockets half is added with bootstrap/realtime; `disconnectUser` is absent until then).
          buildM36AccessRevocationConsumer({
            endChannelMemberships: (orgId, userId) =>
              endChannelMembershipsForUser(dbHandle.db, orgId, userId),
            // WP 3.4: a leaver's active communication tasks move to a successor or are flagged `needs_owner` (never
            // ownerless). Escalations remain P4. Runs whether or not the tasks flag is on.
            // WP 3.5 adds the leaver's open handoffs (receiver left => declined, sender left => flagged + supervisors told).
            // Both are ATTEMPTED; the first failure is rethrown afterwards so the dispatcher retries (the realtime
            // disconnect has already run by then: `reassignThenDisconnect`).
            reassignOwnedItems: combineReassignments([
              m36Tasks?.reassignForLeaver,
              m36Handoffs?.reassignForLeaver,
            ]),
            ...(realtimeEmitter
              ? {
                  disconnectUser: (orgId, userId) =>
                    realtimeEmitter.disconnectRoom(userRoom(orgId, userId)),
                  disconnectAccount: (userId) =>
                    realtimeEmitter.disconnectRoom(accountRoom(userId)),
                }
              : {}),
          }),
          // WP 1.1 — committed message changes become PHI-free realtime hints (`emitToRooms` is added with the
          // Valkey emitter in bootstrap/realtime; until then the event is acknowledged and nothing is sent).
          buildM36MessageHintConsumer({
            audience: (orgId, channelId) => channelHintAudience(dbHandle.db, orgId, channelId),
            ...(realtimeEmitter
              ? {
                  emitToRooms: (rooms, hint) =>
                    realtimeEmitter.emit(rooms, REALTIME_HINT_EVENT, hint),
                }
              : {}),
          }),
          // WP 2.7b C2 — committed message sent/edited/deleted events (re)write or remove the blind-token rows.
          m36GlobalSearch.consumer,
          // FY2027 — the 42 CFR 418.24(d) election-addendum window missed: the first M6 compliance-window fact
          // that pages anyone (care team + compliance), via `m6.election_addendum.overdue`.
          buildM36AdmissionComplianceAlertConsumer(getSeam("AlertEmitter") as AlertEmitter),
          // GAP-118 — M5's §164.526 amendment-SLA events (due soon / overdue) page the privacy officer + compliance.
          buildM36AmendmentSlaAlertConsumer(getSeam("AlertEmitter") as AlertEmitter),
          // GAP-040 — M26's `m26.cap.threshold_crossed` band escalations page finance leads (breach: + compliance).
          buildM36CapThresholdAlertConsumer(getSeam("AlertEmitter") as AlertEmitter),
          // GAP-061 — M20's check-in overdue / escalated / coverage-gap watchdog alerts (M20 spec §4.9): previously
          // unconsumed, so a lone worker's missed check-in paged nobody.
          buildM36FieldSafetyAlertConsumer(getSeam("AlertEmitter") as AlertEmitter),
          // GAP-049 — M30's sentinel / abuse-allegation incident, outbreak, threshold-breach and CAHPS-sample
          // events (M30 spec §4.9): previously unconsumed (`declaredConsumers: []`), so none of them paged anyone.
          // GAP-043 - M29's listener-down / listener-recovered events (published by the worker-role watcher): the page.
          buildM36FeedHealthAlertConsumer(getSeam("AlertEmitter") as AlertEmitter),
          buildM36QualityAlertConsumer(
            getSeam("AlertEmitter") as AlertEmitter,
            (message, context) => app.log.warn(context, message),
          ),
          // GAP-107 — M37's IV-continuous bedside-check-overdue watchdog alert (M37 §2.6/D7, §4.8): previously
          // unconsumed, so a lapsed bedside check on a running IPU infusion told the care team nothing.
          buildM36IpuIvAlertConsumer(getSeam("AlertEmitter") as AlertEmitter),
          // M19 §4.8/§4.9 (GAP-057) — `m19.oncall_shift.coverage_gap` (the coverage-gap watchdog cron + the D10
          // reactive arm) -> the system-locked critical `m19.oncall.coverage_gap_detected` page.
          buildM36OncallAlertConsumer(getSeam("AlertEmitter") as AlertEmitter),
          // M14 §2.7/D8 — the carry-forward COMPLIANCE alert (the count crossing 3): validated against the
          // typed alert-payload catalog (M14's contribution registered on the Foundation registry here, in the
          // composition root — M36 never imports M14), one alert per action item.
          (() => {
            const m14AlertCatalog = createAlertPayloadRegistry();
            m14AlertCatalog.register(M14_ALERT_PAYLOADS);
            m14AlertCatalog.assertValid();
            return buildIdgCarryForwardComplianceConsumer({
              alerts: getSeam("AlertEmitter") as AlertEmitter,
              catalog: m14AlertCatalog.build(),
              membershipUserId: createDrizzleMembershipUserLookup(dbHandle.db),
            });
          })(),
          // M14 §4.10 — the REMAINING typed IDG alerts (packets ready / action item assigned / non-quorate decision /
          // review-clock escalation / review-floor override), one M36 consumer each, same catalog validation and
          // correlation-id idempotency; recipients = platform `alert_rule` role_set + resolved user ids.
          ...(() => {
            const m14AlertCatalog = createAlertPayloadRegistry();
            m14AlertCatalog.register(M14_ALERT_PAYLOADS);
            m14AlertCatalog.assertValid();
            return buildIdgAlertConsumers({
              alerts: getSeam("AlertEmitter") as AlertEmitter,
              catalog: m14AlertCatalog.build(),
              membershipUserId: createDrizzleMembershipUserLookup(dbHandle.db),
              meetingAttendees: createDrizzleIdgAttendeeLookup(
                dbHandle.db,
                createMembershipsHoldingPermissionReader(dbHandle.db),
              ),
            });
          })(),
          buildM10AdmissionWorkflowConsumer({
            db: dbHandle.db,
            outbox: m10OutboxPublisher,
            admissions: getSeam("AdmissionStatusReader") as AdmissionStatusReader,
          }),
          buildM18VisitPublishedConsumer({ db: dbHandle.db }),
          // GAP-056 — the §4.8 outbox-driven M18 workers: the Cures Act aggregator-submission prep (queues a
          // submission per paired check-out) and the D9 GPS-spoof detector (advisory flag + warn event).
          ...(m18AggregatorDeps
            ? [
                buildM18SubmissionPrepConsumer({
                  db: dbHandle.db,
                  aggregator: m18AggregatorDeps,
                }),
              ]
            : []),
          buildM18SpoofDetectorConsumer({
            db: dbHandle.db,
            outbox: m18OutboxPublisher,
            coordsCipher: m18CoordsCipher(), // GAP-133 — opens the §D10 coordinate envelope
          }),
          // §4.8 `m18.dek-rotation` — on `m34.tenant.dek_rotation_completed`, re-seal that tenant's EVV
          // coordinates under the new DEK version through migration 0494's definer (the daily M18 cron sweep
          // is the backstop).
          buildM18DekRotationConsumer({
            store: createDrizzleCoordsResealStore(dbHandle.db),
            keys: m18CoordsKeys(),
          }),
          // F-153 (#248) — D14's other named consumed event: cancel pending aggregator submissions +
          // void open missing-resolution rows for the cancelled visit.
          buildM18VisitCancelledConsumer({
            db: dbHandle.db,
            outbox: m18OutboxPublisher,
          }),
          // F-153 (#248) — D6/§2.2.4: the encounter's own documented EVV-missing reason auto-resolves
          // (or, if no sweep/detector ever opened one, creates already-closed) the missing-resolution row.
          buildM18EncounterSignedConsumer({
            db: dbHandle.db,
            outbox: m18OutboxPublisher,
          }),
          // F-150 (#248) — M30's §4.10 upstream-event handlers had been pure, unit-tested and
          // completely unbound since the package shipped (RULE 3(d) — "the live inbound dispatcher is a
          // later platform phase" never landed). These two are the ones fully ready to bind today: both
          // consume only the real `enqueueRecompute` port (`outbox-consumers/upstream-consumer-ports.ts`).
          buildM30HopeSubmissionAcceptedConsumer({ db: dbHandle.db }),
          buildM30ClaimAdjudicatedConsumer({ db: dbHandle.db }),
          // F-161 (#248) — the M16 bereavement plan-closure trio. All three closure transitions run a
          // `cancel_future_outreach` effect that shrinks `bereavement_coverage_rate`'s denominator.
          // `bereavementPlanSitingForOrg` is M16's seam, injected as a port — M30's manifest `dependsOn`
          // excludes 16 (the F-160 `CapConsumerStore` shape).
          buildM30BereavementPlanClosedConsumer({
            db: dbHandle.db,
            bereavementPlanSitingForOrg,
          }),
          // F-185 (#248) — the M37 restraint-application consumer. Auto-files a `restraint_use` incident
          // draft (D8, thin-pointer payload). `restraintAdmissionSitingForOrg` is M37's seam, injected as
          // a port — M30's manifest `dependsOn` excludes 37 (the same F-160 `CapConsumerStore` shape).
          // GAP-089 — the M6 death consumer (mortality half): auto-creates the `mortality_review` draft and
          // emits `m30.mortality.review_created`. `deathDischargeFactsForOrg` is M6's seam, injected as a
          // port — M30's manifest `dependsOn` excludes 6 (the same F-160 shape).
          buildM30DischargeDeathConsumer({
            db: dbHandle.db,
            outbox: m30OutboxPublisher,
            deathDischargeFactsForOrg,
            resolveMedicalDirectorForOrg: buildMortalityReviewerResolver(
              dbHandle.db,
              createMembershipsHoldingRoleKeyReader(dbHandle.db),
            ),
          }),
          buildM30RestraintAppliedConsumer({
            db: dbHandle.db,
            restraintAdmissionSitingForOrg,
          }),
          // F-194 (#248) — the M18 EVV visit-verified consumer. Enqueues an HVLDL recompute (the
          // already-built `handleEvvVisitVerified`/`hvldl_near_death_recompute` pure logic, previously
          // unwired). `evvVisitProviderEntityForOrg` is M18's seam, injected as a port — M30's manifest
          // `dependsOn` excludes 18 (the same F-160 `CapConsumerStore` shape).
          buildM30VisitVerifiedConsumer({
            db: dbHandle.db,
            evvVisitProviderEntityForOrg,
          }),
          // F-205 (#248) — the M12 medication-error-reported consumer. Auto-files a `medication_error`
          // incident draft (D8). `medicationOrderScheduleContextForOrg`/`admissionSchedulingContextForOrg`
          // are M12's/M6's seams, injected as ports — M30's manifest `dependsOn` excludes both 12 and 6
          // (the same F-160 `CapConsumerStore` shape), the identical two-step chain
          // `buildM13MaterializeScheduleConsumer` (F-166) already uses at this same composition root.
          buildM30MedicationErrorReportedConsumer({
            db: dbHandle.db,
            medicationOrderScheduleContextForOrg,
            admissionSchedulingContextForOrg,
          }),
          // F-158 (#248) — M37's §4.5 "If patient has open `ipu_admission` → cascade-discharge", M37's
          // first outbox consumer. Death discharges are a deliberate no-op here (see the file header) —
          // that path is the separate `m6-discharge-death.ts` consumer, below.
          buildM37AdmissionDischargedConsumer({ db: dbHandle.db, outbox: m37OutboxPublisher }),
          // F-172 (#248) — the §2.2 `recordDeath` producer, previously called nowhere outside its own
          // unit test. Drives `m6.discharge.death` → `transitionAdmission(..., {type: "recordDeath"})`
          // → `m37.ipu_admission.death_recorded` + the auto-opened `ipu_body_release` row.
          buildM37DeathRecordedConsumer({ db: dbHandle.db, outbox: m37OutboxPublisher }),
          // M6 -> M37 LCP handshake (M37 §2.2 `bed_assigned` -> `active`, §4.5). M6's
          // `confirmLocBedAssignment` publishes `m6.level_of_care.activated`; this drives the
          // system-internal `confirm` (GAP-106) as the typed `m6LcpAckActor`, org-explicit and idempotent.
          // `confirm` needs only the outbox: its other ports are never read on that path.
          buildM37LcpActivatedConsumer({
            service: buildDrizzleIpuRouteService(dbHandle.db, { outbox: m37OutboxPublisher }),
            lookup: buildDrizzleLcpAdmissionLookup(dbHandle.db),
          }),
          // GAP-107 — the WRITER of `ipu_iv_safety_overlay` (M37 §2.6/D7). Nothing ever inserted a row, so the
          // overlay seam always answered null and M13 never gated a continuous infusion. A signed continuous-IV
          // medication order for a patient on an open IPU admission gets its overlay; a discontinued/completed
          // order retires it. The order facts come through M12's org-explicit seam function (a relay tick is
          // not a request), and the overlay event goes through the real catalog-validating publisher.
          buildM37IvOverlayOnOrderSignedConsumer({
            db: dbHandle.db,
            outbox: m37OutboxPublisher,
            orderContext: (organizationId, orderId) =>
              medicationOrderScheduleContextForOrg(dbHandle.db, organizationId, orderId),
          }),
          buildM37IvOverlayOnOrderEndedConsumer({ db: dbHandle.db }),
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
          // ADR-0082 - `m36.afterhours_triage.requested`: M36 asks for a triage call by id; M19 decides and
          // always answers. The same patient reads the tier-1 router uses (patient-in-org + provider entity),
          // over the M5 PatientReader seam resolved lazily. Flag-off: M36 publishes nothing.
          buildAfterHoursRequestedConsumer({
            db: dbHandle.db,
            ports: m19TriggerPorts,
            deliveryPorts: m19TriggerPorts,
            outbox: m19OutboxPublisher,
            afterHoursReads: buildDrizzleEscalationRouterReads({
              db: dbHandle.db,
              patientReader: () => getPatientReader(),
              siteReader: buildFoundationSiteReader(),
              listProviderEntityIds: buildOrgProviderEntityLister(dbHandle.db),
            }),
          }),
          // §4.5 path 1 / §4.8 `m19.shift-sync.debounced` (m19 `handlers-unbound` group, #248; F-155's own
          // finding, now built). Bumps the org's `on_call_roster_sync_queue` debounce window forward; the
          // reconciliation itself runs on the separate scheduled drain worker registered above — see
          // `consumers/roster-sync-debounce.ts`'s own header.
          buildOncallRosterSyncDebounceConsumer({ db: dbHandle.db }),
          // M19 §2.2.1 / D8 (GAP-058) — `m8.encounter.signed` advances the linked triage call
          // `documented_pending_encounter → documented`. `decideEncounterSigned` existed since M19-T05 with no
          // production caller and M8 declared no m19 consumer, so `markDocumented` — the only edge into
          // `documented` — never ran and every call stayed parked. Same publisher/no-alerts posture as the
          // trigger consumers above.
          buildOncallEncounterSignedConsumer({ db: dbHandle.db, outbox: m19OutboxPublisher }),
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
          // GAP-070 — the committed `validation_started` / `refresh_requested` request → BullMQ job bridge
          // for the two queues that need no launch gateway (their workers are built above, gated only on a
          // queue connection).
          ...(m23WorkQueues
            ? [
                buildM23WorkRequestConsumer({
                  enqueue: async (queueName, jobId, payload) => {
                    await m23WorkQueues.port.enqueue(queueName, jobId, payload);
                  },
                }),
              ]
            : []),
          ...(m24SubmissionQueues
            ? [buildM24SubmissionRequestConsumer(m24SubmissionQueues.port)]
            : []),
          // F-165 (#248, m24 group) — the m24 `handlers-unbound` group's "trigger-revalidate" + "resolve-medicare
          // -primary" live bindings.
          ...buildM24RevalidateTriggerConsumers({ enqueue: m24RevalidateEnqueue.port }),
          buildM24MedicarePrimaryAckConsumer({ db: dbHandle.db, outbox: m24OutboxPublisher }),
          // GAP-071 — rb_day re-evaluation on `m6.loc.changed` + void on `m6.admission.discharged` /
          // `m5.patient.deceased` (M24 §2.2 / §4.4). M6 reads go through org-explicit ForOrg functions.
          ...buildM24RbDayConsumers({
            db: dbHandle.db,
            locPeriods: {
              periodsForPatient: (organizationId, patientId, range) =>
                levelOfCarePeriodsForPatientForOrg(dbHandle.db, organizationId, patientId, range),
            },
            admissions: {
              patientIdForAdmission: async (organizationId, admissionId) =>
                (await admissionSchedulingContextForOrg(dbHandle.db, organizationId, admissionId))
                  ?.patientId ?? null,
            },
          }),
          // F-172 (#248, m24 group) — the m24 `handlers-unbound` group's last two events:
          // `mark-claim-paid` / `mark-claim-denied`, the Medicaid sibling of M23's own GAP-037
          // `m25-remittance.ts` consumer above. Both `m25.remittance.claim_paid`/`.claim_denied` already
          // declare `m24` a consumer; only the `M24ConsumerStore` implementation was missing.
          buildM24RemittanceConsumer({
            db: dbHandle.db,
            outbox: m24OutboxPublisher,
            onSkipped: (info) =>
              app.log.warn(
                {
                  reason: info.reason,
                  event: info.eventType,
                  org: info.organizationId,
                  claim: info.claimId,
                  state: info.currentState,
                },
                "M24 remittance transition skipped",
              ),
          }),
          ...(m34ProvisionQueue ? [buildM34ProvisionStartedConsumer(m34ProvisionQueue.port)] : []),
          // M5 §4.10 — the proposal applier (LIVE end-to-end now that M29's accept path publishes
          // the event; skips everything not m5-owned).
          buildM29ProposalApplierConsumer(),
          // M5 §7.8 (GAP-004) — the death cascade: resolves the decedent through M6's
          // DeathDischargeReader seam and flips patient.status='deceased' + emits
          // m5.patient.deceased (seeds M16 bereavement / M23 final claim / M28 FHIR / M36 IDG alert).
          buildM5DeathCascadeConsumer({ db: dbHandle.db, outbox: m5OutboxPublisher }),
          // F-235 (#248) — the DocLens chart writeback, both halves. M5 applies an approved review's
          // low-risk contact demographics to the batch's resolved patient and replies; M22 stamps
          // `extraction_provenance` from the reply and emits the terminal `m22.extraction.commit_completed`.
          buildM5ExtractionWritebackConsumer({ db: dbHandle.db, outbox: m5OutboxPublisher }),
          buildM22ExtractionBackrefConsumer({ db: dbHandle.db, outbox: m22OutboxPublisher }),
          // F-238 dx-writeback — the DIAGNOSIS half. M7 lands an approved review's diagnoses as PENDING
          // problem proposals on the patient's care plan (never `problem` rows — a clinician must accept)
          // and replies; M22 stamps `extraction_provenance` with the proposal ids.
          buildM7ExtractionDiagnosisWritebackConsumer({
            db: dbHandle.db,
            outbox: m7OutboxPublisher,
          }),
          buildM22ExtractionDiagnosisBackrefConsumer({
            db: dbHandle.db,
            outbox: m22OutboxPublisher,
          }),
          // F-238 — the DocLens clinical writeback, all three legs. M12 records approved medication lines as
          // reconciliation-only `medication_history_record` rows (never a medication_order — D10/D12); M5
          // records approved allergy lines as UNVERIFIED `patient_allergy` rows; M22 stamps each line's
          // provenance with the row id and emits `m22.extraction.commit_completed`.
          buildM12ExtractionMedicationHistoryConsumer({
            db: dbHandle.db,
            outbox: m12OutboxPublisher,
          }),
          buildM5ExtractionAllergyConsumer({ db: dbHandle.db, outbox: m5OutboxPublisher }),
          buildM22ExtractionClinicalBackrefConsumer({
            db: dbHandle.db,
            outbox: m22OutboxPublisher,
          }),
          // F-237 — M22 §7.4 W4: DocLens SUD detection → the patient's interim `sud` privacy flag, and the
          // reviewer's confirm / false-positive round-trip (a rejection retires only a DocLens-set flag).
          buildM5IntakeSudPrivacyConsumer({ db: dbHandle.db, outbox: m5OutboxPublisher }),
          // F-152 (#248) — the §3.3/ARCH-011 admission-siting denormalization onto `patient`. Resolved
          // through M6's registered AdmissionStatusReader seam (no `dependsOn` edge to M6 required).
          buildM5AdmissionSitingConsumer({ db: dbHandle.db, outbox: m5OutboxPublisher }),
          // §2.4.1 — a LIVE discharge (revocation, transfer out, moved, no longer terminal, for cause,
          // other) moves the chart `active/on_hold → discharged`; a death is the death cascade's.
          buildM5AdmissionDischargedConsumer({ db: dbHandle.db, outbox: m5OutboxPublisher }),
          // The creator's `admitting_staff` access grant ends when its referral is declined / duplicate / withdrawn.
          buildM5ReferralClosedConsumer({ db: dbHandle.db }),
          // GAP-118 — M5's own `geocode_address` job as the consumer of `m5.patient.address_changed`. The vendor
          // is NOT bound (a geocode sends a patient's home address to a third party: no vendor / BAA / key exists),
          // so `resolveGeocoder` returns the fail-closed port unless GEOCODER_VENDOR + GEOCODER_API_KEY +
          // GEOCODER_BAA_ATTESTED=true name a registered adapter — events dead-letter visibly until then.
          buildM5GeocodeAddressConsumer({
            db: dbHandle.db,
            geocoder: resolveGeocoder(process.env),
          }),
          // F-165 (#248, m24 group) — the m5 `handlers-unbound` group's `m17.visit.assigned`/`.unassigned` pair:
          // M17's shift-assignment Valkey cache, unioned additively into `CaseloadProvider`'s read
          // (see `wireModuleSeams`'s `caseloadShiftCacheRedis` wiring above). Gated on the dedicated
          // `m5CaseloadShiftCacheRedisClient` the same way F-152's order-suggestion banner gates on
          // its own dedicated client (no Redis in dev/test without `queueConnection`).
          ...(m5CaseloadShiftCacheRedisClient
            ? [
                buildM5VisitAssignedConsumer({
                  redis: m5CaseloadShiftCacheRedisClient,
                  membershipUserId: (organizationId, membershipId) =>
                    membershipUserIdForOrg(dbHandle.db, organizationId, membershipId),
                }),
                buildM5VisitUnassignedConsumer({
                  redis: m5CaseloadShiftCacheRedisClient,
                  membershipUserId: (organizationId, membershipId) =>
                    membershipUserIdForOrg(dbHandle.db, organizationId, membershipId),
                }),
              ]
            : []),
          // F-167 (#248, m5 group) — the §7.6/D10 privacy-flag-snapshot recompute off M39's
          // signed/revoked/supersedes/renewed consent lifecycle (the one real relationship: M39's own
          // spec §4.3.1 names `42_cfr_part_2_release` → `sud` and no other type).
          buildM5ConsentPrivacyConsumer({ db: dbHandle.db, outbox: m5OutboxPublisher }),
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
          // M39 §7.7 / D13 (GAP-110) — `m5.patient.deceased` expires the decedent's active non-survives-death
          // consents (one `m39.consent.expired` each, same tx). Until bound, the evaluator's death probe was a
          // permanent `false` and a consent that should have ended at death kept authorizing PHI egress.
          buildM39PatientDeceasedConsumer({ db: dbHandle.db, outbox: m39OutboxPublisher }),
          // M39 §4.6 (GAP-067) — `m5.patient.merged` re-points the folded-away chart's consent rows (Part 2
          // releases and revocations included) to the survivor, emitting `m39.consent.repointed`.
          buildM39PatientMergedConsumer({ db: dbHandle.db, outbox: m39OutboxPublisher }),
          // M22 §4.11 (GAP-023/024/038) — the LIVE render handshake. Every `*.document_requested` row was
          // written by a source module and drained by NOBODY: the decider, the two gates, the renderer and
          // (since GAP-095) the Drizzle document-row store all existed, but no binding ever joined them, so
          // M13's finalize-reconciliation request sat `pending` forever. `store:` is a SECOND
          // `createDrizzleDocumentSeamStore` instance over the same tables as the one behind the renderer
          // seam — each opens its own `withOrgContext` per call, so sharing an instance would buy nothing.
          buildM22DocumentRequestConsumer({
            store: createDrizzleDocumentSeamStore(dbHandle.db),
            // GAP-036 - the appeal packet re-verifies every enclosure it names (still visible, active, not Part 2)
            // at render time: a document can change class between submit and render.
            renderGuard: buildAppealPacketRenderGuard(() => getSeam("DocumentReader")),
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
              withOrgContext(dbHandle.db, { organizationId, userId: "" }, (tx) =>
                m22OutboxPublisher.publish(tx as never, {
                  eventName: M22_DOCUMENT_RENDERED_EVENT,
                  payload,
                  organizationId,
                  aggregateKind: "document",
                  aggregateId: payload.documentId,
                }),
              ),
          }),
          // F-171 (#248) — the LIVE `m12.medication_order.list_changed` → `patient_medication_list`
          // render. NOT part of the generic REQUEST_SHAPES pipeline above: the diff payload
          // (`{patientId, addedOrderIds, removedOrderIds}`) carries no renderable content, so this
          // consumer resolves the CURRENT active-medication set fresh, at delivery time, via M12's real
          // `MedicationOrderProvider` seam instead (see medication-list-bindings.ts's own header for why
          // and for the ambient-request-context wrap the underlying seam read needs).
          buildM22MedicationListConsumer({
            store: createDrizzleDocumentSeamStore(dbHandle.db),
            onRefusal: (r) =>
              app.log.warn(
                {
                  event: r.eventType,
                  org: r.organizationId,
                  patient: r.patientId,
                  detail: r.detail,
                },
                `M22 medication-list render refused: ${r.detail}`,
              ),
            emitRendered: ({ organizationId, ...payload }) =>
              withOrgContext(dbHandle.db, { organizationId, userId: "" }, (tx) =>
                m22OutboxPublisher.publish(tx as never, {
                  eventName: M22_DOCUMENT_RENDERED_EVENT,
                  payload,
                  organizationId,
                  aggregateKind: "document",
                  aggregateId: payload.documentId,
                }),
              ),
          }),
          // F-171 (#248) — the LIVE `m11.order.results_received` → `lab_results_pdf` render. NOT part of
          // the generic REQUEST_SHAPES pipeline above (deliberately — see lab-backref-consumer.ts's own
          // header for why: `lab_results_pdf` shares its aggregateType with the order-FORM render, so
          // aggregate-level idempotency would silently skip it forever once an order's form had rendered).
          // `store:` is a THIRD `createDrizzleDocumentSeamStore` instance, the same one-per-consumer
          // pattern the two consumers above use.
          buildM22LabBackrefConsumer({
            store: createDrizzleDocumentSeamStore(dbHandle.db),
            onDeferred: (d) =>
              app.log.warn(
                { org: d.organizationId, order: d.orderId, observation: d.observationId },
                "M22 lab-results render deferred: M29 observation not yet resolved",
              ),
            emitRendered: ({ organizationId, ...payload }) =>
              withOrgContext(dbHandle.db, { organizationId, userId: "" }, (tx) =>
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
          // FY2027 — 42 CFR 418.24(d)(2): a plan-of-care change to the unrelated determinations (M7 problem
          // events + signed care-plan versions) opens the 3-day election-addendum update window.
          ...(m6ElectionAddendum
            ? [
                buildM6CarePlanAddendumConsumer({
                  addendum: () => m6ElectionAddendum,
                }),
                // FY2027 — 42 CFR 418.24(d)(2): an M12 drug / M21 DME-supply coverage determination change
                // changes the addendum's non-covered list → the same 3-day update window.
                buildM6CoverageAddendumConsumer({
                  addendum: () => m6ElectionAddendum,
                }),
              ]
            : []),
          // F-159 (#248) — the §2.3.5 LCP transition M11 D9's signed level-of-care-change order drives.
          // Migration 0250 adds the `source_order_id` idempotency key a genuine redelivery needs.
          buildM6LevelOfCareChangeSignedConsumer({
            db: dbHandle.db,
            outbox: m6OutboxPublisher,
          }),
          // F-223 (#248) — a signed recert order (M11 D10) opens the next PENDING election period via the
          // route's own insert; F2F/CTI adequacy stays gated at activation. Migration 0297 is the key.
          buildM6RecertificationSignedConsumer({
            db: dbHandle.db,
            outbox: m6OutboxPublisher,
          }),
          buildM11DocumentBackrefConsumer({ db: dbHandle.db }),
          buildM12DocumentBackrefConsumer({ db: dbHandle.db }),
          // F-152 (#248) — the §2.7 D7 order-suggestion banner. Needs `orderSuggestionRedisClient`
          // (only present when `queueConnection` is configured), the same optional-worker posture
          // `m34ProvisionQueue` below uses.
          ...(orderSuggestionRedisClient
            ? [
                buildM11AssessmentSuggestionConsumer({
                  db: dbHandle.db,
                  redis: orderSuggestionRedisClient,
                  outbox: m11OutboxPublisher,
                }),
              ]
            : []),
          // F-152 — the D8 one-shot (`supply`/`comfort_kit`) auto-complete on M21 delivery. `dme`
          // stays open — it completes on receipt via a separate monthly-rental close-out.
          buildM11FulfillmentStatusConsumer({ db: dbHandle.db, outbox: m11OutboxPublisher }),
          // F-177 (#248) — `LabTransmissionApplier`: the m11 group's `m29.lab_order.transmitted`/
          // `.transmission_failed` pairs F-175 surfaced when it built M29's real T08 dispatch worker.
          // Drives `order_record.transmission_status` per D16 and re-publishes M11's own decisive
          // `m11.order.transmission_status_changed`/`.transmission_terminal_failed`.
          buildM11LabTransmissionApplierConsumer({ db: dbHandle.db, outbox: m11OutboxPublisher }),
          // GAP-016 — `LabResultsApplier`: the returned-lab half of the M29 handshake. Flips
          // `order_record.results_status` -> `results_received`, stamps `results_first_received_at`, and
          // emits `m11.order.results_received` (M22's `lab_results_pdf` render below) / `_critical`.
          buildM11LabResultsApplierConsumer({ db: dbHandle.db, outbox: m11OutboxPublisher }),
          // F-187 (#248) — a lab order discontinued/replaced after its ORM may already be at the laboratory:
          // nothing withdraws the ORM (T-29.08 defines no outbound cancel), so this raises the M36 alert that
          // tells the care team to cancel it with the lab. The M11-side self-consumption of
          // `m11.order.discontinued` / `m11.order.corrected`.
          buildM11LabCancellationConsumer({
            db: dbHandle.db,
            alerts: getSeam("AlertEmitter") as AlertEmitter,
          }),
          // F-203 (#248) — the two-person lab-recovery control's compliance alerts, DURABLE: the recovery's own
          // transaction publishes the intent, this hands it to M36, a failure is retried by the relay and the alert's
          // correlation id makes the redelivery idempotent.
          buildM11RecoveryAlertConsumer({ alerts: getSeam("AlertEmitter") as AlertEmitter }),
          // GAP-010 (M3 §4.5) — break-glass Compliance notification, DURABLE: the invoke's own transaction publishes
          // `m3.breakglass.invoked`, this hands it to M36's AlertEmitter (platform-default rule → compliance_officer).
          buildM36BreakGlassAlertConsumer({ alerts: getSeam("AlertEmitter") as AlertEmitter }),
          // F-166 (#248) — a staff-initiated `m21.supply_request.cancelled` (never through M11's own
          // discharge cascade above, which already discontinues the order before asking M21) releases
          // the still-in-flight source order M11 never touched. Safe for the cascade-reply producer too
          // (a true no-op — the order is already `discontinued` by then).
          buildM11SupplyCancelledConsumer({ db: dbHandle.db, outbox: m11OutboxPublisher }),
          // F-102 — the M6 discharge cascade, both halves. Each decider has been complete, exported and
          // unit-tested since M11-T07 / M12-T08 with no caller but its own test, and neither COULD be
          // bound: `m6.admission.discharged` did not declare m11 or m12, and
          // `assertBindableAgainstCatalog` refuses a binding whose module the catalog does not name. Every
          // order and every medication order in flight when a patient was discharged stayed in flight —
          // including `queued_for_transmission`, an order waiting to reach the e-prescribing vendor.
          buildM11DischargeCascadeConsumer({ db: dbHandle.db, outbox: m11OutboxPublisher }),
          buildM12DischargeCascadeConsumer({ db: dbHandle.db, outbox: m12OutboxPublisher }),
          // F-161 (#248) — the §2.8 D17 reconciliation-discontinue handshake: an M13 reconciliation
          // decision to discontinue an `m12_active` line now actually reaches the medication order.
          buildM12ReconciliationDiscontinueConsumer({
            db: dbHandle.db,
            outbox: m12OutboxPublisher,
          }),
          // F-164 (#248) — the §2.8 D17 reconciliation "draft order" handshake: a real `medication_order`
          // draft minted from a reconciliation decision, never the historical hardcoded `{}` payload.
          buildM12DraftOrderRequestedConsumer({
            db: dbHandle.db,
            outbox: m12OutboxPublisher,
            resolveAdmissionContext: (organizationId, patientId) =>
              activeAdmissionDraftContextForPatient(dbHandle.db, organizationId, patientId),
          }),
          // F-164 (#248) — the §2.3 D3 verbal-order-expiry backref: M11's polymorphic `verbal_order`
          // sweep (above) flips a medication order to `expired_unsigned` once its deadline passes.
          buildM12VerbalExpiredConsumer({ db: dbHandle.db, outbox: m12OutboxPublisher }),
          // F-164 (#248) — the six §2.6 D4 / §2.8 D10 patient-sync + MedHx-fetch triggers. Each enqueues
          // a debounced row onto `dosespot_sync_queue` (the scheduled drain worker above), never a direct
          // vendor call — the outbox consumer's own transaction is where the debounce is atomic with the
          // delivery. `m6.cti.signed`'s missing `admissionId` resolves through M6's own org-explicit
          // `electionPeriodContextForOrg` seam rather than a schema import (M6 is not in M12's `dependsOn`).
          buildM12PatientSyncCreatedConsumer({
            patientSync: createDrizzlePatientSyncEnqueuePort(dbHandle.db),
            medHxFetch: createDrizzleMedHxFetchEnqueuePort(dbHandle.db),
          }),
          buildM12PatientSyncUpdatedConsumer({
            patientSync: createDrizzlePatientSyncEnqueuePort(dbHandle.db),
            medHxFetch: createDrizzleMedHxFetchEnqueuePort(dbHandle.db),
          }),
          buildM12PatientSyncAddressChangedConsumer({
            patientSync: createDrizzlePatientSyncEnqueuePort(dbHandle.db),
            medHxFetch: createDrizzleMedHxFetchEnqueuePort(dbHandle.db),
          }),
          buildM12PatientSyncPayerChangedConsumer({
            patientSync: createDrizzlePatientSyncEnqueuePort(dbHandle.db),
            medHxFetch: createDrizzleMedHxFetchEnqueuePort(dbHandle.db),
          }),
          buildM12AdmissionActivatedMedHxConsumer({
            patientSync: createDrizzlePatientSyncEnqueuePort(dbHandle.db),
            medHxFetch: createDrizzleMedHxFetchEnqueuePort(dbHandle.db),
          }),
          buildM12RecertificationMedHxConsumer({
            patientSync: createDrizzlePatientSyncEnqueuePort(dbHandle.db),
            medHxFetch: createDrizzleMedHxFetchEnqueuePort(dbHandle.db),
            admissionIdForElectionPeriod: createDrizzleAdmissionIdForElectionPeriodPort(
              dbHandle.db,
              electionPeriodContextForOrg,
            ),
          }),
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
          // The §4.4 M22 back-ref (return leg of the F-166 render handshake): stamps
          // `idg_minutes.minutes_document_id` / `idg_patient_packet.packet_document_id` off
          // `m22.document.rendered`. Until it was bound both columns were written by nothing and the minutes
          // screen said "not rendered" for a document M22 had rendered.
          buildM14DocumentBackrefConsumer({ db: dbHandle.db }),
          // F-164 (#248) — 6 of the §4.5 "since last IDG" projection-cache consumers, gated on the
          // dedicated `m14SinceLastIdgRedisClient` the same way F-152's M11 suggestion-banner consumer
          // gates on its own dedicated client (no Redis in dev/test without `queueConnection`).
          ...(m14SinceLastIdgRedisClient
            ? [
                buildM14AssessmentRecordedConsumer({ redis: m14SinceLastIdgRedisClient }),
                buildM14AssessmentSignificantChangeConsumer({ redis: m14SinceLastIdgRedisClient }),
                buildM14HopeJ2051TriggerConsumer({
                  redis: m14SinceLastIdgRedisClient,
                  patientIdForHopeAssessment: (orgId, hopeAssessmentId) =>
                    hopeAssessmentPatientIdForOrg(dbHandle.db, orgId, hopeAssessmentId),
                }),
                buildM14HopeSfvCreatedConsumer({
                  redis: m14SinceLastIdgRedisClient,
                  patientIdForHopeAssessment: (orgId, hopeAssessmentId) =>
                    hopeAssessmentPatientIdForOrg(dbHandle.db, orgId, hopeAssessmentId),
                }),
                buildM14OrderDiscontinuedConsumer({
                  redis: m14SinceLastIdgRedisClient,
                  orderPatientAndKind: (orgId, orderId) =>
                    orderPatientAndKindForOrg(dbHandle.db, orgId, orderId),
                }),
                buildM14MedicationOrderDiscontinuedConsumer({
                  redis: m14SinceLastIdgRedisClient,
                  medicationOrderPatientAndDrug: (orgId, orderId) =>
                    medicationOrderPatientAndDrugForOrg(dbHandle.db, orgId, orderId),
                }),
              ]
            : []),
          buildM15PlanBootstrapConsumer({
            db: dbHandle.db,
            outbox: m15OutboxPublisher,
            // Same reason as M10's scheduling consumer above: M6's §4.7 seam pins the tenant from the
            // ambient REQUEST scope, and a relay tick is not a request.
            resolveSiting: (organizationId, admissionId) =>
              admissionSchedulingContextForOrg(dbHandle.db, organizationId, admissionId),
          }),
          // F-234 (#248) — M15's side of the M14 IDG-decision contract (M15 spec §7.7): a
          // `discipline_plan_update` decision opens a draft next version on the named discipline plan and
          // applies its mutations. The M7 parent-problem check is an org-explicit port (a relay tick is not
          // a request, so `CarePlanReader`'s id-keyed reads cannot run here).
          buildM15IdgDecisionConsumer({
            db: dbHandle.db,
            outbox: m15OutboxPublisher,
            activeProblemIds: (organizationId, patientId) =>
              activeProblemIdsForOrg(dbHandle.db, organizationId, patientId),
          }),
          // F-234 (#248) — the return leg: M14 records M15's `m15.idg_decision.applied` acknowledgement.
          buildM14DecisionAppliedConsumer({ db: dbHandle.db }),
          buildM13DocumentBackrefConsumer({ db: dbHandle.db }),
          // F-152 (#248) — the §2.8 D17 medication-reconciliation worksheet, opened from all four of
          // M6's trigger events. The admission siting comes from M6's ORG-EXPLICIT seam (a relay tick
          // is not a request), the same `admissionSchedulingContextForOrg` template as M15's/M16's
          // consumers above.
          buildM13ReconciliationTriggerConsumer({
            db: dbHandle.db,
            outbox: m13OutboxPublisher,
            resolveAdmission: async (organizationId, admissionId) => {
              const ctx = await admissionSchedulingContextForOrg(
                dbHandle.db,
                organizationId,
                admissionId,
              );
              return ctx
                ? {
                    patientId: ctx.patientId,
                    providerEntityId: ctx.providerEntityId,
                    locationId: ctx.locationId,
                  }
                : null;
            },
          }),
          // F-155 (#248) — the §2.5/§2.7 D14 admission-discharge cascade: cancels future pending
          // scheduled doses, flags active comfort-kit deployments for return. Same org-explicit M6
          // seam template as the reconciliation-trigger consumer just above.
          buildM13AdmissionDischargedCascadeConsumer({
            db: dbHandle.db,
            outbox: m13OutboxPublisher,
            resolveAdmission: async (organizationId, admissionId) => {
              const ctx = await admissionSchedulingContextForOrg(
                dbHandle.db,
                organizationId,
                admissionId,
              );
              return ctx ? { patientId: ctx.patientId } : null;
            },
          }),
          // F-166 (#248) — the §2.3 D2 scheduled-dose materializer. Order siting comes from the same
          // org-explicit M6 seam as the two consumers just above; the order's own facts come from a new
          // M12 org-explicit seam (`medicationOrderScheduleContextForOrg`, the F-164
          // `medicationOrderPatientAndDrugForOrg` precedent widened); the order's location timezone
          // resolves through M1's `FoundationSiteReader` (the sanctioned direct-import path for a module
          // that already depends on module 1).
          buildM13MaterializeScheduleConsumer({
            db: dbHandle.db,
            outbox: m13OutboxPublisher,
            orderContext: (organizationId, orderId) =>
              medicationOrderScheduleContextForOrg(dbHandle.db, organizationId, orderId),
            resolveAdmission: async (organizationId, admissionId) => {
              const ctx = await admissionSchedulingContextForOrg(
                dbHandle.db,
                organizationId,
                admissionId,
              );
              return ctx
                ? { providerEntityId: ctx.providerEntityId, locationId: ctx.locationId }
                : null;
            },
            locationTimezone: (organizationId, locationId) =>
              withOrgContext(dbHandle.db, { organizationId, userId: "" }, (tx) =>
                buildFoundationSiteReader().locationTimezone(tx as unknown as DbClient, locationId),
              ),
          }),
          // F-166 (#248) — the order-level scheduled-dose cancellation cascade. Reads only M13's own
          // `scheduled_dose` table (the catalogued payload already carries `effectiveAt`); no cross-module
          // seam needed.
          buildM13CancelFutureScheduleConsumer({ db: dbHandle.db, outbox: m13OutboxPublisher }),
          // F-166 (#248) — M13's §2.5/§2.7 D5 comfort-kit deployment/replenishment/return chain, bound
          // live for the first time. `m21.comfort_kit.deployed_at_patient`'s producer-side defect (a
          // premature/wrong `.returned` emission at return-REQUEST time, not reconcile time) is fixed at
          // its source in `21-supplies/routes/write-service-drizzle.ts`'s `createReturn`, in the same
          // change. See each consumer file's own header for what stayed blocked (a nullable
          // `medicationOrderId` for IPU-floor-stock lines — a real, documented M21 business concept M13
          // has no schema representation for anywhere) and how it was scoped.
          buildM13ComfortKitDeployedConsumer({ db: dbHandle.db, outbox: m13OutboxPublisher }),
          buildM13ComfortKitReplenishedConsumer({ db: dbHandle.db }),
          buildM13ComfortKitReturnedConsumer({ db: dbHandle.db }),
          buildM13ComfortKitReturnReconciliationConsumer({
            db: dbHandle.db,
            outbox: m13OutboxPublisher,
          }),
          buildM21DocumentBackrefConsumer({ db: dbHandle.db }),
          // F-120 (#248) — the OTHER two of the three M11 cascade deciders `consumers/m11-orders.ts` has
          // carried since M21-T04 ("the live outbox binding … land with the §4.6 workers alongside the
          // M21-T05 service layer" — the service layer landed, nothing ever bound them). Both events are
          // ALREADY emitted in production by the M11 discharge cascade (F-102) — every death/discharge on
          // an admission with an open supply_request has been cancelling the M11 order while leaving the
          // DME rental or comfort-kit request standing.
          buildM21SupplyCancellationConsumer({ db: dbHandle.db, outbox: m21OutboxPublisher }),
          // F-232 (#248) — the THIRD decider, `decideSupplyFulfillmentIntake` (§7.1): a signed `dme`/`supply`
          // order (`dme.v2`/`supply.v2`) now opens a `supply_request`, pulling the delivery address through
          // M5's `PatientAddressReader.primaryAddress` at consume time (never on the outbox). `comfort_kit`
          // settles, unbound — see the file header.
          buildM21SupplyFulfillmentIntakeConsumer({ db: dbHandle.db, outbox: m21OutboxPublisher }),
          buildM21OrderDiscontinuedConsumer({ db: dbHandle.db, outbox: m21OutboxPublisher }),
          // F-153 (#248) — M13's §2.5 deployment-ack link (resolved by patient+admission, since the
          // whole point of the ack is that the link does not exist yet) and §2.6 return-required
          // chain-of-custody open (no outbox effect of its own — the return row's own state is the fact).
          buildM21ComfortKitDeploymentAckConsumer({ db: dbHandle.db }),
          buildM21ComfortKitReturnRequiredConsumer({ db: dbHandle.db }),
          // F-161 (#248) — §2.1 comfort-kit replenishment intake, the third of the four
          // `consumers/m13-comfort-kit.ts` deciders. Resolves the per-line pharmacy identity and
          // delivery-address snapshot from M21's own tables (M13's payload carries neither).
          buildM21ComfortKitReplenishmentIntakeConsumer({
            db: dbHandle.db,
            outbox: m21OutboxPublisher,
          }),
          // F-233 (#248) — `m12.medication_order.dispensed_at_pharmacy` (Option B): records "dispensed at T"
          // on the correlated comfort-kit request (by `contents[].medicationOrderId`); creates no dispatch.
          buildM21PharmacyDispenseConsumer({ db: dbHandle.db }),
          // F-172 (#248) — §4.5.1 controlled-substance re-emit, the fourth and last of the
          // `consumers/m13-comfort-kit.ts` deciders. Joins M13's bedside discrepancy signal to M21's
          // dispatch/return custody chain via the `returnId` M13's payload now carries.
          buildM21ComfortKitControlledSubstanceReemitConsumer({
            db: dbHandle.db,
            outbox: m21OutboxPublisher,
          }),
          // F-108 — M27's. Unlike the five clinical ones it stamps THREE columns off one event, resolved
          // from `aggregateType`: M27 fans the ECR file, the Print Image and the supporting-doc bundle out
          // under ONE request event name, so the aggregate type is the only discriminator on the wire —
          // and the pure handler's declared payload named an `artifactKind` M22 does not publish, so a
          // binding written to its stated shape would have no-op'd on every delivery.
          buildM27DocumentBackrefConsumer({ db: dbHandle.db, outbox: m27OutboxPublisher }),
          // F-207 (#248) — the M21 vendor-invoice forward seam (M21 spec §1.1 D16), the 4th cost-basis
          // precedence tier additive to D17's M13 administration ▸ M12 ordered ▸ manual entry chain.
          // No dependsOn edge to 21; both event names read structurally off the wire.
          buildM27VendorInvoiceConsumer({ db: dbHandle.db }),
          // GAP-051 — M33's half. Unlike the four above it does more than stamp a column: a rendered
          // scheduled report settles its occurrence `delivered` and emits the §4.9 fan-out, which is why
          // it composes the package's own decider/applier rather than a one-line UPDATE. The ad-hoc
          // "export now" artifact has no table to stamp and is deliberately not handled — see the file.
          buildM33DocumentBackrefConsumer({
            db: dbHandle.db,
            emitDelivered: ({ organizationId, ...payload }) =>
              withOrgContext(dbHandle.db, { organizationId, userId: "" }, (tx) =>
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
          // same in-process `createX12835Client()` as the routes-mount binding above; the terminology lookup and
          // the M23/M24 claim-match adapters are all reconstructed here (each resolves its seam lazily
          // per call, so a duplicate binding across two composition-root scopes is harmless).
          buildM25EdiReceivedConsumer(
            buildDrizzleM25IngestService(dbHandle.db, {
              client: createX12835Client(),
              onRetryableParseDegraded: (event) =>
                app.log.warn(
                  event,
                  "M25 835 post degraded (retryable); no staged-object reader wired?",
                ),
              outbox: m25OutboxPublisher,
              claims: {
                medicare: buildM23BackedClaimMatchCandidateProvider(),
                medicaid: buildM24BackedClaimMatchCandidateProvider(),
              },
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
                    category: typeof props?.category === "string" ? props.category : "unmapped",
                    plainLanguage: concept.display,
                  };
                },
              },
            }),
          ),
          // GAP-072 — M25 is the declared consumer of `m23.claim.rejected` and
          // `m18.evv.aggregator_rejected`; both factories existed and were tested but were never
          // constructed, so every rejection stayed `pending` (re-deferred each 30 minutes) and the denial
          // worklist was never seeded. Same real M38 CARC lookup as the 835 path; an unmapped code
          // degrades honestly to `unmapped` (never a guessed category).
          ...(() => {
            const denialSeedStore = buildDrizzleDenialSeedStore(dbHandle.db);
            const denialTerminology = {
              async lookup(carcCode: string) {
                const concept = await (
                  getSeam("TerminologyProvider") as {
                    lookup(
                      system: string,
                      code: string,
                    ): Promise<{ properties?: Record<string, unknown> } | null>;
                  }
                ).lookup("carc", carcCode);
                if (!concept) return null;
                const category = concept.properties?.category;
                return { category: typeof category === "string" ? category : "unmapped" };
              },
            };
            return [
              buildM23ClaimRejectedConsumer({
                db: dbHandle.db,
                seedStore: denialSeedStore,
                outbox: m25OutboxPublisher,
                terminology: denialTerminology,
              }),
              buildM18EvvAggregatorRejectedConsumer({
                db: dbHandle.db,
                seedStore: denialSeedStore,
                outbox: m25OutboxPublisher,
                terminology: denialTerminology,
              }),
            ];
          })(),
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
            // Org-scoped read (a relay tick has no app.org_id — the 22P02 that stranded transfer-outs).
            resolveCcn: buildRequiredProviderEntityCcnResolver(dbHandle.db),
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
            // Org-scoped read (a relay tick has no app.org_id — the 22P02 that stranded transfer-outs).
            resolveCcn: buildRequiredProviderEntityCcnResolver(dbHandle.db),
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
          // The 8xC transfer notice — the receiving hospice's filing for a transfer-in (direction `in` of
          // `m6.transfer.created`; the NOTR binding above takes direction `out`). A transfer-in's inherited
          // period is deliberately skipped by the NOE draft (8xA opens an election; 8xC continues one).
          buildM23TransferNoticeDraftConsumer({
            db: dbHandle.db,
            outbox: m23OutboxPublisher,
            resolveTransferIn: async (organizationId, transferEventId) =>
              transferInNoticeContextForOrg(dbHandle.db, organizationId, transferEventId),
            resolveCcn: buildRequiredProviderEntityCcnResolver(dbHandle.db),
            onSkipped: (info) =>
              app.log.info(
                {
                  reason: info.reason,
                  org: info.organizationId,
                  transferEvent: info.transferEventId,
                },
                "M23 transfer notice draft skipped",
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
          // F-153 (#248) — the §4.8 `revalidate.consumer` PRODUCER side: six M6/M8 facts that can
          // re-open a VALIDATING/READY claim's validation, each enqueuing the raw event onto the
          // already-registered `runRevalidateConsumer` worker (only runs when `m23LaunchGateway` is
          // configured, same as every other M23 launch worker).
          ...buildM23RevalidateTriggerConsumers({ enqueue: m23RevalidateEnqueue.port }),
          // F-162 (#248) — the seventh revalidate trigger: m18.evv.late_check_resolved, resolved through
          // M8's new reverse visitId→encounterId seam (encounterIdsForVisitsForOrg), injected as a port
          // per this module's established no-package-import posture for M8 bridges.
          buildM23LateCheckResolvedConsumer({
            resolveEncounterForVisit: {
              forVisits: (orgId, visitIds) =>
                encounterIdsForVisitsForOrg(dbHandle.db, orgId, visitIds),
            },
            enqueue: m23RevalidateEnqueue.port,
          }),
          // F-164 (#248) — M23's last originally-deferred pair: the §11.A/D13 unmapped-CARC occurrence
          // tracker + threshold alert, over the same live M36 `AlertEmitter` seam every other consumer in
          // this array resolves inline (the seam registers earlier in boot, but well after this file's
          // TOP-LEVEL statements run — a `getSeam` call at module-body scope throws "requested before
          // registration"; every other caller in this codebase resolves it here, inside the consumer
          // array, for the same reason).
          buildM23TaxonomyUnmappedCodeObservedConsumer({
            db: dbHandle.db,
            alerts: {
              dispatch: async ({ alertCode, severity, organizationId, payload }) => {
                const emitter = getSeam("AlertEmitter") as {
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
                await emitter.emit(organizationId, {
                  eventType: alertCode,
                  payload,
                  severity,
                  correlationId: cronAlertCorrelationId("m23-taxonomy", alertCode, payload),
                });
              },
            },
          }),
          // F-162 (#248) — M35's first outbox consumer: the §4.12 org-lifecycle-handler over M2's
          // organization activate/suspend/close triggers (3 of D21's 8 exhaustive inbound subscriptions).
          buildM35OrgLifecycleConsumer({ db: dbHandle.db, outbox: m35OutboxPublisher }),
          // F-172 (#248) — the remaining 3 of D21's 8: `m2.session.created` (user-active-period-aggregator)
          // and `m5.patient.{deceased,merged}` (patient-active-period-aggregator), unblocked by the real
          // `pseudonymKeyProvider` built above. Each fails closed per-delivery (dead-letters, never
          // silently pseudonymizes under nothing) when `pseudonymKeyProvider` is the unbound stub.
          buildM35SessionCreatedConsumer({ db: dbHandle.db, keyProvider: pseudonymKeyProvider }),
          buildM35PatientActivePeriodConsumer({
            db: dbHandle.db,
            keyProvider: pseudonymKeyProvider,
          }),
          // F-165 (#248, m24 group) — M29's `m5.patient.deceased` freeze: every still-`pending` `hl7_inbound_proposal`
          // matched to the decedent is expired via the same pure `expireProposal` decider the (also
          // unbuilt) §2.2 SLA sweep would use, with its own distinct `decision_rationale`. Builds only the
          // "freeze what is already staged" half of M29's own spec sentence — the real-time "refuse future
          // post-death A01/A04" half needs a new M5 PatientReader field/seam or a new persistent marker
          // plus match-cascade consultation logic, neither of which exists; see the consumer file header.
          buildM29PatientDeceasedConsumer({ db: dbHandle.db, outbox: m29OutboxPublisher }),
          // F-175 (#248) — the real T08 outbound MLLP dispatch worker: `dispatch-planner.ts`'s own header
          // named this worker's job precisely ("mint the ids + clock, resolve the BAA seam, envelope-
          // encrypt the wire into payload_cipher, do the insert, and dispatch over MLLP") and F-165/F-167
          // both confirmed nothing called it. `getTenantKeyProvider()` is safe to call unconditionally here
          // (the `createHearthnoteCiphers(getTenantKeyProvider())` precedent immediately above this array's
          // sibling consumers) — M34's `validateModule34Seams()` guarantees SOME registration (a real one,
          // or the fail-closed deny-stub) exists by the time any consumer runs; an unconfigured KEK fails
          // closed per-call (`dekForOrg` throws), never at construction. `m29OutboundRateLimiter` is shared
          // with the retry-sweep worker below (constructed once, passed to both) so the per-feed throttle
          // budget is shared across the fresh-dispatch and retry paths.
          buildM29OutboundDispatchConsumer({
            db: dbHandle.db,
            outbox: m29OutboxPublisher,
            keys: getTenantKeyProvider(),
            rateLimiter: m29OutboundRateLimiter,
          }),
        ],
        // GAP-099 — the PLATFORM (`organization_id IS NULL`) binding list. Until now this list did not
        // exist and `pollPlatform()` could only claim a row and defer it, so M29's NPPES sync published
        // `m29.nppes.provider_synced` into a queue with no reachable consumer: every row sat pending on
        // the 30-minute deferred clock forever while M40's canonical went stale. These two appliers were
        // written and unit-tested in M40-T09 and have been waiting on the delivery path ever since.
        platformConsumers: [
          ...buildM29NppesPlatformConsumers({
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
          // F-156 (#248) — M33's §4.10 replica-lag probe (`m33.lag.exceeded`/`.recovered`, emitted with
          // `organizationId: null` since GAP-099 landed) flips M1's shared, NON_ORG_SCOPED `system_status`
          // row. `system_status` carries no RLS, so this needs no org envelope.
          buildM1LagProbeStatusConsumer({ db: dbHandle.db }),
          // F-161 (#248) — M23's §4.8 MAC-portal health probe (`m23.mac_portal.unavailable`/`.recovered`,
          // emitted with `organizationId: null` — a MAC jurisdiction serves many tenants). One
          // `system_status` component PER JURISDICTION, not a platform-wide singleton.
          buildM1MacPortalHealthConsumer({ db: dbHandle.db }),
          // WP 1.1 — a platform-wide offboarding (`m2.user.deactivated`, no org) has no org to end memberships in.
          buildM36AccessRevocationPlatformConsumer(
            realtimeEmitter
              ? {
                  disconnectAccount: (userId) =>
                    realtimeEmitter.disconnectRoom(accountRoom(userId)),
                }
              : {},
          ),
        ],
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
      : listenerProcess
        ? Number(process.env.LISTENER_HEALTH_PORT ?? 3002)
        : Number(process.env.PORT ?? 3000);
  app.log.info(describeClearinghouseBinding(clearinghouseBinding));
  // WP 1.1 / ADR-0054 — the Socket.IO transport. API role only (never the worker or the MLLP listener), opt-in via
  // REALTIME_ENABLED. It attaches to the same HTTP server and so bypasses Fastify's hooks: authentication, the
  // Origin check, staff-only and the idle-timer rule are therefore re-implemented here, not inherited.
  if (realtimeEnabled && role !== "worker" && !listenerProcess) {
    if (!auth || !dbHandle || !queueConnection) {
      app.log.warn(
        "REALTIME_ENABLED is set but auth, the database or Valkey is unavailable; not starting",
      );
    } else {
      const sessionEnforcer = createDbSessionTimeoutEnforcer(dbHandle.db);
      const messagingService = createDbMessagingRouteService(dbHandle.db);
      const pubClient = new Redis({
        ...(queueConnection as RedisOptions),
        maxRetriesPerRequest: null,
      });
      const subClient = pubClient.duplicate();
      pubClient.on("error", () => {});
      subClient.on("error", () => {});
      realtimeRef = startRealtimeServer({
        httpServer: app.server,
        pubClient,
        subClient,
        // Native Socket.IO may omit Origin, but a supplied Origin is checked only against browser
        // HTTP(S) origins. Authentication below remains mandatory in either case.
        trustedOrigins: resolveWebTrustedOrigins(),
        ...(tenantOrigins ? { tenantOrigins } : {}),
        // Behind a trusted proxy the socket address is the proxy: key on the entry that proxy appended, but only when
        // the TCP peer really is one of TRUSTED_PROXY_CIDRS (otherwise the header is the caller's own).
        clientKey: realtimeClientKey(parseTrustedProxies(process.env.TRUSTED_PROXY_CIDRS)),
        log: createRealtimeTelemetry(metricsRegistry, {
          handle: () => realtimeRef,
          log: (event, context) => app.log.info(context, event),
          audit: createRealtimeAuditWriter(dbHandle.db),
          onAuditError: (err) => app.log.error({ err }, "realtime audit write failed"),
        }),
        authenticate: async (headers) => {
          const snap = await getIdentitySession(auth, headers);
          if (!snap || snap.passwordChangeRequired || !snap.activeOrganizationId) return null;
          // A socket is not activity (ADR-0054 item 12): never extend the idle timer.
          const state = await sessionEnforcer.enforce(snap.sessionId, { recordActivity: false });
          if (state !== "active") return null;
          const actor = await getSeam("SessionContextResolver").resolveActor(
            { orgId: snap.activeOrganizationId },
            snap.sessionId,
          );
          // Staff only: portal, auditor and external sessions have no realtime channel (addendum A5).
          if (!actor || actor.sessionClass !== "staff") return null;
          // A suspended/removed membership leaves the session valid but resolves with no membership: refuse it, or the
          // user reconnects straight after the suspend-time disconnect.
          if (!actor.membershipId) return null;
          if (mfaGate) {
            const verdict = await mfaGate.forRoles({
              userId: actor.userId,
              sessionId: snap.sessionId,
              roleKeys: actor.roles,
            });
            if (!verdict.satisfied) return null;
          }
          return {
            userId: snap.userId,
            organizationId: actor.organizationId,
            sessionId: snap.sessionId,
          };
        },
        resolveRooms: async ({ organizationId, userId }) =>
          computeRoomSet({
            userId,
            orgId: organizationId,
            channels: (await messagingService.listChannels(organizationId, userId)).map((c) => ({
              channelId: c.channelId,
              kind: c.kind,
              subjectId: c.subjectId,
            })),
          }),
        stillValid: async ({ sessionId, organizationId }) => {
          if ((await sessionEnforcer.enforce(sessionId, { recordActivity: false })) !== "active")
            return false;
          const actor = await getSeam("SessionContextResolver").resolveActor(
            { orgId: organizationId },
            sessionId,
          );
          return Boolean(actor?.membershipId);
        },
      });
      app.addHook("onClose", async () => {
        await realtimeRef?.close();
        pubClient.disconnect();
        subClient.disconnect();
      });
    }
  }
  if (realtimeEmitterClient) app.addHook("onClose", () => realtimeEmitterClient.quit());
  app.listen({ port, host: "0.0.0.0" }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}

if ((import.meta as { main?: boolean }).main) {
  // Start only when run directly (not when imported by tests/tooling/worker.ts) — see `bootChartWarden`.
  await bootChartWarden((process.env.PROCESS_ROLE as ProcessRole | undefined) ?? "all");
}

/**
 * F-201 (#248) — M11's stuck lab-order recovery, wired over the real ports. The composition root is the only place that
 * may see M11, M29 and M36 together (M11 has no `dependsOn` edge to either): the re-emission is F-182's OWN
 * `resendLabTransmission` (so a sweep and an operator's click share one row lock, one conditional update and one attempt
 * id), the BAA pre-check is M29's own gate, and the alert goes out through the M36 `AlertEmitter` seam. `resend` passes no
 * acting user — the M4 audit trigger records the change with a null actor and the order's auto-retry counters say it was
 * the sweep. Called from both the route mount (the worklist reads) and the worker (the sweeps): the service is stateless.
 */
function buildM11StuckRecovery(
  db: DbClient,
  outbox: Parameters<typeof createDbOrderBackend>[1],
  log?: (event: string, fields: Record<string, unknown>) => void,
) {
  const backend = createDbOrderBackend(
    db,
    outbox,
    buildM11OrmRequestedPorts({
      patient: hl7OrmDemographicsInTx,
      feeds: buildDrizzleOutboundFeedResolver(),
      outboundEvidence: ormOutboundEvidenceForOrder,
    }),
  );
  return createStuckTransmissionRecovery({
    db,
    resend: (organizationId, orderId) => backend.resendLabTransmission(organizationId, "", orderId),
    baaCleared: outboundBaaCleared,
    alerts: getSeam("AlertEmitter") as AlertEmitter,
    feedsForOrders: ormOutboundFeedsForOrders,
    thresholds: heldThresholdsFromEnv(process.env),
    ...(log ? { log } : {}),
  });
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
      /** Optional caller-chosen `outbox_event.id` (see {@link OutboxPublishInput.eventId}). */
      readonly eventId?: string;
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
function parseRedisConnection(redisUrl: string | undefined): ConnectionOptions | undefined {
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
