// @chartwarden/consent — the M39 BullMQ job-queue catalog + the pure reminder/expiration engines
// (M39-T08, spec §4.9). The canonical queue names + cadences are DATA (no BullMQ import — the thin
// Worker/Queue construction lives in the composition root once a Valkey connection + the M36 alert
// emitter exist); M39 owns the policy + the pure decision engines the workers call. Same
// M1-owns-mechanism / module-owns-policy split as the M38/M40 jobs.
import type { ConsentReminderKind } from "../interfaces/kinds";

/** The eight §4.9 queues (BullMQ on Valkey). */
export const M39_QUEUES = {
  /** hourly: walk expires_at within the 90/30/14/7/1d window; insert reminders; emit expiring_soon. */
  expirationReminder: "m39.expiration_reminder",
  /** hourly: expires_at<now() AND status=active → expired; emit m39.consent.expired. */
  consentExpiration: "m39.consent_expiration",
  /** every 30s: re-fire stuck cascades (pending/in_progress, started >5m ago). */
  revocationCascadeRetry: "m39.revocation_cascade_retry",
  /** nightly 3 AM: close cycles whose source expired without renewal. */
  renewalCycleClose: "m39.renewal_cycle_close",
  /** daily 4 AM: discard (DELETE) drafts older than 30 days (housekeeping TTL, NOT retention §2.2.1). */
  draftAutoExpire: "m39.draft_auto_expire",
  /** nightly 11:30 PM: pre-create next-month consent_eval_audit partition. */
  evalAuditPartition: "m39.eval_audit_partition",
  /** event: m22.document.rendered (consent_record template) → stamp consent_document_link. */
  m22DocumentRendered: "m39.m22_document_rendered",
  /** event: m5.patient.deceased / m5.patient.merged → D13 cascade / re-point. */
  m5PatientLifecycle: "m39.m5_patient_lifecycle",
} as const;

export type M39QueueName = (typeof M39_QUEUES)[keyof typeof M39_QUEUES];

/** The platform-floor reminder cadence in days (D9), newest-threshold first. */
export const REMINDER_CADENCE_DAYS: ReadonlyArray<{ kind: ConsentReminderKind; days: number }> = [
  { kind: "90_days", days: 90 },
  { kind: "30_days", days: 30 },
  { kind: "14_days", days: 14 },
  { kind: "7_days", days: 7 },
  { kind: "1_day", days: 1 },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The reminder windows that have OPENED for a consent at `nowMs` given its `expiresAtMs` (D9). A
 * window `Nd` is open once `expiresAt - now ≤ N days` AND the consent has not yet expired. The hourly
 * `expiration-reminder` cron fires the most-urgent not-yet-fired window (idempotent on the reminder
 * row's idempotency key); this pure helper just decides which windows are due.
 */
export function dueReminders(input: {
  expiresAtMs: number | null;
  nowMs: number;
}): ConsentReminderKind[] {
  if (input.expiresAtMs === null) return []; // indefinite consents never remind
  const remainingMs = input.expiresAtMs - input.nowMs;
  if (remainingMs <= 0) return []; // already expired → the expiration cron handles it, not reminders
  return REMINDER_CADENCE_DAYS.filter((w) => remainingMs <= w.days * DAY_MS).map((w) => w.kind);
}

/** The single MOST-URGENT reminder window currently open (the one the cron fires this tick). */
export function mostUrgentReminder(input: {
  expiresAtMs: number | null;
  nowMs: number;
}): ConsentReminderKind | null {
  const due = dueReminders(input);
  return due.length > 0 ? due[due.length - 1]! : null; // last = smallest day threshold = most urgent
}

/** §4.9 consent-expiration tick: an active consent with expires_at in the past must flip to expired. */
export function shouldExpire(input: {
  status: "draft" | "active" | "superseded" | "revoked" | "expired";
  expiresAtMs: number | null;
  nowMs: number;
}): boolean {
  return (
    input.status === "active" && input.expiresAtMs !== null && input.expiresAtMs <= input.nowMs
  );
}

/** §4.9 draft housekeeping: a draft older than 30 days is discarded (NOT a retention commitment). */
export function isDraftStale(input: {
  status: string;
  createdAtMs: number;
  nowMs: number;
}): boolean {
  return input.status === "draft" && input.nowMs - input.createdAtMs > 30 * DAY_MS;
}
