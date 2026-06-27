// @wardenx/reporting · export barrel — the three export formats (M33 §4.8 / W-R-08 / D10).
//
// PURE port-injected export handlers (the M34 worker-package precedent: pure logic here; the live BullMQ
// `report.export_render` `Worker` + the M22 reply consumer + the live outbox dispatcher binding land at app
// boot in P2C):
//   - csv-stream.ts          — direct chunked-response CSV streamer (NO M22 hop; aggregate-only, no PHI; cursor
//                              + 250k cap + statement-timeout trailer)
//   - render-request.ts      — the shared M22 render-request contract both M22-rendered formats compose over
//   - pdf-renderer-request.ts — emit `m33.scheduled_report.render_requested` (format=pdf; ≤5000-row gate)
//   - xlsx-renderer-request.ts — emit `m33.scheduled_report.render_requested` (format=xlsx; no row gate)
export * from "./csv-stream";
export * from "./render-request";
export * from "./pdf-renderer-request";
export * from "./xlsx-renderer-request";
