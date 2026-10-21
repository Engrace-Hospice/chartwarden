// apps/backend/src/modules/10-hope/wiring.ts — M10 platform-tenancy registration (TASK-040D, the M25/M30/
// M33/M34 wiring.ts precedent). The §4.8 `hope-window-watchdog` / `sfv-watchdog` cron fan-outs enter
// `withPlatformContext` under this job id to enumerate active orgs; the id must be on the `@chartwarden/tenancy`
// PLATFORM_CONTEXT_ALLOWLIST (which starts empty → fail-closed) for the active-org enumerator to be admitted.
import { registerPlatformJob } from "@chartwarden/tenancy";

/**
 * The platform job id M10's §4.8 cron fan-outs enter `withPlatformContext` under to enumerate active orgs
 * (the cron fan-out source). Registered on the allowlist by {@link wireM10Tenancy} at boot.
 */
export const M10_PLATFORM_JOB_ID = "m10.platform_crons";

/**
 * Register M10's platform job id on the `@chartwarden/tenancy` PLATFORM_CONTEXT_ALLOWLIST so the §4.8
 * `hope-window-watchdog` / `sfv-watchdog` cron fan-outs may enter `withPlatformContext` (idempotent
 * `Set.add`). Called once at boot by the composition root, alongside wireM25Tenancy / wireM30Tenancy /
 * wireM33Tenancy / wireM34Tenancy.
 */
export function wireM10Tenancy(): void {
  registerPlatformJob(M10_PLATFORM_JOB_ID);
}
