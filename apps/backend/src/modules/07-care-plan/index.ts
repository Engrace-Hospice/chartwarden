// apps/backend/src/modules/07-care-plan — M7 Care Plan (IPOC) module entrypoint. Re-exports the pure
// lifecycle core (M7-T03) and the published §7.8 CarePlanReader seam + its registration hook (M7-T04).
import type { DbClient } from "@wardenx/db";
import type { FastifyInstance } from "fastify";
import { createDbCarePlanRouteService } from "./care-plan-route-service-db";
import { registerCarePlanRoutes as _registerM7Routes } from "./routes/care-plan-routes";

export { createDbCarePlanRouteService } from "./care-plan-route-service-db";

/**
 * M7L-T01 — mount the M7 care-plan routes over the PRODUCTION Drizzle route service (RLS-scoped under
 * `withOrgContext`). Called from the composition root's db branch. Reads are live (the patient care-plan
 * aggregate, the §7.5 summary, the version ledger + a single version, all §7.6 SUD-filtered per-caller);
 * writes fail-closed 501 until the M7L-T02+ Drizzle write lifecycle lands. Replaces the in-memory
 * clinical-core scaffold mount for M7. M7's route surface carries no scaffold ABAC predicates that need a
 * resolver here — the §6 authoring predicates register separately via registerCarePlanAbacPredicates.
 */
export function mountCarePlanRoutes(app: FastifyInstance, db: DbClient): void {
  _registerM7Routes(app, { service: createDbCarePlanRouteService(db) });
}

export * from "./lifecycle/index";
export {
  type CarePlanClockRecord,
  type CarePlanElementsRecord,
  type CarePlanReaderSeed,
  type CarePlanReaderStore,
  type CarePlanSeamDeps,
  type NowClock,
  type StoredRelevantProblem,
  createCarePlanReader,
  createInMemoryCarePlanReaderStore,
  getCarePlanReader,
  registerCarePlanSeams,
} from "./seams/index";

// M7-T05 — the §4.1 route inventory behind requirePermission on the §4.5 keys M7 contributes to M3
// (M7_CONTRIBUTED_PERMISSIONS). The three PATCH routes carry §4.1.1 (M07-F09) Idempotency-Key +
// If-Match pre-handlers; §7.7 optimistic concurrency raises 412 STALE_VERSION on a stale write. Routes
// compose over the injected CarePlanRouteService (in-memory slice here; Drizzle in prod under
// withOrgContext so RLS backstops).
export { type CarePlanRouteDeps, registerCarePlanRoutes } from "./routes/care-plan-routes";
export {
  type CarePlanRouteService,
  type CarePlanAbacResolver,
  type CarePlanBackendSeed,
  type CarePlanFacts,
  type CarePlanViewer,
  type ProblemFacts,
  type VersionFacts,
  type ElementResult,
  type CreateProblemInput,
  type PatchProblemInput,
  type CreateGoalInput,
  type PatchGoalInput,
  type CreateInterventionInput,
  type PatchInterventionInput,
  CarePlanAlreadyExistsError,
  createInMemoryCarePlanBackend,
} from "./routes/service";
export {
  type PreHandler,
  type WithIfMatch,
  IdempotencyKeyRequiredError,
  IfMatchRequiredError,
  ifMatchVersionOf,
  requireIdempotencyKey,
  requireIfMatch,
} from "./routes/concurrency";

// M7-T06 — §7.3–7.6 authoring: the pure discipline/redaction/goal-attribution helpers + the five §6
// ABAC predicate resolvers (caseload_or_scope / dpoa_active / sud_disclosure_allowed / signer_role_match
// / discipline_scope) M7 registers into M3's named-predicate registry.
export * from "./authoring/index";
export {
  type CarePlanAbacDeps,
  M7_ABAC_PREDICATES,
  buildCarePlanAbacPredicates,
  disciplineScopeOf,
  registerCarePlanAbacPredicates,
} from "./abac-predicates";

// M7-T07 — §2.4 outbox contract (the full `m7.*` taxonomy; check-fitness-gaps.ts scans events-by-m7.ts
// for naming / ownership / consumers) + §4.6 jobs (the `care-plan.gates` 5-day/15-day scans over the
// due columns derived by lifecycle/gate-clock). The IDG-apply + snapshot jobs are event-driven shells
// (M7-T08 wires the M14 IDG consumer inert).
export { M7_OUTBOX_EVENTS } from "./events-by-m7";
export {
  type CarePlanGateScanPlan,
  type CarePlanGateSnapshot,
  type M7QueueName,
  type PlannedCarePlanEvent,
  M7_DLQ,
  M7_JOB_SCHEDULES,
  M7_QUEUE_PARAMS,
  M7_QUEUES,
  gateScanIdempotencyKey,
  idgApplyIdempotencyKey,
  planInitialGateScan,
  planReviewGateScan,
  summaryJobId,
} from "./jobs/index";

// M7-T08 — the `apply-idg-decision` decision core (§7.9 / §11 D4): the M14 `idg.decision_recorded`
// consumer. PURE + tested now; the M14 producer is Wave F so the outbox binding is forward-declared /
// deferred (M7_IDG_DECISION_CONSUMER{,_DEFERRED}). The worker opens a draft `idg_review` version and
// applies the meeting's element mutations; it refuses a terminal-problem discontinue (T4) and is
// idempotent on `idgDecisionId` (D4). The §7.8 encounter-relevance surface M8 consumes is the
// CarePlanReader seam (registered in M7-T04, served by the /internal/care-plan/relevant-elements +
// overdue-status routes in M7-T05) — finalized; no new code here.
export {
  type IdgApplyFacts,
  type IdgApplyAction,
  type IdgRefusalReason,
  type PlannedElementMutation,
  decideIdgDecision,
} from "./consumers/apply-idg-decision";
export {
  M7_IDG_DECISION_CONSUMER,
  M7_IDG_DECISION_CONSUMER_DEFERRED,
  decideIdgDecisionRecorded,
} from "./outbox-consumers/m14-idg-decision-recorded";

// M7-T09 — the `care_plan_record` data eraser (§3.6 / §11 D8; M4 destruction-cert workflow). Pure
// orchestration over an injectable store; registers the REAL eraser over the Phase-0 deny-stub via the
// composition root's wireModuleErasers() hook (before validateErasers()).
export {
  type CarePlanEraseCounts,
  type CarePlanEraseStore,
  type CarePlanEraserDeps,
  createCarePlanEraser,
  createInMemoryCarePlanEraseStore,
  eraseCarePlanRecord,
  registerCarePlanErasers,
} from "./erasers/care-plan-eraser";
