// apps/backend/src/modules/09-assessments/wiring.ts — M9 platform-tenancy registration (TASK-040D; the
// M25 `25-remittance/wiring.ts` / M7 `07-care-plan/wiring.ts` precedent). The §4.8 `license`/`changes`/
// `cadence` cron fan-outs (`./jobs/cron-workers.ts`) enter `withPlatformContext` under this job id to
// enumerate active orgs; the id must be on the `@chartwarden/tenancy` PLATFORM_CONTEXT_ALLOWLIST (which
// starts empty → fail-closed) for the active-org enumerator to be admitted.
import { registerPlatformJob } from "@chartwarden/tenancy";

/**
 * The platform job id M9's §4.8 cron fan-outs enter `withPlatformContext` under to enumerate active orgs
 * (the cron fan-out source). Registered on the allowlist by {@link wireM9Tenancy} at boot.
 */
export const M9_PLATFORM_JOB_ID = "m9.platform_crons";

/**
 * Register M9's platform job id on the `@chartwarden/tenancy` PLATFORM_CONTEXT_ALLOWLIST so the §4.8 cron
 * fan-outs may enter `withPlatformContext` (idempotent `Set.add`). Called once at boot by the
 * composition root, alongside wireM7Tenancy / wireM25Tenancy / wireM30Tenancy / wireM33Tenancy / wireM34Tenancy.
 */
export function wireM9Tenancy(): void {
  registerPlatformJob(M9_PLATFORM_JOB_ID);
}
