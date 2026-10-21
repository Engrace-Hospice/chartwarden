// apps/backend/src/modules/20-field-safety/wiring.ts — M20 platform-tenancy registration (F-111, #249;
// the M9/M6/M25 `wiring.ts` precedent). The §4.8 `m20.sos-sla-watchdog.cron` fan-out
// (`./jobs/cron-workers.ts`) enters `withPlatformContext` under this job id to enumerate active orgs;
// the id must be on the `@chartwarden/tenancy` PLATFORM_CONTEXT_ALLOWLIST (which starts empty → fail-closed)
// for the active-org enumerator to be admitted.
import { registerPlatformJob } from "@chartwarden/tenancy";

/**
 * The platform job id M20's §4.8 SOS-watchdog cron fan-out enters `withPlatformContext` under to
 * enumerate active orgs. Registered on the allowlist by {@link wireM20Tenancy} at boot.
 */
export const M20_PLATFORM_JOB_ID = "m20.platform_crons";

/**
 * Register M20's platform job id on the `@chartwarden/tenancy` PLATFORM_CONTEXT_ALLOWLIST so the §4.8 SOS
 * watchdog may enter `withPlatformContext` (idempotent `Set.add`). Called once at boot by the
 * composition root, alongside wireM6Tenancy / wireM7Tenancy / wireM9Tenancy / wireM25Tenancy / etc.
 */
export function wireM20Tenancy(): void {
  registerPlatformJob(M20_PLATFORM_JOB_ID);
}
