// apps/backend/src/modules/15-discipline-care-plans — Module 15 (Discipline Care Plans).
//
// M15-T03 lands the §2.2 lifecycle core (`lifecycle/`) and the seam-consuming layer (`consumers/`,
// `seams/`) that resolves the M7 IPOC elements and the M8 signed encounters those machines decide over.
// M15-T04 adds the §7.4/§7.5/§7.6 volunteer domain (`volunteer/`): the 418.78 compliance gates, the
// effective status M17's pre-schedule gate reads, the expiry → inactive cascade, and the 418.78(e) 5%
// hour ledger + ratio. M15-T05 publishes the §4.3 seams (`seams/`): the seven read surfaces
// `registerDisciplinePlanSeams` stands over the M1 deny-stubs, whose two LOCKED entries CLOSE M17's Wave-F
// volunteer-gate + supervisory-advisory stubs. Routes (§4.1), permission keys (§4.4) and the ABAC predicates
// (§4.5) land in M15-T06.
export * from "./lifecycle/index";
export * from "./consumers/index";
export * from "./volunteer/index";
export {
  DEFAULT_ORG_TIME_ZONE,
  type DisciplineComplianceCounts,
  type DisciplinePlanSeamDeps,
  type DisciplinePlanSeamSeed,
  type DisciplinePlanSeamSeedPlan,
  type DisciplinePlanSeamStore,
  type RateCounts,
  type SeamClock,
  type SupervisoryClockRow,
  type VolunteerHourTotals,
  createDisciplineComplianceProvider,
  createDisciplinePlanReader,
  createInMemoryDisciplinePlanSeamStore,
  createMswRiskFactorReader,
  createSupervisoryCadencePlanReader,
  createSupervisoryCadenceReader,
  createVolunteerComplianceProvider,
  createVolunteerGateExpiryReader,
  getCarePlanReader,
  getDisciplineComplianceProvider,
  getDisciplinePlanReader,
  getMswRiskFactorReader,
  getSignedEncountersReader,
  getSupervisoryCadencePlanReader,
  getSupervisoryCadenceReader,
  getVolunteerComplianceProvider,
  getVolunteerGateExpiryReader,
  orgLocalDateOf,
  rateOf,
  registerDisciplinePlanSeams,
} from "./seams/index";
