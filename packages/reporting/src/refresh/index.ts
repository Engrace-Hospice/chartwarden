// @chartwarden/reporting · refresh barrel — the three-tier MV-refresh subsystem (M33 §2.4–§2.6 / §4.5 / §4.8).
//
// PURE port-injected handlers for the `report.mv_refresh` + `report.lag_probe` workers (the M34 worker-package
// precedent: pure logic here, the live BullMQ `Worker`/`Queue` construction binds at app boot in P2C). Three
// tiers, one queue:
//   - dispatcher.ts       — strategy resolution + §2.6 debounce/idempotency → enqueue onto `report.mv_refresh`
//   - outbox-subscriber.ts— the INCREMENTAL tier: §4.5 topic→MV fan-out + forward-declared subscriptions
//   - refresh-worker.ts   — the worker body: REFRESH MATERIALIZED VIEW CONCURRENTLY (primary) + W-R-06 alerts
//   - lag-probe.ts        — the singleton replica-lag probe + the two-probe hysteresis + D14 advisory
//   - nightly-cron.ts     — the NIGHTLY tier: 02:00 tenant-local orchestrator over the nightly-strategy MVs
//   - ports.ts            — the injected port interfaces + the fail-closed unbound-port idiom
export * from "./ports";
export * from "./dispatcher";
export * from "./outbox-subscriber";
export * from "./refresh-worker";
export * from "./lag-probe";
export * from "./nightly-cron";
