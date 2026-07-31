// apps/backend/src/modules/15-discipline-care-plans — Module 15 (Discipline Care Plans).
//
// M15-T03 lands the §2.2 lifecycle core (`lifecycle/`) and the seam-consuming layer (`consumers/`,
// `seams/`) that resolves the M7 IPOC elements and the M8 signed encounters those machines decide over.
// Routes (§4.1), permission keys (§4.4) and the ABAC predicates (§4.5) land in M15-T06; the volunteer
// compliance + hour-ledger domain in M15-T04; the seams M15 PUBLISHES in M15-T05.
export * from "./lifecycle/index";
export * from "./consumers/index";
export { getCarePlanReader, getSignedEncountersReader } from "./seams/index";
