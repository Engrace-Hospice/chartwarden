// apps/backend/src/modules/21-supplies — Module 21 (Supplies, DME & Comfort Kits).
//
// M21-T03 lands the §2.2–§2.7 domain core (`lifecycle/`): the D2 fulfillment machine built from the
// `@wardenx/supplies` edge table, the §2.3 append-only comfort-kit recipe rules, the §2.5 fail-closed
// dispatch validation plus the dispatch row's own status machine, the §2.6 chain-of-custody return machine
// with its computed D8 discrepancy and 30d/90d escalation, and the §2.7 par-stock bands. Every machine is
// PURE — facts arrive resolved and each transition returns a declarative side-effect list the service layer
// executes in one transaction.
//
// Still to land: the M11/M13 consumers + emitters (M21-T04), the §4.8 seams with the §4.1 routes, §4.3
// permission keys and §4.4 ABAC predicates (M21-T05), and the §5 screens (M21-T06).
export * from "./lifecycle/index";
