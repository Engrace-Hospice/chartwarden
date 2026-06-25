// @wardenx/saas-tenant-platform — seam barrel (M34 §4.6).
//
// The seam INTERFACES M34 publishes (lifecycle / key / onboarding / support-session / export-shard)
// plus the one forward seam it CONSUMES from M35 (subscription entitlements, deny-stub today, D15).
// Implementations and the boot-time `setXProvider` / `registerTenantExportShard` registrations land
// in later M34 phases (seam-bootstrap, §4.6); this barrel is the single import site for the contracts.

export type {
  TenantLifecycleProvider,
  TenantLifecycleStatus,
  TenantAccountStatus,
  RetentionExpiry,
} from "./tenant-lifecycle-provider";
export type {
  TenantKeyProvider,
  TenantDek,
  TenantKeyRingState,
} from "./tenant-key-provider";
export type {
  TenantOnboardingProvider,
  OnboardingStep,
  OnboardingTaskStatus,
} from "./tenant-onboarding-provider";
export type {
  TenantSupportSessionProvider,
  SupportConsentGrant,
} from "./tenant-support-session-provider";
export type {
  TenantExportShard,
  NdjsonSink,
  FhirResourceSink,
  TenantExportShardResult,
  DsarExportShardResult,
} from "./tenant-export-shard";
export type {
  TenantSubscriptionEntitlementReader,
  TenantEntitlementResult,
  TenantEntitlements,
} from "./tenant-subscription-entitlement-reader";
export { denyStubTenantSubscriptionEntitlementReader } from "./tenant-subscription-entitlement-reader";
