// apps/backend/src/modules/32-ai-platform/wiring.ts — M32's composition-root helpers (M32-T03).
//
// The §3.3 governance tables (`ai_capability`, `ai_capability_lifecycle_event`,
// `ai_capability_calibration`) grant `wardenx_app` SELECT only; every write is `wardenx_admin` on the
// separately-pooled platform credential. `@wardenx/tenancy`'s allowlist starts EMPTY and
// `withPlatformContext` refuses any caller not on it, so the registry store's writes are dead until
// this runs — which is the fail-closed direction: a module that forgets to wire its tenancy cannot
// write, rather than writing under an unaudited bypass.
//
// The M33 `wireM33Tenancy` / M34 `M34_PLATFORM_JOB_ID` precedent, verbatim in shape.
import { registerPlatformJob } from "@wardenx/tenancy";

/**
 * The registered platform-job id M32's governance writes enter `withPlatformContext` under.
 *
 * ONE id for the whole module, not one per operation, because the allowlist is a list of JOBS and the
 * `platform.bypass_invoked` row already carries the per-entry `reason` string that says which write it
 * was. A per-route id would multiply the allowlist without making any bypass more distinguishable.
 */
export const M32_PLATFORM_JOB_ID = "m32.platform_ops";

/**
 * Register M32's platform job id on the `@wardenx/tenancy` allowlist so the governance registry store
 * may enter `withPlatformContext`. Idempotent (`Set.add`). Must run before any capability registration,
 * lifecycle transition or calibration publication.
 */
export function wireM32Tenancy(): void {
  registerPlatformJob(M32_PLATFORM_JOB_ID);
}
