// @wardenx/messaging — jobs layer (M36-T08, spec §4.4 / §4.4.1).
//
// The §4.4 queue catalog + full §4.4.1 parameters (./queues), the pure security-load-bearing
// processors (./processors: hash_verify, retention legal-hold filter, DLQ OPS-035 record), and the
// in-memory ports the tests run against (./ports). The BullMQ worker/scheduler WIRING + the vendor
// send adapters live in the app composition root / M1 infra; this package stays free of any
// BullMQ/Valkey/Twilio/Postmark import.
export * from "./queues";
export * from "./processors";
export * from "./ports";
