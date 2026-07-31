// apps/backend/src/modules/15-discipline-care-plans — Module 15 (Discipline Care Plans).
//
// M15-T03 lands the §2.2 lifecycle core (`lifecycle/`) and the seam-consuming layer (`consumers/`,
// `seams/`) that resolves the M7 IPOC elements and the M8 signed encounters those machines decide over.
// M15-T04 adds the §7.4/§7.5/§7.6 volunteer domain (`volunteer/`): the 418.78 compliance gates, the
// effective status M17's pre-schedule gate reads, the expiry → inactive cascade, and the 418.78(e) 5%
// hour ledger + ratio. M15-T05 publishes the §4.3 seams (`seams/`): the seven read surfaces
// `registerDisciplinePlanSeams` stands over the M1 deny-stubs, whose two LOCKED entries CLOSE M17's Wave-F
// volunteer-gate + supervisory-advisory stubs. M15-T06 lands the §4.1 route surface (`routes/`) over the
// Drizzle READ + WRITE services, the §4.4 permission keys (`permission-keys.ts`), the §4.5 ABAC predicates
// (`abac-predicates.ts` + the Drizzle subject resolver), the §7.8/§7.9 M39 SUD + family-violence disclosure
// gates (`routes/disclosure.ts`), the §2.4 outbox catalog (`events-by-m15.ts` — whose
// `m15.plan.version_signed` IS the M22 plan-PDF render handshake, D12), and the §8.5
// `discipline_plan_record` eraser.
export * from "./lifecycle/index";
export * from "./consumers/index";
export * from "./volunteer/index";

// §2.4 — the M15 outbox-event catalog (the dispatcher validates each `m15.*` publish against it).
export { M15_OUTBOX_EVENTS } from "./events-by-m15";

// §4.4 — the twenty permission keys M15 contributes to M3's catalog.
export {
  type M15ContributedPermissionKey,
  type M15PermissionKey,
  M15_CONTRIBUTED_PERMISSIONS,
  M15_INTERNAL_PERMISSION_KEYS,
  M15_PERMISSION_KEY_LIST,
} from "./permission-keys";

// §4.5 — the four ABAC predicates M15 owns + registers into M3's named-predicate registry.
export {
  type DisciplinePlanAbacDeps,
  type DisciplinePlanAbacResolver,
  type DisciplinePlanScopeFacts,
  type FamilyViolenceRedactionProbe,
  type M15RegisteredAbacPredicate,
  M15_ABAC_PREDICATES,
  buildDisciplinePlanAbacPredicates,
  denyStubDisciplinePlanAbacResolver,
  registerDisciplinePlanAbacPredicates,
} from "./abac-predicates";
export { buildDrizzleDisciplinePlanAbacResolver } from "./abac-resolver-drizzle";

// §4.1 — the route mount + the Drizzle-backed READ + WRITE service builders.
export {
  type M15ReadDeps,
  type M15ReadService,
  type M15RouteServices,
  type M15WriteDeps,
  type M15WriteService,
  type OutboxEmission as M15OutboxEmission,
  type WriteOutboxPort as M15WriteOutboxPort,
  buildDrizzleM15ReadService,
  buildDrizzleM15WriteService,
} from "./routes/index";
export { mountM15Routes } from "./routes/mount";

// §8.5 — the M4 destruction-registry `discipline_plan_record` eraser (registerEraser INJECTED).
export {
  type DisciplinePlanEraseCounts,
  type DisciplinePlanEraseOptions,
  type DisciplinePlanEraseStore,
  type DisciplinePlanEraserDeps,
  createDisciplinePlanEraser,
  createDrizzleDisciplinePlanEraseStore,
  createInMemoryDisciplinePlanEraseStore,
  eraseDisciplinePlanRecord,
  registerDisciplinePlanErasers,
} from "./erasers/discipline-plan-eraser";
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
