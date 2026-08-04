// @wardenx/dosespot — the per-call exponential backoff schedule (M12-T06, spec §4.10). The §4.10 adapter
// `call()` wraps each DoseSpot request in `retryable(..., { maxAttempts: 3, baseDelayMs: 250 })`: a 429 or a
// 5xx raises {@link RetryableError} and the call re-attempts at 250ms / 500ms / 1000ms before the third
// exhaust converts to a `retryable: true` {@link DegradedError}. The delay schedule is PURE and deterministic
// (no clock, no `Math.random` jitter — the live transport adds host jitter at sleep time); keeping it as data
// lets the worker unit-test the exhaust-and-degrade boundary without sleeping. Edge §5.1 W-MR-01: 429 →
// retries 250/500/1000 → on third exhaust `DegradedError` → worker writes `transmission_failed_at`.
import { RetryableError } from "./errors";

/** §4.10 platform retry defaults for a single DoseSpot call (the per-call layer, not the BullMQ job layer). */
export const DOSESPOT_RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 250,
} as const;

export type DoseSpotRetryConfig = typeof DOSESPOT_RETRY_CONFIG;

/**
 * `computeBackoffDelays` — the deterministic per-attempt backoff schedule. With the §4.10 defaults
 * (`maxAttempts: 3`, `baseDelayMs: 250`) this yields `[250, 500, 1000]` (the delay BEFORE attempts 2, 3, and
 * the would-be 4th — the live transport uses `length === maxAttempts - 1` of them and degrades after). Pure:
 * `delay(n) = baseDelayMs * 2^n`.
 */
export function computeBackoffDelays(
  config: DoseSpotRetryConfig = DOSESPOT_RETRY_CONFIG,
): readonly number[] {
  return Array.from({ length: config.maxAttempts }, (_unused, i) => config.baseDelayMs * 2 ** i);
}

/**
 * `nextRetryDecision` — fold one attempt outcome into the per-call retry verdict: given the attempt index
 * (0-based) and the config, should the adapter retry, and after what delay? `retry: false` once the index
 * reaches `maxAttempts - 1` (exhausted → the caller converts the {@link RetryableError} to a degraded error).
 * Pure + total — the worker tests the exhaust boundary with no sleeping.
 */
export function nextRetryDecision(
  attemptIndex: number,
  config: DoseSpotRetryConfig = DOSESPOT_RETRY_CONFIG,
): { readonly retry: boolean; readonly delayMs: number } {
  const exhausted = attemptIndex >= config.maxAttempts - 1;
  if (exhausted) return { retry: false, delayMs: 0 };
  return { retry: true, delayMs: config.baseDelayMs * 2 ** (attemptIndex + 1) };
}

/**
 * Map an upstream HTTP status to a {@link RetryableError} reason, or `null` when the status is not in-call
 * retryable (4xx other than 429 → permanent → the caller raises a `retryable: false` degraded error). §4.10:
 * 429 → `rate_limited`; ≥500 → `upstream_5xx`.
 */
export function classifyRetryableStatus(status: number): RetryableError | null {
  if (status === 429) return new RetryableError("rate_limited", "rate_limited");
  if (status >= 500) return new RetryableError("upstream_5xx", `5xx_${status}`);
  return null;
}
