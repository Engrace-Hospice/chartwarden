// apps/web/src/modules/34-saas — M34 SaaS Tenant Platform web slice (R2, ADR-0030). The 10
// platform-ops control-plane screens migrated to apps/admin/src/modules/34-saas-platform/ — this
// slice now owns only the tenant-facing /admin/* surface (Account/Onboarding wizard/Support Grants/Agency setup).
export { saasScreens } from "./screens";
export { Account } from "./account";
export { OnboardingScreenGate } from "./wizard/onboarding-gate";
