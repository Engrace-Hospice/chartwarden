// apps/backend/src/modules/10-hope/jobs — M10 background jobs (M10-T06, §4.8 / §4.8.1). Pure,
// deterministic scan processors over the §4.8 queue catalog (NO BullMQ import — the worker construction
// binds at app boot, same pattern as M9-T06 / M6-T10). T06 ships the clinical-path watchdog + alert-
// dispatch bodies whose logic is pure today:
//   • `hope-window-watchdog` (cron 15m)  — flip open schedules past `late_deadline_at` to expired; emit
//                                           `m10.hope.timepoint_expired`.
//   • `sfv-watchdog`        (cron 15m)   — flip open SFVs past `due_at` to overdue, past 7d to missed;
//                                           emit `m10.hope.sfv_overdue` / `m10.hope.sfv_missed`.
//   • `hope-alert-dispatcher` (cron 5m)  — read `alert_cadence` on open schedules/SFVs; plan the M36
//                                           timepoint-window / SFV alerts at threshold (dedup by cadence).
// Every body is idempotent: a re-run after the runner persists the transitions is a no-op (the input no
// longer matches the trigger predicate; the §4.8.1 DLQ triage relies on this). The §4.8 submission queues
// (`assemble-hope-submission` / `iqies-submit-worker` / `iqies-reconcile-worker` / `submit-correction-rfa`)
// + the `revalidate-on-terminology-update` + `hope-partition-rotation` queues are declared in the catalog;
// their bodies bind with their drivers in M10-T07 (the iQIES submission worker loop, §4.10).
import {
  buildSfvAlert,
  buildTimepointWindowAlert,
  classifyCapture,
  decideSfvWatchdogStatus,
} from "@wardenx/hope";
import type {
  HopeRfaKind,
  HopeScheduleStatus,
  HopeSfvAlert,
  HopeSfvStatus,
  HopeTimepointWindowAlert,
} from "@wardenx/types";

// ── §4.8 queue catalog ─────────────────────────────────────────────────────────────────────────────

/**
 * The §4.8 BullMQ queue names (the `hope.` namespace mirrors the spec's §4.8 table). TASK-040D — was
 * originally declared with a `:` separator (`"hope:windows"`); BullMQ's `Queue`/`Worker` constructors
 * reject any name containing `:` (it's reserved for BullMQ's own Redis key scheme) — a latent defect
 * that had never been exercised because nothing constructed a real M10 Worker until TASK-040D's
 * `jobs/cron-workers.ts`. Found live (typecheck/unit tests can't catch it — only a real `new Worker(...)`
 * call throws), fixed by switching to `.` (the M7/M9 convention: `"care-plan.gates"`, `"assessment.license"`).
 */
export const M10_QUEUES = {
  scheduling: "hope.scheduling",
  windows: "hope.windows",
  sfv: "hope.sfv",
  alerts: "hope.alerts",
  validation: "hope.validation",
  submission: "hope.submission",
  retention: "hope.retention",
} as const;

export type M10QueueName = (typeof M10_QUEUES)[keyof typeof M10_QUEUES];

/** The §4.8.1 dead-letter queue names (BullMQ moves jobs here after `attempts` exhausted; OPS-035 alerts off depth). */
export const M10_DLQ = {
  scheduling: "hope.scheduling.dlq",
  windows: "hope.windows.dlq",
  sfv: "hope.sfv.dlq",
  alerts: "hope.alerts.dlq",
  validation: "hope.validation.dlq",
  submission: "hope.submission.dlq",
} as const;

/** The §4.8 cron cadences (event-driven jobs have none; the scheduler registers these repeatables). */
export const M10_JOB_SCHEDULES = {
  "hope-window-watchdog": "*/15 * * * *", // every 15 minutes
  "sfv-watchdog": "*/15 * * * *", // every 15 minutes
  "hope-alert-dispatcher": "*/5 * * * *", // every 5 minutes
  "assemble-hope-submission": "0 2 * * *", // daily 02:00 per tenant TZ
  "iqies-submit-worker": "*/30 * * * *", // every 30 minutes
  "iqies-reconcile-worker": "0 * * * *", // hourly
  "hope-partition-rotation": "0 3 1 * *", // monthly
  "hope-retention-scan": "0 4 2 * *", // monthly, the day after partition rotation (GAP-181)
} as const;

/** The §4.8.1 per-job BullMQ parameter tuple (priority / attempts / backoff / concurrency), declared as
 * data so the boot worker construction reads one source of truth (M10-F10: full SD-059 tuple per queue). */
export const M10_JOB_PARAMS = {
  "schedule-hope-timepoints": {
    priority: 2,
    attempts: 5,
    backoff: "exponential 30s, max 5m",
    concurrency: 4,
  },
  "materialize-discharge-timepoint": {
    priority: 2,
    attempts: 5,
    backoff: "exponential 30s, max 5m",
    concurrency: 4,
  },
  "hope-window-watchdog": { priority: 1, attempts: 5, backoff: "exponential 30s", concurrency: 2 },
  "sfv-watchdog": { priority: 1, attempts: 5, backoff: "exponential 30s", concurrency: 2 },
  "hope-alert-dispatcher": { priority: 2, attempts: 3, backoff: "fixed 15s", concurrency: 8 },
  "revalidate-on-terminology-update": {
    priority: 3,
    attempts: 3,
    backoff: "exponential 60s",
    concurrency: 4,
  },
  "assemble-hope-submission": {
    priority: 3,
    attempts: 3,
    backoff: "exponential 60s",
    concurrency: 2,
  },
  "iqies-submit-worker": {
    priority: 3,
    attempts: 5,
    backoff: "exponential 30s, max 10m",
    concurrency: 2,
  },
  "iqies-reconcile-worker": {
    priority: 3,
    attempts: 5,
    backoff: "exponential 60s",
    concurrency: 2,
  },
  "submit-correction-rfa": { priority: 3, attempts: 5, backoff: "exponential 30s", concurrency: 2 },
  "hope-partition-rotation": {
    priority: 5,
    attempts: 3,
    backoff: "exponential 120s",
    concurrency: 1,
  },
  "hope-retention-scan": { priority: 5, attempts: 3, backoff: "exponential 120s", concurrency: 1 },
} as const;

/**
 * The §4.8 idempotency key: every job is keyed on `(scopeId, jobName, payloadHash)` so duplicate enqueues
 * from cron overlap or outbox-redelivery collapse to a single execution. Stable string join (mirrors
 * M9-T06 / M6-T10's `jobIdempotencyKey`; the caller passes a content hash — no hashing of inputs here).
 */
export function jobIdempotencyKey(input: {
  scopeId: string;
  jobName: string;
  payloadHash: string;
}): string {
  return `${input.scopeId}:${input.jobName}:${input.payloadHash}`;
}

/** An outbox event a scan asks the runner to publish (name + payload; the relay adds the envelope). */
export interface PlannedHopeEvent {
  readonly eventName: "m10.hope.timepoint_expired" | "m10.hope.sfv_overdue" | "m10.hope.sfv_missed";
  readonly payload: Record<string, unknown>;
}

// ── `hope-window-watchdog` (§4.8 cron, every 15 min) ────────────────────────────────────────────────

/** The minimal schedule projection the window watchdog operates over (a slice of the §3 row). */
export interface HopeScheduleSnapshot {
  readonly scheduleId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly rfaKind: HopeRfaKind;
  readonly status: HopeScheduleStatus;
  readonly windowOpensAt: string;
  readonly windowClosesAt: string;
  readonly lateDeadlineAt: string;
}

/** One schedule's watchdog evaluation (and whether the watchdog moves it to expired). */
export interface HopeScheduleTransition {
  readonly scheduleId: string;
  readonly rfaKind: HopeRfaKind;
  readonly fromStatus: HopeScheduleStatus;
  readonly toStatus: HopeScheduleStatus;
  readonly changed: boolean;
}

/** What the window watchdog computed: per-schedule transitions + the §2.4 outbox events to emit. */
export interface HopeWindowWatchdogPlan {
  readonly transitions: readonly HopeScheduleTransition[];
  readonly events: readonly PlannedHopeEvent[];
}

/**
 * `hope-window-watchdog` (§4.8) — flip every `open` schedule whose `target_date` capture window has gone
 * past `late_deadline_at` (verdict `expired`) to `expired` (§2 / D2) and emit `m10.hope.timepoint_expired`.
 * Idempotent: only `open` rows that classify `expired` as of `nowInstant` transition; `completed` /
 * `skipped` / already-`expired` rows pass through unchanged. The `classifyCapture` verdict at `nowInstant`
 * is the single authority on the hard cutoff (shared with the recording-path gate).
 */
export function planHopeWindowWatchdog(
  schedules: readonly HopeScheduleSnapshot[],
  nowInstant: string,
): HopeWindowWatchdogPlan {
  const transitions: HopeScheduleTransition[] = [];
  const events: PlannedHopeEvent[] = [];
  for (const s of schedules) {
    if (s.status !== "open") continue;
    const verdict = classifyCapture(nowInstant, {
      windowOpensAt: s.windowOpensAt,
      windowClosesAt: s.windowClosesAt,
      lateDeadlineAt: s.lateDeadlineAt,
    });
    const changed = verdict === "expired";
    transitions.push({
      scheduleId: s.scheduleId,
      rfaKind: s.rfaKind,
      fromStatus: s.status,
      toStatus: changed ? "expired" : s.status,
      changed,
    });
    if (changed)
      events.push({
        eventName: "m10.hope.timepoint_expired",
        payload: { scheduleId: s.scheduleId, rfaKind: s.rfaKind, expiredAt: nowInstant },
      });
  }
  return { transitions, events };
}

// ── `sfv-watchdog` (§4.8 cron, every 15 min) ─────────────────────────────────────────────────────────

/** The minimal SFV projection the watchdog operates over (a slice of the §3 row). */
export interface SfvWatchdogSnapshot {
  readonly sfvId: string;
  readonly patientId: string;
  readonly admissionId: string | null;
  readonly triggeringAssessmentId: string;
  readonly status: HopeSfvStatus;
  readonly dueAt: string;
  /** Org IANA TZ — the missed boundary is computed in org-local calendar days (§2.2.3 / D3). */
  readonly timeZone: string;
}

/** One SFV's watchdog evaluation (and whether it moves to overdue/missed). */
export interface SfvWatchdogTransition {
  readonly sfvId: string;
  readonly fromStatus: HopeSfvStatus;
  readonly toStatus: HopeSfvStatus;
  readonly changed: boolean;
  /** Whole hours past `due_at` as of the scan (for the `sfv_overdue` transition payload). */
  readonly hoursPastDue: number;
}

/** What the SFV watchdog computed: per-SFV transitions + the §2.4 outbox events to emit. */
export interface SfvWatchdogPlan {
  readonly transitions: readonly SfvWatchdogTransition[];
  readonly events: readonly PlannedHopeEvent[];
}

/**
 * `sfv-watchdog` (§4.8) — decay every `open`/`overdue` SFV as of `nowInstant`: past `due_at` → `overdue`
 * (emit `m10.hope.sfv_overdue` once on the transition), past 7 calendar days → `missed`
 * (emit `m10.hope.sfv_missed`, terminal). Idempotent via `decideSfvWatchdogStatus` (the single decay
 * authority); `completed` / already-`missed` rows pass through.
 */
export function planSfvWatchdog(
  sfvs: readonly SfvWatchdogSnapshot[],
  nowInstant: string,
): SfvWatchdogPlan {
  const transitions: SfvWatchdogTransition[] = [];
  const events: PlannedHopeEvent[] = [];
  const nowMs = Date.parse(nowInstant);
  for (const s of sfvs) {
    const toStatus = decideSfvWatchdogStatus({
      current: s.status,
      dueAt: s.dueAt,
      asOfInstant: nowInstant,
      timeZone: s.timeZone,
    });
    const hoursPastDue = Math.max(0, Math.floor((nowMs - Date.parse(s.dueAt)) / 3_600_000));
    const changed = toStatus !== s.status;
    transitions.push({ sfvId: s.sfvId, fromStatus: s.status, toStatus, changed, hoursPastDue });
    if (toStatus === "missed" && changed)
      events.push({ eventName: "m10.hope.sfv_missed", payload: { sfvId: s.sfvId } });
    else if (toStatus === "overdue" && changed)
      events.push({ eventName: "m10.hope.sfv_overdue", payload: { sfvId: s.sfvId, hoursPastDue } });
  }
  return { transitions, events };
}

// ── `hope-alert-dispatcher` (§4.8 cron, every 5 min) ────────────────────────────────────────────────

/** A planned M36 alert the dispatcher hands to the M36 dispatch seam (in-app + out-of-band projected by §4.9.1). */
export type PlannedHopeAlert =
  | { readonly channel: "timepoint_window"; readonly alert: HopeTimepointWindowAlert }
  | { readonly channel: "sfv"; readonly alert: HopeSfvAlert };

/** The open-schedule projection the alert dispatcher reads (cadence + the window state to render). */
export interface TimepointAlertCandidate {
  readonly scheduleId: string;
  readonly rfaKind: HopeRfaKind;
  readonly patientId: string;
  readonly patientDisplayName: string;
  readonly windowState: HopeTimepointWindowAlert["windowState"];
  readonly hoursUntilDeadline: number;
  readonly ctaUrl: string;
  /** Whether this (schedule, windowState) is past its `alert_cadence` threshold and not yet dispatched. */
  readonly cadenceDue: boolean;
}

/** The open-SFV projection the alert dispatcher reads (cadence + the obligation state to render). */
export interface SfvAlertCandidate {
  readonly sfvId: string;
  readonly triggeringAssessmentId: string;
  readonly patientId: string;
  readonly patientDisplayName: string;
  readonly state: HopeSfvAlert["state"];
  readonly hoursUntilDue: number;
  readonly triggeringSymptoms: ReadonlyArray<{
    readonly symptomCode: string;
    readonly severity: string;
  }>;
  readonly ctaUrl: string;
  /** Whether this (sfv, state) is past its `alert_cadence` threshold and not yet dispatched. */
  readonly cadenceDue: boolean;
}

/**
 * `hope-alert-dispatcher` (§4.8) — plan the M36 alerts for every cadence-due open schedule / SFV. Pure:
 * builds the typed §4.9 payloads (the §4.9.1 in-app / out-of-band split happens in the M36 dispatch layer
 * via `buildInAppPayload` / `buildOutOfBandPayload`). Dedup is the caller's `alert_cadence` offset+anchor
 * key (M10-F10) — this planner only emits for `cadenceDue` candidates, so a re-run with the same cadence
 * state produces the same plan and the runner collapses duplicates on the cadence key.
 */
export function planHopeAlertDispatch(input: {
  readonly timepoints: readonly TimepointAlertCandidate[];
  readonly sfvs: readonly SfvAlertCandidate[];
}): readonly PlannedHopeAlert[] {
  const planned: PlannedHopeAlert[] = [];
  for (const t of input.timepoints) {
    if (!t.cadenceDue) continue;
    planned.push({
      channel: "timepoint_window",
      alert: buildTimepointWindowAlert({
        scheduleId: t.scheduleId,
        rfaKind: t.rfaKind,
        patientId: t.patientId,
        patientDisplayName: t.patientDisplayName,
        windowState: t.windowState,
        hoursUntilDeadline: t.hoursUntilDeadline,
        ctaUrl: t.ctaUrl,
      }),
    });
  }
  for (const s of input.sfvs) {
    if (!s.cadenceDue) continue;
    planned.push({
      channel: "sfv",
      alert: buildSfvAlert({
        sfvId: s.sfvId,
        triggeringAssessmentId: s.triggeringAssessmentId,
        patientId: s.patientId,
        patientDisplayName: s.patientDisplayName,
        state: s.state,
        hoursUntilDue: s.hoursUntilDue,
        triggeringSymptoms: s.triggeringSymptoms,
        ctaUrl: s.ctaUrl,
      }),
    });
  }
  return planned;
}
