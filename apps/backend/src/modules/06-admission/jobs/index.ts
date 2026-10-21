// apps/backend/src/modules/06-admission/jobs — M6 background jobs (M6-T10, §4.3). Pure processors over
// the queue catalog (pure data, no BullMQ import — the worker construction binds at app boot, same
// pattern as M5-T10 / M40-T08). T10 ships the two compliance-window scans (`admission.recompute_windows`
// and `admission.window_alert` / the §3 `workers/window-scanner.ts`): both are pure, deterministic over
// an injected `now`, and idempotent so duplicate enqueues from outbox-redelivery are no-ops. The
// notify/form-render jobs are event-triggered shells whose bodies land with their M14/M22 consumers.
import type { ComplianceWindowSeverity, ComplianceWindowStatusValue } from "@chartwarden/types";
import type { LocalDate } from "@chartwarden/types";
import { computeF2fWindow, decideF2fWindowStatus } from "../certification/window-math";

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
  /** Cron (hourly; each org is evaluated on its own local date): complete ACTIVE benefit periods whose last covered day has passed and publish `m6.election.period_ended` (GAP-025). */
  periodAutoEnd: "m6.admission.period_auto_end",
} as const;

export type M6QueueName = (typeof M6_QUEUES)[keyof typeof M6_QUEUES];

/** The §4.3 cron cadences (the scheduler registers the repeatables; event-triggered jobs have none). */
export const M6_JOB_SCHEDULES = {
  recertDueNotify: "0 6 * * *", // daily 06:00 org TZ
  f2fDueNotify: "0 6 * * *", // daily 06:00 org TZ
  ctiSignatureNotify: "0 6 * * *", // daily 06:00 org TZ
  windowAlert: "*/15 * * * *", // every 15 minutes
  periodAutoEnd: "5 * * * *", // hourly; idempotent, so each org is caught shortly after ITS local midnight
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

// ── F2F "prior-to" window missed scan (F-178b, #248) ────────────────────────────────────────────────
//
// `decideF2fWindowStatus` (certification/window-math.ts) shipped with no caller anywhere in the
// codebase: `m6.f2f.window_missed` was a catalogued (events-by-m6.ts) but never-emitted event. Unlike
// the OTHER compliance-window kinds `planWindowAlert` scans (which assume a `compliance_window` row is
// already open and only promotes its status), NO code path ever opens a `f2f_recert_30d_prior` row —
// only `attestF2f`'s `close_window` effect touches that kind, and it no-ops when nothing is open. So
// this scan cannot read `promoteWindowStatus`'s `ComplianceWindowSnapshot` shape; it computes the
// window itself from the recert election period's (sequence >= `RECERT_SEQUENCE_FLOOR`) own facts and
// OPENS the `compliance_window` row itself, at the moment it first detects "missed" — which then also
// serves as the idempotency ledger (a second tick finds the row already open and skips; a later
// `attestF2f` closes it exactly as it does for a row opened any other way).
//
// `periodStartDate` for a not-yet-active recert period N is not stored anywhere (election-period.ts:
// "the START is the moment the period is activated") — so this reads it off the PRECEDING period N-1's
// `scheduled_end_at + 1 day` (42 CFR 418.21(a) benefit periods are contiguous; the same arithmetic
// `electionPeriodWindow` already treats as authoritative for N-1's own window).

/** One recert election period the store has resolved enough facts for to run `decideF2fWindowStatus`. */
export interface F2fWindowMissedCandidate {
  readonly electionPeriodId: string;
  readonly admissionId: string;
  /** Derived from the preceding period's `scheduled_end_at + 1 day` (yyyy-mm-dd). */
  readonly periodStartDate: LocalDate;
  /** Does this period already carry an ATTESTED face-to-face encounter? */
  readonly attested: boolean;
  /** Is a non-closed `f2f_recert_30d_prior` compliance_window row already open for this admission? */
  readonly alreadyFlagged: boolean;
}

/** One recert period whose F2F window newly reads `missed` and should be opened + emitted. */
export interface PlannedF2fWindowMissed {
  readonly electionPeriodId: string;
  readonly admissionId: string;
  readonly windowStart: LocalDate;
  readonly windowEnd: LocalDate;
  readonly windowEndInstant: string;
}

/**
 * `admission.window_alert` (F2F half, F-178b) — pure: for each candidate not already flagged, compute
 * its CMS 418.22 window off `periodStartDate` and run `decideF2fWindowStatus`; only a fresh `missed`
 * verdict plans an emission. Idempotent by construction: `alreadyFlagged` candidates are skipped by the
 * caller re-supplying them once the compliance_window row this plan asks the runner to open exists.
 */
export function planF2fWindowMissedScan(
  candidates: readonly F2fWindowMissedCandidate[],
  today: LocalDate,
  timeZone: string,
): PlannedF2fWindowMissed[] {
  const planned: PlannedF2fWindowMissed[] = [];
  for (const candidate of candidates) {
    if (candidate.alreadyFlagged) continue;
    const window = computeF2fWindow(candidate.periodStartDate, timeZone);
    const status = decideF2fWindowStatus({
      today,
      window,
      attested: candidate.attested,
    });
    if (status !== "missed") continue;
    planned.push({
      electionPeriodId: candidate.electionPeriodId,
      admissionId: candidate.admissionId,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      windowEndInstant: window.windowEndInstant,
    });
  }
  return planned;
}
