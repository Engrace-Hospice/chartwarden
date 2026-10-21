// @chartwarden/audit — Audit jobs layer (M4-T11, M4 spec §4.4).
//
// The queue catalog + the pure, infra-free processors each BullMQ worker runs, plus the in-memory
// ports the tests run against. The BullMQ worker/scheduler WIRING lives in the app composition root
// (apps/backend/src/modules/04-audit/jobs) — this package stays free of any BullMQ/Redis import.
export * from "./queues";
export * from "./processors";
export * from "./registry";
export * from "./ports";
