// @wardenx/dosespot — the §7.4 D7 inbound-webhook security envelope (M12-T06). HMAC-SHA256 signature
// verification (constant-time), the ±5-minute replay window, the `(dosespotEventId, organizationId)` dedup
// key, and the plaintext SHA-256 body digest — the PURE crypto the `POST /webhooks/dosespot` handler
// (M12-T08) runs before it persists the DEK-encrypted `dosespot_webhook_event` row.
export {
  WEBHOOK_TIMESTAMP_TOLERANCE_MS,
  computeWebhookSignature,
  signaturesMatch,
  verifyWebhookEnvelope,
  webhookBodyDigest,
  webhookDedupKey,
  type WebhookRejectionReason,
  type WebhookVerifyInput,
  type WebhookVerifyResult,
} from "./verify";
