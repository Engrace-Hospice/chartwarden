// apps/backend/src/modules/30-quality/outbox-consumers/upstream-consumer-ports.ts — F-150 (#248).
//
// The Drizzle-backed half of `@wardenx/quality`'s pure §4.10 upstream-event handlers
// (`packages/quality/src/consumers/handlers.ts`, RULE 3(d)): those handlers are pure + port-injected and
// were never bound to a running consumer anywhere (`M30ConsumerPorts` had no implementation in this repo
// at all). This file is that implementation.
//
// SCOPED, NOT COMPLETE: only `enqueueRecompute` is real. The other three `M30ConsumerPorts` methods
// (`createMortalityReviewDraft`, `addCahpsSampleCandidate`, `createIncidentDraft`) stay LAZY fail-closed
// thunks — `unboundWorkerPort`, the exact mechanism `m30-jobs.ts`'s own worker deps already use for the
// identical posture — because each is blocked on real, separate, unbuilt infrastructure:
//   - `addCahpsSampleCandidate` needs the M1 envelope-DEK caregiver-contact encrypt PLUS a caregiver-
//     contact fact `m6.discharge.death`'s payload does not carry — the same gap `m30-jobs.ts`'s own
//     `cahpsMonthlySample.samples.insertSampled` port already reports as unbound.
//   - `createIncidentDraft` needs a resolvable "M30 service membership" for `incident_report
//     .reported_by_membership_id` (NOT NULL) — no system-actor-membership convention exists anywhere in
//     this codebase to attribute an auto-created draft to (the F-102 `actorMembershipId: NULL for
//     system-actor cascades` pattern does not apply here: this column has no such nullable carve-out).
//   - `createMortalityReviewDraft` is itself real and buildable, but `m6.discharge.death`'s consumer
//     handler (`handleDischargeDeath`) calls it TOGETHER with the still-blocked `addCahpsSampleCandidate`
//     in one invocation — binding the event now would mean the mortality-review insert throws (and rolls
//     back) on every delivery because of the CAHPS half, which is worse than leaving it unbound. Left
//     unbound alongside the CAHPS gap it is paired with; a future pass that solves the CAHPS DEK/contact
//     problem can bind `m6.discharge.death` in one piece.
//
// Only `enqueueRecompute` is exercised by the two consumers this file's sibling
// (`upstream-events.ts`) actually binds (`m10.hope.submission_accepted`, `m23.claim.adjudicated`) — both
// call ONLY `ports.enqueueRecompute` (packages/quality/src/consumers/handlers.ts), so the three unbound
// thunks are never invoked by them.
import type { DbClient } from "@wardenx/db";
import {
  type M30ConsumerPorts,
  type MeasureFyBoundary,
  MEASURE_FY_BOUNDARY_v2025,
  MEASURE_FY_BOUNDARY_v2026,
  MEASURE_FY_BOUNDARY_v2028,
  MeasureRecomputeQueueRepository,
  resolvePeriodRule,
  resolvePeriodWindow,
  unboundWorkerPort,
} from "@wardenx/quality";
import { withOrgContext } from "@wardenx/tenancy";

/**
 * Resolve the {@link MeasureFyBoundary} in effect for a reference date. Mirrors
 * `apps/backend/src/modules/30-quality/jobs/m30-jobs.ts`'s own private `resolveFyBoundary` (not exported
 * from `@wardenx/quality`) — the boundary constants are versioned by the calendar year they activate in,
 * so the LATEST constant whose year has arrived wins.
 */
function resolveFyBoundary(asOf: Date): MeasureFyBoundary {
  const year = asOf.getUTCFullYear();
  if (year >= MEASURE_FY_BOUNDARY_v2028.fiscalYear) return MEASURE_FY_BOUNDARY_v2028;
  if (year >= MEASURE_FY_BOUNDARY_v2026.fiscalYear) return MEASURE_FY_BOUNDARY_v2026;
  return MEASURE_FY_BOUNDARY_v2025;
}

/**
 * The real `M30ConsumerPorts.enqueueRecompute` implementation: for each resolved measure code, compute
 * its FY-boundary period window (per-code, since e.g. CAHPS overrides the default rolling-12m rule) and
 * enqueue a debounced `measure_recompute_queue` row via the real repository — the exact §3.3 mechanism
 * D16's ten-event recompute-trigger list describes ("mark the affected period as requires_recompute=true
 * … the worker drains within the next 15 minutes"). RLS-scoped via `withOrgContext`.
 */
export function buildM30UpstreamConsumerPorts(
  db: DbClient,
  now: () => Date = () => new Date(),
): M30ConsumerPorts {
  return {
    async enqueueRecompute(request) {
      await withOrgContext(db, { organizationId: request.organizationId, userId: "" }, async (tx) => {
        const repo = new MeasureRecomputeQueueRepository(tx as DbClient);
        const boundary = resolveFyBoundary(now());
        for (const measureCode of request.measureCodes) {
          const rule = resolvePeriodRule(boundary, measureCode);
          const period = resolvePeriodWindow(rule, now());
          await repo.enqueue({
            measureCode,
            providerEntityId: request.providerEntityId,
            organizationId: request.organizationId,
            periodStart: new Date(period.start),
            periodEnd: new Date(period.end),
            triggeringEventOutboxId: request.triggeringEventId,
            triggeringEventName: request.reason,
          });
        }
      });
    },
    createMortalityReviewDraft: () =>
      unboundWorkerPort(
        "outboxConsumers.m30.createMortalityReviewDraft",
        "m6.discharge.death stays unbound — paired in the same handler call with the still-blocked addCahpsSampleCandidate (F-150, #248)",
      ),
    addCahpsSampleCandidate: () =>
      unboundWorkerPort(
        "outboxConsumers.m30.addCahpsSampleCandidate",
        "needs the M1 envelope-DEK caregiver-contact encrypt + a caregiver-contact source the death event does not carry — the same gap m30-jobs.ts's own cahpsMonthlySample.samples.insertSampled port reports (F-150, #248)",
      ),
    createIncidentDraft: () =>
      unboundWorkerPort(
        "outboxConsumers.m30.createIncidentDraft",
        "needs a resolvable 'M30 service membership' for incident_report.reported_by_membership_id (NOT NULL) — no system-actor-membership convention exists anywhere in this codebase (F-150, #248)",
      ),
  };
}
