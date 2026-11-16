// apps/backend/src/modules/10-hope/jobs/deadline.ts — one awaited call raced against a deadline, so a hung call fails ITS
// org (logged, counted) instead of stalling a sequential per-org job for every org after it. Two callers, two constants:
// the port reads in ./cron-workers.ts (the retention holds and override reads, the submit worker's CCN read, the reconcile
// worker's acceptance-report read) are bounded by `M10_SEAM_READ_TIMEOUT_MS` below, and the alert emit
// (./watchdog-alerts.ts) passes its own `M10_ALERT_EMIT_TIMEOUT_MS` (equal today, tuned separately: changing one leaves the
// other, and the worst-case figures in ./watchdog-ticks.ts, as they were).

/** How long a job waits on one port read (a seam call into another module) before it gives up on it and fails that org. */
export const M10_SEAM_READ_TIMEOUT_MS = 10_000;

/** A port read that did not answer in time. Logged by class and `what` only (see `describeError`); `what` names the call. */
export class DeadlineError extends Error {
  constructor(
    readonly what: string,
    ms: number,
  ) {
    super(`${what} did not answer within ${ms} ms`);
    this.name = "DeadlineError";
  }
}

/**
 * `work()` raced against `ms`. The call cannot be cancelled: if it settles after the deadline, `Promise.race` has already
 * subscribed to it, so a late rejection is handled (never an unhandled rejection); the timer is always cleared. A
 * synchronous throw from `work` becomes a rejection BEFORE the timer exists, so it cannot leak one. `onAbandoned` is
 * called (once, with the call's own promise) only when the deadline wins, so a caller can track the calls still running.
 * The deadline's rejection is settled FIRST: a `timeoutError` or `onAbandoned` that throws can never leave the returned
 * promise pending (the stall this function exists to prevent) or surface as an uncaught exception; a throwing `timeoutError`
 * falls back to a plain `Error`, and a throwing `onAbandoned` is logged by its error class only.
 */
export function withinDeadline<T>(
  work: () => Promise<T>,
  ms: number,
  timeoutError: () => Error,
  onAbandoned?: (late: Promise<T>) => void,
): Promise<T> {
  const call = new Promise<T>((resolve) => resolve(work()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      let error: Error;
      try {
        error = timeoutError();
      } catch {
        error = new Error(`the call did not answer within ${ms} ms`);
      }
      reject(error);
      try {
        onAbandoned?.(call);
      } catch (hookError) {
        console.error(
          `m10: a deadline's onAbandoned hook threw (${hookError instanceof Error ? hookError.name : "non-error"}); the abandoned call is no longer tracked.`,
        );
      }
    }, ms);
  });
  return Promise.race([call, deadline]).finally(() => clearTimeout(timer));
}
