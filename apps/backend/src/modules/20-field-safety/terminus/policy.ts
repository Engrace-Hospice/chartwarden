// apps/backend/src/modules/20-field-safety/terminus/policy.ts - GAP-032: the named constants and the pure
// pacing rules of the SOS emergency-terminus ledger. No IO. Not tenant-tunable-down (spec 8.3's posture for
// the chain): a tenant can add escalation, it cannot shorten the safety floor.
import type { SafetyTerminusActionKind, SafetyTerminusActionStatus } from "@wardenx/types";

/** At most this many contact calls per alert. */
export const DIAL_MAX_ATTEMPTS = 3;
/** A contact call is redialled only this long after the previous attempt settled `failed`. */
export const DIAL_REDIAL_SPACING_MS = 10 * 60 * 1000;
/** An executor claim is good for this long; a crashed executor's `attempting` row is recoverable after it. */
export const TERMINUS_LEASE_MS = 60 * 1000;
/** A row retried in place (transient failure) gives up after this many tries; the next loop period issues a fresh row. */
export const TERMINUS_MAX_ROW_ATTEMPTS = 5;
const RETRY_BACKOFF_STEP_MS = 15 * 1000;
const RETRY_BACKOFF_CAP_MS = 60 * 1000;

/** `m20:sos:{alertId}:{kind}:{iteration}:{attempt}` - the ledger idempotency key. */
export function terminusIdempotencyKey(
  sosAlertId: string,
  kind: SafetyTerminusActionKind,
  loopIteration: number,
  attemptNo: number,
): string {
  return `m20:sos:${sosAlertId}:${kind}:${loopIteration}:${attemptNo}`;
}

export function dialIdempotencyKey(
  sosAlertId: string,
  loopIteration: number,
  attemptNo: number,
): string {
  return terminusIdempotencyKey(sosAlertId, "dial_contact", loopIteration, attemptNo);
}

/** Delay before an in-place retry of a row that has been tried `attempts` times: 15 s, 30 s, then 60 s. */
export function retryBackoffMs(attempts: number): number {
  return Math.min(RETRY_BACKOFF_STEP_MS * 2 ** Math.max(0, attempts - 1), RETRY_BACKOFF_CAP_MS);
}

export interface PriorDialRow {
  readonly attemptNo: number;
  readonly status: SafetyTerminusActionStatus;
  readonly outcomeCode: string | null;
  readonly settledAt: Date | null;
}

export type DialPlan =
  | { readonly kind: "insert"; readonly attemptNo: number }
  | { readonly kind: "none" };

/**
 * Should this loop iteration plan another contact call, and as which attempt?
 *
 *   - never planned: attempt 0 (the terminus entry);
 *   - one pending / in flight / accepted by the vendor: nothing (a placed call is never repeated);
 *   - a terminal skip (no consent, invalid number, dial disabled, voice unbound): nothing;
 *   - settled `failed`: redial only after {@link DIAL_REDIAL_SPACING_MS}, and never past {@link DIAL_MAX_ATTEMPTS}.
 */
export function planDialAttempt(input: {
  readonly priorDialRows: readonly PriorDialRow[];
  readonly now: Date;
}): DialPlan {
  const rows = input.priorDialRows;
  if (rows.length === 0) return { kind: "insert", attemptNo: 0 };
  if (
    rows.some(
      (r) => r.status === "pending" || r.status === "attempting" || r.status === "succeeded",
    )
  ) {
    return { kind: "none" };
  }
  if (rows.some((r) => r.status === "skipped" || r.status === "superseded"))
    return { kind: "none" };
  if (rows.length >= DIAL_MAX_ATTEMPTS) return { kind: "none" };
  const lastSettledMs = Math.max(...rows.map((r) => r.settledAt?.getTime() ?? 0));
  if (input.now.getTime() - lastSettledMs < DIAL_REDIAL_SPACING_MS) return { kind: "none" };
  return { kind: "insert", attemptNo: Math.max(...rows.map((r) => r.attemptNo)) + 1 };
}
