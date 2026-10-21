// @chartwarden/scheduling — Module 17 (Scheduling & Route Optimization) feature package.
//
// M17-T01 lands the domain layout + metadata: the §2.3 / §3.2 pure-data policy constants — the
// `visit_purpose → discipline` map (D8 predicate 3), the seven-predicate pre-schedule gate ordering, the
// EVV-missing self-attest reason floor (`policy.ts`); the §3.2 Phase-D platform cancellation-reason value
// set (`cancellation-reasons.ts`); the §2.2.5 RRULE-subset grammar value sets (`rrule.ts`). The
// cross-module enum/seam/outbox/alert CONTRACTS + the §4.3 read DTOs live in the leaf `@chartwarden/types`
// (`scheduling.ts`) so downstream consumers (M5/M8/M18/M19/M20/M30/M31/M33) import them with no `dependsOn`
// edge. The OSRM `RoutingProvider` adapter (§4.10 D1) lives in `@chartwarden/routing-client`.
//
// The pure (IO-free, `@chartwarden/types`-only) domain that reads these constants — the §2.2 visit state
// machine + visit_state_history (M17-T03), the RRULE materializer (M17-T03), and the frequency/supervisory/
// order proposers (M17-T04) — lands HERE (the M11 `@chartwarden/orders` / M12 `@chartwarden/dosespot` / M13
// `@chartwarden/emar` / M14 `@chartwarden/idg` precedent) rather than the `@chartwarden/domain` leaf because it reads
// the local policy constants.

export * from "./policy";
export * from "./cancellation-reasons";
export * from "./rrule";
export * from "./frequency";
export * from "./lifecycle";
