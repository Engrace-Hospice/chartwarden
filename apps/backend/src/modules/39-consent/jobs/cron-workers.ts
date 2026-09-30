// apps/backend/src/modules/39-consent/jobs/cron-workers.ts — the LIVE BullMQ Worker + repeatable Queue
// construction for M39's §4.9 `m39.consent_expiration` and `m39.expiration_reminder` hourly crons (F-216;
// the M14/M20 `jobs/cron-workers.ts` template). The per-org bodies are `./expiration.ts`; this file is only
// the BullMQ shell + the fail-closed dep bag.
import type { DbClient } from "@wardenx/db";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import type { ConsentWriteOutboxPort } from "../consent-store-db";
import {
  type M39ActiveOrgListPort,
  runConsentExpirationCron,
  runExpirationReminderCron,
} from "./expiration";
import { M39_JOB_SCHEDULES, M39_QUEUES, M39_QUEUE_PARAMS } from "./index";

export type { M39ActiveOrgListPort } from "./expiration";

/** The dep bag the composition root injects. `outbox` is REQUIRED (the flip and its event share a tx);
 *  `activeOrgs` gets the lazy fail-closed thunk (the M14/M20 convention). */
export interface M39WorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly outbox: ConsentWriteOutboxPort;
  readonly activeOrgs?: M39ActiveOrgListPort;
  now?: () => Date;
}

function activeOrgsOf(deps: M39WorkerDeps): M39ActiveOrgListPort {
  return (
    deps.activeOrgs ?? {
      listActiveOrgs: () =>
        Promise.reject(
          new Error(
            "M39_WORKER_PORT_UNBOUND: activeOrgs.listActiveOrgs — bind the M2 active-org enumerator (the cron fan-out source) under withPlatformContext",
          ),
        ),
    }
  );
}

/** Build the {@link M39WorkerDeps} from the composition-root primitives. */
export function buildM39WorkerDeps(deps: {
  connection: ConnectionOptions;
  db: DbClient;
  outbox: ConsentWriteOutboxPort;
  activeOrgs?: M39ActiveOrgListPort;
}): M39WorkerDeps {
  return {
    connection: deps.connection,
    db: deps.db,
    outbox: deps.outbox,
    activeOrgs: deps.activeOrgs,
    now: () => new Date(),
  };
}

/** Construct both M39 crons' Workers (the caller owns lifecycle — `close()` on shutdown). */
export function registerM39CronWorkers(deps: M39WorkerDeps): Worker[] {
  const { connection } = deps;
  const base = { db: deps.db, outbox: deps.outbox, now: deps.now };
  return [
    new Worker(
      M39_QUEUES.consentExpiration,
      async () => {
        await runConsentExpirationCron({ ...base, activeOrgs: activeOrgsOf(deps) });
      },
      { connection, concurrency: M39_QUEUE_PARAMS.consentExpiration.concurrency },
    ),
    new Worker(
      M39_QUEUES.expirationReminder,
      async () => {
        await runExpirationReminderCron({ ...base, activeOrgs: activeOrgsOf(deps) });
      },
      { connection, concurrency: M39_QUEUE_PARAMS.expirationReminder.concurrency },
    ),
  ];
}

/** Parse `M39_QUEUE_PARAMS[*].backoff` (`"exponential 30s"`) into BullMQ's `{type, delay}`. */
function parseBackoff(spec: string): { type: "exponential" | "fixed"; delay: number } {
  const [type, duration] = spec.trim().split(/\s+/);
  const m = /^(\d+)(ms|s|m|h)$/.exec(duration ?? "");
  if ((type !== "exponential" && type !== "fixed") || !m)
    throw new Error(`M39_BACKOFF_PARSE: unrecognized backoff '${spec}'`);
  const n = Number(m[1]);
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "ms" | "s" | "m" | "h"];
  return { type, delay: n * mult };
}

/** Register the §4.9 repeatable hourly schedules. `removeOnFail: false` keeps each queue's failed-jobs set
 *  as the de facto DLQ (the M9/M14/M20 convention). Returns the `Queue`s to `close()`. */
export async function scheduleM39Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const specs = [
    {
      queue: M39_QUEUES.consentExpiration,
      pattern: M39_JOB_SCHEDULES.consentExpiration,
      params: M39_QUEUE_PARAMS.consentExpiration,
    },
    {
      queue: M39_QUEUES.expirationReminder,
      pattern: M39_JOB_SCHEDULES.expirationReminder,
      params: M39_QUEUE_PARAMS.expirationReminder,
    },
  ] as const;
  const queues: Queue[] = [];
  for (const spec of specs) {
    const queue = new Queue(spec.queue, { connection });
    await queue.add(
      "scheduled",
      {},
      {
        repeat: { pattern: spec.pattern },
        priority: spec.params.priority,
        attempts: spec.params.attempts,
        backoff: parseBackoff(spec.params.backoff),
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    queues.push(queue);
  }
  return queues;
}
