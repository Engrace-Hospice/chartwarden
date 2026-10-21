// apps/backend/src/modules/07-care-plan — M7 Care Plan (IPOC) module entrypoint. Re-exports the pure
// lifecycle core (M7-T03) and the published §7.8 CarePlanReader seam + its registration hook (M7-T04).
import type { DbClient } from "@chartwarden/db";
import type { FastifyInstance } from "fastify";
import {
  defaultConsentActiveChecker,
  defaultInternalSudAccessChecker,
  sudDisclosureAllowedForPatient,
} from "./abac-predicates";
import {
  type CarePlanWriteOutboxPort,
  createDbCarePlanAbacResolver,
  createDbCarePlanRouteService,
} from "./care-plan-route-service-db";
import { createDbProblemProposalService } from "./problem-proposals-db";
import { registerCarePlanRoutes as _registerM7Routes } from "./routes/care-plan-routes";
import { registerProblemProposalRoutes } from "./routes/problem-proposal-routes";

export {
  type CarePlanWriteOutboxPort,
  createDbCarePlanRouteService,
  createDbCarePlanAbacResolver,
} from "./care-plan-route-service-db";

/**
 * M7L-T01/T02 — mount the M7 care-plan routes over the PRODUCTION Drizzle route service (RLS-scoped under
 * `withOrgContext`). Called from the composition root's db branch. Reads are live (the patient care-plan
 * aggregate, the §7.5 summary, the version ledger + a single version, all §7.6 SUD-filtered per-caller);
 * the WRITE lifecycle (bootstrap → version draft/finalize/sign/return → problem/goal/intervention
 * authoring) is live too, driving the pure §2.2/§2.3 core with §7.7 optimistic concurrency and emitting
 * `m7.*` on the transactional outbox (the composition root binds the catalog-validating publisher). No
 * route is left at 501. The §6 requireAbac authoring predicates register separately via
 * registerCarePlanAbacPredicates; GAP-013 wires the two route-level DATA-SHAPING deps here
 * (`dpoaConsentActive`/`sudDisclosureAllowed`) over the SAME M39 `ConsentEvaluator` seam glue and RN
 * Case Manager check those predicates use (`defaultConsentActiveChecker`/`sudDisclosureAllowedForPatient`,
 * abac-predicates.ts) — production previously ran the always-false stub defaults, permanently blocking
 * agent-stated (DPOA) goal authoring and hiding every SUD-flagged problem from every caller.
 */
export function mountCarePlanRoutes(
  app: FastifyInstance,
  db: DbClient,
  outbox?: CarePlanWriteOutboxPort,
): void {
  const resolver = createDbCarePlanAbacResolver(db);
  const isConsentActive = defaultConsentActiveChecker();
  const sudInternalAccess = defaultInternalSudAccessChecker();
  const sudDisclosureAllowed: NonNullable<
    Parameters<typeof _registerM7Routes>[1]["sudDisclosureAllowed"]
  > = async ({ organizationId, patientId, planId, roles, membershipId }) => {
    const resolvedPatientId =
      patientId || (await resolver.loadPlan(organizationId, planId))?.patientId;
    if (!resolvedPatientId) return false;
    return sudDisclosureAllowedForPatient(
      {
        organizationId,
        userId: "",
        roles,
        providerEntityIds: [],
        locationIds: [],
        // The Part 2 decision is now PER-ACTOR, so the synthesized context has to carry the one
        // attribute that names the actor. Passing `{}` here would have made every route-level
        // redaction read as `actor_unidentified` against a workforce-restricted release — a
        // fail-closed answer, but one that hides the chart from the very people it names.
        attributes: { membershipId },
      },
      resolvedPatientId,
      sudInternalAccess,
    );
  };
  // F-238 dx-writeback — the clinician's accept / dismiss surface for DocLens-proposed diagnoses.
  registerProblemProposalRoutes(app, {
    service: createDbProblemProposalService(db, outbox),
    sudDisclosureAllowed,
  });
  _registerM7Routes(app, {
    service: createDbCarePlanRouteService(db, outbox),
    dpoaConsentActive: async ({ organizationId, planId }) => {
      const facts = await resolver.loadPlan(organizationId, planId);
      if (!facts) return false;
      return isConsentActive({
        organizationId,
        patientId: facts.patientId,
        consentType: "dpoa_healthcare",
      });
    },
    sudDisclosureAllowed,
  });
}

export * from "./lifecycle/index";
export {
  type CarePlanClockRecord,
  type CarePlanElementsRecord,
  type CarePlanReaderSeed,
  type CarePlanReaderStore,
  type CarePlanSeamDeps,
  type ClaimDiagnosisRecord,
  type ClaimDiagnosisResult,
  type NowClock,
  type StoredRelevantProblem,
  claimDiagnosesForOrg,
  createAddendumDiagnosesReader,
  createCarePlanReader,
  createUnrelatedProblemItemsReader,
  UNRELATED_PROBLEM_REASON,
  createDrizzleCarePlanReaderStore,
  createInMemoryCarePlanReaderStore,
  getCarePlanReader,
  type IdgPacketCarePlanContext,
  activeProblemIdsForOrg,
  idgPacketCarePlanContextForOrg,
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
  defaultConsentActiveChecker,
  disciplineScopeOf,
  registerCarePlanAbacPredicates,
  sudDisclosureAllowedForPatient,
} from "./abac-predicates";

// M7-T07 — §2.4 outbox contract (the full `m7.*` taxonomy; check-fitness-gaps.ts scans events-by-m7.ts
// for naming / ownership / consumers) + §4.6 jobs (the `care-plan.gates` 5-day/15-day scans over the
// due columns derived by lifecycle/gate-clock). The snapshot job remains a shell; M7-T08's M14
// IDG-decision consumer is live and transactionally idempotent.
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

// TASK-040D — the LIVE `care-plan.gates` BullMQ Worker/Queue construction (the M25 precedent) + the
// platform-tenancy registration its active-org fan-out needs.
export {
  type ActiveOrgListPort as M7ActiveOrgListPort,
  type CarePlanOutboxPublishPort,
  type M7WorkerDeps,
  buildM7WorkerDeps,
  registerM7CronWorkers,
  runCarePlanGatesCron,
  scheduleM7Jobs,
} from "./jobs/cron-workers";
export { M7_PLATFORM_JOB_ID, wireM7Tenancy } from "./wiring";

// M7-T08 — the `apply-idg-decision` decision core (§7.9 / §11 D4): the live M14
// `idg.decision_recorded` consumer opens a draft `idg_review` version and
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
  buildM7AdmissionActivatedConsumer,
  buildM7AdmissionDischargedConsumer,
} from "./outbox-consumers/m6-admission-lifecycle";
export {
  type M7IdgConsumerOutboxPort,
  buildM7IdgDecisionConsumer,
  M7_IDG_DECISION_CONSUMER,
  M7_IDG_DECISION_CONSUMER_DEFERRED,
  decideIdgDecisionRecorded,
} from "./outbox-consumers/m14-idg-decision-recorded";
// F-238 dx-writeback — DocLens diagnoses → pending problem PROPOSALS (never `problem` rows) + the
// clinician's accept / dismiss service.
export {
  type Icd10Validator,
  M7_EXTRACTION_DIAGNOSIS_WRITEBACK_CONSUMER,
  applyDiagnosisWriteback,
  buildM7ExtractionDiagnosisWritebackConsumer,
  m38Icd10Validator,
  parseDiagnosisCommitRequested,
} from "./outbox-consumers/m22-diagnosis-writeback";
export {
  type ProblemProposalService,
  type ProblemProposalView,
  type ProposalActor,
  createDbProblemProposalService,
} from "./problem-proposals-db";
export { registerProblemProposalRoutes } from "./routes/problem-proposal-routes";

// M7-T09 — the `care_plan_record` data eraser (§3.6 / §11 D8; M4 destruction-cert workflow). Pure
// orchestration over an injectable store; registers the REAL eraser over the Phase-0 deny-stub via the
// composition root's wireModuleErasers() hook (before validateErasers()).
export {
  type CarePlanEraseCounts,
  type CarePlanEraseStore,
  type CarePlanEraserDeps,
  createCarePlanEraser,
  createDrizzleCarePlanEraseStore,
  createInMemoryCarePlanEraseStore,
  eraseCarePlanRecord,
  registerCarePlanErasers,
} from "./erasers/care-plan-eraser";
