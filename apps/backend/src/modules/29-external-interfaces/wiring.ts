// apps/backend/src/modules/29-external-interfaces/wiring.ts — M29's platform-tenancy registration
// (F-175/#248), the M24/M25/M27/M30/M33/M34 `wireM<N>Tenancy` precedent.
//
// The §4.9-shaped `m29-outbound-retry-sweep` cron (`outbound/dispatch-worker.ts`) fans out over every
// active org's due `hl7_message_outbound` retries. That fan-out's active-org source enters
// `withPlatformContext` under this job id; the id must be on the `@wardenx/tenancy`
// `PLATFORM_CONTEXT_ALLOWLIST` (starts empty → fail-closed) for the enumerator to be admitted.
import { registerPlatformJob } from "@wardenx/tenancy";

/** The platform job id M29's outbound retry-sweep cron enters `withPlatformContext` under to enumerate
 *  active orgs. Registered on the allowlist by {@link wireM29Tenancy} at boot. */
export const M29_PLATFORM_JOB_ID = "m29.platform_crons";

/** Register M29's platform job id on the PLATFORM_CONTEXT_ALLOWLIST (idempotent `Set.add`). Called once at
 *  boot by the composition root, alongside wireM24Tenancy / wireM25Tenancy / wireM27Tenancy. */
export function wireM29Tenancy(): void {
  registerPlatformJob(M29_PLATFORM_JOB_ID);
}
