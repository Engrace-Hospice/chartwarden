// apps/backend/src/modules/22-documents/workers/ai-block-validator-worker.ts — the nightly half of the §4.8
// `ai-block-validator` (GAP-141; D7). The BOOT half is `validateDocumentsAIBlock` in the db-present `onReady`
// hook; this re-runs the SAME check at 02:00 so a prompt template activated AFTER boot (a registry write that
// somehow bypassed the registration-time R30 guard) is caught within a day instead of at the next restart.
//
// A violation cannot "fail boot" mid-flight: it raises the critical `m22.ai_block.violation` ops alert and fails
// the job (BullMQ keeps the failed job — no DLQ, per spec; ops is paged by the alert).
import { type DocumentsAiPromptRegistryPort, validateDocumentsAIBlock } from "../ai-block";
import type { ConnectionOptions } from "bullmq";
import { Queue, Worker } from "bullmq";

export const M22_AI_BLOCK_VALIDATOR_QUEUE = "documents.ai_block_validator";
export const M22_AI_BLOCK_VALIDATOR_SCHEDULE = "0 2 * * *";

export interface AiBlockValidatorWorkerDeps {
  readonly connection: ConnectionOptions;
  /** Resolved per tick (the real `AIPromptRegistry` seam; absent on a no-db slice => the check is a no-op). */
  readonly registry: () => DocumentsAiPromptRegistryPort | null | undefined;
  /** Critical ops alert on a violation (best-effort; the thrown error is what fails the job). */
  readonly onViolation?: (message: string) => Promise<void> | void;
}

/** One nightly check. Re-throws a violation after alerting. */
export async function runAiBlockValidatorTick(
  deps: Pick<AiBlockValidatorWorkerDeps, "registry" | "onViolation">,
): Promise<void> {
  try {
    await validateDocumentsAIBlock(deps.registry());
  } catch (error) {
    try {
      await deps.onViolation?.(error instanceof Error ? error.message : String(error));
    } catch {
      // the job failure below is the durable signal
    }
    throw error;
  }
}

export function registerAiBlockValidatorWorker(deps: AiBlockValidatorWorkerDeps): Worker {
  return new Worker(M22_AI_BLOCK_VALIDATOR_QUEUE, async () => runAiBlockValidatorTick(deps), {
    connection: deps.connection,
    concurrency: 1,
  });
}

export async function scheduleAiBlockValidator(connection: ConnectionOptions): Promise<Queue> {
  const queue = new Queue(M22_AI_BLOCK_VALIDATOR_QUEUE, { connection });
  await queue.add(
    "nightly",
    {},
    {
      repeat: { pattern: M22_AI_BLOCK_VALIDATOR_SCHEDULE },
      jobId: "m22-ai-block-validator-nightly",
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
  return queue;
}
