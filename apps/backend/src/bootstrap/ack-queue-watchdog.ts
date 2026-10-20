// apps/backend/src/bootstrap/ack-queue-watchdog.ts - ADR-0079 (G-4): the stalled escalation worker check. The per-org notices of
// ack-queue-metrics.ts run INSIDE `messaging.ack_escalation_sweep`, so they cannot report that the sweep itself is not running. This reads
// the stalled figure on a plain timer in every backend process, independent of BullMQ, through the SAME guarded sampler as the gauges
// (30 s cache, 8 s timeout, one sample in flight, -1 semantics), with the notice claimed fleet-wide so N processes make one notice.
//
// Cost control: the sample enumerates the active organisations through an AUDITED platform bypass. Each tick first takes a fleet-wide
// claim (TICK_CLAIM_MS), so with Valkey up one process per minute samples, not one per process; the sampler's cache means a scrape in the
// same 30 s adds none. RESIDUAL: with Valkey down the claim falls back to per process, so each process samples once a minute (one audited
// enumeration per process per minute) until Valkey returns; and a scrape of /metrics still samples on its own, as before this change.
//
// The check can be UNMEASURED (sample null: database/platform pool unreachable, timeout; or an organisation could not be counted). After
// UNMEASURED_TICKS consecutive unmeasured ticks it raises a distinct `m36.ack.escalation_stall_unmeasured` notice (claim-deduped), so a
// blind watchdog is not mistaken for a healthy one. A tick skipped because another process holds the claim is neither measured nor unmeasured.
import type { AckQueueNotice, AckQueueSample, AckQueueSampler } from "./ack-queue-metrics";
import type { OpsNoticeClaims } from "./ops-notice-claims";

/** PROVISIONAL (ADR-0079, OPEN for operations): a request the sweep should have handled this long ago means the timer and sweep are not working. Five sweep ticks. */
export const STALLED_NOTICE_SECONDS = 5 * 60;
/** A lasting stall (or blindness) notifies again at most this often; the watchdog re-evaluates this often. */
export const STALLED_REPEAT_MS = 60 * 60 * 1000;
export const WATCHDOG_INTERVAL_MS = 60 * 1000;
/** Fleet-wide: one process samples per this window (a little under the interval, so the next tick can take it). */
export const TICK_CLAIM_MS = 50 * 1000;
/** Consecutive unmeasured ticks before the "unmeasured" notice. */
export const UNMEASURED_TICKS = 3;

const CLAIM_KEY = "m36.ack.escalation_stalled";
const UNMEASURED_KEY = "m36.ack.escalation_stall_unmeasured";
const TICK_KEY = "m36.ack.watchdog_tick";

export type WatchdogOutcome = "stalled" | "ok" | "unmeasured" | "skipped";

export interface WatchdogDeps {
  readonly sample: AckQueueSampler;
  readonly claims: OpsNoticeClaims;
  readonly notify: (notice: AckQueueNotice) => void;
}

/** One evaluation of an already-taken sample. Pure of timers; never throws. */
export async function evaluateStalled(
  deps: Pick<WatchdogDeps, "claims" | "notify">,
  s: AckQueueSample,
): Promise<"stalled" | "ok"> {
  if (s.escalationStalledSeconds < STALLED_NOTICE_SECONDS) {
    await deps.claims.release(CLAIM_KEY);
    return "ok";
  }
  if (await deps.claims.claim(CLAIM_KEY, STALLED_REPEAT_MS)) {
    deps.notify({
      kind: "m36.ack.escalation_stalled",
      summary: `the oldest acknowledgment request the escalation sweep should have handled is ${Math.round(s.escalationStalledSeconds / 60)} min past its deadline; check the messaging.ack_escalation_timer and messaging.ack_escalation_sweep workers (a backlog that predates enabling messaging.escalation_timers also shows here until the sweep catches up)`,
      details: { oldestUnprocessedSeconds: s.escalationStalledSeconds, orgsChecked: s.orgsChecked },
      correlationId: CLAIM_KEY,
    });
  }
  return "stalled";
}

/** Builds the tick: one in flight at a time, fleet-wide tick claim, unmeasured counter. Never throws. */
export function createWatchdogTick(deps: WatchdogDeps): () => Promise<WatchdogOutcome> {
  let running = false;
  let unmeasuredInARow = 0;
  return async () => {
    if (running) return "skipped";
    running = true;
    try {
      if (!(await deps.claims.claim(TICK_KEY, TICK_CLAIM_MS))) return "skipped";
      const s = await deps.sample().catch(() => null);
      if (!s || s.orgsFailed > 0) {
        unmeasuredInARow += 1;
        if (
          unmeasuredInARow >= UNMEASURED_TICKS &&
          (await deps.claims.claim(UNMEASURED_KEY, STALLED_REPEAT_MS))
        ) {
          deps.notify({
            kind: "m36.ack.escalation_stall_unmeasured",
            summary: `the escalation stall check could not measure for ${unmeasuredInARow} consecutive minutes (database or platform pool unreachable, or an organisation could not be counted); a stalled escalation worker would go unreported`,
            details: { consecutiveUnmeasuredTicks: unmeasuredInARow },
            correlationId: UNMEASURED_KEY,
          });
        }
        return "unmeasured";
      }
      unmeasuredInARow = 0;
      await deps.claims.release(UNMEASURED_KEY);
      return await evaluateStalled(deps, s);
    } catch {
      return "unmeasured"; // a claim/notify failure must not kill the timer; the next tick tries again
    } finally {
      running = false;
    }
  };
}

/** Starts the timer (unref'd, so it never holds the process open). Returns the stop function for `onClose`. */
export function startAckQueueWatchdog(
  deps: WatchdogDeps,
  intervalMs: number = WATCHDOG_INTERVAL_MS,
): () => void {
  const tick = createWatchdogTick(deps);
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
