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
// Phase boundary (§0): Phase 1 (schema + migrations) is DONE; this phase wires the package spine + the
// permission/ABAC/event/seam registration surfaces. ROUTES are Phase 2C (the §4.1–4.2 platform/tenant
// route inventory behind `withPlatformContext`/`withOrgContext` on the §4.5 keys + the §4.6 ABAC chain)
// — NOT registered here yet; the typed TODO at the foot of this file marks the wiring site.

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
  setTenantKeyProvider,
  setTenantLifecycleProvider,
  setTenantOnboardingProvider,
  setTenantSubscriptionEntitlementReader,
  setTenantSupportSessionProvider,
  validateSeams as validateModule34Seams,
} from "@wardenx/saas-tenant-platform";

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

// TODO(Phase 2C — routes): register the §4.1–4.2 platform/tenant route inventory here (over the
// in-memory route service, then the Drizzle-backed one), behind `requirePermission` on the §4.5 keys +
// `requireAbac` on the §4.6 predicates, with `withPlatformContext` / `withOrgContext` org binding and
// the §6/D10 step-up enforcement. The composition root will call the exported `mountTenantPlatformRoutes`
// when a DB client is present (the M36 `mountMessagingRoutes` precedent). No routes are mounted yet.
