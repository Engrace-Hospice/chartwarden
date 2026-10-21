// apps/backend/src/modules/37-ipu/wiring.ts — M37 platform-tenancy registration (F-071 / #174; the M14
// `14-idg/wiring.ts` / M25 `25-remittance/wiring.ts` precedent). The `ipu.rn-coverage-watchdog` cron
// (`./jobs/cron-workers.ts`) enters `withPlatformContext` under this job id to enumerate active orgs; the
// id must be on the `@chartwarden/tenancy` PLATFORM_CONTEXT_ALLOWLIST (which starts empty → fail-closed) for
// the active-org enumerator to be admitted.
import { registerPlatformJob } from "@chartwarden/tenancy";

/**
 * The platform job id M37's `ipu.rn-coverage-watchdog` cron enters `withPlatformContext` under to
 * enumerate active orgs (the cron fan-out source). Registered on the allowlist by {@link wireM37Tenancy}.
 */
export const M37_PLATFORM_JOB_ID = "m37.platform_crons";

/**
 * Register M37's platform job id on the `@chartwarden/tenancy` PLATFORM_CONTEXT_ALLOWLIST so the RN-coverage
 * watchdog may enter `withPlatformContext` (idempotent `Set.add`). Called once at boot by the composition
 * root, alongside wireM7Tenancy / wireM9Tenancy / wireM10Tenancy / wireM14Tenancy / wireM25Tenancy.
 */
export function wireM37Tenancy(): void {
  registerPlatformJob(M37_PLATFORM_JOB_ID);
}
