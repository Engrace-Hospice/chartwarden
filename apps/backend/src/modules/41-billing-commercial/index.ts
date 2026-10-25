// apps/backend/src/modules/41-billing-commercial - Billing - Commercial (ADR-0100). #724 lands eligibility (270/271) and enrollment.
export { createCommercialAdminService, type CommercialAdminService } from "./eligibility/admin-service";
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
