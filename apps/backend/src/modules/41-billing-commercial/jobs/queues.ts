// apps/backend/src/modules/41-billing-commercial/jobs/queues.ts - the M41 BullMQ queue catalog and the platform job id.
//
// The submission worker is a DRAIN, not a per-request queue: `POST .../submit` writes a durable `queued` row in the same
// transaction as its decision, and the drain (every minute) sends what is due. A job enqueued after commit could be lost between the
// commit and the enqueue; a row cannot. A refused request writes no row, so no job can exist for it (ADR-0100 D4).
import { registerPlatformJob } from "@chartwarden/tenancy";

/** BullMQ queues owned by M41. Module-prefixed so no other module's worker can pick up a tick (`arch:queue-names`). */
export const M41_CRON_QUEUES = {
  /** Send every due queued commercial submission through the bound ClearinghouseTransport. */
  submissionDrain: "m41.submission-drain",
} as const;

export const M41_JOB_SCHEDULES = {
  submissionDrain: "* * * * *",
} as const;

/** The platform job id the drain enters `withPlatformContext` under to enumerate active orgs (must be allowlisted at boot). */
export const M41_PLATFORM_JOB_ID = "m41.platform_crons";

/** Allowlist M41's platform job id (idempotent). Called once at boot by the composition root, like `wireM25Tenancy`. */
export function wireM41Tenancy(): void {
  registerPlatformJob(M41_PLATFORM_JOB_ID);
}
