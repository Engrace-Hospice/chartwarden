// @wardenx/messaging — webhook timestamp replay window (M36-T08, spec §4.9.1 / SD-056).
//
// Shared by all three inbound webhook handlers (Twilio sms-status / voice-status, Postmark event).
// Call at the TOP of each handler, BEFORE signature verification — a stale request need not be
// verified at all (avoid a timing oracle). Every inbound payload is gated against a 5-minute
// (±300 s) window anchored to server UTC: Twilio sends `X-Twilio-Timestamp` (epoch seconds),
// Postmark sends the ISO-8601 `Date` header. The window rejects replayed/forged stale copies while
// still allowing legitimate Postmark retries (each retry carries a fresh `Date`).
import { WebhookError } from "./errors";

/** The ±replay tolerance in seconds (§4.9.1). */
export const REPLAY_WINDOW_SECONDS = 300;

/**
 * Reject a webhook whose timestamp is outside the ±300 s replay window (§4.9.1). Accepts either a
 * Twilio epoch-seconds string or a Postmark ISO-8601 `Date` header (both parse via the numeric /
 * Date paths below). Throws `WebhookError(400, …)` on a missing/invalid/expired timestamp — log
 * `diffSeconds` at warn for ops; repeated offenders are rate-limited at the gateway.
 */
export function assertReplayWindow(
  timestampHeader: string | undefined,
  nowMs: number = Date.now(),
): void {
  if (!timestampHeader) throw new WebhookError(400, "MISSING_TIMESTAMP_HEADER");

  // Twilio: epoch seconds ("1718452800"); Postmark: ISO-8601 ("2026-06-15T12:00:00Z").
  const tMs = /^\d+$/.test(timestampHeader.trim())
    ? Number(timestampHeader) * 1000
    : Date.parse(timestampHeader);
  if (Number.isNaN(tMs)) throw new WebhookError(400, "INVALID_TIMESTAMP_HEADER");

  const diffSeconds = Math.abs((nowMs - tMs) / 1000);
  if (diffSeconds > REPLAY_WINDOW_SECONDS) {
    throw new WebhookError(400, "REPLAY_WINDOW_EXPIRED");
  }
}
