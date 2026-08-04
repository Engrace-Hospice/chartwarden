// apps/backend/src/modules/07-care-plan/wiring.ts — M7 platform-tenancy registration (TASK-040D; the
// M25 `25-remittance/wiring.ts` precedent). The `care-plan.gates` cron fan-out (`./jobs/cron-workers.ts`)
// enters `withPlatformContext` under this job id to enumerate active orgs; the id must be on the
// `@wardenx/tenancy` PLATFORM_CONTEXT_ALLOWLIST (which starts empty → fail-closed) for the active-org
// enumerator to be admitted.
import { registerPlatformJob } from "@wardenx/tenancy";

/**
 * The platform job id M7's `care-plan.gates` cron enters `withPlatformContext` under to enumerate
 * active orgs (the cron fan-out source). Registered on the allowlist by {@link wireM7Tenancy} at boot.
 */
export const M7_PLATFORM_JOB_ID = "m7.platform_crons";

/**
 * Register M7's platform job id on the `@wardenx/tenancy` PLATFORM_CONTEXT_ALLOWLIST so the
 * `care-plan.gates` cron fan-out may enter `withPlatformContext` (idempotent `Set.add`). Called once at
 * boot by the composition root, alongside wireM25Tenancy / wireM30Tenancy / wireM33Tenancy / wireM34Tenancy.
 */
export function wireM7Tenancy(): void {
  registerPlatformJob(M7_PLATFORM_JOB_ID);
}
