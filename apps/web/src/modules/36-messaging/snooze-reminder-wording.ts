// M36 WP 4.10 (ADR-0077) - the words of snooze and reminders. PROVISIONAL (brief section 12): the presets, the lengths and the sentences wait
// for the clinical lead. Plain sentences; nothing here names a patient or a message.
import { SNOOZE_REMINDER_ERROR_CODES as CODES } from "@wardenx/types";

export interface DurationPreset {
  readonly minutes: number;
  readonly label: string;
}

/** Every preset is within the hard bounds (5 minutes to 24 hours); the server enforces them again. */
export const SNOOZE_PRESETS: readonly DurationPreset[] = [
  { minutes: 60, label: "1 hour" },
  { minutes: 240, label: "4 hours" },
  { minutes: 480, label: "8 hours" },
  { minutes: 1440, label: "24 hours" },
];

export const SNOOZE_TRIGGER_LABEL = "Snooze";
export const SNOOZE_TITLE = "Snooze this conversation";
export const SNOOZE_EXPLANATION =
  "If you get push, text or email copies of ordinary notices from this conversation, snooze pauses those copies. Nothing is hidden here, and urgent items always notify you.";
export const SNOOZE_UNSNOOZABLE_SHORT = "Urgent item - cannot snooze";
export const SNOOZE_UNSNOOZABLE_TEXT =
  "This conversation has an urgent or response-required item, so it cannot be snoozed. Urgent items always notify you.";
export const SNOOZE_END_LABEL = "End snooze";
export const SNOOZE_STARTED_TEXT = "Notifications snoozed.";
export const SNOOZE_ENDED_TEXT = "Snooze ended.";
export const SNOOZE_UNAVAILABLE_TEXT = "Snooze is unavailable right now.";

export const REMINDER_TRIGGER_LABEL = "Remind me";
export const REMINDER_TITLE = "Remind me about this message";
export const REMINDER_EXPLANATION =
  "You will get a notification with a link back to this message. The notification does not repeat the message.";
export const REMINDER_CANCEL_LABEL = "Cancel reminder";
export const REMINDER_SET_TEXT = "Reminder set.";
export const REMINDER_CANCELLED_TEXT = "Reminder cancelled.";

/** The reminder times offered; each is an absolute instant computed in the viewer's own clock at the moment the dialog opens. */
export interface ReminderPreset {
  readonly id: string;
  readonly label: string;
  readonly at: Date;
}

const HOUR_MS = 3_600_000;
const TOMORROW_HOUR = 9;

export function reminderPresets(now: Date): readonly ReminderPreset[] {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(TOMORROW_HOUR, 0, 0, 0);
  const inThreeDays = new Date(now);
  inThreeDays.setDate(inThreeDays.getDate() + 3);
  return [
    { id: "1h", label: "In 1 hour", at: new Date(now.getTime() + HOUR_MS) },
    { id: "3h", label: "In 3 hours", at: new Date(now.getTime() + 3 * HOUR_MS) },
    { id: "tomorrow", label: "Tomorrow morning", at: tomorrow },
    { id: "3d", label: "In 3 days", at: inThreeDays },
  ];
}

const FALLBACK = "That did not work. Try again.";

export function snoozeErrorText(status: number | undefined, code: string | undefined): string {
  if (code === CODES.snoozeUrgent) return SNOOZE_UNSNOOZABLE_TEXT;
  if (status === 404) return SNOOZE_UNAVAILABLE_TEXT;
  return FALLBACK;
}

export function reminderErrorText(status: number | undefined, code: string | undefined): string {
  if (code === CODES.reminderUrgent) {
    return "A reminder cannot be set on an urgent or response-required message.";
  }
  if (code === CODES.reminderLimit) return "You have the most reminders allowed. Cancel one first.";
  if (code === CODES.reminderTimeInvalid) return "Choose a later time within the next 30 days.";
  if (status === 404) return "Reminders are unavailable for this message.";
  return FALLBACK;
}
