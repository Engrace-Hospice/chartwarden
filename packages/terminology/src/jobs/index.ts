// @chartwarden/terminology — terminology jobs layer (M38-T10, spec §4.3).
//
// The §4.3 queue catalog + the pure, infra-free processors each BullMQ worker runs, plus the
// in-memory ports the tests run against. The BullMQ worker/scheduler WIRING lives in the app
// composition root (apps/backend/src/modules/38-terminology/jobs); this package stays free of any
// BullMQ/Valkey import.
export * from "./queues";
export * from "./processors";
export * from "./ports";
