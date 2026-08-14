// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/index.ts — M34 platform-ops route barrel.
//
// The four platform-ops tenant-lifecycle route plugins (§4.1) + their shared route service / TypeBox /
// cursor helpers. The module index re-exports `mountTenantPlatformRoutes` (the composition-root mount,
// the M36 `mountMessagingRoutes` precedent); the route plugins are individually exported so the route
// tests can mount one group over a fresh in-memory backend.
export { registerTenantPlatformRoutes, type TenantPlatformRouteDeps } from "./tenants";
export {
  registerTenantInvitationRoutes,
  type TenantInvitationRouteDeps,
} from "./tenant-invitations";
export { registerTenantKeyRingRoutes, type TenantKeyRingRouteDeps } from "./key-ring";
export {
  registerOnboardingTemplateRoutes,
  type OnboardingTemplateRouteDeps,
} from "./onboarding-templates";
export { registerSupportSessionRoutes, type SupportSessionRouteDeps } from "./support-sessions";
export { registerSignupIntentRoutes, type SignupIntentRouteDeps } from "./signup-intents";
export { registerBaaRegisterRoutes, type BaaRegisterRouteDeps } from "./baa-register";
export {
  registerTenantExportApprovalRoutes,
  type TenantExportApprovalRouteDeps,
} from "./tenant-export-approval";
export {
  registerFeatureFlagAdminRoutes,
  type FeatureFlagAdminRouteDeps,
} from "./feature-flags-admin";
export {
  type BaaRecordView,
  type CreateBaaRecordArgs,
  type FeatureFlagView,
  type SignupIntentView,
  type SupportSessionEventView,
  type SupportSessionView,
  type UpdateBaaRecordArgs,
  type UpsertFeatureFlagArgs,
  type EnqueuePort,
  type KeyRingMetadataView,
  type M34QueueName,
  type OnboardingTemplateView,
  type ProvisionTenantArgs,
  type StatusTransitionArgs,
  type TenantInvitationView,
  type TenantOverview,
  type TenantPlatformBackendInspect,
  type TenantPlatformRouteSeed,
  type TenantPlatformRouteService,
  type TenantSummaryView,
  createInMemoryTenantPlatformBackend,
} from "./service";
