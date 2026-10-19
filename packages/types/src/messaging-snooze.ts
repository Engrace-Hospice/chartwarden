// M36 WP 4.10 (ADR-0077) - snooze and reminders. A SNOOZE is one user's bounded pause of OUT-OF-BAND (push / SMS / email) notices
// for one conversation's NON-URGENT alerts; it never hides anything in the app and never touches an urgent or acknowledgment-bound
// alert. A REMINDER re-surfaces one non-urgent message to its owner at an instant, through the ordinary alert pipeline.
// Both are behind the existing ops flag `messaging.notification_policy` (absent = off). All numbers are PROVISIONAL (brief section 12).
import { NOTIFICATION_POLICY_FLAG_KEY } from "./messaging-ack";

/** The flag that gates the snooze and reminder routes, the reminder sweep and the snooze lookup. */
export const SNOOZE_REMINDER_FLAG_KEY = NOTIFICATION_POLICY_FLAG_KEY;

/** A snooze lasts at least this long (a shorter one is a slip of the finger). */
export const SNOOZE_MIN_MINUTES = 5;
/** HARD maximum, enforced by a database CHECK as well as the service: a snooze can never outlive one working day. */
export const SNOOZE_MAX_MINUTES = 24 * 60;

/** A reminder is set at least this far ahead (the sweep runs every minute). */
export const REMINDER_MIN_LEAD_MINUTES = 1;
/** HARD horizon, enforced by a database CHECK as well as the service. */
export const REMINDER_MAX_HORIZON_DAYS = 30;
/** Pending reminders one user may hold in one organisation. */
export const REMINDER_MAX_PENDING = 25;
/** A reminder this long overdue is dropped unfired (a sweep that was down for a week must not wake a stale one). */
export const REMINDER_STALE_AFTER_DAYS = 7;

/** The alert event type of a due reminder. */
export const REMINDER_ALERT_EVENT = "m36.reminder.due";

export interface SnoozeDto {
  readonly channel_id: string;
  /** ISO instant the snooze ends; null when the conversation is not snoozed. */
  readonly snoozed_until: string | null;
  /**
   * True when the caller may snooze this conversation now. False while the caller is the sender or the assignee of an open
   * acknowledgment request in it (an urgent or acknowledgment-bound item can never be snoozed).
   */
  readonly snoozable: boolean;
}

export interface ReminderDto {
  readonly id: string;
  readonly channel_id: string;
  readonly message_id: string;
  readonly remind_at: string;
}

export interface ReminderListResponse {
  readonly reminders: readonly ReminderDto[];
  readonly max_pending: number;
}

/** Typed error codes (HTTP 409 unless noted) the UI maps to wording. */
export const SNOOZE_REMINDER_ERROR_CODES = {
  snoozeUrgent: "SNOOZE_URGENT_NOT_ALLOWED",
  reminderUrgent: "REMINDER_URGENT_NOT_ALLOWED",
  reminderLimit: "REMINDER_LIMIT_REACHED",
  /** 422 */
  snoozeDurationInvalid: "SNOOZE_DURATION_INVALID",
  /** 422 */
  reminderTimeInvalid: "REMINDER_TIME_INVALID",
} as const;
