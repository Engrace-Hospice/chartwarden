// apps/backend/src/modules/16-bereavement/wiring.ts — M16 platform-tenancy registration (GAP-048; the
// M20/M9/M6 `wiring.ts` precedent). The §4.9 cron fan-outs (`./jobs/cron-workers.ts`) enter
// `withPlatformContext` under this job id to enumerate active orgs; the id must be on the
// `@chartwarden/tenancy` PLATFORM_CONTEXT_ALLOWLIST (which starts empty → fail-closed) to be admitted.
import { registerPlatformJob } from "@chartwarden/tenancy";

/** The platform job id M16's §4.9 cron fan-outs enter `withPlatformContext` under. */
export const M16_PLATFORM_JOB_ID = "m16.platform_crons";

/** Register M16's platform job id on the allowlist (idempotent `Set.add`). Called once at boot. */
export function wireM16Tenancy(): void {
  registerPlatformJob(M16_PLATFORM_JOB_ID);
}
