// apps/backend/src/modules/06-admission/jobs — M6 background jobs (M6-T10, §4.3). Pure processors over
// the queue catalog (pure data, no BullMQ import — the worker construction binds at app boot, same
// pattern as M5-T10 / M40-T08). T10 ships the two compliance-window scans (`admission.recompute_windows`
// and `admission.window_alert` / the §3 `workers/window-scanner.ts`): both are pure, deterministic over
// an injected `now`, and idempotent so duplicate enqueues from outbox-redelivery are no-ops. The
// notify/form-render jobs are event-triggered shells whose bodies land with their M14/M22 consumers.
import type {
  ComplianceWindowSeverity,
  ComplianceWindowStatusValue,
} from "@wardenx/types";

export const M6_PLATFORM_JOB_ID = "m6-admission-cron";
// ── §4.3 queue catalog ────────────────────────────────────────────────────────────────────────────

/** The §4.3 BullMQ queue names (the `m6.` namespace mirrors the events-by-m6 contract). */
export const M6_QUEUES = {
  /** On referral accepted: create draft admission + draft period-1 + open NOR window. */
  draftFromReferral: "m6.admission.draft_from_referral",
  /** On activation / recert sign / LOC change / F2F attestation: recompute open windows (idempotent). */
  recomputeWindows: "m6.admission.recompute_windows",
  /** Cron (daily 06:00 org TZ): notify M14 for periods entering the recert window. */
  recertDueNotify: "m6.admission.recert_due_notify",
  /** Cron (daily 06:00 org TZ): notify M14 for upcoming F2F windows opening. */
  f2fDueNotify: "m6.admission.f2f_due_notify",
  /** Cron: monitor the hospice-MD 3-day CTI signature SLA. */
  ctiSignatureNotify: "m6.admission.cti_signature_notify",
  /** On `cti.mark_late`: remind to complete the written cert by `writtenCertDeadlineAt`. */
  ctiLateFollowup: "m6.admission.cti_late_followup",
  /** On election/CTI sign / NOR ack / F2F attest / discharge: post to outbox for M22 form render. */
  emitFormRequest: "m6.admission.emit_form_request",
  /** Scheduled (every 15 min): move overdue windows to alert severity; emit metrics. */
  windowAlert: "m6.admission.window_alert",
} as const;

export type M6QueueName = (typeof M6_QUEUES)[keyof typeof M6_QUEUES];

/** The §4.3 cron cadences (the scheduler registers the repeatables; event-triggered jobs have none). */
export const M6_JOB_SCHEDULES = {
  recertDueNotify: "0 6 * * *", // daily 06:00 org TZ
  f2fDueNotify: "0 6 * * *", // daily 06:00 org TZ
  ctiSignatureNotify: "0 6 * * *", // daily 06:00 org TZ
  windowAlert: "*/15 * * * *", // every 15 minutes
} as const;

/**
 * The §4.3 idempotency key: every job is keyed on `(admissionId, eventType, payloadHash)` so duplicate
 * enqueues from outbox-redelivery collapse to a single execution. Stable string join — no hashing of
 * the inputs themselves (the caller passes a content hash for the payload).
 */
export function jobIdempotencyKey(input: {
  admissionId: string;
  eventType: string;
  payloadHash: string;
}): string {
  return `${input.admissionId}:${input.eventType}:${input.payloadHash}`;
}

export type DueReminderTier = "due_7d" | "due_3d" | "overdue_1d";

export interface DueReminderSnapshot {
  readonly resourceId: string;
  readonly dueDate: string; // yyyy-mm-dd
  readonly completed: boolean;
}

export interface PlannedDueReminder {
  readonly resourceId: string;
  readonly tier: DueReminderTier;
}

/**
 * Determine whether a due item should produce today's reminder.
 *
 * Rules:
 *   7 calendar days before due → due_7d
 *   3 calendar days before due → due_3d
 *   1 calendar day after due  → overdue_1d
 *
 * Completed items never emit.
 */
export function planDueReminder(
  item: DueReminderSnapshot,
  today: string,
): PlannedDueReminder | null {
  if (item.completed) return null;

  const dayMs = 86_400_000;

  const due = Date.parse(`${item.dueDate}T00:00:00Z`);

  const current = Date.parse(`${today}T00:00:00Z`);

  const daysUntilDue = Math.round((due - current) / dayMs);

  if (daysUntilDue === 7) {
    return {
      resourceId: item.resourceId,
      tier: "due_7d",
    };
  }

  if (daysUntilDue === 3) {
    return {
      resourceId: item.resourceId,
      tier: "due_3d",
    };
  }

  if (daysUntilDue === -1) {
    return {
      resourceId: item.resourceId,
      tier: "overdue_1d",
    };
  }

  return null;
}

export type CtiSignatureReminderTier = "requested" | "due_1d" | "overdue";

export interface CtiSignatureReminderSnapshot {
  readonly ctiId: string;
  readonly requestedAt: string;
  readonly dueAt: string;
  readonly signedAt: string | null;
}

/**
 * CTI signature operational SLA:
 *
 * - initial assignment/request → requested
 * - <= 24h remaining          → due_1d
 * - deadline passed           → overdue
 *
 * A signed CTI never emits.
 */
export function planCtiSignatureReminder(
  item: CtiSignatureReminderSnapshot,
  now: Date,
): CtiSignatureReminderTier | null {
  if (item.signedAt) return null;

  const at = now.getTime();
  const requested = Date.parse(item.requestedAt);
  const due = Date.parse(item.dueAt);

  if (!Number.isFinite(requested) || !Number.isFinite(due)) {
    return null;
  }

  if (at > due) {
    return "overdue";
  }

  const remaining = due - at;

  if (remaining <= 24 * 60 * 60 * 1000) {
    return "due_1d";
  }

  return null;
}

// ── compliance-window scans ─────────────────────────────────────────────────────────────────────────

/** The minimal compliance-window projection the scans operate over (a slice of the §3 row). */
export interface ComplianceWindowSnapshot {
  readonly complianceWindowId: string;
  readonly admissionId: string;
  readonly windowType: string;
  readonly status: ComplianceWindowStatusValue;
  readonly severity: ComplianceWindowSeverity;
  /** When the window is due, as an ISO-8601 instant. */
  readonly dueAt: string;
}

/** Default lead time before `dueAt` at which an open window flips to `closing_soon` (24h). */
export const CLOSING_SOON_LEAD_MS = 24 * 60 * 60 * 1000;

/**
 * Pure status promotion for one window (§3 `workers/window-scanner.ts` rule): a `closed` window is
 * terminal; otherwise the status is derived solely from `now` vs `dueAt` and the closing-soon lead.
 * Monotonic and idempotent — re-running on the same inputs yields the same status.
 */
export function promoteWindowStatus(
  window: ComplianceWindowSnapshot,
  now: Date,
  closingSoonLeadMs: number = CLOSING_SOON_LEAD_MS,
): ComplianceWindowStatusValue {
  if (window.status === "closed") return "closed";
  const due = new Date(window.dueAt).getTime();
  const at = now.getTime();
  if (at >= due) return "overdue";
  if (at >= due - closingSoonLeadMs) return "closing_soon";
  return "open";
}

/** One window's recomputed status (and whether it actually moved). */
export interface WindowTransition {
  readonly complianceWindowId: string;
  readonly admissionId: string;
  readonly windowType: string;
  readonly fromStatus: ComplianceWindowStatusValue;
  readonly toStatus: ComplianceWindowStatusValue;
  readonly changed: boolean;
}

/** An outbox event the scan asks the runner to publish (name + payload, envelope added by the relay). */
export interface PlannedWindowEvent {
  readonly eventName:
    | "m6.compliance.window.overdue"
    | "m6.compliance.window.opened"
    | "m6.compliance.window.closed";
  readonly payload: Record<string, unknown>;
}

/** What a window scan computed: per-window transitions + the outbox events to emit. */
export interface WindowScanPlan {
  readonly transitions: readonly WindowTransition[];
  readonly events: readonly PlannedWindowEvent[];
}

function planTransitions(
  windows: readonly ComplianceWindowSnapshot[],
  now: Date,
  closingSoonLeadMs: number,
): WindowTransition[] {
  return windows.map((w) => {
    const toStatus = promoteWindowStatus(w, now, closingSoonLeadMs);
    return {
      complianceWindowId: w.complianceWindowId,
      admissionId: w.admissionId,
      windowType: w.windowType,
      fromStatus: w.status,
      toStatus,
      changed: toStatus !== w.status,
    };
  });
}

/**
 * `admission.recompute_windows` (§4.3) — recompute the open compliance windows for ONE admission after
 * activation / recert sign / LOC change / F2F attestation. Pure and idempotent: it only reports the
 * transitions (the runner persists them); a re-run after the writes is a no-op (`changed:false`).
 */
export function planRecomputeWindows(
  admissionId: string,
  windows: readonly ComplianceWindowSnapshot[],
  now: Date,
  closingSoonLeadMs: number = CLOSING_SOON_LEAD_MS,
): WindowScanPlan {
  const scoped = windows.filter((w) => w.admissionId === admissionId);
  const transitions = planTransitions(scoped, now, closingSoonLeadMs);
  return { transitions, events: [] };
}

/**
 * `admission.window_alert` (§4.3) — the every-15-min scan that moves windows newly past `dueAt` to
 * `overdue` and emits `m6.compliance.window.overdue` (severity escalates to `alert`). Idempotent: a
 * window already `overdue` does not re-emit (only the open→overdue / closing_soon→overdue edges fire).
 */
export function planWindowAlert(
  windows: readonly ComplianceWindowSnapshot[],
  now: Date,
  closingSoonLeadMs: number = CLOSING_SOON_LEAD_MS,
): WindowScanPlan {
  const transitions = planTransitions(windows, now, closingSoonLeadMs);
  const events: PlannedWindowEvent[] = transitions
    .filter((t) => t.changed && t.toStatus === "overdue")
    .map((t) => ({
      eventName: "m6.compliance.window.overdue" as const,
      payload: {
        complianceWindowId: t.complianceWindowId,
        severity: "alert" as const,
      },
    }));
  return { transitions, events };
}
