// @wardenx/quality · repositories barrel (M30 §3.3).
//
// Ten Drizzle data ports over the eighteen M30-owned tables. Each repo is a thin reader/writer that takes
// the Drizzle client (`QualityDb` — the pooled client or a `withOrgContext` transaction handle) in its
// constructor and issues plain Drizzle queries; the read/write SERVICES (later phases) wrap each call in
// `withOrgContext` so Postgres RLS scopes every statement to `app.org_id` — keeping tenant-scoping in one
// home. No Fastify, no outbox, no `withOrgContext` here: pure data access.
//
//   QualityMeasureValueRepository      — quality_measure_value (append-only / soft-supersede measure ledger)
//   MeasureRecomputeQueueRepository    — measure_recompute_queue (debounced recompute work list)
//   CahpsRepository                    — cahps_vendor_binding + cahps_decedent_sample + cahps_result_summary
//   QapiRepository                     — qapi_program + indicator + project + pip + governance_minutes
//   SraRepository                      — sra_cycle + sra_finding + sra_remediation
//   CopComplianceRepository            — cop_compliance_status
//   IncidentRepository                 — incident_report (partitioned; PHI; cursor-paged)
//   MortalityReviewRepository          — mortality_review (partitioned; PHI; cursor-paged)
//   InfectionRepository                — infection_surveillance_event (partitioned) + infection_outbreak_case
//   RiskRegisterRepository             — the four risk-register source tables → buildRiskRegister input (D13)
export type { QualityDb } from "./db";
export { QualityMeasureValueRepository } from "./measures";
export { MeasureRecomputeQueueRepository } from "./recompute-queue";
export { CahpsRepository } from "./cahps";
export { QapiRepository } from "./qapi";
export { SraRepository } from "./sra";
export { CopComplianceRepository } from "./cop";
export { IncidentRepository, type IncidentCursor } from "./incidents";
export { MortalityReviewRepository, type MortalityCursor } from "./mortality";
export { InfectionRepository, type InfectionEventCursor } from "./infection";
export { RiskRegisterRepository } from "./risk";
