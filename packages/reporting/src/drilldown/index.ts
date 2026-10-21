// @chartwarden/reporting · drilldown barrel — the drilldown emitter (M33 §5.1.3 / W-R-05 / §4.10 / D16).
//
// PURE port-injected handlers for the synchronous `POST /api/reporting/drilldown/emit` path (audit flush via the
// `report.drilldown_audit_flush` queue; the live route + outbox dispatcher binding land at app boot in P2C). The
// three steps compose into one drilldown emit, fail-closed at every layer that could surface patient identifiers:
//   - url-template-resolver.ts — base `drilldown_url_template` + dimension context → candidate owner-module URL
//                                (substitutes ONLY catalog-whitelisted dimension values)
//   - consent-narrowing.ts     — M39 `ConsentEvaluator.evaluateForReporting` → narrow (never refuse) under
//                                redaction; FAIL-CLOSED to maximal narrowing when M39 is unavailable
//   - audit-writer.ts          — envelope-encrypt the filter context under the per-tenant DEK → insert-only
//                                `report_drilldown_audit` + emit `m33.drilldown.*`; FAIL-CLOSED (deny) when the
//                                DEK is unavailable (never plaintext at rest)
export * from "./url-template-resolver";
export * from "./consent-narrowing";
export * from "./audit-writer";
