// WP 2.6 — pure helpers for the scheduled-send UI: the native datetime-local input format, the window the picker
// offers, and the plain-language texts for server refusals and blocked reasons.

/** The server minimum is 1 minute; offer 2 so a time picked "now" is still valid when the request lands. */
export const SCHEDULE_MIN_LEAD_MINUTES = 2;
export const SCHEDULE_MAX_DAYS = 30;
const DEFAULT_LEAD_MINUTES = 60;

const pad = (n: number): string => String(n).padStart(2, "0");

/** `YYYY-MM-DDTHH:mm` in the viewer's local time: the value format of `<input type="datetime-local">`. */
export function toLocalInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The instant a datetime-local value means in the viewer's time zone, or null when empty/malformed. */
export function fromLocalInputValue(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The earliest and latest time the picker should offer. */
export function scheduleBounds(now: Date): { min: Date; max: Date } {
  // Round the minimum UP to a whole minute so the input's `min` is never earlier than the lead time.
  const min = new Date(now.getTime() + SCHEDULE_MIN_LEAD_MINUTES * 60_000);
  if (min.getSeconds() > 0 || min.getMilliseconds() > 0) {
    min.setSeconds(0, 0);
    min.setMinutes(min.getMinutes() + 1);
  }
  return { min, max: new Date(now.getTime() + SCHEDULE_MAX_DAYS * 86_400_000) };
}

/** A suggested time: an hour from now, on a five-minute mark. */
export function defaultScheduleValue(now: Date): string {
  const target = new Date(now.getTime() + DEFAULT_LEAD_MINUTES * 60_000);
  target.setSeconds(0, 0);
  target.setMinutes(Math.ceil(target.getMinutes() / 5) * 5);
  return toLocalInputValue(target);
}

/** Why `picked` cannot be scheduled right now (against the clock passed in), or null when it can. */
export function validateScheduleTime(picked: Date | null, now: Date): string | null {
  if (!picked) return "Pick a date and time.";
  const { min, max } = scheduleBounds(now);
  if (picked.getTime() < min.getTime()) return scheduleErrorText("SCHEDULE_TOO_SOON");
  if (picked.getTime() > max.getTime()) return scheduleErrorText("SCHEDULE_TOO_FAR");
  return null;
}

/** The input value to start from when moving a row: its current time if that is still schedulable, else a default. */
export function rescheduleSeedValue(scheduledFor: string, now: Date): string {
  const current = new Date(scheduledFor);
  return validateScheduleTime(current, now) === null
    ? toLocalInputValue(current)
    : defaultScheduleValue(now);
}

/**
 * Whether a failed create/reschedule was a DEFINITE refusal (the server did not store it), so its idempotency key may
 * be rotated. A 5xx, 408 or a lost reply may have committed behind a gateway: the key is kept so a retry replays.
 */
export function isDefiniteRefusal(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500 && status !== 408;
}

/** A readable time in the viewer's own zone, with the zone named. */
export function formatScheduledTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

/** The IANA zone this browser is in (what the time is shown and sent in). */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Plain-language text for a server refusal on create/reschedule, or null for one we do not special-case. */
export function scheduleErrorText(code: string | null): string | null {
  switch (code) {
    case "SCHEDULE_TOO_SOON":
      return "Pick a time at least a couple of minutes from now, or send the message now.";
    case "SCHEDULE_TOO_FAR":
      return "Pick a time within the next 30 days.";
    case "SCHEDULE_LIMIT_REACHED":
      return "You have 50 scheduled messages. Send or cancel one before scheduling another.";
    case "CHANNEL_ARCHIVED":
      return "This conversation is closed, so a message can no longer be scheduled in it.";
    default:
      return null;
  }
}

/** Why a scheduled message was not sent. Generic: names no channel, patient or content. */
export function blockedReasonText(reason: string | null | undefined): string {
  switch (reason) {
    case "channel_archived":
      return "Not sent: the conversation is closed.";
    case "not_member":
      return "Not sent: you are no longer a member of the conversation.";
    case "permission_revoked":
      return "Not sent: you no longer have permission to send messages.";
    case "announcement_not_permitted":
      return "Not sent: only administrators can post announcements.";
    case "parent_unavailable":
      return "Not sent: the message it replies to is no longer available.";
    case "dispatch_failed":
      return "Not sent: it could not be delivered. You can retry or cancel it.";
    default:
      // A code this client does not know (a newer server): a generic note, never the raw code.
      return "This message could not be sent. Reschedule it to try again.";
  }
}
