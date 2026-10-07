// apps/backend/src/modules/21-supplies/lifecycle — the M21 §2.2–§2.7 domain core (M21-T03).
//
// Four pure machines over already-resolved facts, plus the §2.3 template rules and the two monitor deciders
// the §4.6 crons run. Nothing here touches IO: each transition returns its new state plus a DECLARATIVE
// side-effect list (./effects) that the M21-T05 service layer executes inside the aggregate's transaction,
// so the domain row, the M4 audit row and the §4.5 outbox row commit together or not at all.
//
//   • ./supply-request  §2.2 / D2 — the fulfillment machine, built FROM `SUPPLY_REQUEST_EDGES` in
//                       `@wardenx/supplies` rather than restating it, with the two-phase post-`ordered`
//                       cancellation, the kit-only `returned` branch and the §2.10 lateness detectors
//   • ./template        §2.3 / D3 — the append-only comfort-kit recipe: floor validation, supersession,
//                       effective-window resolution, the `system_locked` delete guard
//   • ./dispatch        §2.5 / D6 — the five fail-closed dispatch refusals and the dispatch row's OWN
//                       status machine (which outlives the request's terminal state)
//   • ./return          §2.6 / D8 — the chain-of-custody machine, the separation-of-duties + coverage +
//                       over-return guards, the computed discrepancy, and the 30d/90d escalation scan
//   • ./par-stock       §2.7 / D5 — the nightly band evaluation (cron emits, observations do not) and the
//                       refusing-not-clamping dispatch decrement
//   • ./caregiver-signature  F-193 (#248) — the M21-owned caregiver-signature CAPTURE, NOT a §2.2
//                       transition (evidence about an already-`delivered` row, not a step in the machine)
//   • ./coverage-determination  COP27 — the hospice coverage determination rules (dme/supply only; reason
//                       required when not covered); NOT a §2.2 transition
//   • ./errors          the §7 / §2.10 code → status catalog on the M1 `WardenXError` envelope
export * from "./effects";
export * from "./errors";
export * from "./supply-request";
export * from "./template";
export * from "./dispatch";
export * from "./return";
export * from "./par-stock";
export * from "./caregiver-signature";
export * from "./coverage-determination";
export * from "./serving-location";
