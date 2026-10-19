// apps/backend/src/bootstrap/ack-queue-watchdog.ts - ADR-0079 (G-4): the stalled escalation worker check. The per-org notices of
// ack-queue-metrics.ts run INSIDE `messaging.ack_escalation_sweep`, so they cannot report that the sweep itself is not running. This is
// the same sample (shared with the gauges) read on a plain timer in every backend process, independent of BullMQ, with the notice claimed
// fleet-wide so N processes make one notice per window. The gauge `wardenx_m36_ack_escalation_stalled_seconds` is the scrape-side twin.
import type { AckQueueNotice, AckQueueSampler } from "./ack-queue-metrics";
import type { OpsNoticeClaims } from "./ops-notice-claims";

/** PROVISIONAL (ADR-0079, OPEN for operations): a request the sweep should have handled this long ago means the timer and sweep are not working. Five sweep ticks. */
export const STALLED_NOTICE_SECONDS = 5 * 60;
/** A lasting stall notifies again at most this often; the watchdog re-evaluates this often. */
export const STALLED_REPEAT_MS = 60 * 60 * 1000;
export const WATCHDOG_INTERVAL_MS = 60 * 1000;

const CLAIM_KEY = "m36.ack.escalation_stalled";

/** One evaluation. Never throws: a failed sample is skipped (the gauge reads -1 for it, which an operator alerts on). */
export async function checkEscalationStalled(deps: {
  readonly sample: AckQueueSampler;
  readonly claims: OpsNoticeClaims;
  readonly notify: (notice: AckQueueNotice) => void;
}): Promise<void> {
  const s = await deps.sample().catch(() => null);
  if (!s || s.orgsFailed > 0) return;
  if (s.escalationStalledSeconds < STALLED_NOTICE_SECONDS) {
    await deps.claims.release(CLAIM_KEY);
    return;
  }
  if (!(await deps.claims.claim(CLAIM_KEY, STALLED_REPEAT_MS))) return;
  deps.notify({
    kind: "m36.ack.escalation_stalled",
    summary: `the oldest acknowledgment request the escalation sweep should have handled is ${Math.round(s.escalationStalledSeconds / 60)} min past its deadline; check the messaging.ack_escalation_timer and messaging.ack_escalation_sweep workers`,
    details: { oldestUnprocessedSeconds: s.escalationStalledSeconds, orgsChecked: s.orgsChecked },
    correlationId: CLAIM_KEY,
  });
}

/** Starts the timer (unref'd, so it never holds the process open). Returns the stop function for `onClose`. */
export function startAckQueueWatchdog(
  deps: Parameters<typeof checkEscalationStalled>[0],
  intervalMs: number = WATCHDOG_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => void checkEscalationStalled(deps), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
