// @wardenx/messaging — Twilio webhook signature verification (M36-T08, spec §4.9.2 / SD-056).
//
// Twilio signs each callback with HMAC-SHA1 over `(POST URL + sorted-param key=value concat)` using
// the account Auth Token, base64-encoded into `X-Twilio-Signature`. The spec shows the `twilio` SDK
// `validateRequest` helper; this package stays dependency-free (only @wardenx/types), so we
// implement the SAME published algorithm directly with `node:crypto` — production may swap in the
// SDK at the wiring layer, but the bytes computed here are identical. The Auth Token comes from the
// tenant secret store (M1 §8.3); the signing URL must match the configured public URL EXACTLY
// (scheme, host, port, path prefix), or the HMAC differs and the request is rejected.
import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookError } from "./errors";

/** The request fields the Twilio HMAC is computed over (§4.9.2). */
export interface TwilioVerifyRequest {
  /** The exact public callback URL Twilio signed (scheme+host+port+path), no query string mangling. */
  readonly url: string;
  /** Request headers (lower-cased keys); `x-twilio-signature` carries the base64 HMAC. */
  readonly headers: Record<string, string>;
  /** The form-encoded POST body as key/value pairs. */
  readonly body: Record<string, string>;
  /** The account Auth Token (tenant secret store, M1 §8.3). */
  readonly authToken: string;
}

/**
 * Compute the Twilio signature for `(url, body, authToken)` per the published algorithm: start from
 * the full URL, then for each POST param in lexicographic key order append `key + value` (no
 * separator), HMAC-SHA1 under the Auth Token, base64. Pure + deterministic — the verifier compares
 * this against the supplied header.
 */
export function computeTwilioSignature(
  url: string,
  body: Record<string, string>,
  authToken: string,
): string {
  const data = Object.keys(body)
    .sort()
    .reduce((acc, key) => acc + key + body[key], url);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

/** Constant-time string compare that tolerates unequal lengths (no early-exit length oracle). */
function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a Twilio webhook signature (§4.9.2). Recomputes the HMAC and compares it (constant-time)
 * against `X-Twilio-Signature`; throws `WebhookError(401, 'INVALID_SIGNATURE')` on any mismatch
 * (including a missing header). Call AFTER {@link assertReplayWindow}.
 */
export function verifyTwilioSignature(req: TwilioVerifyRequest): void {
  const provided = req.headers["x-twilio-signature"] ?? "";
  const expected = computeTwilioSignature(req.url, req.body, req.authToken);
  if (!constantTimeEquals(provided, expected)) {
    throw new WebhookError(401, "INVALID_SIGNATURE");
  }
}
