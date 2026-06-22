// @wardenx/consent — the revocation-cascade status machine (§2.2.3, D7).
//
// M39-T04. The typed cascade walks pending → in_progress → completed, or → partial_failed when the
// retry budget (5 attempts over 1h, exponential backoff per the M1 outbox helper) is exhausted with
// one or more consumers still un-ACKed. Each consumer ACKs idempotently on
// (consent_record_id, revocation_id, consumer_name); this module is the pure status arbiter the
// revocation-cascade-retry cron consults — it does NOT perform the dispatch (that is the service +
// outbox helper, M39-F08).
import type { ConsentRevocationCascadeStatus } from "../interfaces/kinds";
import { type Decision, deny, ok } from "./result";

export const CASCADE_MAX_ATTEMPTS = 5;

export interface CascadeProgress {
  readonly status: ConsentRevocationCascadeStatus;
  /** consumer name → ACKed. */
  readonly consumers: Readonly<Record<string, boolean>>;
  /** attempts spent so far (incremented per retry sweep). */
  readonly attempts: number;
}

/** Resolve the next cascade status after a sweep that may have collected new consumer ACKs.
 *  All consumers ACKed → completed; budget exhausted with stragglers → partial_failed (alerts M36);
 *  otherwise in_progress (the retry cron will sweep again). */
export function nextCascadeStatus(
  progress: CascadeProgress,
): Decision<ConsentRevocationCascadeStatus> {
  if (progress.status === "completed" || progress.status === "partial_failed")
    return ok<ConsentRevocationCascadeStatus>(progress.status); // terminal
  const consumerStates = Object.values(progress.consumers);
  const allAcked = consumerStates.length > 0 && consumerStates.every(Boolean);
  if (allAcked) return ok<ConsentRevocationCascadeStatus>("completed");
  if (progress.attempts >= CASCADE_MAX_ATTEMPTS)
    return deny(
      "cascade_retry_budget_exhausted",
      `cascade unresolved after ${progress.attempts} attempts → partial_failed (alert m39.consent.revoked_cascade_failed)`,
    );
  return ok<ConsentRevocationCascadeStatus>("in_progress");
}

/** The terminal status a budget-exhausted cascade lands in (the caller stamps it + fires the alert). */
export const CASCADE_FAILED: ConsentRevocationCascadeStatus = "partial_failed";

/** Whether a given consumer still needs a (re)dispatch this sweep (idempotent: ACKed consumers skip). */
export function consumerNeedsDispatch(progress: CascadeProgress, consumer: string): boolean {
  return progress.consumers[consumer] !== true;
}
