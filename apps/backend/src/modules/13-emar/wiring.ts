// apps/backend/src/modules/13-emar/wiring.ts — M13 platform-tenancy registration (GAP-038/039/040; the M14
// `14-idg/wiring.ts` precedent). M13's §4.8 crons (`./jobs/cron-workers.ts`) enter `withPlatformContext`
// under this job id to enumerate active orgs; the id must be on the `@wardenx/tenancy`
// PLATFORM_CONTEXT_ALLOWLIST (which starts empty → fail-closed) for the active-org enumerator to be admitted.
import { registerPlatformJob } from "@wardenx/tenancy";

/** The platform job id every M13 §4.8 cron enters `withPlatformContext` under (active-org enumeration). */
export const M13_PLATFORM_JOB_ID = "m13.platform_crons";

/** Register {@link M13_PLATFORM_JOB_ID} on the allowlist (idempotent `Set.add`). Called once at boot. */
export function wireM13Tenancy(): void {
  registerPlatformJob(M13_PLATFORM_JOB_ID);
}
