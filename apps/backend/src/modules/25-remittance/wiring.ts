// apps/backend/src/modules/25-remittance/wiring.ts — M25 platform-tenancy registration (the M30/M33/M34
// wiring.ts precedent). The §4.8 cron fan-outs (denial-aging, appeal-deadline) enter `withPlatformContext`
// under this job id to enumerate active orgs; the id must be on the `@chartwarden/tenancy`
// PLATFORM_CONTEXT_ALLOWLIST (which starts empty → fail-closed) for the active-org enumerator to be admitted.
import { registerPlatformJob } from "@chartwarden/tenancy";

/**
 * The platform job id M25's §4.8 platform-scoped crons enter `withPlatformContext` under to enumerate active
 * orgs (the cron fan-out source). Registered on the allowlist by {@link wireM25Tenancy} at boot.
 */
export const M25_PLATFORM_JOB_ID = "m25.platform_crons";

/**
 * Register M25's platform job id on the `@chartwarden/tenancy` PLATFORM_CONTEXT_ALLOWLIST so the §4.8 cron
 * fan-outs may enter `withPlatformContext` (idempotent `Set.add`). Called once at boot by the composition
 * root, alongside wireM30Tenancy / wireM33Tenancy / wireM34Tenancy.
 */
export function wireM25Tenancy(): void {
  registerPlatformJob(M25_PLATFORM_JOB_ID);
}
