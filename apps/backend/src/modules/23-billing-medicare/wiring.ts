// apps/backend/src/modules/23-billing-medicare/wiring.ts — M23 platform-tenancy registration (the M25/M30/M33
// wiring.ts precedent). The §4.8 per-org watchdog crons (NOE/NOTR window-watch, eligibility stale-watch) enter
// `withPlatformContext` under this job id to enumerate active orgs; the id must be on the `@chartwarden/tenancy`
// PLATFORM_CONTEXT_ALLOWLIST (which starts empty → fail-closed) for the enumerator to be admitted.
import { registerPlatformJob } from "@chartwarden/tenancy";

/** The platform job id M23's per-org watchdog crons enumerate active orgs under. */
export const M23_PLATFORM_JOB_ID = "m23.platform_crons";

/**
 * Register M23's platform job id on the allowlist (idempotent `Set.add`). Called once at boot by the
 * composition root, alongside the other `wireM*Tenancy` calls.
 */
export function wireM23Tenancy(): void {
  registerPlatformJob(M23_PLATFORM_JOB_ID);
}
