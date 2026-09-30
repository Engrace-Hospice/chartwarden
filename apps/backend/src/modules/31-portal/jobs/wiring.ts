// apps/backend/src/modules/31-portal/jobs/wiring.ts — M31's platform-tenancy registration (F-222/#248), the
// M24/M25/M27/M29/M30/M33/M34 `wireM<N>Tenancy` precedent.
//
// The §4.8 `m31.post-discharge-grace.cron` fans out over every active org. That fan-out's active-org source
// enters `withPlatformContext` under this job id; the id must be on the `@wardenx/tenancy`
// `PLATFORM_CONTEXT_ALLOWLIST` (starts empty → fail-closed) for the enumerator to be admitted.
import { registerPlatformJob } from "@wardenx/tenancy";

/** The platform job id M31's crons enter `withPlatformContext` under to enumerate active orgs. */
export const M31_PLATFORM_JOB_ID = "m31.platform_crons";

/** Register M31's platform job id on the PLATFORM_CONTEXT_ALLOWLIST (idempotent `Set.add`). */
export function wireM31Tenancy(): void {
  registerPlatformJob(M31_PLATFORM_JOB_ID);
}
