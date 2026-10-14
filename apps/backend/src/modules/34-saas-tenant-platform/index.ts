// apps/backend/src/modules/34-saas-tenant-platform — M34 SaaS Tenant Platform module root.
//
// The platform control plane: tenant lifecycle + onboarding state machine, per-tenant DEK lifecycle /
// cryptographic shred, DSAR & tenant-export fulfilment, platform-ops support sessions (tenant-consented
// break-glass), and the platform-tenant BAA register + feature-flag admin UI (§1.1). The pure domain
// (seams / repositories / services / state machines + M34's own `TenantExportShard`) lives in
// `@wardenx/saas-tenant-platform`; this backend module is the Fastify-side wiring root — it re-exports
// the §4.5 permission keys M34 contributes to M3, the §4.6 ABAC predicates M34 owns, the §4.9 outbox
// event catalog, and the seam boot wiring (`bootstrapModule34` / `validateSeams`). Mirrors the M22
// barrel: this file exports the registration surfaces; the composition root invokes them in the boot
// gate (`wireModuleSeams` / the permission mirror-row merge / `registerTenantPlatformAbacPredicates`).
//
// Phase boundary (§0): Phase 1 (schema + migrations) + Phase 2A/2B (seams/repos/lifecycle + perms/ABAC/
// events/alert-rules) are DONE. Phase 2C (this phase) mounts the §4.1–4.2 platform/tenant/public route
// inventory behind `withPlatformContext`/`withOrgContext` on the §4.5 keys + the §4.6 ABAC chain
// (`mountTenantPlatformRoutes` at the foot of this file). The LIVE BullMQ worker construction + binding
// every worker port to its real M1/M2/M4/M22/M36 adapter (the command routes only ENQUEUE today) is the
// SEPARATE Phase-2D follow-up — see the typed TODOs in routes/*/service.ts + seam-bootstrap.ts.

// §4.5 — the forty-one permission keys M34 contributes to M3's catalog (the auth-package mirror-row
// projector consumes `M34_CONTRIBUTED_PERMISSIONS`; the route layer gates on these keys, Phase 2C).
export {
  type M34ContributedPermissionKey,
  M34_CONTRIBUTED_PERMISSIONS,
  M34_PERMISSION_KEYS,
} from "./permission-keys";

// §4.6 — the eight ABAC predicate resolvers M34 owns + registers into M3's named-predicate registry.
// `registerTenantPlatformAbacPredicates` is invoked at boot (after the M5 `CaseloadProvider` seam is
// registered) by the composition root, idempotently (single-owner registry; the M22 precedent).
export {
  type FeatureFlagFacts,
  type OnboardingTaskFacts,
  type SupportConsentGrantFacts,
  type TenantPlatformAbacDeps,
  type TenantPlatformAbacResolver,
  M34_ABAC_PREDICATES,
  buildTenantPlatformAbacPredicates,
  registerTenantPlatformAbacPredicates,
} from "./abac-predicates";
export { buildDrizzleTenantPlatformAbacResolver } from "./abac-resolver-drizzle";
export { buildFeatureFlagKillSwitchPorts } from "./feature-flag-kill-switch-ports";

// §4.9 — M34's outbox event catalog (the eighteen typed `m34.*` alert payloads). Merged into the
// platform outbox-event catalog by the composition root; the dispatcher validates each publish against
// the declared `payloadSchema` + `declaredConsumers`.
export { M34_OUTBOX_EVENTS } from "./events-by-m34";

// §4.6 — the seam boot wiring. M34's seams are PACKAGE-OWNED (the D5 `TenantKeyProvider` interface is
// imported by M1's envelope helper FROM `@wardenx/saas-tenant-platform`, so the live-impl registry
// lives there, not in the M1 registry). The composition root calls
// `bootstrapModule34({ tenantKeyProvider, … })` inside the boot gate, then `validateSeams()` (which
// THROWS if the mandatory `TenantKeyProvider` is missing, D5) — both re-exported here so the M34 wiring
// site is one import.
export {
  type BootstrapModule34Deps,
  M34SeamError,
  TenantKeyProviderUnregistered,
  bootstrapModule34,
  getTenantExportShard,
  getTenantKeyProvider,
  getTenantLifecycleProvider,
  getTenantOnboardingProvider,
  getTenantSubscriptionEntitlementReader,
  getTenantSupportSessionProvider,
  listTenantExportShards,
  registerTenantExportShard,
  getTenantOrgCreationProvider,
  setTenantKeyProvider,
  setTenantLifecycleProvider,
  setTenantOnboardingProvider,
  setTenantOrgCreationProvider,
  setTenantSubscriptionEntitlementReader,
  setTenantSupportSessionProvider,
  validateSeams as validateModule34Seams,
} from "@wardenx/saas-tenant-platform";

// §2.5 r2 / §7.1 step 3 — the forward `TenantOrgCreationProvider` seam (M2 implements it later; deny-stub
// today). Re-exported so the M2 registration site + the provision-worker consumer have one import.
export type {
  TenantOrgCreationIntent,
  TenantOrgCreationProvider,
  TenantOrgCreationResult,
} from "@wardenx/saas-tenant-platform";
export { denyStubTenantOrgCreationProvider } from "@wardenx/saas-tenant-platform";

// Phase 2D — bind the PACKAGE-OWNED seams (lifecycle / onboarding / support-session + the MANDATORY D5
// `TenantKeyProvider`) to their real Drizzle-backed implementations over the §3 repositories. The
// composition root calls `registerM34SeamProviders(deps)` from `wireModuleSeams()` BEFORE
// `validateModule34Seams()` — replacing the boot `SLICE_MODULE_34_SEAM_DEPS` deny-stubs.
export {
  type KekUnwrapPort,
  type M34SeamRegistrationDeps,
  type RunInOrgContext,
  type RunInPlatformContext,
  TenantKeyDestroyed,
  TenantKeyMissing,
  TenantKeyVersionMissing,
  registerM34SeamProviders,
} from "./seam-registration";

// §3.8 — M34's own `TenantExportShard` (the inverse-fan-out self-shard) + its store port. The export
// worker (Phase 2D) registers this via `registerTenantExportShard` alongside every other module's shard.
export {
  type M34ExportShardStore,
  type M34ExportTableRows,
  M34_EXPORT_TABLES,
  M34_MODULE_KEY,
  createInMemoryM34ExportShardStore,
  createTenantExportShardForM34,
} from "@wardenx/saas-tenant-platform";

// Phase 2D — the LIVE composition glue: the seam-provider registration over real repos/tenancy runners,
// the Drizzle-backed route services, the §4.3 queue producers (EnqueuePort), and the worker deps. The
// composition root imports these to bind M34's real dependencies (see apps/backend/src/index.ts).
export {
  M34_PLATFORM_JOB_ID,
  M34InfraPortUnbound,
  assertM34JobCapability,
  buildDrizzlePlatformService,
  buildDrizzleTenantService,
  buildM34WorkerDeps,
  enableM34JobCapability,
  buildPlatformEnqueue,
  buildTenantEnqueue,
  registerLiveM34Seams,
  wireM34Tenancy,
} from "./wiring";

// Phase 2D — the LIVE BullMQ worker construction + the four cron-schedule producers (the §4.3 jobs). The
// composition root calls these from a worker-runner section (the M4-T11 `registerAuditWorkers` precedent),
// guarded by a Valkey connection.
export {
  type M34WorkerDeps,
  M34WorkerPortUnbound,
  buildM34WorkerPorts,
  registerM34DekRotateWorker,
  registerM34DsarExportWorker,
  registerM34ProvisionWorker,
  registerM34ShredWorker,
  registerM34TenantExportWorker,
  scheduleM34Jobs,
} from "./jobs/saas-jobs";
// GAP-163 — the nightly bundle-expiry reaper (worker + its own schedule).
export {
  registerM34BundleExpiryWorker,
  scheduleM34BundleExpiryJob,
} from "./jobs/bundle-expiry-worker";
// GAP-163 - the BAA radar, the support-session close sweep and the onboarding advance worker.
export {
  describeM34SweepSchedules,
  registerM34BaaExpiryWorker,
  registerM34OnboardingAdvanceWorker,
  registerM34SupportSessionCloseWorker,
  scheduleM34PlatformSweepJobs,
} from "./jobs/platform-sweeps-worker";

export {
  buildM34ProvisionQueue,
  buildM34ProvisionStartedConsumer,
} from "./outbox-consumers/provision-started";

export {
  type M34ProvisionGateway,
  createM34ProvisionGateway,
  m34ProvisionGatewayConfigFromEnv,
} from "./provision-gateway";

// §8.4 / D6 — the `saas_tenant_platform_class` data eraser (tenant-offboarding control-plane cleanup).
// The composition root registers `registerSaasTenantPlatformErasers` over the Phase-0 deny-stub (the same
// `registerModuleErasers` hook M5/M6/M22/M36/M40 use). The pure eraseFn lives in the package; this backend
// wrapper adapts it to the M1 `DataEraser` contract.
export {
  type DrizzleSaasTenantPlatformEraseDeps,
  type SaasTenantPlatformEraserDeps,
  createDrizzleSaasTenantPlatformEraseStore,
  createSaasTenantPlatformEraser,
  registerSaasTenantPlatformErasers,
} from "./erasers/saas-tenant-platform-eraser";

// §4.1 — the platform-ops tenant-lifecycle route surface (tenants / tenant-invitations / key-ring /
// onboarding-templates), behind `requirePermission` on the §4.5 keys + `requireAbac` on
// `tenant_lifecycle_platform_ops` + §6/D10 `requireStepUp` on the command routes. The READ/LIST routes
// (which the Phase-3 platform-ops screens consume) are fully live over the injected route service; the
// lifecycle-command routes ENQUEUE the §4.3 worker job (the live BullMQ worker construction is Phase 2D —
// see routes/platform/service.ts). The composition root calls `mountTenantPlatformRoutes` when a DB
// client is present (the M36 `mountMessagingRoutes` precedent).
export {
  type EnqueuePort,
  type TenantPlatformRouteSeed,
  type TenantPlatformRouteService,
  createInMemoryTenantPlatformBackend,
  registerBaaRegisterRoutes,
  registerFeatureFlagAdminRoutes,
  registerOnboardingTemplateRoutes,
  registerSignupIntentRoutes,
  registerSupportSessionRoutes,
  registerTenantExportApprovalRoutes,
  registerTenantInvitationRoutes,
  registerTenantKeyRingRoutes,
  registerTenantPlatformRoutes,
} from "./routes/platform/index";

// §4.1 — the TENANT-scoped route surface (support-consent-grants / dsar-export-jobs / tenant-export-jobs /
// onboarding-tasks / baa), behind `requirePermission` on the §4.5 keys + the §4.6 ABAC chain + `withOrgContext`
// (the tenant's own org, M2 `staff` session class). READ/LIST routes are live over the injected service; the
// command routes enqueue the §4.3 worker job. The Phase-3 admin/onboarding screens consume the READ surface.
export {
  type TenantRouteService,
  type TenantRoutesDeps,
  createInMemoryTenantBackend,
  registerTenantTenantRoutes,
} from "./routes/tenant/index";

// §4.1 — the PUBLIC (session-less, pre-organization) self-serve signup surface, gated 503 SIGNUP_DISABLED
// behind the `m34.self_serve_signup` feature flag (default OFF for the platform; the M22 doclens 503 precedent).
export {
  type PublicSignupRouteDeps,
  type SignupIntentRouteService,
  registerPublicSignupRoutes,
} from "./routes/public/signup-intents";

import type { DbClient } from "@wardenx/db";
import { WardenXError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import {
  type TenantPlatformRouteService as _TenantPlatformRouteService,
  createInMemoryTenantPlatformBackend as _createInMemoryTenantPlatformBackend,
  registerBaaRegisterRoutes as _registerBaaRegisterRoutes,
  registerFeatureFlagAdminRoutes as _registerFeatureFlagAdminRoutes,
  registerOnboardingTemplateRoutes as _registerOnboardingTemplateRoutes,
  registerSignupIntentRoutes as _registerSignupIntentRoutes,
  registerSupportSessionRoutes as _registerSupportSessionRoutes,
  registerTenantExportApprovalRoutes as _registerTenantExportApprovalRoutes,
  registerTenantInvitationRoutes as _registerTenantInvitationRoutes,
  registerTenantKeyRingRoutes as _registerTenantKeyRingRoutes,
  registerTenantPlatformRoutes as _registerTenantPlatformRoutes,
} from "./routes/platform/index";
import {
  type RateLimiter as _PublicSignupRateLimiter,
  type SignupIntentRouteService as _SignupIntentRouteService,
  registerPublicSignupRoutes as _registerPublicSignupRoutes,
} from "./routes/public/signup-intents";
import {
  type TenantRouteService as _TenantRouteService,
  createInMemoryTenantBackend as _createInMemoryTenantBackend,
  registerTenantTenantRoutes as _registerTenantTenantRoutes,
} from "./routes/tenant/index";

/**
 * Fail-closed `SignupIntentRouteService` for the public self-serve signup routes. Every method throws
 * `503 SIGNUP_DISABLED` — but it is NEVER reached: the public routes' `requireSignupEnabled` preHandler
 * already 503s when the `m34.self_serve_signup` flag is OFF (the Phase-1 platform default), so the
 * deny-default `SelfServeSignupGate` short-circuits before the service runs. This keeps the public surface
 * MOUNTED (so the routes exist + 503 cleanly) without binding the Drizzle/M2-createUser adapter yet.
 * TODO(Phase 2D): replace with the Drizzle adapter over `SignupIntentRepository` (writes under
 * `withPlatformContext`) + the M2 createUser/first-`org_admin` helper, gated by M1's platform-global flag.
 */
const SLICE_M34_SIGNUP_SERVICE: _SignupIntentRouteService = {
  async createIntent() {
    throw new WardenXError("SIGNUP_DISABLED", "self-serve signup is not enabled", 503);
  },
  async verifyEmail() {
    throw new WardenXError("SIGNUP_DISABLED", "self-serve signup is not enabled", 503);
  },
  async acceptInvitation() {
    throw new WardenXError("SIGNUP_DISABLED", "self-serve signup is not enabled", 503);
  },
};

/**
 * Mount EVERY M34 REST route surface (§4.1) on a server — invoked by the composition root when a DB client
 * is present. Three surfaces:
 *   - PLATFORM-OPS (nine plugins: tenants / invitations / key-ring / onboarding-templates / support-sessions
 *     / signup-intents / baa-register / feature-flags-admin / tenant-export-approval) behind
 *     `withPlatformContext` (M1 @wardenx/tenancy — the separately-pooled, RLS-bypass, AUDITED cross-tenant
 *     platform read path, F03/F09);
 *   - TENANT-scoped (five plugins, support-consent-grants / dsar-export-jobs / tenant-export-jobs /
 *     onboarding-tasks / baa) behind `withOrgContext` (the tenant's own org);
 *   - PUBLIC (the session-less self-serve signup surface, gated 503 behind `m34.self_serve_signup`).
 *
 * READ/LIST routes are fully live over the injected route services (the Phase-3 screens consume them); the
 * command routes enqueue the §4.3 worker job through the injected `EnqueuePort`. Phase 2D: the composition
 * root passes the Drizzle-backed `platformService`/`tenantService` (built by `buildDrizzlePlatformService`
 * / `buildDrizzleTenantService` in wiring.ts) so the route plugins run over real RLS-scoped reads; when no
 * services are injected (tests / no-db boot) this falls back to the in-memory slice (the DTOs match the
 * prod shape). The §4.6 ABAC predicates are registered separately at boot via
 * `registerTenantPlatformAbacPredicates`.
 */
import { registerPlatformOpsRoutes } from "./routes/platform/ops-routes";
import {
  type PlatformOpsService,
  createInMemoryPlatformOpsService,
} from "./routes/platform/ops-service";
import { registerTenantAccountFlagsRoutes } from "./routes/tenant/account-flags-routes";
import {
  type TenantAccountFlagsService,
  createInMemoryTenantAccountFlagsService,
} from "./routes/tenant/account-flags-service";

export function mountTenantPlatformRoutes(
  app: FastifyInstance,
  db: DbClient,
  services?: {
    platform?: { service: _TenantPlatformRouteService };
    tenant?: { service: _TenantRouteService };
    /** GAP-164 - cross-tenant DSAR list + onboarding read/skip (absent => in-memory slice). */
    platformOps?: { service: PlatformOpsService };
    /** GAP-164 - tenant account + feature-flag read/write (absent => in-memory slice). */
    tenantAccountFlags?: { service: TenantAccountFlagsService };
    public?: {
      service?: _SignupIntentRouteService;
      /** AC-05 — §22.1's 5/IP/hour limiter. Absent ⇒ `createAllowAllRateLimiter()`, i.e. UNLIMITED,
       *  which is what the composition root left it as: the port existed and nothing ever filled it. */
      rateLimiter?: _PublicSignupRateLimiter;
    };
  },
): void {
  void db; // the Drizzle services already hold the platform/org-pooled handles (services.* below).

  // ── platform-ops surface (withPlatformContext; F03/F09 audited cross-tenant reads) ──
  // Drizzle-backed when the composition root injects it; the in-memory slice otherwise (tests / no-db).
  const { service: platformService } = services?.platform ?? _createInMemoryTenantPlatformBackend();
  _registerTenantPlatformRoutes(app, { service: platformService });
  _registerTenantInvitationRoutes(app, { service: platformService });
  _registerTenantKeyRingRoutes(app, { service: platformService });
  _registerOnboardingTemplateRoutes(app, { service: platformService });
  _registerSupportSessionRoutes(app, { service: platformService });
  _registerSignupIntentRoutes(app, { service: platformService });
  _registerBaaRegisterRoutes(app, { service: platformService });
  _registerFeatureFlagAdminRoutes(app, { service: platformService });
  _registerTenantExportApprovalRoutes(app, { service: platformService });

  // GAP-164 - the three platform-ops routes the first build deferred.
  registerPlatformOpsRoutes(app, {
    service: (services?.platformOps ?? { service: createInMemoryPlatformOpsService().service })
      .service,
  });

  // ── tenant-scoped surface (withOrgContext; the tenant's own org) ──
  const { service: tenantService } = services?.tenant ?? _createInMemoryTenantBackend();
  _registerTenantTenantRoutes(app, { service: tenantService });
  // GAP-164 - tenant account + feature flags.
  registerTenantAccountFlagsRoutes(app, {
    service: (
      services?.tenantAccountFlags ?? { service: createInMemoryTenantAccountFlagsService() }
    ).service,
  });

  // ── public, session-less self-serve signup surface (503-gated by default; D14) ──
  // The route has always composed its `requireUnderRateLimit` preHandler; what was missing was a
  // limiter to inject, so the §22.1 budget resolved to `createAllowAllRateLimiter()` (AC-05).
  _registerPublicSignupRoutes(app, {
    service: services?.public?.service ?? SLICE_M34_SIGNUP_SERVICE,
    ...(services?.public?.rateLimiter ? { rateLimiter: services.public.rateLimiter } : {}),
  });
}

// GAP-098 — the boot UPSERT of M34's own platform-default `alert_rule` rows (§4.8). GAP-057: complete —
// M34's two resolvers are registered at boot (./alert-resolver-ports.ts), so every rule is seeded.
export {
  createDrizzleM34AlertResolverPorts,
  m34ResolverExtension,
} from "./alert-resolver-ports";
export {
  type M34AlertRuleSeedResult,
  wireM34AlertRuleSeed,
} from "./alert-rule-seed-persister";

// GAP-164 - the six routes added after the first build (ops reads/skip + tenant account/flags).
export {
  type DrizzlePlatformOpsDeps,
  type PlatformOpsService,
  createDrizzlePlatformOpsService,
  createInMemoryPlatformOpsService,
} from "./routes/platform/ops-service";
export { registerPlatformOpsRoutes } from "./routes/platform/ops-routes";
export {
  type TenantAccountFlagsService,
  type TenantFlagAdminPort,
  createDrizzleTenantAccountFlagsService,
  createInMemoryTenantAccountFlagsService,
} from "./routes/tenant/account-flags-service";
export { registerTenantAccountFlagsRoutes } from "./routes/tenant/account-flags-routes";
