// apps/backend/src/modules/03-authorization/jobs/close-engagements-worker.ts — the BullMQ shell of
// `authz.close_engagements` (M3 §4.5.1): one repeatable trigger, active-org fan-out under the audited
// platform context, then `closeEngagementsForOrg` per org. One org's failure never skips the others; all
// failures are re-raised together so BullMQ retries (every step is idempotent).
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import {
  type CloseEngagementsDeps,
  M3_CLOSE_ENGAGEMENTS_CRON,
  M3_CLOSE_ENGAGEMENTS_QUEUE,
  closeEngagementsForOrg,
} from "./close-engagements";

export interface CloseEngagementsWorkerDeps extends CloseEngagementsDeps {
  readonly connection: ConnectionOptions;
  readonly activeOrgs: {
    listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
  };
}

export async function runCloseEngagementsFanout(
  deps: Omit<CloseEngagementsWorkerDeps, "connection">,
): Promise<{ orgs: number; activated: number; closed: number }> {
  const failures: unknown[] = [];
  let orgs = 0;
  let activated = 0;
  let closed = 0;
  for (const { organizationId } of await deps.activeOrgs.listActiveOrgs()) {
    orgs++;
    try {
      const r = await closeEngagementsForOrg(deps, organizationId);
      activated += r.activated;
      closed += r.closed;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `M3_CLOSE_ENGAGEMENTS: ${failures.length} org failure(s)`);
  }
  return { orgs, activated, closed };
}

/** Construct the worker + register the repeatable trigger. Returns both for shutdown. */
export async function registerCloseEngagementsWorker(
  deps: CloseEngagementsWorkerDeps,
): Promise<{ worker: Worker; queue: Queue }> {
  const worker = new Worker(M3_CLOSE_ENGAGEMENTS_QUEUE, () => runCloseEngagementsFanout(deps), {
    connection: deps.connection,
    concurrency: 1,
  });
  const queue = new Queue(M3_CLOSE_ENGAGEMENTS_QUEUE, { connection: deps.connection });
  await queue.add(
    "scheduled",
    {},
    { repeat: { pattern: M3_CLOSE_ENGAGEMENTS_CRON }, removeOnComplete: true },
  );
  return { worker, queue };
}
