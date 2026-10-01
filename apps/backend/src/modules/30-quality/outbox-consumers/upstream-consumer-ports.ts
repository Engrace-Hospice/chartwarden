// apps/backend/src/modules/30-quality/outbox-consumers/upstream-consumer-ports.ts — F-150 (#248).
//
// The Drizzle-backed half of `@wardenx/quality`'s pure §4.10 upstream-event handlers
// (`packages/quality/src/consumers/handlers.ts`, RULE 3(d)): those handlers are pure + port-injected and
// were never bound to a running consumer anywhere (`M30ConsumerPorts` had no implementation in this repo
// at all). This file is that implementation.
//
// SCOPED, NOT COMPLETE: `enqueueRecompute` and (as of F-185, #248) `createIncidentDraft` are real. The
// other two `M30ConsumerPorts` methods (`createMortalityReviewDraft`, `addCahpsSampleCandidate`) stay
// LAZY fail-closed thunks — `unboundWorkerPort`, the exact mechanism `m30-jobs.ts`'s own worker deps
// already use for the identical posture — because each is blocked on real, separate, unbuilt
// infrastructure:
//   - `addCahpsSampleCandidate` needs the M1 envelope-DEK caregiver-contact encrypt PLUS a caregiver-
//     contact fact `m6.discharge.death`'s payload does not carry — the same gap `m30-jobs.ts`'s own
//     `cahpsMonthlySample.samples.insertSampled` port already reports as unbound.
//   - `createMortalityReviewDraft` is itself real and buildable, but `m6.discharge.death`'s consumer
//     handler (`handleDischargeDeath`) calls it TOGETHER with the still-blocked `addCahpsSampleCandidate`
//     in one invocation — binding the event now would mean the mortality-review insert throws (and rolls
//     back) on every delivery because of the CAHPS half, which is worse than leaving it unbound. Left
//     unbound alongside the CAHPS gap it is paired with; a future pass that solves the CAHPS DEK/contact
//     problem can bind `m6.discharge.death` in one piece.
//
// F-185 (#248) — `createIncidentDraft` is now real. The F-150-era blocker ("no system-actor-membership
// convention exists anywhere in this codebase" for `incident_report.reported_by_membership_id`, NOT NULL)
// was stale: that column carries no DB-level FK (`packages/db/src/schema/quality/incident-report.ts:77`,
// confirmed against migration `0063_quality_m30_incident_report.sql` — only `organization_id` has a real
// FK), and this codebase already has four working precedents for a NOT NULL, non-FK, module-owned
// system-actor sentinel on this exact column shape (`M17_SYSTEM_USER_ID`
// `17-scheduling/outbox-consumers/m20-safety-visit-cancellation.ts`, `M18_SYSTEM_USER_ID`
// `18-evv/outbox-consumers/m17-visit-cancelled.ts`, `M37_SYSTEM_MEMBERSHIP_ID`
// `37-ipu/consumers/m6-discharge-death.ts`, `RENDER_SYSTEM_MEMBERSHIP_ID`
// `22-documents/seams/drizzle-seam-store.ts`) — `M30_SYSTEM_MEMBERSHIP_ID` below is a fifth, same-shape,
// no-migration fix, not a new mechanism.
//
// `enqueueRecompute` is exercised by the consumers this file's siblings (`upstream-events.ts`,
// `m16-plan-closed.ts`) bind that consume ONLY `ports.enqueueRecompute`; `createIncidentDraft` is now
// exercised by `m37-restraint-applied.ts`'s `buildM30RestraintAppliedConsumer` (F-185).
import { type DbClient, schema } from "@wardenx/db";
import {
  type M30ConsumerPorts,
  MEASURE_FY_BOUNDARY_v2025,
  MEASURE_FY_BOUNDARY_v2026,
  MEASURE_FY_BOUNDARY_v2028,
  type MeasureFyBoundary,
  MeasureRecomputeQueueRepository,
  resolvePeriodRule,
  resolvePeriodWindow,
  unboundWorkerPort,
} from "@wardenx/quality";
import { withOrgContext } from "@wardenx/tenancy";

/**
 * `incident_report.reported_by_membership_id`'s "no real acting user" sentinel for an M30-system-authored
 * auto-created draft — NOT a real membership row, the same all-zero-except-module-number convention
 * `M17_SYSTEM_USER_ID` / `M18_SYSTEM_USER_ID` / `M37_SYSTEM_MEMBERSHIP_ID` already use (see the file
 * header for the exact precedents; the column has no DB-level FK, so this is a valid, if non-referential,
 * uuid). F-185 (#248).
 */
export const M30_SYSTEM_MEMBERSHIP_ID = "00000000-0000-0000-0000-000000000030";

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
      await withOrgContext(
        db,
        { organizationId: request.organizationId, userId: "" },
        async (tx) => {
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
        },
      );
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
    async createIncidentDraft(row) {
      await withOrgContext(db, { organizationId: row.organizationId, userId: "" }, async (tx) => {
        const t = tx as DbClient;
        // Idempotency: `incident_report` is RANGE-partitioned on `occurred_at`, so the §2.6 backstop is a
        // PER-LEAF partial-UNIQUE on `(triggering_event_outbox_id) WHERE triggering_event_outbox_id IS NOT
        // NULL` (`add_incident_report_unique_indexes`, migration 0063), created directly on each monthly
        // partition rather than as a partitioned index on the parent. An `INSERT ... ON CONFLICT` issued
        // against the PARENT cannot infer that index (confirmed against a live Postgres 16 — `there is no
        // unique or exclusion constraint matching the ON CONFLICT specification`, `infer_arbiter_indexes`,
        // SQLSTATE 42P10): arbiter-index inference on a partitioned table only sees indexes declared on the
        // partitioned table itself, and this one deliberately is not (it OMITS the partition key, so it
        // cannot be). The `uq_measure_recompute_pending` `onConflictDoNothing` shape
        // `MeasureRecomputeQueueRepository.enqueue` uses does not apply here for that reason — that table
        // is not partitioned. Idempotency is instead a catch on the real `23505` the per-leaf index raises:
        // a redelivery (same `triggeringEventOutboxId`) hits the unique index on INSERT, and is a silent
        // no-op rather than a duplicate draft or a thrown error.
        try {
          await t.insert(schema.incidentReport).values(row);
        } catch (err) {
          if (!isAutoCreationRedelivery(err)) throw err;
        }
      });
    },
  };
}

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = "23505";
/** How far down a `.cause` chain to look — Drizzle wraps the `pg` `DatabaseError` once. */
const MAX_CAUSE_DEPTH = 5;

/**
 * True iff `err` is the `23505` raised by `incident_report`'s per-leaf `..._auto_creation_uidx` partial-
 * unique index — the §2.6 auto-creation idempotency backstop, not some other constraint. Mirrors
 * `classifyDatabaseError`'s `.cause`-walk (`@wardenx/db` `business-rules.ts`) without pulling in that
 * registry's caller-facing-409 machinery, which this internal consumer-port no-op has no use for.
 */
function isAutoCreationRedelivery(err: unknown): boolean {
  let cursor: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cursor instanceof Error; depth++) {
    const code = (cursor as { code?: unknown }).code;
    const constraint = (cursor as { constraint?: unknown }).constraint;
    if (code === UNIQUE_VIOLATION && typeof constraint === "string") {
      return constraint.endsWith("_auto_creation_uidx");
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}
