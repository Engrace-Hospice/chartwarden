// @chartwarden/messaging — Postmark webhook verification (M36-T08, spec §4.9.2 / INT-016 / SD-056).
//
// Per INT-016, Postmark authenticity rests on TWO complementary controls — both active, both must
// pass:
//   1. DNS/IP-based sender validation — the request must originate from a Postmark-owned IP range
//      (the gateway / webhook router maintains a 6-hourly-refreshed allowlist cached in Valkey and
//      passes the result in as `sourceIpAllowed`). A non-Postmark IP is rejected `403`.
//   2. Bearer-token verification — a tenant-specific shared secret (`Authorization: Bearer <token>`,
//      tenant secret store M1 §8.3, 90-day rotation) compared in CONSTANT TIME.
// Both are exercised by §9.4: a valid token from a non-Postmark IP is rejected; an invalid token
// from a valid IP is rejected. Call AFTER the replay-window guard.
import { timingSafeEqual } from "node:crypto";
import { WebhookError } from "./errors";

/** The fields the Postmark verification reads (§4.9.2). */
export interface PostmarkVerifyRequest {
  /** Request headers (lower-cased keys); `authorization` carries `Bearer <token>`. */
  readonly headers: Record<string, string>;
  /** The expected per-webhook shared secret (tenant secret store, M1 §8.3). */
  readonly expectedToken: string;
  /** Whether the source IP is in the Postmark allowlist — pre-checked by the gateway / router. */
  readonly sourceIpAllowed: boolean;
}

/**
 * Verify a Postmark event webhook (§4.9.2 / INT-016). Rejects a non-Postmark source IP
 * (`403 FORBIDDEN_SOURCE`), a missing bearer (`401 MISSING_BEARER_TOKEN`), and a wrong/short token
 * (`401 INVALID_BEARER_TOKEN`) — the token compare is constant-time and length-guarded (no length
 * or timing oracle). The IP check runs first so a forged request never reaches the token compare.
 */
export function verifyPostmarkWebhook(req: PostmarkVerifyRequest): void {
  if (!req.sourceIpAllowed) throw new WebhookError(403, "FORBIDDEN_SOURCE");

  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) throw new WebhookError(401, "MISSING_BEARER_TOKEN");

  const provided = Buffer.from(auth.slice(7));
  const expected = Buffer.from(req.expectedToken);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new WebhookError(401, "INVALID_BEARER_TOKEN");
  }
}
