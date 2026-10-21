// @chartwarden/supplies — Module 21 (Supplies, DME & Comfort Kits) feature package.
//
// M21-T01 lands the §2 domain layout + the pure-data policy every later M21 task builds on:
//   · `policy.ts`      — the §2.2 72h caregiver-confirm grace, the §2.10 24h vendor-confirmation window,
//                        the §2.6 72h return window with its 30d/90d escalation ladder, the §3.1.9
//                        controlled-substance expiration floor, the D8 5% discrepancy threshold, and the
//                        D3 tenant-tightening multiples;
//   · `kinds/`         — the D1 per-kind `supply_request.data` TypeBox schemas (`dme` · `supply` ·
//                        `comfort_kit_deploy` · `comfort_kit_replenish`), the shared address-snapshot and
//                        kit-medication-content shapes, and the §2.10 cross-field rules TypeBox cannot
//                        state (the ipu_room ↔ address either/or, the controlled↔schedule pairing, the
//                        orderable delivery window);
//   · `lifecycle.ts`   — the §2.2 / D2 edge set the M21-T03 XState actor is built FROM, incl. the
//                        two-phase post-`ordered` cancellation and the kit-only `returned` branch;
//   · `routing/`       — the §2.4 / D4 precedence ladder (sku > location > tenant > platform) producing
//                        the immutable resolution record with its full roads-not-taken trace;
//   · `reconciliation.ts` — the §2.6 / D8 return math in Decimal, plus the witness-distinctness rule;
//   · `template/`      — the D3 four-medication platform floor and the tenant-tighten-only validator.
//
// M21-T03 adds:
//   · `par.ts`         — the §2.7 / D5 par-stock bands (derived, never stored) and the refusing-not-clamping
//                        quantity delta the dispatch decrement runs through.
//
// The cross-module enum / seam / outbox / alert CONTRACTS — the §3.1.1 enum mirrors, the §3.1 owned-table
// names + D13 audit denylists, the §4.5 `m21.*` event names and payloads, the §4.7 M36 alert union, and
// the §4.8 published-seam interfaces + read DTOs — live in the leaf `@chartwarden/types` (`supplies.ts`) per
// ADR-0005 D1/D2, so M11/M13/M22/M27/M30/M33/M36/M37 import them with no `dependsOn` edge. The spec's §4.8
// writes the seam file as `packages/seams/src/supplies.ts`; that package does not exist and the repo's
// convention is the `@chartwarden/types` leaf — architecture wins over the spec's proposed path.
//
// The §2.2/§2.5/§2.6/§2.7 machines that consume this package landed in M21-T03 under
// `apps/backend/src/modules/21-supplies/lifecycle/` — they are pure deciders over already-resolved facts,
// so the IO stays in the M21-T05 service layer.
//
// Still to land: the M11/M13 consumers + emitters (M21-T04), the §4.8 seam impls with the §4.1 routes,
// §4.3 permission keys and §4.4 ABAC predicates (M21-T05), and the §5 screens (M21-T06).
//
// D15 — supplies is an AI-PROHIBITED zone. Nothing in this package is reachable from an M32 prompt, and
// `validateSupplyAIBlock()` (M21-T05) fails boot if M32's registry ever names a supplies surface.
//
// PURE — no IO, `@chartwarden/types` + TypeBox + decimal.js only.

export * from "./policy";
export * from "./kinds";
export * from "./lifecycle";
export * from "./par";
export * from "./routing/precedence";
export * from "./reconciliation";
export * from "./template/floor";
