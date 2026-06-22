// @wardenx/dosespot — the inbound-webhook security envelope (M12-T06, spec §2.5 / §7.4 D7). `POST
// /webhooks/dosespot` is the only public-internet-facing route in M12; this module is the PURE crypto core
// the route handler (M12-T08) calls before it touches the DB. The full §7.4 envelope, in order:
//   (1) signature — HMAC-SHA256 of the RAW body with the per-tenant `webhookSecret`, constant-time compare
//       via `crypto.timingSafeEqual` (timing-attack-safe); mismatch → `INVALID_SIGNATURE` (401).
//   (2) timestamp — `X-DoseSpot-Timestamp` within ±5 min of `now()` (replay protection); else
//       `STALE_REQUEST` (400). `nowMs` is INJECTED (never read from a clock) so the boundary is unit-testable.
//   (3) tenant — the body carries `organization_id`; the handler loads that tenant's secret and (1) verifies
//       against it (a forged tenant fails the signature).
//   (4) dedup — the handler keys `(dosespotEventId, organizationId)` on `dosespot_webhook_event`'s unique
//       index; a re-delivery returns 200 with no double-processing. `webhookDedupKey` derives that key.
//   (5) body-at-rest — `webhookBodyDigest` is SHA-256 of the plaintext (stored as `body_digest`); the raw
//       body is persisted only as a per-tenant DEK envelope (M1), never logged in the clear (§7.4.7).
// No PHI ever leaves this module — it returns a verdict, never the decrypted body. Mirrors Integrations §3.7.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** §7.4 — the ±5-minute replay window (in ms) for `X-DoseSpot-Timestamp`. */
export const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

/** §7.4 — the rejection reasons, mapped to HTTP status by the route handler (M12-T08). */
export type WebhookRejectionReason =
  | "INVALID_SIGNATURE" // (1) HMAC mismatch → 401
  | "STALE_REQUEST" // (2) timestamp outside tolerance → 400
  | "MALFORMED_TIMESTAMP"; // (2) non-numeric / missing timestamp header → 400

/** The inputs the route handler hands the verifier (the raw body + the two security headers + the tenant
 * secret + the injected `nowMs`). `rawBody` is the EXACT bytes received — re-serializing breaks the HMAC. */
export interface WebhookVerifyInput {
  readonly rawBody: string;
  readonly signatureHeader: string | undefined;
  readonly timestampHeader: string | undefined;
  readonly webhookSecret: string;
  readonly nowMs: number;
  readonly toleranceMs?: number;
}

/** The verifier verdict: `ok: true` carries the plaintext SHA-256 digest the handler stores as `body_digest`
 * (§7.4.5); `ok: false` carries the rejection reason the handler maps to a status (no PHI either way). */
export type WebhookVerifyResult =
  | { readonly ok: true; readonly bodyDigest: string }
  | { readonly ok: false; readonly reason: WebhookRejectionReason };

/** §7.4.1 — HMAC-SHA256 (hex) of the raw body with the per-tenant secret (the expected signature). */
export function computeWebhookSignature(rawBody: string, webhookSecret: string): string {
  return createHmac("sha256", webhookSecret).update(rawBody, "utf8").digest("hex");
}

/** §7.4.5 — SHA-256 (hex) of the plaintext body, stored as `dosespot_webhook_event.body_digest` for later
 * integrity verification of the DEK-encrypted `raw_body_cipher`. */
export function webhookBodyDigest(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

/** §7.4.4 — the idempotency dedup key `(dosespotEventId, organizationId)` (the unique index on
 * `dosespot_webhook_event`); a re-delivery hitting this key returns 200 with no re-processing. */
export function webhookDedupKey(dosespotEventId: string, organizationId: string): string {
  return `${organizationId}:${dosespotEventId}`;
}

/**
 * §7.4.1 — constant-time signature comparison. Decodes both hex digests to bytes and compares via
 * `crypto.timingSafeEqual` (a length mismatch short-circuits to `false` BEFORE the compare, since
 * `timingSafeEqual` throws on unequal lengths — that length check is itself not secret-dependent).
 */
export function signaturesMatch(expectedHex: string, providedHex: string): boolean {
  if (expectedHex.length !== providedHex.length) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const provided = Buffer.from(providedHex, "hex");
  // `Buffer.from(hex)` silently drops invalid nibbles → re-check lengths match before the timing-safe compare.
  if (expected.length !== provided.length || expected.length === 0) return false;
  return timingSafeEqual(expected, provided);
}

/**
 * `verifyWebhookEnvelope` — the §7.4 (1)+(2) gate the route handler runs first. Returns `{ ok: true,
 * bodyDigest }` only when the timestamp is well-formed AND inside the tolerance AND the HMAC matches; else the
 * first failing reason. Timestamp is checked before signature so a stale replay is cheap to reject; both are
 * required. PURE — `nowMs` is injected; no clock, no IO, no PHI in the result.
 */
export function verifyWebhookEnvelope(input: WebhookVerifyInput): WebhookVerifyResult {
  const tolerance = input.toleranceMs ?? WEBHOOK_TIMESTAMP_TOLERANCE_MS;

  // (2) timestamp tolerance — reject a missing / non-numeric / out-of-window timestamp (replay protection).
  if (input.timestampHeader === undefined || input.timestampHeader.trim() === "") {
    return { ok: false, reason: "MALFORMED_TIMESTAMP" };
  }
  const ts = Number(input.timestampHeader);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: "MALFORMED_TIMESTAMP" };
  }
  if (Math.abs(input.nowMs - ts) > tolerance) {
    return { ok: false, reason: "STALE_REQUEST" };
  }

  // (1) signature — HMAC-SHA256 of the raw body with the per-tenant secret, constant-time compare.
  if (input.signatureHeader === undefined || input.signatureHeader.trim() === "") {
    return { ok: false, reason: "INVALID_SIGNATURE" };
  }
  const expected = computeWebhookSignature(input.rawBody, input.webhookSecret);
  if (!signaturesMatch(expected, input.signatureHeader.trim())) {
    return { ok: false, reason: "INVALID_SIGNATURE" };
  }

  return { ok: true, bodyDigest: webhookBodyDigest(input.rawBody) };
}
