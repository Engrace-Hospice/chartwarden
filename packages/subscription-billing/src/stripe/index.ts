// @wardenx/subscription-billing — §4.13/§4.14/§8.7 Stripe adapter barrel (M35-T04).
//
// The outbox-only Stripe access layer: the SDK-free typed client + fail-closed transport, the audit-envelope
// redactor, the deterministic idempotency-key derivation, the HMAC webhook verifier, the outbox-only
// dispatcher, and the webhook ingestion core. All PURE over injected ports (the T06 composition root wires
// the live transport, the Drizzle stores, and the mirror applier). No vendor SDK is imported anywhere in
// this tree — the whole package stays inside the VENDOR_ADAPTERS boundary by construction.

export * from "./types";
export * from "./redactor";
export * from "./idempotency";
export * from "./webhook-verifier";
export * from "./client";
export * from "./dispatcher";
export * from "./webhook-handler";
