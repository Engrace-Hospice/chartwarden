// @wardenx/discipline-plans — Module 15 (Discipline Care Plans) feature package.
//
// M15-T01 lands the §3.1 domain layout + metadata: the §1.1 / §2.3 / §7.6 pure-data policy constants
// (`policy.ts`: the plan-kind ↔ authoring-discipline matrix, the CoP 418.78 volunteer out-of-scope list and
// blocking gate set, the 418.78(e) hours-÷-hours ratio thresholds), the §2.2.4 / D3 supervisory-cadence
// catalog + escalation ladder and the §1.1 / D10 initial-assessment clocks (`cadence/`), and the §3.5 / D11
// per-kind required-signer sets (`kinds/`).
//
// The cross-module enum / seam / outbox / alert CONTRACTS — the §3.2 enum mirrors, the §3.3 owned-table
// names + §3.6 audit denylists, the §2.4 `m15.*` event names and payloads, the §4.7 M36 alert union, and the
// §4.3 published-seam interfaces + read DTOs — live in the leaf `@wardenx/types` (`discipline-plans.ts`) per
// M15-F01 / ADR-0005 D1/D2, so M14/M16/M17/M22/M27/M28/M30/M33/M36 import them with no `dependsOn` edge.
//
// Still to land: the §3.4 per-kind TypeBox `data jsonb` schemas + validators alongside the Drizzle tables
// they validate (M15-T02), the §2.2 version/signature lifecycle + supervisory-cadence service (M15-T03), and
// the §7.4/§7.5 volunteer compliance + hour-ledger domain (M15-T04). Like `@wardenx/idg` / `@wardenx/orders`
// this package (rather than the `@wardenx/domain` leaf) is the home for that pure domain, because it reads
// the local cadence / signer / policy constants.
//
// PURE — no IO, `@wardenx/types`-only.

export * from "./policy";
export * from "./cadence";
export * from "./kinds";
