// apps/backend/src/modules/36-messaging/delivery/delivery-workers.ts — GAP-101: the LIVE BullMQ shell for the
// §4.4 `messaging.send_push|sms|voice|email` queues (the M39/M14 `jobs/cron-workers.ts` template). The queue
// names, priority and concurrency are the §4.4.1 catalog's (`MESSAGING_QUEUE_PARAMETERS`); the tick body is
// `./delivery-sweep.ts`. Each queue carries ONE repeatable "tick" job on its channel's cadence
// (`DELIVERY_SWEEP_INTERVAL_MS` — voice/push every 10-15 s, because a Tier-1 page that waits a minute is not a
// page), and the per-row retry budget + backoff come from the SAME catalog row (see `@chartwarden/messaging` retry).
import {
  DELIVERY_SWEEP_INTERVAL_MS,
  MESSAGING_QUEUES,
  MESSAGING_QUEUE_PARAMETERS,
  type OutOfBandTransportChannel,
} from "@chartwarden/messaging";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { type DeliverySweepDeps, runDeliverySweep } from "./delivery-sweep";

const QUEUE_BY_CHANNEL = {
  push: MESSAGING_QUEUES.sendPush,
  sms: MESSAGING_QUEUES.sendSms,
  voice: MESSAGING_QUEUES.sendVoice,
  email: MESSAGING_QUEUES.sendEmail,
} as const satisfies Record<OutOfBandTransportChannel, string>;

const CHANNELS = Object.keys(QUEUE_BY_CHANNEL) as OutOfBandTransportChannel[];

/** The tick job's id on its queue — BullMQ ids must not contain ':'. */
const TICK_JOB_NAME = "delivery-sweep-tick";

export interface M36DeliveryWorkerDeps extends DeliverySweepDeps {
  readonly connection: ConnectionOptions;
}

/** Construct the four send_* Workers (the caller owns lifecycle — `close()` on shutdown). */
export function registerM36DeliveryWorkers(deps: M36DeliveryWorkerDeps): Worker[] {
  return CHANNELS.map(
    (channel) =>
      new Worker(
        QUEUE_BY_CHANNEL[channel],
        async () => {
          const result = await runDeliverySweep(deps, channel);
          if (result.errors > 0) {
            // Surface a partially failed tick to BullMQ (failed-jobs set = the de facto DLQ, OPS-035).
            throw new Error(
              `M36 ${channel} delivery sweep finished with ${result.errors} error(s)`,
            );
          }
          return result;
        },
        {
          connection: deps.connection,
          // The tick is a sweep, not a per-row job: two concurrent ticks would only contend on the claim.
          concurrency: 1,
        },
      ),
  );
}

/** Register the repeatable tick on each queue. Returns the `Queue`s to `close()`. */
export async function scheduleM36DeliveryJobs(connection: ConnectionOptions): Promise<Queue[]> {
  const queues: Queue[] = [];
  for (const channel of CHANNELS) {
    const name = QUEUE_BY_CHANNEL[channel];
    const queue = new Queue(name, { connection });
    await queue.add(
      TICK_JOB_NAME,
      {},
      {
        repeat: { every: DELIVERY_SWEEP_INTERVAL_MS[channel] },
        priority: MESSAGING_QUEUE_PARAMETERS[name].priority,
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    queues.push(queue);
  }
  return queues;
}
