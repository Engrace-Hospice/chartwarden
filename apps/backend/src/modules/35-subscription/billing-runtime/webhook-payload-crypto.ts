// apps/backend/src/modules/35-subscription/billing-runtime/webhook-payload-crypto.ts - GAP-058.
//
// The D15 at-rest protection for the raw Stripe webhook payload (`stripe_webhook_event.payload_ciphertext`). The cipher
// itself lives in @chartwarden/shared (shared with M23's Claim.MD receipts); this file keeps M35's key env name and key
// id so its behaviour and stored format are unchanged. The key comes from `M35_WEBHOOK_PAYLOAD_KEY` (base64, 32 bytes)
// - a SEPARATE secret from the Stripe credentials and the pseudonym KEK.
import {
  type WebhookPayloadCipher,
  WebhookPayloadKeyError,
  createWebhookPayloadCipher as createSharedCipher,
  parseWebhookPayloadKey as parseSharedKey,
} from "@chartwarden/shared";

export { WebhookPayloadKeyError };
export type { WebhookPayloadCipher };

/** Parse a base64 32-byte key, or throw (a wrong-length key must never silently weaken the cipher). */
export function parseWebhookPayloadKey(base64Key: string): Buffer {
  return parseSharedKey(base64Key, "M35_WEBHOOK_PAYLOAD_KEY");
}

export function createWebhookPayloadCipher(
  key: Buffer,
  keyId = "m35-webhook-v1",
): WebhookPayloadCipher {
  return createSharedCipher(key, keyId);
}
