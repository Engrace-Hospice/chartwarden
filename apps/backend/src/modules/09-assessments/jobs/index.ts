// apps/backend/src/modules/09-assessments/jobs — M9 background jobs (M9-T06, §4.8). Pure, deterministic
// scan processors over the §4.8 queue catalog (pure data, no BullMQ import — the worker construction
// binds at app boot, same pattern as M6-T10 / M5-T10). T06 ships the three compliance scans whose bodies
// are pure today:
//   • `license-status-scan`   (daily 02:00 org-tz) — recompute scale_license statuses; emit the §2.2.3
//                              license_pending_renewal / license_lapsed transition events.
//   • `change-escalation`     (hourly) — flip CRITICAL significant-change events still `open` after 24h to
//                              `escalated`; emit significant_change_escalated (M36 re-delivers at high).
//   • `reassessment-due-scan` (daily 06:00 org-tz) — flag a (patient, scale) past its reassessment cadence.
// All three are idempotent: a re-run after the runner persists the transitions is a no-op (the inputs no
// longer match the trigger predicate). The summary-cache + eraser queues are declared in the catalog;
// their bodies bind with their drivers (`build-summary-cache` = outbox subscriber; `erase-patient-
// assessments` = the M4 destruction-cert `eraseFn`, M9-T07).
import {
  computeScaleLicenseStatus,
  escalatesOnNoAck,
  transitionSignificantChange,
} from "@wardenx/assessments";
import type {
  ScaleLicenseStatus,
  ScaleType,
  SignificantChangeRuleId,
  SignificantChangeStatus,
} from "@wardenx/types";

// ── §4.8 queue catalog ────────────────────────────────────────────────────────────────────────────

/** The §4.8 BullMQ queue names (the `assessment.` namespace mirrors the spec's §4.8 table). */
export const M9_QUEUES = {
  /** Daily scan: flip scale_license statuses; emit the §2.2.3 license transition events. */
  license: "assessment.license",
  /** Hourly scan: escalate CRITICAL open significant-change events past the 24h no-ack mark. */
  changes: "assessment.changes",
  /** Daily scan: flag (patient, scale_type) past its reassessment cadence (soft — never blocks recording). */
  cadence: "assessment.cadence",
  /** Outbox subscriber + on-demand: rebuild the per-patient/scale summary cache (Valkey, 1h TTL). */
  summary: "assessment.summary",
  /** M4 destruction-cert callback: erase all assessment rows for a patient under an approved certificate. */
  eraser: "assessment.eraser",
} as const;

export type M9QueueName = (typeof M9_QUEUES)[keyof typeof M9_QUEUES];

/** The §4.8 dead-letter queue names (BullMQ moves jobs here after `attempts` exhausted; ops alerts off depth). */
export const M9_DLQ = {
  license: "assessment.license.dlq",
  changes: "assessment.changes.dlq",
  cadence: "assessment.cadence.dlq",
  summary: "assessment.summary.dlq",
  eraser: "assessment.eraser.dlq",
} as const;

/** The §4.8 cron cadences (the scheduler registers these repeatables; event-triggered jobs have none). */
export const M9_JOB_SCHEDULES = {
  license: "0 2 * * *", // daily 02:00 org-tz
  changes: "0 * * * *", // hourly
  cadence: "0 6 * * *", // daily 06:00 org-tz
} as const;

/** The §4.8 per-queue BullMQ parameters (priority / attempts / backoff / concurrency), declared as data so
 * the boot worker construction reads one source of truth (M09-F12: every job declares full parameters). */
export const M9_QUEUE_PARAMS = {
  license: { priority: 5, attempts: 3, backoff: "exponential 60s", concurrency: 2 },
  changes: { priority: 1, attempts: 5, backoff: "exponential 30s, max 5m", concurrency: 4 },
  cadence: { priority: 5, attempts: 3, backoff: "exponential 120s", concurrency: 2 },
  summary: { priority: 3, attempts: 3, backoff: "fixed 10s", concurrency: 8 },
  eraser: { priority: 2, attempts: 3, backoff: "exponential 30s", concurrency: 1 },
} as const;

/**
 * The §4.8 idempotency key: every job is keyed on `(scopeId, jobName, payloadHash)` so duplicate enqueues
 * from cron overlap or outbox-redelivery collapse to a single execution. Stable string join — the caller
 * passes a content hash (no hashing of inputs here). Mirrors M6-T10's `jobIdempotencyKey`.
 */
export function jobIdempotencyKey(input: {
  scopeId: string;
  jobName: string;
  payloadHash: string;
}): string {
  return `${input.scopeId}:${input.jobName}:${input.payloadHash}`;
}

/** An outbox event a scan asks the runner to publish (name + payload; the relay adds the envelope). */
export interface PlannedAssessmentEvent {
  readonly eventName:
    | "m9.scale.license_pending_renewal"
    | "m9.scale.license_lapsed"
    | "m9.assessment.significant_change_escalated";
  readonly payload: Record<string, unknown>;
}

// ── `license-status-scan` (§4.8 daily) ──────────────────────────────────────────────────────────────

/** The minimal scale_license projection the daily scan recomputes status over (a slice of the §3 row). */
export interface ScaleLicenseSnapshot {
  readonly scaleLicenseId: string;
  readonly scaleType: ScaleType;
  readonly status: ScaleLicenseStatus;
  /** `YYYY-MM-DD` calendar dates (§2.2.3 / D3 — date-derived, TZ-stable). */
  readonly effectiveDate: string;
  readonly expiresAt: string;
}

/** One license's recomputed status (and whether it actually moved). */
export interface LicenseTransition {
  readonly scaleLicenseId: string;
  readonly scaleType: ScaleType;
  readonly fromStatus: ScaleLicenseStatus;
  readonly toStatus: ScaleLicenseStatus;
  readonly changed: boolean;
}

/** What the license scan computed: per-license transitions + the §2.4 outbox events to emit. */
export interface LicenseScanPlan {
  readonly transitions: readonly LicenseTransition[];
  readonly events: readonly PlannedAssessmentEvent[];
}

/**
 * `license-status-scan` (§4.8) — recompute every proprietary-scale license status as of `today` and emit
 * the §2.2.3 transition events. Idempotent: emits `license_pending_renewal` / `license_lapsed` only on the
 * status *edge* (a license already `pending_renewal`/`expired` does not re-emit). `today` is `YYYY-MM-DD`
 * org-tz (the scheduler supplies it; the math is pure over the calendar date).
 */
export function planLicenseStatusScan(
  licenses: readonly ScaleLicenseSnapshot[],
  today: string,
): LicenseScanPlan {
  const transitions = licenses.map((lic) => {
    const toStatus = computeScaleLicenseStatus(
      { effectiveDate: lic.effectiveDate, expiresAt: lic.expiresAt },
      today,
    );
    return {
      scaleLicenseId: lic.scaleLicenseId,
      scaleType: lic.scaleType,
      fromStatus: lic.status,
      toStatus,
      changed: toStatus !== lic.status,
      expiresAt: lic.expiresAt,
    };
  });
  const events: PlannedAssessmentEvent[] = [];
  for (const t of transitions) {
    if (!t.changed) continue;
    if (t.toStatus === "pending_renewal")
      events.push({
        eventName: "m9.scale.license_pending_renewal",
        payload: { scaleType: t.scaleType, expiresAt: t.expiresAt },
      });
    else if (t.toStatus === "expired")
      events.push({
        eventName: "m9.scale.license_lapsed",
        payload: { scaleType: t.scaleType, expiredAt: t.expiresAt },
      });
  }
  return {
    transitions: transitions.map(({ expiresAt: _e, ...t }) => t),
    events,
  };
}

// ── `change-escalation` (§4.8 hourly) ───────────────────────────────────────────────────────────────

/** The 24h no-ack escalation window (§2.2.2 / §4.8 — only CRITICAL rules escalate). */
export const ESCALATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The minimal significant-change projection the hourly escalation scan operates over. */
export interface SignificantChangeSnapshot {
  readonly eventId: string;
  readonly ruleId: SignificantChangeRuleId;
  readonly status: SignificantChangeStatus;
  /** When the change was detected, as an ISO-8601 instant. */
  readonly detectedAt: string;
}

/** One escalated change (status moved open → escalated) — the runner persists + re-emits at severity=high. */
export interface ChangeEscalation {
  readonly eventId: string;
  readonly ruleId: SignificantChangeRuleId;
  readonly fromStatus: SignificantChangeStatus;
  readonly toStatus: SignificantChangeStatus;
  readonly originalDetectedAt: string;
  readonly escalatedAt: string;
}

/** What the change-escalation scan computed: the escalations + the §2.4 escalated outbox events. */
export interface ChangeEscalationPlan {
  readonly escalations: readonly ChangeEscalation[];
  readonly events: readonly PlannedAssessmentEvent[];
}

/**
 * `change-escalation` (§4.8) — flip every `open` significant-change event on a CRITICAL rule whose
 * `detected_at < now - 24h` to `escalated` (§2.2.2) and emit `m9.assessment.significant_change_escalated`
 * (M36 re-delivers at severity=high). Idempotent: only `open` rows matching the predicate transition; an
 * already-`escalated`/`acknowledged` row is skipped, and the §2.2.2 `transitionSignificantChange` machine
 * is the single authority on the legal move (non-CRITICAL rules never escalate).
 */
export function planChangeEscalation(
  changes: readonly SignificantChangeSnapshot[],
  now: Date,
  windowMs: number = ESCALATION_WINDOW_MS,
): ChangeEscalationPlan {
  const escalatedAt = now.toISOString();
  const escalations: ChangeEscalation[] = [];
  for (const c of changes) {
    if (c.status !== "open") continue;
    if (!escalatesOnNoAck(c.ruleId)) continue;
    if (now.getTime() - new Date(c.detectedAt).getTime() < windowMs) continue;
    // The §2.2.2 machine is the legality authority; it throws if the move is illegal (defensive).
    const toStatus = transitionSignificantChange(c.status, {
      type: "escalate",
      ruleId: c.ruleId,
    });
    escalations.push({
      eventId: c.eventId,
      ruleId: c.ruleId,
      fromStatus: c.status,
      toStatus,
      originalDetectedAt: c.detectedAt,
      escalatedAt,
    });
  }
  const events: PlannedAssessmentEvent[] = escalations.map((e) => ({
    eventName: "m9.assessment.significant_change_escalated",
    payload: {
      eventId: e.eventId,
      originalDetectedAt: e.originalDetectedAt,
      escalatedAt: e.escalatedAt,
    },
  }));
  return { escalations, events };
}

// ── `reassessment-due-scan` (§4.8 daily) ────────────────────────────────────────────────────────────

/** The CoP §418.54(d) reassessment cadence: update the comprehensive assessment every 15 days. The scans
 * flag overdue per (patient, scale) from the last capture; overdue is a SOFT state (never blocks). */
export const REASSESSMENT_CADENCE_DAYS = 15;

/**
 * The effective reassessment cadence for one scale: the CoP floor, TIGHTENED (never loosened) by the tenant's
 * `scale_policy.reassessment_cadence_overrides[scaleType]` (spec D2 floor rule). A missing, non-numeric,
 * non-integer or < 1 override is ignored — a malformed policy must never disable the cadence — and an override
 * above the floor is clamped to the floor.
 */
export function effectiveCadenceDays(
  scaleType: ScaleType,
  overrides: Readonly<Record<string, unknown>> | undefined,
  floorDays: number = REASSESSMENT_CADENCE_DAYS,
): number {
  const raw = overrides?.[scaleType];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return floorDays;
  return Math.min(floorDays, raw);
}

/** The minimal latest-capture projection the cadence scan operates over (one row per patient+scale). */
export interface ReassessmentSnapshot {
  readonly patientId: string;
  readonly scaleType: ScaleType;
  /** The last capture for this (patient, scale), as an ISO-8601 instant. */
  readonly lastCapturedAt: string;
  /** Siting denormalized from the last capture (the three-column rule); carried into the due ledger. */
  readonly providerEntityId?: string;
  readonly locationId?: string;
}

/** One (patient, scale) cadence evaluation: whether it is past due and when it became/becomes due. */
export interface ReassessmentDueFlag {
  readonly patientId: string;
  readonly scaleType: ScaleType;
  readonly dueAt: string;
  /** The effective cadence (days) the due date was derived from. */
  readonly cadenceDays: number;
  readonly overdue: boolean;
}

/**
 * `reassessment-due-scan` (§4.8) — per (patient, scale_type), flag overdue when
 * `now > lastCapturedAt + cadence`. Pure + idempotent: returns the full evaluation (the runner refreshes
 * the chart-banner cache from `overdue:true` rows). Cadence defaults to the §418.54(d) 15-day floor.
 */
export function planReassessmentDueScan(
  latest: readonly ReassessmentSnapshot[],
  now: Date,
  cadenceDays: number | ((scaleType: ScaleType) => number) = REASSESSMENT_CADENCE_DAYS,
): readonly ReassessmentDueFlag[] {
  return latest.map((r) => {
    const days = typeof cadenceDays === "function" ? cadenceDays(r.scaleType) : cadenceDays;
    const dueMs = new Date(r.lastCapturedAt).getTime() + days * 24 * 60 * 60 * 1000;
    return {
      patientId: r.patientId,
      scaleType: r.scaleType,
      cadenceDays: days,
      dueAt: new Date(dueMs).toISOString(),
      overdue: now.getTime() > dueMs,
    };
  });
}
