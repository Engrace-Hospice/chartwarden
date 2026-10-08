// @wardenx/messaging — out-of-band notification surface (M36-T06, spec §4.7).
//
// The PHI sanitization wrapper — the only path to out-of-band vendors. The vendor dispatchers
// (twilio/postmark/web-push) + the dependency-cruiser rule that forces every one of them through
// this chokepoint land with M36-T08; this barrel ships the sanitizer they will consume.

export {
  sanitizeForOutOfBand,
  type Alert,
  type Message,
  type SanitizedNotification,
  type OutOfBandChannel,
} from "./sanitize";

// FB-T14 — the M36-owned TRANSACTIONAL email transport (password reset / magic-link delivery; the
// auth `EmailTransport` seam binds to this at the composition root). DR/INT #14 (Postmark = M36).
export {
  selectTransactionalEmailTransport,
  createConsoleTransactionalEmailTransport,
  createNoopTransactionalEmailTransport,
  type OutboundEmail,
  type TransactionalEmailTransport,
} from "./transactional-email";

// Postmark HTTP adapter for the port above + env-driven bind decision (credentials only from env).
export {
  createPostmarkTransactionalEmailTransport,
  resolvePostmarkConfig,
  postmarkConfigAttempted,
  EmailDeliveryError,
  POSTMARK_ENV,
  type EmailDeliveryErrorCode,
  type PostmarkConfigResult,
  type PostmarkTransportOptions,
} from "./postmark-transactional-email";
