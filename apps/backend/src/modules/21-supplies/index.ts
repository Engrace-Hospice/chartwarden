// apps/backend/src/modules/21-supplies — Module 21 (Supplies, DME & Comfort Kits).
//
// M21-T03 landed the §2.2–§2.7 domain core (`lifecycle/`): the D2 fulfillment machine built from the
// `@wardenx/supplies` edge table, the §2.3 append-only comfort-kit recipe rules, the §2.5 fail-closed
// dispatch validation plus the dispatch row's own status machine, the §2.6 chain-of-custody return machine
// with its computed D8 discrepancy and 30d/90d escalation, and the §2.7 par-stock bands. Every machine is
// PURE — facts arrive resolved and each transition returns a declarative side-effect list the service layer
// executes in one transaction.
//
// M21-T04 lands the cross-module boundary in both directions:
//   • `events-by-m21.ts`  — the §4.5.2 `m21.*` outbox catalog (naming/ownership/consumers scanned by
//     `arch:gaps`, merged into the platform catalog at boot, and the dispatcher's payload validator)
//   • `consumers/`        — the §4.5.1 inbound deciders that CLOSE M11's and M13's Wave-E deny-stubs
//   • `seams/consumed.ts` — M11's `OrderProvider` + M6's `AdmissionStatusReader`/`DeathDischargeReader`,
//     resolved through the M1 registry (which is why M21's manifest `dependsOn` gains M1)
//
// Still to land: the §4.8 published seams with the §4.1 routes, §4.3 permission keys and §4.4 ABAC
// predicates (M21-T05), and the §5 screens (M21-T06).
export * from "./lifecycle/index";
export * from "./consumers/index";
export { getAdmissionStatusReader, getDeathDischargeReader, getOrderProvider } from "./seams/index";
export { M21_OUTBOX_EVENTS, assertM21EventCatalogComplete } from "./events-by-m21";
