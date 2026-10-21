// apps/backend/src/modules/39-consent/wiring.ts — M39 platform-tenancy registration (F-216; the M20/M14
// `wiring.ts` precedent). The §4.9 hourly `m39.consent_expiration` / `m39.expiration_reminder` cron
// fan-out (`./jobs/cron-workers.ts`) enters `withPlatformContext` under this job id to enumerate active
// orgs; the id must be on the `@chartwarden/tenancy` PLATFORM_CONTEXT_ALLOWLIST (which starts empty →
// fail-closed) for the active-org enumerator to be admitted.
import { registerPlatformJob } from "@chartwarden/tenancy";

/** The platform job id M39's §4.9 expiration/reminder cron fan-out enters `withPlatformContext` under. */
export const M39_PLATFORM_JOB_ID = "m39.platform_crons";

/** Register M39's platform job id (idempotent `Set.add`). Called once at boot by the composition root,
 *  alongside wireM14Tenancy / wireM20Tenancy / etc. */
export function wireM39Tenancy(): void {
  registerPlatformJob(M39_PLATFORM_JOB_ID);
}
