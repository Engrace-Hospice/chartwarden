// @chartwarden/reporting · scheduled barrel — the scheduled-delivery subsystem (M33 §2.2 / §2.5–§2.6 / §4.3 /
// §4.8 W-R-04 / D7).
//
// PURE port-injected handlers for the `report.scheduled_run` worker + the M22 render-reply consumer (the M34
// worker-package precedent: pure logic here, the live BullMQ `Worker`/`Queue` construction + the live outbox
// dispatcher binding land at app boot in P2C):
//   - cron-evaluator.ts — the tick brain: walk due `report_schedule` rows → enqueue at-most-once per
//                         `(schedule_id, scheduled_for)` → advance `next_run_at` via cron-at-tenant-TZ
//   - runner.ts         — one occurrence `queued → running → rendered_pending`: recipient re-validation +
//                         the §1.1 `m33.scheduled_report.render_requested` handshake to M22
//   - delivery.ts       — the `m22.document.rendered` reply consumer: write `document_id`, `→ delivered`,
//                         emit `m33.scheduled_report.delivered`; + the §4.3 recipient-revocation cascade
//   - retention.ts      — the operational-retention sweep over aged terminal occurrences
export * from "./cron-evaluator";
export * from "./runner";
export * from "./delivery";
export * from "./retention";
