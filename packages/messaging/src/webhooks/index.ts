// @chartwarden/messaging — webhook security layer (M36-T08, spec §4.9 / SD-056 / INT-016).
//
// The §4.9 two-layer inbound-webhook defense, shared by all three handlers (Twilio sms-status /
// voice-status, Postmark event): the replay-window guard (§4.9.1) + the signature verifiers
// (§4.9.2, Twilio HMAC-SHA1 / Postmark IP-allowlist + bearer token), and the `WebhookError` the
// handler throws on rejection. Both layers run BEFORE any application logic; neither may be
// short-circuited. The Fastify routes that compose these live in the M36 module
// (apps/backend/src/modules/36-messaging/routes/webhook-routes.ts).
export { WebhookError } from "./errors";
export { REPLAY_WINDOW_SECONDS, assertReplayWindow } from "./replay-guard";
export {
  type TwilioVerifyRequest,
  computeTwilioSignature,
  verifyTwilioSignature,
} from "./verify-twilio";
export { type PostmarkVerifyRequest, verifyPostmarkWebhook } from "./verify-postmark";
