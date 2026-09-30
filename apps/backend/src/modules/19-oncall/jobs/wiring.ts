// apps/backend/src/modules/19-oncall/jobs/wiring.ts — M19 platform-tenancy registration for the
// §4.8 `m19.shift-sync.debounced` drain + catch-up-seed workers (m19 `handlers-unbound` group, #248;
// F-155's own finding, now built; the M12 `jobs/wiring.ts` / `M12_PLATFORM_JOB_ID` precedent).
//
// Both workers fan out over active orgs via `apps/backend/src/bootstrap/active-org-enumerator.ts`'s
// `buildActiveOrgEnumerator`, which enters ONE audited `withPlatformContext` transaction per tick. That
// entry is gated: the job id must be on the `@wardenx/tenancy` `PLATFORM_CONTEXT_ALLOWLIST`, which starts
// empty (fail-closed). This registers M19's id on it at boot. One job id covers both workers — they are
// two halves of the same §4.5 mechanism (drain vs. catch-up-seed), not two independent platform crons.
import { registerPlatformJob } from "@wardenx/tenancy";

/** The platform job id the roster-sync drain + catch-up-seed workers' active-org fan-out enters
 *  `withPlatformContext` under. Registered on the allowlist by {@link wireM19Tenancy} at boot. */
export const M19_PLATFORM_JOB_ID = "m19.platform_crons";

/** Register M19's platform job id (idempotent `Set.add`). Called once at boot by the composition root,
 *  alongside wireM6Tenancy / wireM12Tenancy / wireM20Tenancy / wireM25Tenancy / etc. */
export function wireM19Tenancy(): void {
  registerPlatformJob(M19_PLATFORM_JOB_ID);
}
