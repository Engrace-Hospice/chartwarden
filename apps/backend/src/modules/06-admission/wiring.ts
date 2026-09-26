import { registerPlatformJob } from "@wardenx/tenancy";
import { M6_PLATFORM_JOB_ID } from "./jobs/index";

/**
 * Allow M6 scheduled jobs to enter platform context for active-org fan-out.
 */
export function wireM6Tenancy(): void {
  registerPlatformJob(M6_PLATFORM_JOB_ID);
}