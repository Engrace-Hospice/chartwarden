// @wardenx/quality · workers barrel — the §4.8 ASYNC/WORKER layer (P2c).
//
// PURE, port-injected processors for M30's four BullMQ queues + four crons. The job LOGIC lives here
// (unit-testable against in-memory ports, the M33 `@wardenx/reporting/refresh` precedent); the thin,
// infra-touching BullMQ `Worker`/`Queue` construction binds at app boot in the backend `jobs/m30-jobs.ts`
// adapter (NOT in this package — constructing a Worker is what opens Valkey). Nothing here runs at import.
//
//   params.ts                — the §4.8 queue/DLQ/cron/idempotency-key catalog + per-queue tenancy scope
//   ports.ts                 — the shared `processing_log` guard + active-org enumerator + fail-closed idiom
//   measure-recompute.ts     — `m30.measure_recompute` (§7.1; consumes the LIVE M10 HOPE seam)
//   cahps-export.ts          — `m30.cahps_export` (§7.2; per-org vendor adapter; export_failed on exhaustion)
//   outbreak-detection.ts    — `m30.outbreak_detection` (§7.8 / D11; the ≥3-events/14d cluster detector)
//   risk-register-refresh.ts — `m30.risk_register_refresh` (§7.9 / D13; REFRESH MV CONCURRENTLY + reproject)
//   crons.ts                 — the four §4.8 crons (nightly recompute / cahps monthly sample / risk refresh /
//                              sra reminders) — pure decision cores + platform-scoped active-org fan-out
export * from "./params";
export * from "./ports";
export * from "./measure-recompute";
export * from "./cahps-export";
export * from "./outbreak-detection";
export * from "./risk-register-refresh";
export * from "./crons";
