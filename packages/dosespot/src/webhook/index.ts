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
// F-230 — the inbound body contract (§4.2 envelope is spec-defined; the script_status_update inner payload is
// PROVISIONAL pending vendor documentation — see payloads.ts).
export {
  DOSESPOT_DISPENSE_STATUSES,
  DOSESPOT_WEBHOOK_EVENT_TYPES,
  DOSESPOT_WIRE_MAPPING_VERIFIED,
  DoseSpotScriptStatusUpdatePayloadSchema,
  DoseSpotWebhookEnvelopeSchema,
  isDispenseStatus,
  parseScriptStatusUpdate,
  parseWebhookEnvelope,
  type DoseSpotDispenseStatus,
  type DoseSpotScriptStatusUpdatePayload,
  type DoseSpotWebhookEnvelope,
  type DoseSpotWebhookEventType,
  type ScriptStatusParseResult,
  type WebhookEnvelopeParseResult,
} from "./payloads";
