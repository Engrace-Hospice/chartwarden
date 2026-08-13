// apps/backend/src/modules/14-idg — M14 (Interdisciplinary Group / IDG) backend module surface.
//
import type { DbClient } from "@wardenx/db";
import type { FastifyInstance } from "fastify";
import { registerIdgAbacPredicates as _registerM14Abac } from "./abac-predicates";
import { type IdgWriteOutboxPort, createDbIdgBackend } from "./idg-route-service-db";
import { registerIdgRoutes as _registerM14Routes } from "./routes/idg-routes";

/**
 * M14L — mount the M14 IDG routes over the PRODUCTION Drizzle route service + §4.7 ABAC resolver (one object
 * that is both, RLS-scoped under `withOrgContext`). Called from the composition root's db branch. Reads + the
 * full write lifecycle (meeting machine, attendance, agenda, decisions, action items, minutes/amendments,
 * recurring policies) are live over Drizzle+RLS; every mutation emits `m14.*` / the canonical
 * `idg.decision_recorded` on the bound transactional `outbox`. Replaces the in-memory scaffold mount for M14.
 */
export function mountIdgRoutes(
  app: FastifyInstance,
  db: DbClient,
  outbox?: IdgWriteOutboxPort,
): void {
  const backend = createDbIdgBackend(db, outbox);
  _registerM14Abac({ resolver: backend });
  _registerM14Routes(app, { service: backend });
}

export { type IdgWriteOutboxPort, createDbIdgBackend } from "./idg-route-service-db";

// M14-T05 lands the three §4.8 owned seams (IdgPacketProvider — the packet-snapshot + M22 render handshake
// M22/M33 consume — + IdgDecisionProvider — the decision read path M30/M33 consume — + IdgScheduleProvider —
// the meeting-schedule + 15-day-cadence read path M28/M30/M33 consume) registered into the M1 registry via
// `registerIdgSeams` (driven from the composition root's wireModuleSeams()); the three §4.7 ABAC predicates M14
// owns (`quorate_decision` / `idg_meeting_scope` / `per_patient_review_floor_clear`); and the §4.1 route
// inventory behind the real `requirePermission` / `requireAbac` Authorization Contract (the §4.6 keys live in
// @wardenx/auth as `M14_CONTRIBUTED_PERMISSIONS`).
export {
  type IdgCadenceAdherence,
  type IdgDecisionSeedRow,
  type IdgSeamDeps,
  type IdgSeamSeed,
  type IdgSeamStore,
  type StoredIdgPacket,
  createDrizzleIdgSeamStore,
  createIdgDecisionProvider,
  createIdgPacketProvider,
  createIdgScheduleProvider,
  createInMemoryIdgSeamStore,
  getIdgDecisionProvider,
  getIdgPacketProvider,
  getIdgScheduleProvider,
  registerIdgSeams,
} from "./seams/index";
// M14-T05 — the three §4.7 ABAC predicates M14 owns (`quorate_decision` / `idg_meeting_scope` /
// `per_patient_review_floor_clear`). The §4.6 permission keys M14 contributes to M3 live in @wardenx/auth
// (M14_CONTRIBUTED_PERMISSIONS).
export {
  type IdgAbacDeps,
  type IdgAbacResolver,
  type MeetingScopeFacts,
  type ReviewFloorBreachFact,
  M14_ABAC_PREDICATES,
  REVIEW_FLOOR_OVERRIDE_ATTRIBUTE,
  buildIdgAbacPredicates,
  registerIdgAbacPredicates,
} from "./abac-predicates";
// M14-T05 — the §4.1 route inventory over an in-memory backend + the route service contract (in-mem slice;
// Drizzle in prod under withOrgContext so RLS backstops).
export { type IdgRouteDeps, registerIdgRoutes } from "./routes/idg-routes";
export {
  type IdgRouteService,
  type IdgRouteSeed,
  type MeetingView,
  type AttendanceView,
  type AgendaItemView,
  type DecisionView,
  type ActionItemView,
  type MinutesView,
  type PacketDigestView,
  type RecurringPolicyView,
  type MeetingScheduleView,
  type RecordedIdgEvent,
  createInMemoryIdgBackend,
} from "./routes/service";
// M14-T06 — the §4.4 outbox contract (the full `m14.*` taxonomy + the canonical `idg.decision_recorded`
// cross-module decision seam; check-fitness-gaps.ts scans events-by-m14.ts for naming + ownership + declared
// consumers). `idg.decision_recorded` is live for M7; the dispatcher preserves the source row for the
// other catalog-declared modules until their handlers bind.
export { M14_OUTBOX_EVENTS } from "./events-by-m14";
// M14-T06 — the §4.5 outbox subscriptions: the M6 inclusion cache, the M7/M8/M11/M12 D8 action-item
// auto-close, the M9/M10/M11/M12 "since last IDG" projection cache, and the M22 PDF back-ref. Pure
// auto-close planner + the event → consumer binding registry; consumed event names are string literals
// (no dependsOn edge).
export {
  M14_AUTO_CLOSE_LINKED_KIND,
  M14_OUTBOX_SUBSCRIPTIONS,
  planActionItemAutoClose,
} from "./consumers/index";
// M14-T06 — the §4.10 M36 typed alert payloads M14 OWNS (packet-ready / action-item assigned + carry-forward
// compliance / non-quorate decision / per-patient review-clock + review-floor override). Registered onto
// M36's Foundation alert-payload registry at boot; composition + recipient resolution is M36's (ADR-0024).
export { M14_ALERT_PAYLOADS } from "./alerts-by-m14";
// M14-T07 — the `idg_record` destruction-cert eraser (§8.4). Registered over the Phase-0 deny-stub via the
// composition root's wireModuleErasers() (apps/backend/src/index.ts). Patient-scoped packet/decision/action-item/
// agenda rows are deleted; the caseload-wide meeting/policy/attendance/minutes rows survive.
export {
  type IdgEraseCounts,
  type IdgEraseOptions,
  type IdgEraserDeps,
  type IdgEraseStore,
  type InMemoryIdgEraseSeed,
  createDrizzleIdgEraseStore,
  createIdgEraser,
  createInMemoryIdgEraseStore,
  eraseIdgRecord,
  registerIdgErasers,
} from "./erasers/idg-eraser";
// GAP-092 — the §4.8 `idg.review-clock-sweep` BullMQ queue catalog + the pure T-3/T-0/T+1 escalation scan
// (the M9 license/change-escalation/cadence precedent).
export {
  type M14QueueName,
  type ReviewClockEscalation,
  type ReviewClockSnapshot,
  M14_DLQ,
  M14_JOB_SCHEDULES,
  M14_QUEUES,
  M14_QUEUE_PARAMS,
  REVIEW_FLOOR_DAYS,
  planReviewClockSweep,
} from "./jobs/index";
// GAP-092 — the LIVE `idg.review-clock-sweep` BullMQ Worker/Queue construction (the M9/M10/M25 precedent)
// + the platform-tenancy registration its active-org fan-out needs.
export {
  type ActiveOrgListPort as M14ActiveOrgListPort,
  type M14WorkerDeps,
  buildM14WorkerDeps,
  registerM14CronWorkers,
  runReviewClockSweepCron,
  scheduleM14Jobs,
} from "./jobs/cron-workers";
export { M14_PLATFORM_JOB_ID, wireM14Tenancy } from "./wiring";
