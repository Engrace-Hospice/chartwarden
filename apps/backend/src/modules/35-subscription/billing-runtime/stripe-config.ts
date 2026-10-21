// apps/backend/src/modules/35-subscription/billing-runtime/stripe-config.ts - GAP-058.
//
// Config-driven binding of the Stripe transport. Every piece is OPTIONAL and independent, and the absence of
// any one leaves that capability fail-closed (never a silent no-op that looks like billing worked):
//
//   STRIPE_SECRET_KEY           outbound calls (payment-method verification, refund execution). Unset => the
//                               bound client is the fail-closed port; attach refuses 503; refunds stay approved.
//   STRIPE_WEBHOOK_SECRET       inbound HMAC verification. Unset => POST /api/v1/webhooks/stripe is 503.
//   M35_WEBHOOK_PAYLOAD_KEY     base64 32-byte AES key for the stored webhook payload (D15). Unset => the
//                               webhook route is 503 (a payload is never stored in the clear) and the
//                               handler sweep is not scheduled.
//   STRIPE_API_BASE_URL         optional override (Stripe's mock server / a sandbox proxy).
import {
  type StripeClient,
  createFetchStripeHttpPort,
  createStripeClient,
} from "@chartwarden/subscription-billing";
import {
  type WebhookPayloadCipher,
  createWebhookPayloadCipher,
  parseWebhookPayloadKey,
} from "./webhook-payload-crypto";

export interface M35StripeConfig {
  /** Present only when `STRIPE_SECRET_KEY` is set. */
  readonly client: StripeClient | undefined;
  readonly webhookSecret: string | undefined;
  readonly cipher: WebhookPayloadCipher | undefined;
}

const nonEmpty = (v: string | undefined): string | undefined =>
  v !== undefined && v.trim().length > 0 ? v.trim() : undefined;

/** Read the Stripe bindings from the environment. A malformed payload key throws (fail loud at boot). */
export function loadM35StripeConfig(env: NodeJS.ProcessEnv): M35StripeConfig {
  const secretKey = nonEmpty(env.STRIPE_SECRET_KEY);
  const baseUrl = nonEmpty(env.STRIPE_API_BASE_URL);
  const payloadKey = nonEmpty(env.M35_WEBHOOK_PAYLOAD_KEY);
  return {
    client: secretKey
      ? createStripeClient(
          createFetchStripeHttpPort({ secretKey, ...(baseUrl ? { baseUrl } : {}) }),
        )
      : undefined,
    webhookSecret: nonEmpty(env.STRIPE_WEBHOOK_SECRET),
    cipher: payloadKey ? createWebhookPayloadCipher(parseWebhookPayloadKey(payloadKey)) : undefined,
  };
}
