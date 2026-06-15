// @wardenx/shared — M1 Foundation platform helpers (outbox dispatcher + idempotency).
// Per the manifest, packages/shared owns the outbox publish/dispatcher and the
// idempotency middleware (HELPER-ONLY writers of outbox_event / idempotency_key).
export * from "./outbox-events/events-by-m1";
export * from "./outbox-events/registry";
export * from "./outbox-events/catalog-rows";
export * from "./outbox/publish";
export * from "./idempotency/idempotency";
