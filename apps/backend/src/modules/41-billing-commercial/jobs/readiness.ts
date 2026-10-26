// apps/backend/src/modules/41-billing-commercial/jobs/readiness.ts - whether the submission drain is actually scheduled.
//
// "Bound is not computing": POST /submit queues a durable row that only the drain sends. If the repeatable schedule could not be
// registered (a Valkey blip at boot) or no queue connection exists at all, accepting a submission would queue a row nothing sends. So
// the routes consult this flag and refuse with a typed 503 while it is false. Peers (M25, M31, M33) log and swallow a schedule failure;
// failing the whole API boot for a Redis blip would take every other module down with it, so M41 instead stays up, says so loudly,
// refuses the one thing that cannot work, and keeps retrying the registration in the background with a bounded backoff.
import type { Queue } from "bullmq";

export interface DrainReadiness {
  /**
   * True once both the submission drain and the acknowledgment pull have their repeatable schedule registered. May answer
   * asynchronously: in a split deployment the API process asks the shared queue store (see {@link createSharedDrainReadiness}).
   */
  drainScheduled(): boolean | Promise<boolean>;
}

export interface MutableDrainReadiness extends DrainReadiness {
  drainScheduled(): boolean;
  markScheduled(): void;
  markNotScheduled(): void;
}

/** Starts NOT scheduled: with no queue connection nothing ever flips it, and nothing would send. */
export function createDrainReadiness(): MutableDrainReadiness {
  let scheduled = false;
  return {
    drainScheduled: () => scheduled,
    markScheduled: () => {
      scheduled = true;
    },
    markNotScheduled: () => {
      scheduled = false;
    },
  };
}

/** How long a positive / negative shared-state answer is reused. A negative one is short so a freshly registered schedule is seen quickly. */
export const SHARED_READINESS_TTL_MS = 20_000;
export const SHARED_READINESS_NEGATIVE_TTL_MS = 5_000;

export interface SharedReadinessOptions {
  /** This process' own registration flag (set by the worker / all roles when they register the schedule). */
  readonly local: DrainReadiness;
  /**
   * Looks at the SHARED queue store (Valkey) for both schedules. Present whenever a queue connection exists. Absent = nothing to ask,
   * and with the local flag false the answer is false (fail closed): no queue connection means nothing would ever send.
   */
  readonly probe?: () => Promise<boolean>;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly negativeTtlMs?: number;
}

/**
 * Readiness that reflects SHARED state, not a per-process flag. In the split deployment (PROCESS_ROLE=api serving requests, a separate
 * worker process registering the repeatable jobs) the API process never registers anything itself, so its own flag stays false; it
 * asks the queue store whether both repeatable schedules exist instead. A fault in the probe is "not scheduled" (fail closed). The
 * answer is cached briefly so a request does not cost a round trip to Valkey.
 */
export function createSharedDrainReadiness(options: SharedReadinessOptions): DrainReadiness {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? SHARED_READINESS_TTL_MS;
  const negativeTtl = options.negativeTtlMs ?? SHARED_READINESS_NEGATIVE_TTL_MS;
  let cached: { readonly at: number; readonly value: boolean } | null = null;
  let inFlight: Promise<boolean> | null = null;
  return {
    async drainScheduled(): Promise<boolean> {
      if (await options.local.drainScheduled()) return true;
      const probe = options.probe;
      if (!probe) return false;
      if (cached && now() - cached.at < (cached.value ? ttl : negativeTtl)) return cached.value;
      inFlight ??= probe()
        .catch(() => false)
        .then((value) => {
          cached = { at: now(), value };
          return value;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}

/** The always-ready value for tests and for callers that do not run workers. */
export const ALWAYS_READY: DrainReadiness = { drainScheduled: () => true };

/** Retry delays (ms) after a failed registration: bounded, about half an hour in all, then it stays not scheduled. */
export const SCHEDULE_RETRY_DELAYS_MS: readonly number[] = [
  5_000, 15_000, 45_000, 120_000, 300_000, 300_000, 300_000, 300_000, 300_000, 300_000,
];

export interface ScheduleWithRetryOptions {
  readonly schedule: () => Promise<Queue[]>;
  readonly onScheduled: (queues: Queue[]) => void;
  /** `nextDelayMs` is null when the retries are used up. */
  readonly onFailure: (err: unknown, attempt: number, nextDelayMs: number | null) => void;
  readonly delaysMs?: readonly number[];
  /** Injected for tests; the real timer is unref'd so a pending retry never keeps the process alive. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
}

/**
 * Try to register the schedule now; on failure report it and retry in the background with the bounded backoff. Resolves after the FIRST
 * attempt (success or failure), so boot continues either way. Never throws.
 */
export async function scheduleWithRetry(options: ScheduleWithRetryOptions): Promise<void> {
  const delays = options.delaysMs ?? SCHEDULE_RETRY_DELAYS_MS;
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      timer.unref();
      return timer;
    });
  const attempt = async (n: number): Promise<void> => {
    try {
      options.onScheduled(await options.schedule());
    } catch (err) {
      const next = n < delays.length ? (delays[n] ?? null) : null;
      options.onFailure(err, n + 1, next);
      if (next !== null) setTimer(() => void attempt(n + 1), next);
    }
  };
  await attempt(0);
}
