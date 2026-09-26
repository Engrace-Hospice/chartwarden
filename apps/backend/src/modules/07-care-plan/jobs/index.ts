// apps/backend/src/modules/07-care-plan/jobs — M7 background jobs (M7-T07, §4.6). Pure processors over
// the queue catalog (pure data, no BullMQ import — the worker construction binds at app boot, same
// pattern as M6-T10 / M5-T10). T07 ships the two §7.1/§7.2 gate scans that turn the due columns
// maintained by `../lifecycle/gate-clock` into outbox events; both are pure, deterministic over an
// injected `now`, and idempotent via per-plan emission markers so duplicate cron fires are no-ops. The
// `apply-idg-decision` is now handled directly by the live M14 outbox binding. The legacy queue name is
// retained for contract compatibility; `build-summary` remains a separate event-driven job.
import type { IsoInstant } from "@wardenx/types";
import { warningOpensAt } from "../lifecycle/gate-clock";

// ── §4.6 queue catalog ──────────────────────────────────────────────────────────────────────────────

/** The §4.6 BullMQ queue names (spec-literal `care-plan.*`; the scheduler binds repeatables at boot). */
export const M7_QUEUES = {
  /** Daily gate scans: `5day-warning` (§7.1) + `15day-overdue` (§7.2); also on-demand after a sign. */
  gates: "care-plan.gates",
  /** Legacy queue identifier for `idg.decision_recorded`; live delivery uses the M1 dispatcher. */
  idg: "care-plan.idg",
  /** Outbox subscriber + on-demand: rebuild the summary cache on `m7.care_plan.version_signed`. */
  snapshot: "care-plan.snapshot",
} as const;

export type M7QueueName = (typeof M7_QUEUES)[keyof typeof M7_QUEUES];

/** The §4.6 dead-letter queue names (DLQ document-before-clear per OPS-035). */
export const M7_DLQ = {
  gates: "care-plan.gates.dlq",
  idg: "care-plan.idg.dlq",
  snapshot: "care-plan.snapshot.dlq",
} as const;

/** The §4.6 cron cadence: both gate scans run as one daily repeatable at 06:00 org-tz. */
export const M7_JOB_SCHEDULES = {
  gates: "0 6 * * *", // daily 06:00 org TZ (§4.6 `5day-warning` + `15day-overdue`)
} as const;

/**
 * The §4.6 BullMQ standard parameter set (SD-059) per queue, declared as pure data so the boot-time
 * worker construction (M1 infra) consumes one source of truth. `removeOnFail:false` keeps exhausted
 * jobs for DLQ promotion (OPS-035).
 */
export const M7_QUEUE_PARAMS = {
  gates: {
    priority: 5,
    attempts: 3,
    backoff: { type: "exponential", delay: 60_000 },
    concurrency: 2,
    removeOnComplete: { count: 100 },
    removeOnFail: false,
    dlq: M7_DLQ.gates,
  },
  idg: {
    priority: 3,
    attempts: 5,
    backoff: { type: "exponential", delay: 5_000 },
    concurrency: 5,
    removeOnComplete: { count: 500 },
    removeOnFail: false,
    dlq: M7_DLQ.idg,
  },
  snapshot: {
    priority: 6,
    attempts: 3,
    backoff: { type: "fixed", delay: 10_000 },
    concurrency: 3,
    removeOnComplete: { count: 200 },
    removeOnFail: false,
    dlq: M7_DLQ.snapshot,
  },
} as const;

// ── §4.6 idempotency keys ─────────────────────────────────────────────────────────────────────────

/** `care-plan.gates` idempotency: one scan per `(YYYY-MM-DD org-tz, planId)` (Valkey SETNX, §4.6). */
export function gateScanIdempotencyKey(input: { date: string; planId: string }): string {
  return `care-plan.gates.scanned:${input.date}:${input.planId}`;
}

/** `care-plan.idg` idempotency: the IDG decision id (no-op if a version already records it; §4.6 D4). */
export function idgApplyIdempotencyKey(idgDecisionId: string): string {
  return `idg:apply:${idgDecisionId}`;
}

/** `care-plan.snapshot` idempotency: BullMQ jobId `summary:<planId>:<versionId>` dedups rebuilds (§4.6). */
export function summaryJobId(input: { planId: string; versionId: string }): string {
  return `summary:${input.planId}:${input.versionId}`;
}

// ── §7.1/§7.2 gate scans ────────────────────────────────────────────────────────────────────────────

/**
 * The per-plan projection the gate scans operate over — the §7.1/§7.2 clock columns plus the emission
 * markers that make the scans idempotent. A plan re-arms its markers when a version signs (initial sign
 * clears `initialWarningEmitted`; each review sign clears the review markers and resets the due date).
 */
export interface CarePlanGateSnapshot {
  readonly planId: string;
  readonly patientId: string;
  /** `m6.admission.activated` instant — echoed into the `initial_overdue` payload. */
  readonly admissionActivatedAt: IsoInstant;
  /** Whether a `signed` initial version exists yet (disarms the 5-day scan, arms the 15-day scan). */
  readonly hasSignedInitialVersion: boolean;
  /** `care_plan.initial_due_at` (gate-clock.computeInitialDueAt). */
  readonly initialDueAt: IsoInstant;
  /** `care_plan.next_review_due_at` (gate-clock.computeNextReviewDueAt); null pre-first-signature. */
  readonly nextReviewDueAt: IsoInstant | null;
  /** Set once the `5day-warning` event has fired for the current initial deadline. */
  readonly initialWarningEmitted: boolean;
  /** Set once `review_due` (T+13) has fired for the current `nextReviewDueAt`. */
  readonly reviewDueEmitted: boolean;
  /** Set once `review_overdue` (T+15) has fired for the current `nextReviewDueAt`. */
  readonly reviewOverdueEmitted: boolean;
}

/** An outbox event a scan asks the runner to publish (name + payload; the relay adds the envelope). */
export interface PlannedCarePlanEvent {
  readonly eventName:
    | "m7.care_plan.initial_overdue"
    | "m7.care_plan.review_due"
    | "m7.care_plan.review_overdue";
  readonly payload: Record<string, unknown>;
}

/** What a gate scan computed: the outbox events to emit + the planIds whose markers must be set. */
export interface CarePlanGateScanPlan {
  readonly events: readonly PlannedCarePlanEvent[];
  /** The plans that just emitted, so the runner can flip the matching emission marker (idempotency). */
  readonly markedPlanIds: readonly string[];
}

/**
 * True once `now` has reached the start of the org-local warning day (`GATE_WARNING_LEAD_DAYS` calendar
 * days before the due day — D2 day 3, D3 day 13); see `warningOpensAt`.
 */
function withinLead(now: IsoInstant, dueAt: IsoInstant): boolean {
  return Date.parse(now) >= Date.parse(warningOpensAt(dueAt));
}

/**
 * `care-plan.gates / 5day-warning` (§7.1) — the daily scan that warns when an UNSIGNED initial version's
 * 5-day deadline is within `GATE_WARNING_LEAD_DAYS` (day 3). Emits `m7.care_plan.initial_overdue` once
 * per deadline; a plan that already warned, or whose initial version is signed, is skipped (idempotent).
 */
export function planInitialGateScan(
  snapshots: readonly CarePlanGateSnapshot[],
  now: IsoInstant,
): CarePlanGateScanPlan {
  const events: PlannedCarePlanEvent[] = [];
  const markedPlanIds: string[] = [];
  for (const s of snapshots) {
    if (s.hasSignedInitialVersion || s.initialWarningEmitted) continue;
    if (!withinLead(now, s.initialDueAt)) continue;
    events.push({
      eventName: "m7.care_plan.initial_overdue",
      payload: {
        planId: s.planId,
        patientId: s.patientId,
        admissionActivatedAt: s.admissionActivatedAt,
      },
    });
    markedPlanIds.push(s.planId);
  }
  return { events, markedPlanIds };
}

/**
 * `care-plan.gates / 15day-overdue` (§7.2) — the daily scan over plans with a signed initial version. It
 * fires `m7.care_plan.review_due` once the deadline is within `GATE_WARNING_LEAD_DAYS` (T+13) and
 * `m7.care_plan.review_overdue` once `now` has crossed the deadline (T+15). Both are emitted at most once
 * per `nextReviewDueAt` (markers); a fresh signed version resets the due date and re-arms the markers.
 */
export function planReviewGateScan(
  snapshots: readonly CarePlanGateSnapshot[],
  now: IsoInstant,
): CarePlanGateScanPlan {
  const events: PlannedCarePlanEvent[] = [];
  const markedPlanIds: string[] = [];
  for (const s of snapshots) {
    if (!s.hasSignedInitialVersion || s.nextReviewDueAt === null) continue;
    const dueAt = s.nextReviewDueAt;
    const overdue = Date.parse(now) >= Date.parse(dueAt);
    if (overdue && !s.reviewOverdueEmitted) {
      events.push({
        eventName: "m7.care_plan.review_overdue",
        payload: { planId: s.planId, patientId: s.patientId, dueAt, overdueAt: now },
      });
      markedPlanIds.push(s.planId);
      continue; // the overdue event supersedes the due warning for this scan
    }
    if (!overdue && !s.reviewDueEmitted && withinLead(now, dueAt)) {
      events.push({
        eventName: "m7.care_plan.review_due",
        payload: { planId: s.planId, patientId: s.patientId, dueAt },
      });
      markedPlanIds.push(s.planId);
    }
  }
  return { events, markedPlanIds };
}
