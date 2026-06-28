import { randomUUID } from "node:crypto";
import { audit } from "@wardenx/audit";
// @wardenx/backend — Fastify host entry + COMPOSITION ROOT (not in any module codePath, so
// exempt from the module-boundary import rules — it may import every module's init). It builds
// the server, runs the seam/eraser boot gate, and registers each Phase-1 module's real seams
// via `wireModuleSeams` (M1's bootstrap cannot import a downstream module; the composition
// root does, then hands the registration into the boot gate before validateSeams()).
import {
  createDbActorEnrichmentReader,
  createDbAdminMembershipReader,
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
import type { ConnectionOptions } from "bullmq";
import {
  assertProductionEnv,
  buildServer,
  createSessionAuthenticate,
  getSeam,
} from "./bootstrap/index";
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
  registerPatientSeams,
} from "./modules/05-patient/index";
import { registerAdmissionErasers, registerAdmissionSeams } from "./modules/06-admission/index";
import { registerCarePlanErasers, registerCarePlanSeams } from "./modules/07-care-plan/index";
import { registerEncounterErasers, registerEncounterSeams } from "./modules/08-encounters/index";
import { registerAssessmentErasers, registerAssessmentSeams } from "./modules/09-assessments/index";
import { registerHopeErasers, registerHopeSeams } from "./modules/10-hope/index";
import { registerOrderErasers, registerOrderSeams } from "./modules/11-orders/index";
import { registerDoseSpotErasers, registerDoseSpotSeams } from "./modules/12-dosespot/index";
import { registerEmarErasers, registerEmarSeams } from "./modules/13-emar/index";
import { registerIdgErasers, registerIdgSeams } from "./modules/14-idg/index";
import { registerSchedulingSeams } from "./modules/17-scheduling/index";
import { registerEvvSeams } from "./modules/18-evv/index";
import { registerDocumentErasers, registerDocumentSeams } from "./modules/22-documents/index";
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
  scheduleM33Jobs,
  wireM33Tenancy,
} from "./modules/33-reporting/index";
import {
  buildDrizzleM30ReadService,
  buildDrizzleM30WriteService,
  M30_OUTBOX_EVENTS,
  buildM30RecomputeEnqueue,
  buildM30WorkerDeps,
  mountM30Routes,
  registerM30AbacPredicates,
  registerM30CronWorkers,
  registerM30Workers,
  registerQualityErasers,
  scheduleM30Jobs,
  wireM30Tenancy,
} from "./modules/30-quality/index";
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
  registerPatientSeams(); // M5 — CaseloadProvider (§4.1, + caseload_membership predicate); PatientReader/Mutator land T08
  // M6 — the six §4.7 admission reader seams (election/CTI/F2F/LOC/status/census). Slice/tests keep the
  // in-memory store; the Drizzle-backed store lands with M6's routes/repos (M6-T06+).
  registerAdmissionSeams();
  // M7 — the §7.8 CarePlanReader (encounter-relevance picker + the 5-/15-day overdue sign-gate M8
  // consumes). Slice/tests keep the in-memory store + real clock; the Drizzle-backed store lands with
  // M7's routes/repos (M7-T05+).
  registerCarePlanSeams();
  // M8 — the four §4.7 owned seams (billable/signed/mileage/creator). M8 also CONSUMES M7's CarePlanReader
  // (registered just above) for the encounter authoring picker + the overdue sign-gate. Slice/tests keep
  // the in-memory store; the Drizzle-backed store lands with M8's routes/repos (M8-T09+).
  registerEncounterSeams();
  // M9 — the two §4.7 / D7 owned seams (LatestAssessmentProvider + ScaleSeriesProvider) M7/M10/M14/M28/M32
  // consume for latest-scale reads + trend series/deltas. Slice/tests keep the in-memory store; the
  // Drizzle-backed store lands with M9's routes/repos (M9-T05+).
  registerAssessmentSeams();
  // M10 — the three §2 / D10 owned seams (HopeTimepointProvider + HopeJ2051Provider + HopeSubmissionProvider)
  // M14/M22/M30/M32 consume for open HOPE windows, J2051 trigger/SFV obligations, and per-PE submission
  // status. Slice/tests keep the in-memory store; the Drizzle-backed store lands with M10's routes/repos
  // (M10-T06+).
  registerHopeSeams();
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
export function wireModuleErasers(): void {
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
  registerIdgErasers(); // M14-T07 — `idg_record` (patient-scoped packet/decision/action-item/agenda destruction-cert callback; meetings/minutes survive; §8.4)
  registerDocumentErasers(); // M22-T10 — `documents` (document/intake-subtree destruction-cert callback; DEK crypto-erase §8.6; legal-hold + Part 2 skip; D9/D12)
  registerSaasTenantPlatformErasers(); // M34 — `saas_tenant_platform_class` (tenant-offboarding control-plane cleanup; subjectId=org; D6/§8.4)
  registerReportingErasers(); // M33 — `reporting_class` (tenant-offboarding operational-row cleanup; subjectId=org; report_drilldown_audit destruction-blocked; D6/§8.4)
  registerQualityErasers(); // M30 — `quality_class` (tenant-offboarding operational-row cleanup; subjectId=org; compliance-class survey evidence destruction-blocked; D6/§8.4)
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
    M30_OUTBOX_EVENTS,
    M33_OUTBOX_EVENTS,
    M34_OUTBOX_EVENTS,
  ]);
  const txOutboxPublisher = buildTxOutboxPublisher(bootOutboxCatalog);
  // Per-module adapters that pin `callerModule` (the module-scoped `WriteOutboxPort` omits it; the
  // dispatcher's namespace check requires it). Each forwards the caller's open tx + envelope to the shared
  // publisher. M30 and M33 ONLY — M34's port stays unbound.
  const m30OutboxPublisher = bindCallerModule(txOutboxPublisher, "m30");
  const m33OutboxPublisher = bindCallerModule(txOutboxPublisher, "m33");
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
            }),
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
    registerModuleErasers: wireModuleErasers,
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
    // The §4.4 / M10-real HOPE consumer: M30 needs org-wide rollups (timepoint-completion / submission
    // posture / open-SFV count) but M10 publishes PER-ENTITY readers (HopeTimepointProvider /
    // HopeSubmissionProvider / HopeJ2051Provider). The live seams are resolved lazily here (so a missing M10
    // surface fails fast at run time, never at boot) and held; the org-wide projection over them needs a
    // patient/admission enumerator M30 has no seam for yet, so each rollup is fail-closed until that lands —
    // and the recompute worker never reaches `hope` until `registrations` + `resolveInput` are bound anyway.
    const m30HopeConsumer: QualityHopeConsumer = {
      async timepointCompletionRollup() {
        void getSeam("HopeTimepointProvider"); // LIVE M10 seam (RULE 4) — held; org-wide projection deferred
        throw new Error(
          "M30 hope.timepointCompletionRollup: M10 HopeTimepointProvider is per-entity; the org-wide rollup needs a patient enumerator seam not yet wired (fail-closed)",
        );
      },
      async submissionPostureRollup() {
        void getSeam("HopeSubmissionProvider"); // LIVE M10 seam (RULE 4) — held; org-wide projection deferred
        throw new Error(
          "M30 hope.submissionPostureRollup: M10 HopeSubmissionProvider is per-PE; the org-wide rollup needs a provider-entity enumerator seam not yet wired (fail-closed)",
        );
      },
      async openSfvObligationCount() {
        void getSeam("HopeJ2051Provider"); // LIVE M10 seam (RULE 4) — held; org-wide projection deferred
        throw new Error(
          "M30 hope.openSfvObligationCount: M10 HopeJ2051Provider is per-patient; the org-wide count needs a patient enumerator seam not yet wired (fail-closed)",
        );
      },
    };
    const m30WorkerDeps = buildM30WorkerDeps({
      connection: queueConnection,
      db: dbHandle.db,
      hopeProvider: m30HopeConsumer,
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
