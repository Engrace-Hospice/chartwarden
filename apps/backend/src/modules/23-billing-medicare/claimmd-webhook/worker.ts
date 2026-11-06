// apps/backend/src/modules/23-billing-medicare/claimmd-webhook/worker.ts — the BullMQ shell over the Claim.MD receipt
// sweep. A repeatable sweep over durable rows (a lost job loses nothing). Constructed by the composition root only with a
// Valkey connection and a bound webhook (never at import, never in tests).
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import {
  CLAIMMD_WEBHOOK_SWEEP_QUEUE,
  type ClaimMdSweepDeps,
  runClaimMdWebhookSweep,
} from "./sweep";

/** Claim.MD retries at least 30 minutes apart; a one-minute sweep keeps our side well inside that. */
export const CLAIMMD_SWEEP_EVERY_MS = 60_000;

export function registerClaimMdWebhookSweepWorker(
  connection: ConnectionOptions,
  deps: ClaimMdSweepDeps,
): Worker {
  return new Worker(
    CLAIMMD_WEBHOOK_SWEEP_QUEUE,
    async () => void (await runClaimMdWebhookSweep(deps)),
    {
      connection,
      concurrency: 1,
    },
  );
}

export async function scheduleClaimMdWebhookSweep(connection: ConnectionOptions): Promise<Queue> {
  const queue = new Queue(CLAIMMD_WEBHOOK_SWEEP_QUEUE, { connection });
  await queue.add(
    "scheduled",
    {},
    { repeat: { every: CLAIMMD_SWEEP_EVERY_MS }, removeOnComplete: true },
  );
  return queue;
}
