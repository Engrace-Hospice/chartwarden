// apps/backend/src/modules/15-discipline-care-plans — Module 15 (Discipline Care Plans).
//
// M15-T03 lands the §2.2 lifecycle core (`lifecycle/`) and the seam-consuming layer (`consumers/`,
// `seams/`) that resolves the M7 IPOC elements and the M8 signed encounters those machines decide over.
// M15-T04 adds the §7.4/§7.5/§7.6 volunteer domain (`volunteer/`): the 418.78 compliance gates, the
// effective status M17's pre-schedule gate reads, the expiry → inactive cascade, and the 418.78(e) 5%
// hour ledger + ratio. Routes (§4.1), permission keys (§4.4) and the ABAC predicates (§4.5) land in
// M15-T06; the seams M15 PUBLISHES in M15-T05.
export * from "./lifecycle/index";
export * from "./consumers/index";
export * from "./volunteer/index";
export { getCarePlanReader, getSignedEncountersReader } from "./seams/index";
