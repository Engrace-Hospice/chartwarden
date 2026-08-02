import { randomUUID } from "node:crypto";
import { audit } from "@wardenx/audit";
import { sql } from "drizzle-orm";
// @wardenx/backend — Fastify host entry + COMPOSITION ROOT (not in any module codePath, so
// exempt from the module-boundary import rules — it may import every module's init). It builds
// the server, runs the seam/eraser boot gate, and registers each Phase-1 module's real seams
// via `wireModuleSeams` (M1's bootstrap cannot import a downstream module; the composition
// root does, then hands the registration into the boot gate before validateSeams()).
import {
  createDbActorEnrichmentReader,
  createDbAdminMembershipReader,
  createDbEffectivePermissionStore,
  createDbSessionContextStore,
  createIdentityAuth,
  getIdentitySession,
  registerAbacRegistry,
  registerDbEffectivePermissionResolver,
  registerIdentityAuth,
} from "@wardenx/auth";
import type { SessionContextStore } from "@wardenx/auth";
import { type DbClient, createDbClient } from "@wardenx/db";
import type { PlatformBypassAuditor } from "@wardenx/tenancy";
import { DegradedError } from "@wardenx/types";
import type { ConnectionOptions } from "bullmq";
import { createDbIdempotencyStore } from "./bootstrap/plugins/idempotency-store-db";
import {
  assertProductionEnv,
  buildServer,
  createSessionAuthenticate,
  getSeam,
  registerEraser,
} from "./bootstrap/index";
import { buildActiveOrgEnumerator } from "./bootstrap/active-org-enumerator";
import {
  buildOrgProviderEntityLister,
  buildPrimaryProviderEntityResolver,
} from "./bootstrap/provider-entity-resolver";
import {
  type OutboxPublishPort,
  type OutboxTx,
  buildBootOutboxCatalog,
  buildTxOutboxPublisher,
  wireOutboxCatalog,
} from "./bootstrap/outbox-persister";
import {
  mountIdentityRoutes,
  registerIdentityErasers,
  registerIdentitySeams,
} from "./modules/02-identity/index";
import {
  mountAuthorizationRoutes,
  registerAuthorizationAbacPredicates,
} from "./modules/03-authorization/index";
import {
  assertAuditActionCatalog,
  mountAuditRoutes,
  registerAuditErasers,
} from "./modules/04-audit/index";
import {
  mountPatientRoutes,
  registerPatientErasers,
  getPatientCoverageReader,
  registerPatientSeams,
} from "./modules/05-patient/index";
import {
  createInMemoryAdmissionBackend,
  mountAdmissionRoutes,
  registerAdmissionAbacPredicates,
  registerAdmissionErasers,
  registerAdmissionRoutes,
  registerAdmissionSeams,
} from "./modules/06-admission/index";
import {
  createInMemoryCarePlanBackend,
  M7_OUTBOX_EVENTS,
  registerCarePlanAbacPredicates,
  registerCarePlanErasers,
  registerCarePlanRoutes,
  registerCarePlanSeams,
  mountCarePlanRoutes,
} from "./modules/07-care-plan/index";
import {
  createDrizzleEncounterReaderStore,
  createInMemoryEncounterBackend,
  registerEncounterAbacPredicates,
  registerEncounterErasers,
  registerEncounterRoutes,
  registerEncounterSeams,
  mountEncounterRoutes,
} from "./modules/08-encounters/index";
import {
  createInMemoryAssessmentBackend,
  registerAssessmentAbacPredicates,
  registerAssessmentErasers,
  registerAssessmentRoutes,
  registerAssessmentSeams,
  mountAssessmentRoutes,
} from "./modules/09-assessments/index";
import {
  createInMemoryHopeBackend,
  registerHopeAbacPredicates,
  registerHopeErasers,
  registerHopeRoutes,
  registerHopeSeams,
  mountHopeRoutes,
} from "./modules/10-hope/index";
import {
  createInMemoryOrderBackend,
  registerOrderAbacPredicates,
  registerOrderErasers,
  registerOrderRoutes,
  registerOrderSeams,
  mountOrderRoutes,
} from "./modules/11-orders/index";
import {
  createInMemoryDoseSpotBackend,
  registerDoseSpotAbacPredicates,
  registerDoseSpotErasers,
  registerDoseSpotRoutes,
  registerDoseSpotSeams,
  mountDoseSpotRoutes,
} from "./modules/12-dosespot/index";
import {
  createInMemoryEmarBackend,
  registerEmarAbacPredicates,
  registerEmarErasers,
  registerEmarRoutes,
  registerEmarSeams,
  mountEmarRoutes,
} from "./modules/13-emar/index";
import {
  createInMemoryIdgBackend,
  registerIdgAbacPredicates,
  registerIdgErasers,
  registerIdgRoutes,
  registerIdgSeams,
  mountIdgRoutes,
} from "./modules/14-idg/index";
import {
  M15_OUTBOX_EVENTS,
  buildDrizzleDisciplinePlanAbacResolver,
  buildDrizzleM15ReadService,
  buildDrizzleM15WriteService,
  createDrizzleDisciplinePlanEraseStore,
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
  createDrizzleBereavementEraseStore,
  denyStubBereavementAbacResolver,
  mountM16Routes,
  registerBereavementAbacPredicates,
  registerBereavementErasers,
  registerBereavementSeams,
} from "./modules/16-bereavement/index";
import {
  SchedulingRouteService,
  registerSchedulingAbacPredicates,
  registerSchedulingRoutes,
  registerSchedulingSeams,
  mountSchedulingRoutes,
} from "./modules/17-scheduling/index";
import {
  EvvRouteService,
  registerEvvAbacPredicates,
  registerEvvRoutes,
  registerEvvSeams,
  mountEvvRoutes,
} from "./modules/18-evv/index";
import {
  buildDrizzleM19ReadService,
  buildDrizzleM19WriteService,
  buildDrizzleOncallAbacResolver,
  buildDrizzleOncallSeamStore,
  createDrizzleTriageEraseStore,
  denyStubOncallAbacResolver,
  mountM19Routes,
  registerOncallAbacPredicates,
  registerOncallSeams,
  registerTriageErasers,
} from "./modules/19-oncall/index";
import {
  M20_OUTBOX_EVENTS,
  buildDrizzleM20ReadService,
  buildDrizzleM20WriteService,
  buildDrizzleSafetyAbacResolver,
  buildDrizzleSafetySeamStore,
  createDrizzleSafetyEraseStore,
  denyStubSafetyAbacResolver,
  mountM20Routes,
  registerFieldSafetyAbacPredicates,
  registerFieldSafetySeams,
  registerSafetyErasers,
} from "./modules/20-field-safety/index";
import {
  M21_OUTBOX_EVENTS,
  buildDrizzleM21ReadService,
  buildDrizzleM21WriteService,
  buildDrizzleSuppliesAbacResolver,
  buildDrizzleSuppliesSeamStore,
  decideDispatcherEligible,
  denyStubSuppliesAbacResolver,
  mountM21Routes,
  registerSuppliesAbacPredicates,
  bindSupplyRequestCreator,
  registerSuppliesSeams,
  registerSupplyEraser,
} from "./modules/21-supplies/index";
import {
  createInMemoryDocumentBackend,
  createSignedUrlService,
  registerDocumentAbacPredicates,
  registerDocumentErasers,
  registerDocumentRoutes,
  registerDocumentSeams,
  mountDocumentRoutes,
} from "./modules/22-documents/index";
import {
  buildDrizzleM33ExportDrilldownService,
  buildDrizzleM33ReadService,
  buildDrizzleM33WriteService,
  M33_OUTBOX_EVENTS,
  buildM33ReadEnqueue,
  buildM33WorkerDeps,
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
  buildDrizzleM30ReadService,
  buildDrizzleM30WriteService,
  M30_OUTBOX_EVENTS,
  M30_PLATFORM_JOB_ID,
  buildM30RecomputeEnqueue,
  buildM30WorkerDeps,
  mountM30Routes,
  registerM30AbacPredicates,
  registerM30CronWorkers,
  registerM30PublishedSeams,
  registerM30Workers,
  registerQualityErasers,
  scheduleM30Jobs,
  wireM30Tenancy,
} from "./modules/30-quality/index";
// M32 (AI Platform) boot surface — M32-T02's §3.7 destruction contract, M32-T06's §4.4 seam registration
// and M32-T07's HTTP surface: the §4.11 `m32.*` outbox catalog, the six §4.7 ABAC predicate resolvers and
// the §4.1 route mount over the T03/T04/T05 command services + T07's read port. `ai.full` stays OFF.
import {
  M32_OUTBOX_EVENTS,
  M32_PLATFORM_JOB_ID,
  buildDrizzleAiPlatformAbacResolver,
  buildDrizzleM32ReadService,
  createAiPromptRegistry,
  createDrizzleAiCapabilityRegistryStore,
  createDrizzleAiEvaluationRunStore,
  createDrizzleAiHallucinationReportStore,
  createDrizzleAiKillSwitchStore,
  createDrizzleAiProvenanceEraseStore,
  createDrizzleAiPromptTemplateStore,
  createDrizzleAiRoutingOverrideStore,
  createDrizzleAiTenantConsentStore,
  createUnconfiguredAiTokenBudgetResolver,
  createUnresolvableAiPromptArtifactReader,
  createDenyingAiOptInEvidenceResolver,
  denyStubAiPlatformAbacResolver,
  mountM32Routes,
  registerAiPlatformAbacPredicates,
  registerAiPlatformSeams,
  registerAiProvenanceErasers,
  wireM32Tenancy,
} from "./modules/32-ai-platform/index";
// M27 (Cost Report) boot surface — the §4.10 outbox catalog, the §4.7 ABAC resolvers, the §4.1 route mount
// over the Drizzle read/write services, the §3.7 `cost_report_class` eraser, and the §4.8 BullMQ workers
// (the M30 precedent). Worker infra/seam ports stay fail-closed-unbound at boot (RULE 4); the recompute
// enqueue + the live Xero/Gusto + M6/M8 statistics seam binds are P4 follow-ups (jobs/m27-jobs.ts TODO).
import {
  M27_OUTBOX_EVENTS,
  type ProviderEntityResolver as M27ProviderEntityResolver,
  type PatientDaysSeam as M27PatientDaysSeam,
  type ClaimSettlementSeam as M27ClaimSettlementSeam,
  type DrugCostSeam as M27DrugCostSeam,
  buildDrizzleM27ReadService,
  buildDrizzleM27WriteService,
  buildM27AllocationInputs,
  buildM27ValidationContext,
  buildM27WorkerDeps,
  m27CapSeamResolver,
  mountM27Routes,
  registerCostReportErasers,
  registerM27AbacPredicates,
  registerM27PublishedSeams,
  registerM27CronWorkers,
  registerM27Workers,
  scheduleM27Jobs,
} from "./modules/27-cost-report/index";
// M25 (Remittance & Denials) boot surface — the §4.5 outbox catalog, the §4.7 ABAC resolvers
// (`claim_assigned_to_actor`, `appeal_within_deadline`), and the §4.1 route mount over the Drizzle
// read/write services. The write service's transactional outbox publisher + the read service's M38
// terminology lookup stay on their fail-closed defaults at boot (no-op emit / deny-stub lookup) until those
// binds land — a documented follow-up (the M23/M27 deferred-bind posture); routes are fully live otherwise.
import {
  M25_OUTBOX_EVENTS,
  type TerminologyLookupPort,
  buildDrizzleM25ReadService,
  buildDrizzleM25WriteService,
  M25_PLATFORM_JOB_ID,
  type WorkerAlertPort as M25WorkerAlertPort,
  buildM25WorkerDeps,
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
  mountM26Routes,
  registerM26AbacPredicates,
  registerM26PublishedSeams,
  registerCapErasers,
  registerM26CronWorkers,
  scheduleM26Jobs,
} from "./modules/26-cap/index";
// M24 (Billing — Medicaid) boot surface — the §4.11 outbox catalog, the §4.8 ABAC resolvers
// (provider_entity_medicaid_billing_scope / medicaid_claim_in_billing_manager_caseload /
// medicaid_override_role_eligible / regulatory_required_rule_protected_medicaid / rb_arrangement_visible_in_scope
// / state_trading_partner_credential_admin), the §4.1 route mount over the Drizzle read/write services, and the
// §3.7 `medicaid_billing_record` eraser. The write service's `m24.*` transactional outbox publisher binds at
// boot; the §4.3 published-seam registration + the §4.9 per-state-adapter workers + the consumed-reader binds
// are deferred follow-ups (the M26 posture — the adapter wire I/O lands later).
import {
  M24_OUTBOX_EVENTS,
  buildCredentialCipherPort,
  buildDrizzleM24ReadService,
  buildDrizzleM24WriteService,
  mountM24Routes,
  registerM24AbacPredicates,
  registerM24PublishedSeams,
  registerMedicaidErasers,
} from "./modules/24-billing-medicaid/index";
// M23 (Billing — Medicare) boot surface — the §4.10 outbox catalog, the §4.7 ABAC resolvers, the §4.1 route
// mount over the Drizzle read/write services + the boot-time claim-assembly service, the §3.7 `billing_record`
// eraser (registerEraser INJECTED — M23 cannot import the M1 bootstrap registry), and the §4.8 BullMQ workers
// (claim/NOE/NOTR submit[.retry], 999/277CA ack pulls, eligibility refresh, NOE/NOTR window-watch, eligibility
// stale-watch, MAC-portal health, the revalidate consumer). Every worker infra/seam/x12/portal port stays
// fail-closed-unbound at boot (RULE 4); the assembly reader seams + the live MAC/X12 binds are follow-ups.
import {
  M23_OUTBOX_EVENTS,
  buildDrizzleM23ReadService,
  buildDrizzleM23WriteService,
  buildM23BootAssemblyService,
  buildM23WorkerDeps,
  mountM23Routes,
  registerBillingErasers,
  registerM23AbacPredicates,
  registerM23CronWorkers,
  registerM23PublishedSeams,
  registerM23Workers,
  scheduleM23Jobs,
} from "./modules/23-billing-medicare/index";
// The §4.4 / M10-real HOPE consumer interface the M30 worker deps bind (composed from the three live M10
// §D10 readers via `getSeam` in the worker-runner block below).
import type { QualityHopeConsumer } from "@wardenx/quality";
import {
  type BootstrapModule34Deps,
  type TenantPlatformAbacResolver,
  M34_OUTBOX_EVENTS,
  bootstrapModule34,
  buildDrizzlePlatformService,
  buildDrizzleTenantService,
  buildM34WorkerDeps,
  buildPlatformEnqueue,
  buildTenantEnqueue,
  mountTenantPlatformRoutes,
  registerLiveM34Seams,
  registerM34Workers,
  registerSaasTenantPlatformErasers,
  registerTenantPlatformAbacPredicates,
  scheduleM34Jobs,
  validateModule34Seams,
  wireM34Tenancy,
} from "./modules/34-saas-tenant-platform/index";
import {
  createDbMessagingProvider,
  mountMessagingRoutes,
  registerMessagingErasers,
  registerMessagingSeams,
  selectTransactionalEmailTransport,
} from "./modules/36-messaging/index";
import {
  createDbTerminologyStore,
  mountTerminologyRoutes,
  registerTerminologyErasers,
  registerTerminologySeams,
} from "./modules/38-terminology/index";
import {
  createDbConsentStore,
  mountConsentRoutes,
  registerConsentAbacPredicates,
  registerConsentErasers,
  registerConsentSeams,
} from "./modules/39-consent/index";
import {
  createDbBaaStore,
  createDbMdmStore,
  mountMdmRoutes,
  registerMdmErasers,
  registerMdmSeams,
} from "./modules/40-mdm/index";

export { buildServer };
export * from "./bootstrap/index";

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// M6–M14 / M17 / M18 / M22 — THE CLINICAL-CORE ROUTE SCAFFOLD. READ THIS BEFORE YOU BELIEVE A SCREEN.
//
// These twelve modules ship route plugins and a §4.1 route inventory, but NOT ONE of them has a
// Drizzle route service: every `routes/service.ts` exports exactly one backend factory and it is
// `createInMemory*Backend` (M17/M18 hand-construct a class over a seed literal). The `seams/drizzle-
// store.ts` files in M7/M8/M11/M13/M14 are narrow cross-module SEAM readers, not route services.
//
// Mounting them therefore turns ~336 endpoints from 404 into 200-with-an-empty-array over a
// per-process `Map`. That is a UI-development scaffold, and it is NOT the database:
//   • M4's WRITE-AUDIT TRIGGERS NEVER FIRE. They are Postgres triggers; an in-memory mutation touches
//     no table. A signed encounter, an administered controlled substance and a discharge would all
//     commit with NO audit row. (The PHI READ-audit hook still fires — it is a Fastify
//     preSerialization hook — so you get read rows for data that was never written.)
//   • RLS NEVER RUNS. Tenancy on these paths is a JS `organizationId` comparison inside each slice,
//     not a policy. There is no second line of defence behind a missed check.
//   • Every row is lost on restart and invisible to every other replica.
//
// So this is HARD-OFF IN PRODUCTION and cannot be re-enabled by an env var: a clinical record that
// silently evaporates and audits nothing is worse than a 404, which at least tells the truth. Set
// WARDENX_CLINICAL_CORE_SCAFFOLD=0 to opt out in dev too (restoring the 404s).
//
// The backends are constructed ONCE and shared: each module's ABAC resolver MUST be the same instance
// its routes mutate, or the predicate reads a different dataset than the handler.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
export const clinicalCoreScaffoldEnabled =
  process.env.NODE_ENV !== "production" && process.env.WARDENX_CLINICAL_CORE_SCAFFOLD !== "0";

let clinicalCoreBackends: ReturnType<typeof buildClinicalCoreBackends> | undefined;

function buildClinicalCoreBackends() {
  return {
    m6: createInMemoryAdmissionBackend({}),
    m7: createInMemoryCarePlanBackend({}),
    m8: createInMemoryEncounterBackend({}),
    m9: createInMemoryAssessmentBackend({}),
    m10: createInMemoryHopeBackend({}),
    m11: createInMemoryOrderBackend({}),
    m12: createInMemoryDoseSpotBackend({}),
    m13: createInMemoryEmarBackend({}),
    m14: createInMemoryIdgBackend({}),
    m17: new SchedulingRouteService({
      now: () => new Date().toISOString(),
      newId: () => randomUUID(),
    }),
    m18: new EvvRouteService({}),
    m22: createInMemoryDocumentBackend({}),
  };
}

/** Memoized so the ABAC resolvers registered at boot are the SAME instances the routes later mutate. */
function getClinicalCoreBackends(): ReturnType<typeof buildClinicalCoreBackends> {
  clinicalCoreBackends ??= buildClinicalCoreBackends();
  return clinicalCoreBackends;
}

/**
 * Register every Phase-1 producer module's real seams into the M1 registry. Passed to
 * buildServer() as `registerModuleSeams`, it runs inside bootSeams() after M1's wireSeams()
 * and before validateSeams(), so the real seams stand over the deny-stubs (§3.18).
 */
export function wireModuleSeams(
  deps: { sessionContextStore?: SessionContextStore; db?: DbClient } = {},
): void {
  // AUTH-T05b: pass the DB-backed SessionContextStore in production (composition root supplies it when
  // a DB client is present); the slice/tests fall back to M2's in-memory store.
  registerIdentitySeams({ sessions: deps.sessionContextStore, db: deps.db }); // M2 — SessionContextResolver + AuditorSessionMinter + TenantOrgCreationProvider (§4.7 / M34 §7.1)
  // M3 — register the live RBAC resolver (DB-backed effective permissions) when a DB client is present,
  // turning `requirePermission` from fail-closed to real resolution. Slice/tests keep the default.
  if (deps.db) registerDbEffectivePermissionResolver(deps.db);
  // M3 — register M3's own `step_up_recent` ABAC predicate (§4.2.1 — the step-up freshness gate every
  // `requireStepUp` route resolves through). It reads M2's SessionContextResolver seam (registered just
  // above) lazily at request time, so registration order only requires the seam present by first request.
  registerAuthorizationAbacPredicates();
  // M38 — TerminologyProvider (§4.5). Production backs it with the Drizzle store over the real M38
  // tables (FB-T01); slice/tests keep the in-memory default.
  registerTerminologySeams(deps.db ? { store: createDbTerminologyStore(deps.db) } : {});
  // M36 — AlertEmitter (§4.6) always; the DB-backed MessagingProvider (§4.6 channel/message CRUD with
  // per-tenant DEK encryption) registers over the deny-stub when a DB client is present (FB-T05).
  registerMessagingSeams(deps.db ? { provider: createDbMessagingProvider(deps.db) } : {});
  // M40 — MdmEntityProvider (§4.5) + BaaStatusProvider (§4.6 §7.7 as-of gate). Production backs both
  // seams with Drizzle stores over the real M40 tables (FB-T02); slice/tests keep the in-memory default.
  registerMdmSeams(
    deps.db ? { store: createDbMdmStore(deps.db), baaStore: createDbBaaStore(deps.db) } : {},
  );
  // M5 — CaseloadProvider (§4.1, + caseload_membership predicate); PatientReader/Mutator land T08. The
  // §3.4 PatientCoverageReader registers over the real `patient_payer` rows when a db is present — the
  // read M23/M24 resolve a claim's billed payer from (without it, billing degrades fail-closed).
  registerPatientSeams(deps.db ? { db: deps.db } : {});
  // M6 — the six §4.7 admission reader seams (election/CTI/F2F/LOC/status/census). Slice/tests keep the
  // in-memory store; the Drizzle-backed store lands with M6's routes/repos (M6-T06+). PLUS the §4.11
  // DeathDischargeReader the M30 measure-recompute worker consumes for the HVLDL denominator — registered over
  // a DEDICATED Drizzle reader when a db is present (it self-scopes each call, HARD RULE 3); slice/tests
  // without a db keep it on the fail-closed deny-stub.
  registerAdmissionSeams(deps.db ? { db: deps.db } : {});
  // M7 — the §7.8 CarePlanReader (encounter-relevance picker + the 5-/15-day overdue sign-gate M8
  // consumes). Slice/tests keep the in-memory store + real clock; the Drizzle-backed store lands with
  // M7's routes/repos (M7-T05+).
  registerCarePlanSeams();
  // M8 — the four §4.7 owned seams (billable/signed/mileage/creator). M8 also CONSUMES M7's CarePlanReader
  // (registered just above) for the encounter authoring picker + the overdue sign-gate. Slice/tests keep
  // the in-memory store; the Drizzle-backed store lands with M8's routes/repos (M8-T09+).
  // M8 — back the §4.7 reader seams with the Drizzle store when a db is present (#107): the live
  // SignedEncountersReader.signedEncountersForPatientSince over the real encounter table (the prior in-memory
  // default returned empty, zeroing M30's HVLDL numerator). Slice/tests keep the in-memory store.
  registerEncounterSeams(deps.db ? { store: createDrizzleEncounterReaderStore(deps.db) } : {});
  // M9 — the two §4.7 / D7 owned seams (LatestAssessmentProvider + ScaleSeriesProvider) M7/M10/M14/M28/M32
  // consume for latest-scale reads + trend series/deltas. Slice/tests keep the in-memory store; the
  // Drizzle-backed store lands with M9's routes/repos (M9-T05+).
  registerAssessmentSeams();
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
  // QapiProjectProvider / ComplianceStatusProvider / SecurityRiskAssessmentReader) so M22's quality report,
  // M28's FHIR MeasureReport/AdverseEvent, M33's dashboards and M34's FY-rollover tenant gate reach M30's
  // read surfaces via getSeam. Before this M30 was outbox-only across boundaries. The per-PE aggregation
  // grain binds to the same M40 provider-entity resolver the M30 workers use; UNBOUND ⇒ empty, never a
  // fabricated cross-provider rollup. The M1 fail-closed deny-stubs stand when no db is present.
  registerM30PublishedSeams(deps.db, {
    providerEntities: deps.db ? buildOrgProviderEntityLister(deps.db) : undefined,
  });
  // M27 — register the PUBLISHED CostReportFilingStatusReader (M27's FIRST M1 publish) so M30's CoP
  // 418.310 failure-to-file indicator resolves the live filing posture. The other six declared M27 seams
  // stay unregistered until they have a consumer (the M24 posture).
  registerM27PublishedSeams(deps.db);
  // M11 — the two §2.8 D14 / §4.3 owned seams (OrderSignatureProvider — the polymorphic clinical-signature
  // WRITE primitive M12 routes medication-order signatures through, D4 — + OrderProvider — the read-side
  // counterpart M14/M23/M30/M7 consume). Slice/tests keep the in-memory store; the Drizzle-backed store lands
  // with M11's routes/repos (M11-T06+).
  registerOrderSeams();
  // M12 — the two §2.10 D17 owned READ seams (MedicationOrderProvider — the medication-order read path M13
  // (eMAR administration context) / M14 / M19 / M28 (FHIR) / M30 / M31 (portal) / M33 consume — + RefillInboxProvider
  // — the refill-inbox read path the prescriber UI + M19/M33 consume). Slice/tests keep the in-memory store;
  // the Drizzle-backed store lands with M12's routes/repos (M12-T08+).
  registerDoseSpotSeams();
  // M13 — the two §2.12 D16 owned READ seams (MedicationAdministrationProvider — the administration read path M14
  // (IDG "administrations since last meeting") / M28 (FHIR) / M30 (PRN-effectiveness / missed-dose /
  // comfort-kit-timeliness measures) / M31 (portal summary) / M33 (dashboards) / M37 (IPU IV-pump overlay)
  // consume — + ReconciliationProvider — the reconciliation-worksheet read path M14/M30 consume). Slice/tests
  // keep the in-memory store; the Drizzle-backed store lands with M13's routes/repos (M13-T08+).
  registerEmarSeams();
  // M14 — the three §4.8 owned READ seams (IdgPacketProvider — the packet-snapshot + M22 render handshake M22
  // (minutes / packet PDF) + M33 consume — + IdgDecisionProvider — the decision read path M30
  // (decision-to-careplan-update latency) + M33 consume — + IdgScheduleProvider — the meeting-schedule +
  // 15-day-cadence read path M28 (FHIR) + M30 (cadence-adherence) + M33 consume). Slice/tests keep the
  // in-memory store; the Drizzle-backed store lands with M14's routes/repos (M14-T05+).
  registerIdgSeams();
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
  registerDisciplinePlanSeams();
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
  registerBereavementSeams();
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
  registerSuppliesSeams(deps.db ? { store: buildDrizzleSuppliesSeamStore(deps.db) } : {});
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
  if (deps.db) registerOncallSeams({ store: buildDrizzleOncallSeamStore(deps.db) });
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
  // process-local and is bound by the consumer that fills it (T06's `m18.evv.gps_spoof_suspected`
  // subscriber); absent, the board shows no spoof badge, which is the documented cost of holding that
  // suspicion in memory (a MISSING caveat, never a missing alert).
  if (deps.db) registerFieldSafetySeams({ store: buildDrizzleSafetySeamStore(deps.db) });
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
  // M17 — the four §4.3 owned READ seams (VisitReader — the visit read path M8 (encounter-authoring context,
  // which CLOSES M8's visit-seeding inert consumer M8 D9) / M18 (EVV geofence target) / M14 (IDG since-meeting)
  // consume — + VisitAssignmentReader — the assignment read path M5 (the §4.5 D11 caseload-contribution
  // projection) / M19 (on-call triage) / M20 (field-safety live-awareness) consume — + PortalVisitReader — the
  // M31 portal upcoming-visit read path (lay-language, scrubbed) — + VisitMetricsProvider — the M30/M33
  // productivity + quality measures read path). Slice/tests keep the in-memory store; the Drizzle-backed store
  // lands with M17's routes/repos (M17-T07+).
  registerSchedulingSeams();
  // M18 — the six §4.3 owned reader seams. `EvvBracketResolver` is published over M8's EXISTING `resolveBracket`
  // contract — this registration CLOSES M8's `encounter.period` forward seam (M8 D9), replacing its fail-closed
  // deny-stub with the real resolver. The other five (EvvComplianceReader — M23/M24 billing gate + M30 HQRP —
  // EvvAggregatorReferenceReader — M24 claim / M25 denial — EvvLocationProvider — M20 field-safety live-awareness,
  // the only coordinate-bearing seam, D10 — EvvMetricsProvider — M30/M33 dashboards — EvvVerificationProvider — M31
  // portal arrival surface) stand over their deny-stubs. Slice/tests keep the in-memory store; the Drizzle-backed
  // store lands with M18's routes/repos (M18-T06+).
  registerEvvSeams();
  // M22 — the two §4.3 published seams: `DocumentRenderer` (the §7.2 W2 render-from-typed-payload handshake
  // M5/M6/M8/M11/M12/M13/M14/M16/M17/M18/M23/M39 consume to materialize their PDFs) + `DocumentStorageProvider`
  // (the §11 D1 per-tenant object store: presign-download + version-aware destroy). Registering the renderer
  // CLOSES the forward-seam deny-stub M39 consent's Wave-C render path + every source module's m22-document-
  // backref consumer awaited. Slice/tests keep the in-memory store + in-memory object store; the Drizzle +
  // MinIO adapters land with M22's routes/worker (a later M22 task).
  registerDocumentSeams();
  // M39 — ConsentEvaluator (§4.3, the disclosure/redaction gate). Production backs it with the Drizzle
  // store over the real M39 consent tables (FB-T03); slice/tests keep the in-memory default.
  registerConsentSeams(deps.db ? { store: createDbConsentStore(deps.db) } : {});
  registerConsentAbacPredicates(); // M39 — the 11 §4.8 ABAC predicate resolvers (resolve via the seam)
  // M7 — the five §6 predicate resolvers. `caseload_or_scope` is the SHARED patient-scope predicate that
  // M9-M15/M19-M26/M34 bind BY NAME, so it must be registered even while M7's own routes are unmounted:
  // M3's registry denies on an unregistered name, which made every consumer's guard a permanent 403
  // (GET /api/v1/triage-calls being the visible one). Registered after the M5 `CaseloadProvider` / M39
  // `ConsentEvaluator` seams above, as the registrar's contract requires. M7 has no Drizzle resolver yet
  // (its routes are unmounted, so no plan/problem/version row is reachable) — the deny-stub resolver keeps
  // the `planId`-keyed arms and the M7-owned predicates fail-closed, while the `patientId` and collection
  // arms resolve through the live caseload seam. Swap for a Drizzle resolver when M7's routes mount.
  // M7's predicates MUST be registered here rather than beside its route mount: bootSeams() runs before
  // registerModuleRoutes(), and every registrar skips a name the registry already holds, so a later
  // re-registration is silently ignored. When the clinical-core scaffold is on, hand it the SAME backend
  // instance the routes get, so the `planId`-keyed arms resolve against the store the handlers mutate
  // instead of a permanent null. NOTE this registrar also owns `caseload_or_scope`, the shared predicate
  // M9–M15/M19–M26/M34 bind BY NAME — its `patientId`/collection arms resolve through the live M5
  // CaseloadProvider either way, so consumers keep the behaviour they had.
  registerCarePlanAbacPredicates({
    resolver: clinicalCoreScaffoldEnabled
      ? getClinicalCoreBackends().m7.resolver
      : {
          loadPlan: async () => null,
          loadProblem: async () => null,
          loadVersion: async () => null,
        },
  });
  // M33 — the two §4.7 ABAC predicate resolvers (`reportable_scope` D8 cross-cutting read scope +
  // `dashboard_visibility` §4.7.2 saved-view ladder). Defaults to the deny-stub resolver until P2C binds
  // the real M2 `SupervisorReader` / M5 `CaseloadProvider` reach + the Drizzle `report_view` facts — with
  // the deny-stub every actor collapses to `self` scope (fail-closed), which is the correct posture.
  registerM33AbacPredicates();
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
    registerLiveM34Seams({ db: deps.db, auditBypass: m34PlatformBypassAuditor });
  } else {
    bootstrapModule34(SLICE_MODULE_34_SEAM_DEPS);
  }
  validateModule34Seams();
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
 * This binds M4's audit helper over the platform tx the bypass runs on: it writes one `platform.bypass_invoked`
 * row (organizationId null — a cross-tenant action has no single org; actorKind `system`; the caller's jobId +
 * reason in context) at the event's own severity, atomically with the platform work. If the write fails it
 * propagates, so the cross-tenant read fails rather than serving an UNAUDITED bypass (the fail-closed posture).
 */
export const m34PlatformBypassAuditor: PlatformBypassAuditor<DbClient> = async (tx, event) => {
  await audit(
    tx,
    {
      organizationId: null,
      userId: null,
      actorKind: "system",
      correlationId: `platform-bypass:${event.jobId}:${randomUUID()}`,
    },
    {
      eventType: "platform.bypass_invoked",
      resourceKind: "tenant",
      outcome: "success",
      severity: event.severity,
      context: { jobId: event.jobId, reason: event.reason },
    },
  );
};

/**
 * Fail-closed slice `TenantKeyProvider` (D5) so `validateModule34Seams()` passes at boot before the real
 * KMS-backed key provider lands. Every method THROWS — the platform has no live PHI ciphertext to key in the
 * slice/local boot, so a resolve is a programming error, not a silent fail-open. This satisfies the mandatory
 * D5 registration without handing out a real key.
 *
 * TODO(Phase 2D — TenantKeyProvider adapter): replace with M34's key-ring service backed by the real KEK/KMS
 * (the §3.3 tenant-key-destruction-log + per-tenant DEK wrap/unwrap). It is the ONLY seam that hard-fails boot;
 * the lifecycle/onboarding/support providers + the M35 subscription-entitlement reader bind their real adapters
 * in the same phase (until then they fail-closed via their typed resolvers).
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
export function wireModuleErasers(deps: { db?: DbClient } = {}): void {
  registerIdentityErasers(); // M2 — `identity` data class (two_factor/passkey + invitations)
  registerAuditErasers(); // M4-T08 — `audit_event` data class (legal-hold + Part 2 lifetime aware)
  registerTerminologyErasers(); // M38-T10 — `terminology_tenant_extensions` (D8 tenant offboarding)
  registerMessagingErasers(); // M36-T10 — `messages` (D9 tenant offboarding; DEK crypto-erase §7.8)
  registerMdmErasers(); // M40-T10 — `mdm_tenant_overlays` (D7 tenant offboarding; canonical untouched)
  registerPatientErasers(); // M5-T12 — `clinical_record` (patient-subtree destruction-cert callback; D7/D8)
  registerConsentErasers(); // M39-T10 — `consent` (subtree erase; legal-hold + 42 CFR Part 2 lifetime refusal)
  registerAdmissionErasers(); // M6-T12 — `admission_record` (admission-subtree destruction-cert callback; D7/D8)
  registerCarePlanErasers(); // M7-T09 — `care_plan_record` (care-plan-subtree destruction-cert callback; D7/D8)
  registerEncounterErasers(); // M8-T12 — `encounter_record` (encounter-subtree destruction-cert callback; DEK crypto-erase §3.6; D7/D8)
  registerAssessmentErasers(); // M9-T07 — `clinical_assessment` (assessment-subtree destruction-cert callback; §8.4; D7/D8)
  registerHopeErasers(); // M10-T08 — `hope_record` (HOPE-timepoint-subtree destruction-cert callback; CMS 10-year retention block; §8.4; D7/D8)
  registerOrderErasers(); // M11-T08 — `order_record` (orders-subtree destruction-cert callback; partition-drop; §7.7; D12; D7/D8)
  registerDoseSpotErasers(); // M12-T09 — `medication_order_record` (prescribing-subtree destruction-cert callback; partition-drop; §7.7; D15; D7/D8)
  registerEmarErasers(); // M13-T10 — `emar_record` (eMAR-subtree destruction-cert callback; partition-drop; §7.7; D7/D8)
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
  registerIdgErasers(); // M14-T07 — `idg_record` (patient-scoped packet/decision/action-item/agenda destruction-cert callback; meetings/minutes survive; §8.4)
  registerDocumentErasers(); // M22-T10 — `documents` (document/intake-subtree destruction-cert callback; DEK crypto-erase §8.6; legal-hold + Part 2 skip; D9/D12)
  registerSaasTenantPlatformErasers(); // M34 — `saas_tenant_platform_class` (tenant-offboarding control-plane cleanup; subjectId=org; D6/§8.4)
  registerReportingErasers(); // M33 — `reporting_class` (tenant-offboarding operational-row cleanup; subjectId=org; report_drilldown_audit destruction-blocked; D6/§8.4)
  registerQualityErasers(); // M30 — `quality_class` (tenant-offboarding operational-row cleanup; subjectId=org; compliance-class survey evidence destruction-blocked; D6/§8.4)
  registerCostReportErasers(); // M27 — `cost_report_class` (tenant-offboarding operational-config cleanup; subjectId=org; submitted/accepted cost reports are survey-evidence, destruction-gated; §3.7/§8.4)
  registerBillingErasers({ registerEraser }); // M23 — `billing_record` (per-PATIENT destruction-cert callback; in-flight/surveyor-hold guard; MAC secret crypto-shred is the org-destruction path; §3.7/§8.4). registerEraser is INJECTED (M23 may not import the M1 bootstrap registry); in-memory slice store until the Drizzle BillingEraseStore binds.
  registerRemittanceErasers({ registerEraser }); // M25 — `remittance` (per-PATIENT PR-ledger destruction-cert callback; the line/adjustment/remark history rolls off via the M4 partition manager, not per-patient; §3.7/§8.4). registerEraser INJECTED; in-memory slice store until the Drizzle PR-ledger destruction store binds (the M23 posture).
  registerMedicaidErasers({ registerEraser }); // M24 — `medicaid_billing_record` (per-PATIENT redact-to-shred destruction-cert callback; PHI free-text + KMS ciphers on the patient's rb/eligibility rows are shredded, the FK chain survives; the join-only submission/override + the trading-partner secret crypto-shred follow the claim chain / org-destruction path; §3.7/§8.4). registerEraser INJECTED; in-memory slice store until the privileged Drizzle redaction store binds (the M26 posture). Distinct from M23's `billing_record` (single-keyed registry — M24 must not clobber M23).
  registerCapErasers({ registerEraser }); // M26 — `cap` (per-PATIENT redact-to-sentinel destruction-cert callback; D14 — aggregates survive right-to-erasure so CMS-side cap reconciliation stays reproducible; §3.7/§8.4). registerEraser INJECTED; in-memory slice store until the privileged Drizzle redaction store binds (the M25 posture).
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
  // Phase-1 data-class owners append here as they land.
}

// Start only when run directly (not when imported by tests/tooling).
// `import.meta.main` is a Bun runtime flag; cast keeps tsc happy without bun-types.
if ((import.meta as { main?: boolean }).main) {
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
  // audit C1 — RLS is the tenancy control, and a role with BYPASSRLS makes every policy decorative.
  // The migrator now gates that grant on WARDENX_DEV_BYPASSRLS + non-production, but a grant applied
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
        `the database role this process connects as (current_user) has BYPASSRLS: ` +
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
  // M1-T10 — assemble the FULL transactional-outbox catalog (M1 folded in by the helper + the passed
  // M30/M33/M34 contributions) and build the catalog-validating tx publisher. The publisher is threaded
  // into the M30 + M33 write services below so their §4.10 `m30.*`/`m33.*` emits persist into
  // `outbox_event` on the mutation's own tx (transactional outbox). M34 is registered in the catalog for
  // completeness but is intentionally NOT bound (its emit payloads are non-conformant — zero regression).
  // A duplicate `eventName` across contributions fails boot here (OutboxEventCollisionError — fail-closed).
  const bootOutboxCatalog = buildBootOutboxCatalog([
    // M7L-T02 — the `m7.*` care-plan catalog. REQUIRED for the write lifecycle's outbox emits to
    // validate: the bound `m7OutboxPublisher` (below) runs every emit through this catalog, and an
    // unlisted event name throws `unknown_event` and rolls back the caller's write.
    M7_OUTBOX_EVENTS,
    M15_OUTBOX_EVENTS,
    M16_OUTBOX_EVENTS,
    // M21-T04 — the §4.5.2 `m21.*` catalog. Registered for the dispatcher's payload validation; the
    // per-module publisher binds with the §4.6 workers + the M21-T05 service layer (the M34 precedent —
    // catalogued now, bound when there is a mutation to bind it to).
    M21_OUTBOX_EVENTS,
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
  ]);
  const txOutboxPublisher = buildTxOutboxPublisher(bootOutboxCatalog);
  // Per-module adapters that pin `callerModule` (the module-scoped `WriteOutboxPort` omits it; the
  // dispatcher's namespace check requires it). Each forwards the caller's open tx + envelope to the shared
  // publisher. M30/M33/M34 — M34's lifecycle outbox now binds too (#107; its emit is gated to the conformant
  // `m34.tenant.provisioned` event, so no mutation rolls back).
  const m6OutboxPublisher = bindCallerModule(txOutboxPublisher, "m6");
  const m7OutboxPublisher = bindCallerModule(txOutboxPublisher, "m7");
  const m15OutboxPublisher = bindCallerModule(txOutboxPublisher, "m15");
  const m16OutboxPublisher = bindCallerModule(txOutboxPublisher, "m16");
  const m19OutboxPublisher = bindCallerModule(txOutboxPublisher, "m19");
  const m20OutboxPublisher = bindCallerModule(txOutboxPublisher, "m20");
  const m21OutboxPublisher = bindCallerModule(txOutboxPublisher, "m21");
  const m23OutboxPublisher = bindCallerModule(txOutboxPublisher, "m23");
  const m24OutboxPublisher = bindCallerModule(txOutboxPublisher, "m24");
  const m25OutboxPublisher = bindCallerModule(txOutboxPublisher, "m25");
  const m26OutboxPublisher = bindCallerModule(txOutboxPublisher, "m26");
  const m27OutboxPublisher = bindCallerModule(txOutboxPublisher, "m27");
  // M24 §8.7 — the trading-partner secret cipher port. Built once at boot so a missing/short KEK surfaces
  // here, not on the first tenant write; left undefined when no key is configured, which makes credential
  // WRITES fail closed while every other M24 route keeps working (production requires the key via env.ts).
  const m24CredentialCipher = process.env.M24_CREDENTIAL_ENCRYPTION_KEY
    ? buildCredentialCipherPort()
    : undefined;
  // M24 → M5 §3.4 — the coverage read claim assembly + eligibility resolve a billed payer from. Resolved
  // through getSeam at CALL time (not boot), so registration order does not matter and an unregistered
  // reader denies loudly at the deny-stub rather than silently reporting "no coverage".
  const m24CoverageResolver = {
    async activeMedicaidCoverage(q: { organizationId: string; patientId: string; onDate: string }) {
      const found = await getPatientCoverageReader().activeCoverageOfKind({
        organizationId: q.organizationId,
        patientId: q.patientId,
        coverageKind: "medicaid",
        onDate: q.onDate,
      });
      return found
        ? { id: found.id, payerId: found.payerId, subscriberId: found.subscriberId }
        : null;
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
  const auth = dbHandle
    ? createIdentityAuth(dbHandle.db as Parameters<typeof createIdentityAuth>[0], {
        emailTransport,
      })
    : undefined;
  const authenticate = auth
    ? createSessionAuthenticate({
        getSnapshot: (request) => getIdentitySession(auth, request.raw.headers),
        getResolver: () => getSeam("SessionContextResolver"),
      })
    : undefined;
  const app = buildServer({
    db: dbHandle?.db,
    authenticate,
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
          mountAuthorizationRoutes(app, dbHandle.db); // M3 — role catalog + grants on real stores
          // M2 — member roster on the real MembershipRepository; isAdmin via the M3 admin reader.
          mountIdentityRoutes(app, dbHandle.db, createDbAdminMembershipReader(dbHandle.db));
          mountAuditRoutes(app, dbHandle.db); // M4 — audit-log search on the real Drizzle AuditQuery
          mountPatientRoutes(app, dbHandle.db); // M5 — patient census/chart READS on the real patient table
          mountAdmissionRoutes(app, dbHandle.db, m6OutboxPublisher); // M6 — reads + the T02 referral/admission write lifecycle over Drizzle+RLS, m6.* transactional outbox
          // Clinical core (M7–M14, M17, M18, M22) — reads mounted over the real Drizzle route services under
          // RLS, replacing the retired in-memory scaffold. Writes fail-closed 501 until each module's write
          // lifecycle lands. See each module's `*-route-service-db.ts`.
          mountCarePlanRoutes(app, dbHandle.db, m7OutboxPublisher); // M7 — reads + the T02 write lifecycle over Drizzle+RLS, m7.* transactional outbox
          mountEncounterRoutes(app, dbHandle.db); // M8 reads
          mountAssessmentRoutes(app, dbHandle.db); // M9 reads
          mountHopeRoutes(app, dbHandle.db); // M10 reads
          mountOrderRoutes(app, dbHandle.db); // M11 reads
          mountDoseSpotRoutes(app, dbHandle.db); // M12 reads
          mountEmarRoutes(app, dbHandle.db); // M13 reads
          mountIdgRoutes(app, dbHandle.db); // M14 reads
          mountSchedulingRoutes(app, dbHandle.db); // M17 reads
          mountEvvRoutes(app, dbHandle.db); // M18 reads
          mountDocumentRoutes(app, dbHandle.db); // M22 reads
          mountTerminologyRoutes(app, dbHandle.db); // M38 — terminology read surface + tenant value-set extensions (FB-T01)
          mountMdmRoutes(app, dbHandle.db); // M40 — MDM entity directory + overlay/BAA + platform-ops (FB-T02)
          mountConsentRoutes(app, dbHandle.db); // M39 — consent catalog/records/decision-audit reads (FB-T03)
          mountMessagingRoutes(app, dbHandle.db); // M36 — channel/thread/alert-inbox/prefs reads (FB-T04; writes → FB-T05)
          // M34 (Phase 2D) — mount the platform-ops + tenant-scoped surfaces over the DRIZZLE route services
          // (RLS-scoped reads under withPlatformContext/withOrgContext; commands enqueue the §4.3 queue job
          // through the BullMQ producer). The platform queue producer + the tenant queue producer are the
          // SAME Valkey connection the workers run on. The platform service's cross-tenant reads require the
          // M4 bypass auditor (currently fail-closed typed-TODO), so the platform surface 5xxs until that
          // lands; the tenant surface is fully live (its deps — org-pooled db + tenant queue producer + clock
          // — are all bound). Both fall back to the in-memory slice when no DB client is present (tests).
          const m34PlatformEnqueue = buildPlatformEnqueue(queueConnection);
          const m34TenantEnqueue = buildTenantEnqueue(queueConnection);
          mountTenantPlatformRoutes(app, dbHandle.db, {
            platform: buildDrizzlePlatformService({
              platformDb: dbHandle.db,
              enqueue: m34PlatformEnqueue.enqueue,
              auditBypass: m34PlatformBypassAuditor,
              outbox: m34OutboxPublisher,
            }),
            tenant: buildDrizzleTenantService({
              db: dbHandle.db,
              enqueue: m34TenantEnqueue.enqueue,
            }),
          });
          // M33 (Phase 2C) — mount the Reporting READ + WRITE + EXPORT/DRILLDOWN surfaces over the DRIZZLE
          // route services. Reads run under withReportSession (replica-over-primary, RLS-scoped, read-only,
          // tiered statement_timeout); writes run under withOrgContext on the primary. The MV-admin command
          // routes enqueue the on-PRIMARY `report.mv_refresh` job through the SAME Valkey connection the
          // workers run on. Deny-stub-safe infra ports (tile/export SQL executor, M22 render outbox, the
          // per-tenant DEK encrypt, the cron-parser adapter) forward-seam or fail closed until they bind.
          const m33ReadEnqueue = buildM33ReadEnqueue(queueConnection);
          mountM33ReadRoutes(
            app,
            buildDrizzleM33ReadService({ db: dbHandle.db, enqueue: m33ReadEnqueue.enqueue })
              .service,
          );
          // M33 — bind the catalog-validating tx outbox publisher (callerModule `m33`) so the §4.10
          // `m33.report_definition.published` / `report_view.shared_org` / `report_schedule.created`
          // emits persist into `outbox_event` on the mutation's own withOrgContext tx (was unbound = no-op).
          mountM33WriteRoutes(
            app,
            buildDrizzleM33WriteService({ db: dbHandle.db, outbox: m33OutboxPublisher }).service,
          );
          mountM33ExportDrilldownRoutes(
            app,
            buildDrizzleM33ExportDrilldownService({ db: dbHandle.db }).service,
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
          // unit of work. The §4.8 recompute enqueue is left on its safe no-op default (the refresh/validate/
          // allocate routes still succeed; the BullMQ producer-adapter binds in P4 — m27-jobs.ts TODO).
          mountM27Routes(app, {
            readService: buildDrizzleM27ReadService(dbHandle.db),
            writeService: buildDrizzleM27WriteService(dbHandle.db, {
              outbox: m27OutboxPublisher,
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
            ): Promise<{ display: string; properties?: Record<string, unknown> } | null>;
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
          mountM25Routes(app, {
            readService: buildDrizzleM25ReadService(dbHandle.db, m25Terminology),
            writeService: buildDrizzleM25WriteService(dbHandle.db, m25OutboxPublisher),
          });
          // M26 (Cap Management) — mount the §4.1 route plugins over the Drizzle READ + WRITE services; the
          // §4.10 `m26.cap.*` transactional outbox publisher binds here (events persist on the mutation's tx).
          mountM26Routes(app, {
            readService: buildDrizzleM26ReadService(dbHandle.db),
            writeService: buildDrizzleM26WriteService(dbHandle.db, m26OutboxPublisher),
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
            writeService: buildDrizzleM16WriteService(dbHandle.db, m16ReadService, {
              outbox: m16OutboxPublisher,
            }),
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
                  if (typeof provider.isActiveEntity !== "function") return false;
                  return await provider.isActiveEntity(organizationId, "dme_vendor", vendorId);
                } catch {
                  return false;
                }
              },
            });
          mountM21Routes(app, { readService: m21ReadService, writeService: m21WriteService });
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
            writeService: buildDrizzleM20WriteService(dbHandle.db, m20ReadService, {
              outbox: m20OutboxPublisher,
            }),
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
              consent: createDrizzleAiTenantConsentStore({ db: dbHandle.db, userId: "" }),
              // W4.1's evidence resolver stays DENYING: the BAA / ZDR / clinical-reviewer checks are
              // three upstream seams nothing binds yet, and a default that answered "resolved" would
              // make the wave's most consequential consent gate a no-op indistinguishable from a
              // working one (governance/service.ts's header).
              evidence: createDenyingAiOptInEvidenceResolver(),
              evaluations: createDrizzleAiEvaluationRunStore(m32SafetyStoreDeps),
            },
            safety: {
              killSwitches: createDrizzleAiKillSwitchStore(m32SafetyStoreDeps),
              reports: createDrizzleAiHallucinationReportStore({ db: dbHandle.db, userId: "" }),
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
            routing: createDrizzleAiRoutingOverrideStore({ db: dbHandle.db, userId: "" }),
            cipher: null,
            promptRegistry: m32PromptRegistry,
          });

        }
      : undefined,
    registerModuleSeams: () =>
      wireModuleSeams({
        sessionContextStore: dbHandle
          ? createDbSessionContextStore(dbHandle.db, createDbActorEnrichmentReader(dbHandle.db))
          : undefined,
        db: dbHandle?.db,
      }),
    registerModuleErasers: () => wireModuleErasers({ db: dbHandle?.db }),
  });
  if (dbHandle && auth) {
    registerIdentityAuth(app, auth); // AUTH-T02: mount /api/auth/* (needs BETTER_AUTH_SECRET/URL in prod)
    app.addHook("onClose", () => dbHandle.close());
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

  // ── worker-runner section (the M4-T11 BullMQ worker-construction precedent) ──────────────────────────
  // Construct the §4.3 M34 BullMQ Workers + the four cron-schedule Queue producers, and tear them down on
  // app close. Guarded by a Valkey connection (constructing a Worker opens the connection — never at import,
  // never in tests). When REDIS_URL is unset the workers are NOT constructed (the host still boots; the
  // command routes' enqueue ports already fail closed without a connection). The M4 audit workers
  // (registerAuditWorkers/scheduleAuditJobs) stay deferred here until their production AuditJobAdapters have
  // a boot accessor — they are the SAME construction shape and slot in beside the M34 block when bound.
  if (dbHandle && queueConnection) {
    const m34Workers = registerM34Workers(
      buildM34WorkerDeps({ connection: queueConnection, db: dbHandle.db }),
    );
    app.addHook("onClose", async () => {
      await Promise.all(m34Workers.map((w) => w.close()));
    });
    // Register the repeatable cron schedules and their close hook BEFORE app.listen() — awaiting here (the
    // boot block is top-level, so top-level await is legal) so the `onClose` hook is added while the
    // instance is still pre-listen. The previous `.then()` ran the addHook on a later microtask, after
    // listen() had already started, which Fastify rejects (FST_ERR_INSTANCE_ALREADY_LISTENING).
    try {
      const scheduleQueues = await scheduleM34Jobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(scheduleQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M34 cron-schedule registration failed");
    }
    app.log.info(
      { queues: m34Workers.length },
      "M34 §4.3 BullMQ workers constructed (worker ports bind their M1/M4/M22/M36 seams as those accessors land)",
    );

    // ── M33 §4.8 reporting workers + cron schedules (the same worker-runner shape) ──────────────────────
    // Construct the §4.8 BullMQ Workers (mv_refresh / scheduled_run / export_render / drilldown_audit_flush /
    // lag_probe) + the two repeatable cron schedules (the 30s lag probe + the nightly MV-refresh tick). The
    // worker ports bind their bindable adapters (the M33 repos + the on-PRIMARY REFRESH / lag sample) and
    // fail closed on the still-missing cross-module infra (outbox dispatcher / envelope-DEK / replica session).
    const m33Workers = registerM33Workers(
      buildM33WorkerDeps({ connection: queueConnection, db: dbHandle.db }),
    );
    app.addHook("onClose", async () => {
      await Promise.all(m33Workers.map((w) => w.close()));
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
    const m30WorkerDeps = buildM30WorkerDeps({
      connection: queueConnection,
      db: dbHandle.db,
      hopeProvider: m30HopeConsumer,
      activeOrgs: m30ActiveOrgs,
      deathDischargeReader: m30DeathDischargeReader,
      signedEncounters: m30SignedEncounters,
    });
    const m30Workers = [...registerM30Workers(m30WorkerDeps), ...registerM30CronWorkers(m30WorkerDeps)];
    app.addHook("onClose", async () => {
      await Promise.all(m30Workers.map((w) => w.close()));
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
    app.log.info({ queues: m30Workers.length }, "M30 §4.8 BullMQ HQRP/quality workers constructed");
    // ── M27 §4.8 Cost-Report workers + the filing-deadline cron (same worker-runner shape) ──────────────
    // buildM27WorkerDeps binds only the connection + db; every infra/seam port stays fail-closed-unbound at
    // boot (RULE 4 — the typed thunks in m27-jobs.ts throw only when a JOB RUNS, so boot stays green). The
    // live binds (transactional outbox, M1 DEK, Xero/Gusto pull seams, M6/M8 statistics seams, the M2
    // active-org enumerator for the filing-deadline cron fan-out, the M36 alert router) are P4 follow-ups.
    const m27WorkerDeps = buildM27WorkerDeps({
      connection: queueConnection,
      db: dbHandle.db,
      // M26's CapAccrualReader is registered live above (registerM26PublishedSeams) — flag the cap provider
      // bound so the cost-report cap rules evaluate against the live aggregate (per-org availability still
      // comes from the cap-context resolver, which fail-closes when an org has no cap period). D13.
      capProviderBound: true,
      // The §11.B ValidationContext shaper — reads M27's materialized state + the live M26 cap / M40 MAC
      // jurisdiction and assembles the typed context every validation rule evaluates against (the M30
      // buildM30WorkerDeps({ deathDischargeReader: getSeam(...) }) precedent). M23-gated rules SKIP (unbound).
      validationContext: buildM27ValidationContext({
        capResolver: m27CapSeamResolver,
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
    });
    const m27Workers = [...registerM27Workers(m27WorkerDeps), ...registerM27CronWorkers(m27WorkerDeps)];
    app.addHook("onClose", async () => {
      await Promise.all(m27Workers.map((w) => w.close()));
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
    // ── M23 §4.8 Billing workers (claim/NOE/NOTR submit[.retry], eligibility refresh, validation-run,
    // revalidate consumer) + the cron consumers (999/277CA ack pulls, NOE/NOTR window-watch, eligibility
    // stale-watch, MAC-portal health) — same worker-runner shape. buildM23WorkerDeps binds only the
    // connection + db; every infra/seam/x12/portal port stays fail-closed-unbound at boot (RULE 4 — the typed
    // thunks in m23-jobs.ts throw only when a JOB RUNS, so boot stays green). The live binds (transactional
    // outbox, x12-837-client generation, MAC-portal HTTP, HETS eligibility, the M2 active-org / MAC-jurisdiction
    // enumerators for the cron fan-out, the validation-runner → claim-validation-service, the M36 alert router)
    // are follow-ups.
    const m23WorkerDeps = buildM23WorkerDeps({
      connection: queueConnection,
      db: dbHandle.db,
    });
    const m23Workers = [...registerM23Workers(m23WorkerDeps), ...registerM23CronWorkers(m23WorkerDeps)];
    app.addHook("onClose", async () => {
      await Promise.all(m23Workers.map((w) => w.close()));
    });
    try {
      const m23ScheduleQueues = await scheduleM23Jobs(queueConnection);
      app.addHook("onClose", async () => {
        await Promise.all(m23ScheduleQueues.map((q) => q.close()));
      });
    } catch (err) {
      app.log.error(err, "M23 cron-schedule registration failed");
    }
    app.log.info({ queues: m23Workers.length }, "M23 §4.8 BullMQ billing workers constructed");
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
      emit(orgId: string, input: { eventType: string; payload: Record<string, unknown>; severity: string; correlationId: string }): Promise<unknown>;
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
    // watchdog). Constructed over the same Valkey connection + db; the M2 active-org enumerator + the M36
    // alert router stay on their fail-closed/no-op defaults until bound (a cron tick fails closed, never at
    // import — the M25 deferred-bind posture). Idempotent recompute/close via the §2.6 unique constraints.
    const m26Workers = registerM26CronWorkers({ connection: queueConnection, db: dbHandle.db });
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
  }

  const port = Number(process.env.PORT ?? 3000);
  app.listen({ port, host: "0.0.0.0" }).catch((err) => {
    app.log.error(err);
    process.exit(1);
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
      readonly organizationId: string;
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
