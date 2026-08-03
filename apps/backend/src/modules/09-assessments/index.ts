// apps/backend/src/modules/09-assessments — M9 Clinical Assessments Suite module entrypoint. M9-T04
// publishes the two §4.7 / D7 owned seams (LatestAssessmentProvider + ScaleSeriesProvider) + their
// registration hook; M9-T05 adds the §4.1 route inventory over an in-memory backend, plus the two §4.7
// ABAC predicates M9 owns (`discipline_can_record_scale` / `cosigner_role_match`). The pure domain core
// (lifecycle/scoring/cosign/eligibility) lives in @wardenx/assessments; the §4.6 permission keys M9
// contributes to M3 live in @wardenx/auth (M9_CONTRIBUTED_PERMISSIONS).
import type { DbClient } from "@wardenx/db";
import type { FastifyInstance } from "fastify";
import {
  type AssessmentWriteOutboxPort,
  createDbAssessmentAbacResolver,
  createDbAssessmentRouteService,
} from "./assessments-route-service-db";
import { registerAssessmentAbacPredicates as _registerM9Abac } from "./abac-predicates";
import { registerAssessmentRoutes as _registerM9Routes } from "./routes/assessments-routes";

/**
 * M9L — mount the M9 assessment routes over the PRODUCTION Drizzle route service + ABAC resolver
 * (RLS-scoped under `withOrgContext`). Called from the composition root's db branch. Reads and the §10
 * write pipeline (record → correct → cosign → acknowledge → license/policy admin) are live over Drizzle;
 * every scale insert emits its `m9.*` event on the passed transactional-outbox publisher (the composition
 * root binds M1's catalog-validating publisher pinned to caller-module `m9`). Replaces the in-memory
 * clinical-core scaffold mount for M9.
 */
export function mountAssessmentRoutes(
  app: FastifyInstance,
  db: DbClient,
  outbox?: AssessmentWriteOutboxPort,
): void {
  _registerM9Abac({ resolver: createDbAssessmentAbacResolver(db) });
  _registerM9Routes(app, { service: createDbAssessmentRouteService(db, outbox) });
}

export {
  type AssessmentReaderSeed,
  type AssessmentReaderStore,
  type AssessmentSeamDeps,
  type SeededSeriesPoint,
  AssessmentSeamDataGapError,
  createDrizzleAssessmentReaderStore,
  createInMemoryAssessmentReaderStore,
  createLatestAssessmentProvider,
  createScaleSeriesProvider,
  getLatestAssessmentProvider,
  getScaleSeriesProvider,
  registerAssessmentSeams,
} from "./seams/index";
// M9-T05 — the §4.1 route inventory + in-memory backend + the §4.7 ABAC predicates M9 owns.
export {
  type AssessmentAbacDeps,
  M9_ABAC_PREDICATES,
  buildAssessmentAbacPredicates,
  registerAssessmentAbacPredicates,
} from "./abac-predicates";
export {
  type AssessmentRouteDeps,
  registerAssessmentRoutes,
} from "./routes/assessments-routes";
export {
  type AssessmentAbacFacts,
  type AssessmentAbacResolver,
  type AssessmentRouteSeed,
  type AssessmentRouteService,
  type AssessmentView,
  createInMemoryAssessmentBackend,
} from "./routes/service";
export {
  type AssessmentWriteOutboxPort,
  createDbAssessmentAbacResolver,
  createDbAssessmentRouteService,
} from "./assessments-route-service-db";
// M9-T06 — the §2.4 outbox contract (the full `m9.*` taxonomy; check-fitness-gaps.ts scans events-by-m9.ts
// for naming + ownership + declared consumers). `m9.assessment.significant_change` feeds the §4.9 alert.
export { M9_OUTBOX_EVENTS } from "./events-by-m9";
// M9-T06 — the §4.8 BullMQ queue catalog + the pure license / change-escalation / reassessment scans.
export {
  type ChangeEscalation,
  type ChangeEscalationPlan,
  type LicenseScanPlan,
  type LicenseTransition,
  type M9QueueName,
  type PlannedAssessmentEvent,
  type ReassessmentDueFlag,
  type ReassessmentSnapshot,
  type ScaleLicenseSnapshot,
  type SignificantChangeSnapshot,
  ESCALATION_WINDOW_MS,
  M9_DLQ,
  M9_JOB_SCHEDULES,
  M9_QUEUES,
  M9_QUEUE_PARAMS,
  REASSESSMENT_CADENCE_DAYS,
  jobIdempotencyKey,
  planChangeEscalation,
  planLicenseStatusScan,
  planReassessmentDueScan,
} from "./jobs/index";
// M9-T07 — the `clinical_assessment` data eraser (§8.4). registerAssessmentErasers stands the REAL eraser
// over the Phase-0 deny-stub; invoked from the composition root's wireModuleErasers() before validateErasers().
export {
  type AssessmentEraseCounts,
  type AssessmentEraseStore,
  type AssessmentEraserDeps,
  createAssessmentEraser,
  createDrizzleAssessmentEraseStore,
  createInMemoryAssessmentEraseStore,
  eraseAssessmentRecord,
  registerAssessmentErasers,
} from "./erasers/assessment-eraser";
// M9-T07 — the M22 assessment-summary PDF forward seam (DENY-STUB; §12 forward seam). NOT registry-wired and
// NO `dependsOn` edge — M22 is Wave F; this documents the binding point and fails closed until M22 lands.
export {
  type AssessmentSummaryPdfRenderer,
  type AssessmentSummaryPdfResult,
  type AssessmentSummaryRenderPayload,
  denyStubAssessmentSummaryPdfRenderer,
} from "./seams/m22-summary-pdf";
