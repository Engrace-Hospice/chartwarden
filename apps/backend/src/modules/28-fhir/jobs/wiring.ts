// apps/backend/src/modules/28-fhir/jobs/wiring.ts — M28 platform-tenancy registration (GAP-084; the M13
// `wiring.ts` precedent). The §4.8 crons enter `withPlatformContext` under this job id to enumerate active
// orgs; it must be on the `@wardenx/tenancy` PLATFORM_CONTEXT_ALLOWLIST (which starts empty → fail-closed).
import { registerPlatformJob } from "@wardenx/tenancy";

import { M28_PLATFORM_JOB_ID } from "./queues";

/** Register {@link M28_PLATFORM_JOB_ID} on the allowlist (idempotent `Set.add`). Called once at boot. */
export function wireM28Tenancy(): void {
  registerPlatformJob(M28_PLATFORM_JOB_ID);
}
