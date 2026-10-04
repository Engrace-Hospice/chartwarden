// apps/backend/src/modules/22-documents/records-request/expiry-worker.ts — the hourly records-request expiry
// sweep (F-238). A request nobody answered by its `expires_on` day moves `requested` → `expired`.
//
// The same thin per-org fan-out shape as M11's verbal-order expiry (`orders.verbal_timer`): one repeatable
// hourly trigger enumerates active orgs under the audited platform context (the composition root binds
// `buildActiveOrgEnumerator` under M22_RECORDS_REQUEST_EXPIRY_PLATFORM_JOB_ID), then each org's write runs
// in its own `withOrgContext` transaction (`expireRecordsRequestsForOrg`, org-explicit: a cron tick is not a
// request). One org's failure never skips the others; all failures are re-raised together so BullMQ retries.
import type { ConnectionOptions } from "bullmq";
import { Queue, Worker } from "bullmq";

export const M22_RECORDS_REQUEST_EXPIRY_QUEUE = "documents.records_request_expiry";
/** Hourly, at minute 17 (off the top of the hour, where most crons pile up). */
export const M22_RECORDS_REQUEST_EXPIRY_SCHEDULE = "17 * * * *";
/** The platform job id the active-org enumeration enters `withPlatformContext` under (registered at boot). */
export const M22_RECORDS_REQUEST_EXPIRY_PLATFORM_JOB_ID = "m22.records_request_expiry";

export interface RecordsRequestExpiryWorkerDeps {
  readonly connection: ConnectionOptions;
  readonly activeOrgs: {
    listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
  };
  /** `expireRecordsRequestsForOrg` bound to the tenant pool. Returns how many requests it expired. */
  readonly expireForOrg: (organizationId: string) => Promise<number>;
  readonly log?: (msg: string, detail: Record<string, unknown>) => void;
}

export async function runRecordsRequestExpiryFanout(
  deps: Omit<RecordsRequestExpiryWorkerDeps, "connection">,
): Promise<{ orgs: number; expired: number }> {
  const failures: unknown[] = [];
  let orgs = 0;
  let expired = 0;
  for (const { organizationId } of await deps.activeOrgs.listActiveOrgs()) {
    orgs++;
    try {
      const n = await deps.expireForOrg(organizationId);
      expired += n;
      if (n > 0) deps.log?.("m22.records_request.expired", { organizationId, expired: n });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      `M22_RECORDS_REQUEST_EXPIRY: ${failures.length} org failure(s)`,
    );
  return { orgs, expired };
}

export function registerRecordsRequestExpiryWorker(deps: RecordsRequestExpiryWorkerDeps): Worker {
  return new Worker(
    M22_RECORDS_REQUEST_EXPIRY_QUEUE,
    async () => runRecordsRequestExpiryFanout(deps),
    { connection: deps.connection, concurrency: 1 },
  );
}

export async function scheduleRecordsRequestExpiry(connection: ConnectionOptions): Promise<Queue> {
  const queue = new Queue(M22_RECORDS_REQUEST_EXPIRY_QUEUE, { connection });
  await queue.add(
    "hourly",
    {},
    {
      repeat: { pattern: M22_RECORDS_REQUEST_EXPIRY_SCHEDULE },
      jobId: "m22-records-request-expiry-hourly",
      attempts: 3,
      backoff: { type: "exponential", delay: 120_000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
  return queue;
}
