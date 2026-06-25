// @wardenx/reporting · session barrel — the read-replica session discipline (M33 §8.1.2 / D3 / D14).
//
//   - with-report-session.ts — `withReportSession`: the read-only replica session wrapper (tiered
//                              `statement_timeout` + `app.org_id` RLS GUC) with the D14 lag circuit-breaker /
//                              `DegradedError` → Valkey-cache fallback. Pure over an injected M1
//                              `read_replica_session` port (bound at boot in P2C).
export * from "./with-report-session";
