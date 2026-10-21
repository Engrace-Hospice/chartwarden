// apps/backend/src/modules/14-idg/wiring.ts — M14 platform-tenancy registration (GAP-092; the M25
// `25-remittance/wiring.ts` / M9 `09-assessments/wiring.ts` precedent). The `idg.review-clock-sweep`
// cron (`./jobs/cron-workers.ts`) enters `withPlatformContext` under this job id to enumerate active
// orgs; the id must be on the `@chartwarden/tenancy` PLATFORM_CONTEXT_ALLOWLIST (which starts empty → fail-
// closed) for the active-org enumerator to be admitted.
import { registerPlatformJob } from "@chartwarden/tenancy";

/**
 * The platform job id M14's `idg.review-clock-sweep` cron enters `withPlatformContext` under to enumerate
 * active orgs (the cron fan-out source). Registered on the allowlist by {@link wireM14Tenancy} at boot.
 */
export const M14_PLATFORM_JOB_ID = "m14.platform_crons";

/**
 * Register M14's platform job id on the `@chartwarden/tenancy` PLATFORM_CONTEXT_ALLOWLIST so the review-clock
 * sweep may enter `withPlatformContext` (idempotent `Set.add`). Called once at boot by the composition
 * root, alongside wireM7Tenancy / wireM9Tenancy / wireM10Tenancy / wireM25Tenancy.
 */
export function wireM14Tenancy(): void {
  registerPlatformJob(M14_PLATFORM_JOB_ID);
}
