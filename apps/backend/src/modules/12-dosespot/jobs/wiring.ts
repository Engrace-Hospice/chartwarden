// apps/backend/src/modules/12-dosespot/jobs/wiring.ts — M12 platform-tenancy registration for the
// `dosespot_sync_queue` drain worker (M12 `handlers-unbound` group, #248; the M20 `wiring.ts` /
// `M20_PLATFORM_JOB_ID` precedent).
//
// `runDoseSpotSyncQueueDrain` (`./worker.ts`) fans out over active orgs the same way M11's standing-spawn
// worker and M20's SOS watchdog do — via `apps/backend/src/bootstrap/active-org-enumerator.ts`'s
// `buildActiveOrgEnumerator`, which enters ONE audited `withPlatformContext` transaction per drain tick.
// That entry is gated: the job id must be on the `@wardenx/tenancy` `PLATFORM_CONTEXT_ALLOWLIST`, which
// starts empty (fail-closed). This registers M12's id on it at boot.
import { registerPlatformJob } from "@wardenx/tenancy";

/** The platform job id the `dosespot_sync_queue` drain's active-org fan-out enters `withPlatformContext`
 *  under. Registered on the allowlist by {@link wireM12Tenancy} at boot. */
export const M12_PLATFORM_JOB_ID = "m12.platform_crons";

/** Register M12's platform job id (idempotent `Set.add`). Called once at boot by the composition root,
 *  alongside wireM6Tenancy / wireM9Tenancy / wireM20Tenancy / wireM25Tenancy / etc. */
export function wireM12Tenancy(): void {
  registerPlatformJob(M12_PLATFORM_JOB_ID);
}
