// apps/backend/src/modules/40-mdm/wiring.ts — M40 platform-tenancy registration (GAP-173; the M39/M14
// `wiring.ts` precedent). The §4.3 daily `mdm.baa_expiration_scan` cron fan-out (`./jobs/cron-workers.ts`)
// enters `withPlatformContext` under this job id to enumerate active orgs; the id must be on the
// `@chartwarden/tenancy` PLATFORM_CONTEXT_ALLOWLIST (which starts empty → fail-closed) for the active-org
// enumerator to be admitted.
import { registerPlatformJob } from "@chartwarden/tenancy";

/** The platform job id M40's §4.3 scheduled scans enter `withPlatformContext` under. */
export const M40_PLATFORM_JOB_ID = "m40.platform_crons";

/** Register M40's platform job id (idempotent `Set.add`). Called once at boot by the composition root. */
export function wireM40Tenancy(): void {
  registerPlatformJob(M40_PLATFORM_JOB_ID);
}
